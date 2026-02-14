import { PrivateKey } from '@bsv/sdk';
import { Setup } from '@bsv/wallet-toolbox';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { WalletConfig, CreateWalletOptions, ExpectedOutput, Chain } from '../types';
import {
  FEE_SATS, FEE_KID, FEE_DERIVATION_SUFFIX, FEE_IDENTITY_KEY, DEFAULT_TAAL_API_KEY
} from '../protocol/constants';

export class WalletManager {
  // Using 'any' to avoid cross-package @bsv/sdk type mismatches
  // between the version bundled in @bsv/wallet-toolbox and the direct dep.
  private wallet: any = null;
  private config: WalletConfig | null = null;

  async createWallet(options: CreateWalletOptions = {}): Promise<WalletConfig> {
    const {
      name = `claw-${Date.now()}`,
      chain = 'test',
      rootKeyHex = PrivateKey.fromRandom().toHex(),
      storageType = 'sqlite',
      storagePath: customPath,
      autoFund = false,
      testnetFaucetUrl = 'https://faucet.bitcoincloud.net/faucet'
    } = options;

    // Resolve storage path
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    const storagePath = customPath || join(dataDir, `${name}.sqlite`);

    // Derive the identity key from the root key
    const rootKey = PrivateKey.fromHex(rootKeyHex);
    const identityKey = rootKey.toPublicKey().toString();

    // Create wallet using the canonical wallet-toolbox Setup API.
    // Setup.createWalletClientNoEnv is the cleanest path for autonomous
    // agents — no .env file required, just chain + rootKeyHex.
    if (storageType === 'sqlite') {
      // Build a synthetic SetupEnv so we can use createWalletSQLite
      const env = WalletManager.buildEnv(chain, identityKey, rootKeyHex);
      const sw = await Setup.createWalletSQLite({
        env,
        rootKeyHex,
        filePath: storagePath,
        databaseName: name
      });
      this.wallet = sw.wallet;
    } else {
      // In-memory wallet backed by remote StorageClient
      this.wallet = await Setup.createWalletClientNoEnv({
        chain,
        rootKeyHex
      });
    }

    // Auto-fund with testnet BSV if requested
    if (autoFund && chain === 'test') {
      await this.fundWithTestnet(identityKey, testnetFaucetUrl);
    }

    // Build wallet configuration
    this.config = {
      identityKey,
      chain,
      rootKeyHex,
      storageType,
      storagePath,
      endpoints: {
        jsonrpc: 'http://localhost:3321',
        health: 'http://localhost:3321/health',
        discovery: 'http://localhost:3321/discovery'
      },
      capabilities: [
        'createAction',
        'internalizeAction',
        'listOutputs',
        'listActions',
        'getPublicKey',
        'createSignature',
        'verifySignature'
      ],
      clawsats: {
        feeKeyId: FEE_KID,
        defaultFeeSuffix: FEE_DERIVATION_SUFFIX
      }
    };

    this.saveConfig(this.config);
    return this.config;
  }

  async loadWallet(configPath: string): Promise<WalletConfig> {
    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }

    const configData = readFileSync(configPath, 'utf-8');
    const loaded: WalletConfig = JSON.parse(configData);

    if (!loaded || !loaded.rootKeyHex) {
      throw new Error('Invalid wallet config: missing rootKeyHex. Re-create the wallet.');
    }

    this.config = loaded;
    const chain = this.config.chain;
    const rootKeyHex = this.config.rootKeyHex!;
    const { storageType, storagePath } = this.config;
    const rootKey = PrivateKey.fromHex(rootKeyHex);
    const identityKey = rootKey.toPublicKey().toString();

    if (storageType === 'sqlite' && storagePath) {
      const env = WalletManager.buildEnv(chain, identityKey, rootKeyHex!);
      const sw = await Setup.createWalletSQLite({
        env,
        rootKeyHex: rootKeyHex!,
        filePath: storagePath,
        databaseName: `claw-${identityKey.substring(0, 8)}`
      });
      this.wallet = sw.wallet;
    } else {
      this.wallet = await Setup.createWalletClientNoEnv({
        chain,
        rootKeyHex: rootKeyHex!
      });
    }

    return this.config;
  }

  getWallet(): any {
    if (!this.wallet) {
      throw new Error('Wallet not initialized. Call createWallet() or loadWallet() first.');
    }
    return this.wallet;
  }

  getConfig(): WalletConfig | null {
    return this.config;
  }

  createPaymentChallenge(
    providerAmount: number,
    derivationPrefix?: string
  ): Record<string, string> {
    if (!derivationPrefix) {
      derivationPrefix = randomBytes(16).toString('base64');
    }

    const headers: Record<string, string> = {
      'x-bsv-payment-version': '1.0',
      'x-bsv-payment-satoshis-required': providerAmount.toString(),
      'x-bsv-payment-derivation-prefix': derivationPrefix,
      'x-clawsats-fee-satoshis-required': String(FEE_SATS),
      'x-clawsats-fee-kid': FEE_KID,
      'x-clawsats-fee-derivation-suffix': FEE_DERIVATION_SUFFIX
    };

    // Always include the protocol fee treasury key so payers know
    // where to direct the 2-sat fee output.
    headers['x-clawsats-fee-identity-key'] = FEE_IDENTITY_KEY;

    return headers;
  }

  async verifyPayment(txid: string, expectedOutputs: ExpectedOutput[]): Promise<boolean> {
    const wallet = this.getWallet();

    const providerOutput = expectedOutputs.find(o => o.type === 'provider');
    const feeOutput = expectedOutputs.find(o => o.type === 'protocol-fee');

    if (!providerOutput || !feeOutput) {
      return false;
    }

    if (feeOutput.amount < FEE_SATS) {
      return false;
    }

    // Search both the payer label ('clawsats-payment') and legacy label ('payment')
    const actions = await wallet.listActions({
      labels: ['clawsats-payment', 'payment'],
      limit: 200,
      includeOutputs: true
    });

    const action = actions.actions?.find((a: any) => a.txid === txid);
    if (!action || !action.outputs) {
      return false;
    }

    // Verify output amounts match expectations.
    // NOTE: This is a soft check — full verification requires checking
    // that output scripts derive from the correct identity keys via BRC-29.
    // The primary enforcement is internalizeAction in the 402 flow.
    const hasProviderAmount = action.outputs.some(
      (output: any) => output.satoshis === providerOutput.amount
    );
    const hasFeeAmount = action.outputs.some(
      (output: any) => output.satoshis === feeOutput.amount
    );

    return hasProviderAmount && hasFeeAmount;
  }

  async destroy(): Promise<void> {
    if (this.wallet && typeof this.wallet.destroy === 'function') {
      await this.wallet.destroy();
    }
    this.wallet = null;
  }

  /**
   * Build a synthetic SetupEnv for autonomous wallet creation.
   * This avoids requiring a .env file — perfect for Clawbot-AI agents.
   */
  private static buildEnv(
    chain: Chain,
    identityKey: string,
    rootKeyHex: string
  ) {
    return {
      chain,
      identityKey,
      identityKey2: identityKey,
      filePath: undefined,
      taalApiKey: process.env.TAAL_API_KEY || DEFAULT_TAAL_API_KEY,
      devKeys: { [identityKey]: rootKeyHex } as Record<string, string>,
      mySQLConnection: '{}'
    };
  }

  private async fundWithTestnet(identityKey: string, faucetUrl: string): Promise<void> {
    try {
      console.log(`[wallet] Requesting testnet funding for: ${identityKey.substring(0, 16)}...`);
      const res = await fetch(faucetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityKey }),
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) {
        const body = await res.text();
        console.warn(`[wallet] Faucet returned ${res.status}: ${body}`);
        return;
      }
      const data: any = await res.json();
      if (data.funded) {
        console.log(`[wallet] Testnet funding complete: ${data.satoshis || '?'} sats received`);
      } else {
        console.warn(`[wallet] Faucet declined: ${data.reason || data.error || 'unknown'}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('[wallet] Failed to fund with testnet:', msg);
    }
  }

  private saveConfig(config: WalletConfig): void {
    const configDir = join(process.cwd(), 'config');
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    const configPath = join(configDir, 'wallet-config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log(`[wallet] Configuration saved to: ${configPath}`);
    console.warn(`[wallet] ⚠️  ${configPath} contains rootKeyHex (private key). Protect this file!`);
    console.warn(`[wallet]    chmod 600 ${configPath} — never commit to git or expose publicly.`);
  }
}