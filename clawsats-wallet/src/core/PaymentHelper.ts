import { FEE_SATS, FEE_IDENTITY_KEY, FEE_DERIVATION_SUFFIX } from '../protocol/constants';
import { log, logWarn } from '../utils';

const TAG = 'payment';

/**
 * Client-side helper for paying a remote Claw's capability via BRC-105.
 *
 * Flow:
 *   1. Call the capability endpoint with no payment → get 402 + challenge headers
 *   2. Build a BSV tx with two outputs:
 *      - output 0: provider amount → BRC-29 derived from provider's identity key
 *      - output 1: FEE_SATS (2 sat) → BRC-29 derived from FEE_IDENTITY_KEY (treasury)
 *   3. Re-call with x-bsv-payment JSON header containing the tx
 *
 * Each payment goes to a FRESH derived address (BRC-29/BRC-42).
 * No address reuse ever occurs.
 */
export class PaymentHelper {

  /**
   * Pay for and execute a remote capability in one call.
   * Handles the full 402 round-trip automatically.
   *
   * @param wallet - BRC-100 wallet instance (must support createAction)
   * @param endpoint - Full URL of the capability, e.g. "http://host:3321/call/echo"
   * @param params - JSON body to send with the capability request
   * @param senderIdentityKey - This Claw's identity key (for x-bsv-identity-key header)
   * @returns The capability result from the provider
   */
  static async payForCapability(
    wallet: any,
    endpoint: string,
    params: Record<string, any>,
    senderIdentityKey: string
  ): Promise<any> {
    // Step 1: Call without payment to get 402 challenge
    log(TAG, `Requesting challenge from ${endpoint}...`);
    const challengeRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bsv-identity-key': senderIdentityKey
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });

    if (challengeRes.status !== 402) {
      // Either free capability (200) or error
      if (challengeRes.ok) {
        return challengeRes.json();
      }
      const errBody = await challengeRes.text();
      throw new Error(`Unexpected status ${challengeRes.status}: ${errBody}`);
    }

    // Step 2: Parse challenge headers
    const satoshisRequired = parseInt(
      challengeRes.headers.get('x-bsv-payment-satoshis-required') || '0', 10
    );
    const derivationPrefix = challengeRes.headers.get('x-bsv-payment-derivation-prefix') || '';
    const feeIdentityKey = challengeRes.headers.get('x-clawsats-fee-identity-key') || FEE_IDENTITY_KEY;
    const feeSats = parseInt(
      challengeRes.headers.get('x-clawsats-fee-satoshis-required') || String(FEE_SATS), 10
    );

    if (!derivationPrefix) {
      throw new Error('402 response missing x-bsv-payment-derivation-prefix');
    }
    if (satoshisRequired <= 0) {
      throw new Error('402 response has invalid satoshis-required');
    }

    // Verify the fee key matches the canonical protocol key
    if (feeIdentityKey !== FEE_IDENTITY_KEY) {
      logWarn(TAG, `Provider advertised non-canonical fee key: ${feeIdentityKey.substring(0, 16)}... — refusing to pay`);
      throw new Error(
        'CLAWSATS SECURITY: Provider fee key does not match canonical FEE_IDENTITY_KEY. ' +
        'This provider may be running modified code. Payment refused.'
      );
    }

    log(TAG, `Challenge received: ${satoshisRequired} sats + ${feeSats} sat fee, prefix=${derivationPrefix.substring(0, 12)}...`);

    // Step 3: Build the payment transaction via BRC-100 createAction
    // Output 0: provider payment (BRC-29 derived from provider's identity key)
    // Output 1: protocol fee (BRC-29 derived from FEE_IDENTITY_KEY)
    const providerIdentityKey = challengeRes.headers.get('x-bsv-identity-key') || '';
    const derivationSuffix = 'clawsats';
    const feeSuffix = FEE_DERIVATION_SUFFIX;

    const actionResult = await wallet.createAction({
      description: `ClawSats payment: ${satoshisRequired} sats + ${feeSats} sat fee`,
      outputs: [
        {
          // Output 0: provider payment
          satoshis: satoshisRequired,
          lockingScript: await PaymentHelper.deriveLockingScript(
            wallet, providerIdentityKey || senderIdentityKey,
            derivationPrefix, derivationSuffix, senderIdentityKey
          ),
          outputDescription: 'ClawSats provider payment'
        },
        {
          // Output 1: protocol fee to treasury
          satoshis: feeSats,
          lockingScript: await PaymentHelper.deriveLockingScript(
            wallet, FEE_IDENTITY_KEY,
            derivationPrefix, feeSuffix, senderIdentityKey
          ),
          outputDescription: 'ClawSats protocol fee'
        }
      ],
      labels: ['clawsats-payment'],
      options: { signAndProcess: true }
    });

    // Extract the raw tx as base64 for the x-bsv-payment header
    let txBase64: string;
    if (actionResult.rawTx) {
      txBase64 = typeof actionResult.rawTx === 'string'
        ? actionResult.rawTx
        : Buffer.from(actionResult.rawTx).toString('base64');
    } else if (actionResult.tx) {
      txBase64 = typeof actionResult.tx === 'string'
        ? actionResult.tx
        : Buffer.from(actionResult.tx).toString('base64');
    } else {
      throw new Error('createAction did not return rawTx or tx');
    }

    log(TAG, `Payment tx built: ${satoshisRequired + feeSats} sats total`);

    // Step 4: Re-call with payment proof (BRC-105 §6.3)
    const paymentHeader = JSON.stringify({
      derivationPrefix,
      derivationSuffix,
      transaction: txBase64
    });

    const resultRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bsv-identity-key': senderIdentityKey,
        'x-bsv-payment': paymentHeader
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30000)
    });

    if (!resultRes.ok) {
      const errBody = await resultRes.text();
      throw new Error(`Payment accepted but capability failed (${resultRes.status}): ${errBody}`);
    }

    const result = await resultRes.json();
    log(TAG, `Capability executed successfully, paid ${resultRes.headers.get('x-bsv-payment-satoshis-paid') || satoshisRequired} sats`);
    return result;
  }

  /**
   * Derive a BRC-29 P2PKH locking script for a recipient.
   * Uses BRC-42 key derivation: invoice = "2-3241645161d8-<prefix> <suffix>"
   */
  private static async deriveLockingScript(
    wallet: any,
    recipientIdentityKey: string,
    derivationPrefix: string,
    derivationSuffix: string,
    _senderIdentityKey: string
  ): Promise<string> {
    // Use the wallet's getPublicKey with BRC-29 protocol to derive the recipient's
    // payment public key, then build a P2PKH script from it.
    const result = await wallet.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: recipientIdentityKey
    });

    const pubKeyHex = result.publicKey;
    // Build P2PKH: OP_DUP OP_HASH160 <hash160(pubkey)> OP_EQUALVERIFY OP_CHECKSIG
    // We need to hash the public key to get the address hash
    const { createHash } = await import('crypto');
    const sha256 = createHash('sha256').update(Buffer.from(pubKeyHex, 'hex')).digest();
    const ripemd160 = createHash('ripemd160').update(sha256).digest('hex');
    return `76a914${ripemd160}88ac`;
  }
}
