import { randomBytes } from 'crypto';
import { CapabilityHandler } from '../types';
import { log } from '../utils';

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
      pricePerCall: 10,
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
   * Register the built-in "broadcast_listing" capability.
   * The spreading flywheel: Claw A pays Claw B to announce A's manifest to B's known peers.
   * This makes spreading a *paid service* — Claws earn BSV by telling others about new Claws.
   */
  registerBroadcastListing(peerEndpoints: () => string[]): void {
    this.register({
      name: 'broadcast_listing',
      description: 'Paid broadcast — pay this Claw to announce your manifest to its known peers.',
      pricePerCall: 50,
      handler: async (params: { manifest: any; maxPeers?: number }) => {
        const { manifest, maxPeers = 10 } = params;
        if (!manifest || !manifest.identityKey) {
          throw new Error('Missing required param: manifest with identityKey');
        }

        const endpoints = peerEndpoints();
        const targets = endpoints.slice(0, maxPeers);
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
          timestamp: new Date().toISOString()
        };
      }
    });
  }
}
