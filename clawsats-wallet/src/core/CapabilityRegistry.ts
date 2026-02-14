import { randomBytes, createHash } from 'crypto';
import { CapabilityHandler } from '../types';
import { log } from '../utils';
import {
  ECHO_PRICE_SATS, SIGN_MESSAGE_PRICE_SATS, HASH_COMMIT_PRICE_SATS,
  TIMESTAMP_ATTEST_PRICE_SATS, BROADCAST_PRICE_SATS,
  BROADCAST_HOP_LIMIT, BROADCAST_AUDIENCE_LIMIT
} from '../protocol/constants';

const TAG = 'capabilities';

/**
 * Registry of paid capabilities this Claw offers.
 * Each capability has a name, price, and handler function.
 * The 402 flow checks this registry to determine pricing.
 */
export class CapabilityRegistry {
  private capabilities: Map<string, CapabilityHandler> = new Map();

  register(capability: CapabilityHandler): void {
    this.capabilities.set(capability.name, capability);
    log(TAG, `Registered capability: ${capability.name} (${capability.pricePerCall} sats/call)`);
  }

  get(name: string): CapabilityHandler | undefined {
    return this.capabilities.get(name);
  }

  has(name: string): boolean {
    return this.capabilities.has(name);
  }

  list(): CapabilityHandler[] {
    return Array.from(this.capabilities.values());
  }

  listNames(): string[] {
    return Array.from(this.capabilities.keys());
  }

  getPrice(name: string): number | undefined {
    return this.capabilities.get(name)?.pricePerCall;
  }

  /**
   * Register the built-in "echo" capability.
   * A trivial paid service: send a message + pay, get it signed and returned.
   * Proves the entire 402 flow works end-to-end.
   */
  registerEcho(wallet: any, identityKey: string): void {
    this.register({
      name: 'echo',
      description: 'Signed echo service — send a message, get it signed and returned. Proves 402 payment flow.',
      pricePerCall: ECHO_PRICE_SATS,
      handler: async (params: { message: string; nonce?: string }) => {
        const message = params.message;
        if (!message || typeof message !== 'string') {
          throw new Error('Missing required param: message (string)');
        }
        const nonce = params.nonce || randomBytes(8).toString('hex');
        const payload = `${message}|${nonce}`;

        // Sign with wallet's identity key
        let signature = '';
        try {
          const result = await wallet.createSignature({
            data: Array.from(Buffer.from(payload, 'utf8')),
            protocolID: [0, 'clawsats-echo'],
            keyID: 'echo-v1'
          });
          signature = Buffer.from(result.signature).toString('base64');
        } catch {
          // If signing fails (e.g. wallet doesn't support this yet), return unsigned
          signature = 'unsigned';
        }

        return {
          message,
          nonce,
          signedBy: identityKey,
          signature,
          timestamp: new Date().toISOString()
        };
      }
    });
  }

  /**
   * Register "sign_message" — cryptographically verifiable.
   * Requester submits message; provider returns signature using identity key.
   * BrowserAI #2: "objectively checkable" baseline capability.
   */
  registerSignMessage(wallet: any, identityKey: string): void {
    this.register({
      name: 'sign_message',
      description: 'Sign a message with provider identity key. Verifiable by anyone with the pubkey.',
      pricePerCall: SIGN_MESSAGE_PRICE_SATS,
      handler: async (params: { message: string }) => {
        if (!params.message || typeof params.message !== 'string') {
          throw new Error('Missing required param: message (string)');
        }
        const data = Array.from(Buffer.from(params.message, 'utf8'));
        let signature = '';
        try {
          const result = await wallet.createSignature({
            data,
            protocolID: [0, 'clawsats-sign'],
            keyID: 'sign-v1'
          });
          signature = Buffer.from(result.signature).toString('base64');
        } catch {
          signature = 'error';
        }
        return {
          message: params.message,
          signedBy: identityKey,
          signature,
          timestamp: new Date().toISOString()
        };
      }
    });
  }

  /**
   * Register "hash_commit" — provider returns sha256(payload) with signature.
   * BrowserAI #2: provably correct, cheap, objectively checkable.
   */
  registerHashCommit(wallet: any, identityKey: string): void {
    this.register({
      name: 'hash_commit',
      description: 'SHA-256 hash commitment with provider signature. Verifiable by re-hashing.',
      pricePerCall: HASH_COMMIT_PRICE_SATS,
      handler: async (params: { payload: string }) => {
        if (!params.payload || typeof params.payload !== 'string') {
          throw new Error('Missing required param: payload (string)');
        }
        const hash = createHash('sha256').update(params.payload).digest('hex');
        let signature = '';
        try {
          const result = await wallet.createSignature({
            data: Array.from(Buffer.from(hash, 'utf8')),
            protocolID: [0, 'clawsats-hash'],
            keyID: 'hash-v1'
          });
          signature = Buffer.from(result.signature).toString('base64');
        } catch {
          signature = 'error';
        }
        return {
          payload: params.payload,
          hash,
          signedBy: identityKey,
          signature,
          timestamp: new Date().toISOString()
        };
      }
    });
  }

  /**
   * Register "timestamp_attest" — provider signs { hash, ts }.
   * BrowserAI #2: timestamping service, provably correct.
   */
  registerTimestampAttest(wallet: any, identityKey: string): void {
    this.register({
      name: 'timestamp_attest',
      description: 'Timestamp attestation — provider signs {hash, timestamp}. Provable time witness.',
      pricePerCall: TIMESTAMP_ATTEST_PRICE_SATS,
      handler: async (params: { hash: string }) => {
        if (!params.hash || typeof params.hash !== 'string') {
          throw new Error('Missing required param: hash (string)');
        }
        const ts = new Date().toISOString();
        const attestation = `${params.hash}|${ts}`;
        let signature = '';
        try {
          const result = await wallet.createSignature({
            data: Array.from(Buffer.from(attestation, 'utf8')),
            protocolID: [0, 'clawsats-timestamp'],
            keyID: 'ts-v1'
          });
          signature = Buffer.from(result.signature).toString('base64');
        } catch {
          signature = 'error';
        }
        return {
          hash: params.hash,
          timestamp: ts,
          signedBy: identityKey,
          signature
        };
      }
    });
  }

  /**
   * Register the built-in "broadcast_listing" capability.
   * The spreading flywheel: Claw A pays Claw B to announce A's manifest to B's known peers.
   * BrowserAI #3: hop_limit, audience_limit, dedupe_key enforced.
   */
  registerBroadcastListing(
    peerEndpoints: () => string[],
    dedupeCache?: Set<string>
  ): void {
    const seen = dedupeCache || new Set<string>();

    this.register({
      name: 'broadcast_listing',
      description: `Paid broadcast — announce your manifest to known peers. Max ${BROADCAST_AUDIENCE_LIMIT} peers, ${BROADCAST_HOP_LIMIT} hops.`,
      pricePerCall: BROADCAST_PRICE_SATS,
      handler: async (params: {
        manifest: any;
        maxPeers?: number;
        hopCount?: number;
        dedupeKey?: string;
      }) => {
        const { manifest, maxPeers, hopCount = 0, dedupeKey } = params;
        if (!manifest || !manifest.identityKey) {
          throw new Error('Missing required param: manifest with identityKey');
        }

        // Hop limit enforcement
        if (hopCount >= BROADCAST_HOP_LIMIT) {
          return { peersNotified: 0, peerEndpoints: [], reason: 'Hop limit reached', timestamp: new Date().toISOString() };
        }

        // Dedupe: don't broadcast the same listing twice
        const key = dedupeKey || `${manifest.identityKey}:${manifest.announcementId || ''}`;
        if (seen.has(key)) {
          return { peersNotified: 0, peerEndpoints: [], reason: 'Duplicate broadcast', timestamp: new Date().toISOString() };
        }
        seen.add(key);

        // Audience limit enforcement
        const limit = Math.min(maxPeers || BROADCAST_AUDIENCE_LIMIT, BROADCAST_AUDIENCE_LIMIT);
        const endpoints = peerEndpoints();
        const targets = endpoints.slice(0, limit);
        const notified: string[] = [];

        for (const endpoint of targets) {
          try {
            const res = await fetch(`${endpoint}/wallet/announce`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(manifest),
              signal: AbortSignal.timeout(5000)
            });
            if (res.ok) {
              notified.push(endpoint);
            }
          } catch {
            // Peer unreachable — skip
          }
        }

        return {
          peersNotified: notified.length,
          peerEndpoints: notified,
          hopCount: hopCount + 1,
          maxHops: BROADCAST_HOP_LIMIT,
          dedupeKey: key,
          timestamp: new Date().toISOString()
        };
      }
    });
  }
}
