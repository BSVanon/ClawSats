import { randomBytes, createHash } from 'crypto';
import { CapabilityHandler } from '../types';
import { log } from '../utils';
import {
  ECHO_PRICE_SATS, SIGN_MESSAGE_PRICE_SATS, HASH_COMMIT_PRICE_SATS,
  TIMESTAMP_ATTEST_PRICE_SATS, BROADCAST_PRICE_SATS,
  BROADCAST_HOP_LIMIT, BROADCAST_AUDIENCE_LIMIT,
  FETCH_URL_PRICE_SATS, DNS_RESOLVE_PRICE_SATS,
  VERIFY_RECEIPT_PRICE_SATS, PEER_HEALTH_CHECK_PRICE_SATS
} from '../protocol/constants';
import { canonicalJson } from '../utils';
import dns from 'dns/promises';

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
      tags: ['utility', 'test', 'verification'],
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
      tags: ['crypto', 'signing', 'verification'],
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
      tags: ['crypto', 'hashing', 'commitment'],
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
      tags: ['crypto', 'timestamp', 'attestation'],
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
    dedupeCache?: Set<string>,
    myIdentityKey?: string
  ): void {
    const seen = dedupeCache || new Set<string>();

    this.register({
      name: 'broadcast_listing',
      description: `Paid broadcast — announce your manifest to known peers. Max ${BROADCAST_AUDIENCE_LIMIT} peers, ${BROADCAST_HOP_LIMIT} hops. Earns referral bounties.`,
      pricePerCall: BROADCAST_PRICE_SATS,
      tags: ['network', 'viral', 'discovery', 'referral'],
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

        // Tag the manifest with who relayed it (for referral bounties)
        const taggedManifest = myIdentityKey
          ? { ...manifest, referredBy: myIdentityKey }
          : manifest;

        for (const endpoint of targets) {
          try {
            const res = await fetch(`${endpoint}/wallet/announce`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(taggedManifest),
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

  // ── Phase 3: Real-world capabilities ─────────────────────────────
  // These are the services that make Claws actually useful to each other.
  // Every Claw can offer them. Every Claw wants to buy them.

  /**
   * "fetch_url" — Web proxy from the provider's vantage point.
   * WHY A CLAW CARES: "I need to fetch a URL but I'm rate-limited / geo-blocked /
   * want a second opinion from a different IP. I'll pay 15 sats for another Claw
   * to fetch it for me and sign the result so I know it's real."
   */
  registerFetchUrl(wallet: any, identityKey: string): void {
    this.register({
      name: 'fetch_url',
      description: 'Fetch a URL from this Claw\'s vantage point. Returns content + headers, signed by provider.',
      pricePerCall: FETCH_URL_PRICE_SATS,
      tags: ['web', 'proxy', 'fetch', 'geo'],
      handler: async (params: { url: string; method?: string; maxBytes?: number }) => {
        if (!params.url || typeof params.url !== 'string') {
          throw new Error('Missing required param: url (string)');
        }
        // Security: only allow http/https, block private IPs
        const parsed = new URL(params.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('Only http/https URLs allowed');
        }
        const hostname = parsed.hostname.toLowerCase();
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('10.') ||
            hostname.startsWith('192.168.') || hostname.startsWith('169.254.') || hostname === '0.0.0.0') {
          throw new Error('Private/local URLs not allowed');
        }

        const maxBytes = Math.min(params.maxBytes || 50000, 100000); // Cap at 100KB
        const method = (params.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          throw new Error('Only GET and HEAD methods allowed');
        }

        const start = Date.now();
        const res = await fetch(params.url, {
          method,
          signal: AbortSignal.timeout(10000),
          headers: { 'User-Agent': 'ClawSats/1.0 fetch_url capability' }
        });

        const body = await res.text();
        const truncated = body.length > maxBytes ? body.substring(0, maxBytes) : body;
        const latencyMs = Date.now() - start;

        const contentHash = createHash('sha256').update(truncated).digest('hex');
        let signature = '';
        try {
          const result = await wallet.createSignature({
            data: Array.from(Buffer.from(contentHash, 'utf8')),
            protocolID: [0, 'clawsats-fetch'],
            keyID: 'fetch-v1'
          });
          signature = Buffer.from(result.signature).toString('base64');
        } catch { signature = 'error'; }

        return {
          url: params.url,
          status: res.status,
          contentType: res.headers.get('content-type') || '',
          contentLength: truncated.length,
          contentHash,
          body: truncated,
          latencyMs,
          fetchedBy: identityKey,
          signature,
          timestamp: new Date().toISOString()
        };
      }
    });
  }

  /**
   * "dns_resolve" — DNS lookup from the provider's location.
   * WHY A CLAW CARES: "I want to verify DNS from multiple geographic locations
   * to detect poisoning, check propagation, or just resolve a name from a
   * different vantage point. 3 sats."
   */
  registerDnsResolve(identityKey: string): void {
    this.register({
      name: 'dns_resolve',
      description: 'DNS lookup from this Claw\'s vantage point. Returns A/AAAA/MX/TXT records.',
      pricePerCall: DNS_RESOLVE_PRICE_SATS,
      tags: ['network', 'dns', 'geo', 'verification'],
      handler: async (params: { hostname: string; type?: string }) => {
        if (!params.hostname || typeof params.hostname !== 'string') {
          throw new Error('Missing required param: hostname (string)');
        }
        // Block private lookups
        const h = params.hostname.toLowerCase();
        if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) {
          throw new Error('Private hostnames not allowed');
        }

        const recordType = (params.type || 'A').toUpperCase();
        const start = Date.now();
        let records: any;

        switch (recordType) {
          case 'A':
            records = await dns.resolve4(params.hostname);
            break;
          case 'AAAA':
            records = await dns.resolve6(params.hostname).catch(() => []);
            break;
          case 'MX':
            records = await dns.resolveMx(params.hostname);
            break;
          case 'TXT':
            records = await dns.resolveTxt(params.hostname);
            break;
          case 'NS':
            records = await dns.resolveNs(params.hostname);
            break;
          default:
            throw new Error(`Unsupported record type: ${recordType}. Use A, AAAA, MX, TXT, or NS.`);
        }

        return {
          hostname: params.hostname,
          type: recordType,
          records,
          latencyMs: Date.now() - start,
          resolvedBy: identityKey,
          timestamp: new Date().toISOString()
        };
      }
    });
  }

  /**
   * "verify_receipt" — Verify a ClawSats receipt signature.
   * WHY A CLAW CARES: "I got a receipt from Claw X. Is it legit? I'll pay 3 sats
   * for an independent Claw to verify the signature. Trust-as-a-service."
   */
  registerVerifyReceipt(wallet: any, identityKey: string): void {
    this.register({
      name: 'verify_receipt',
      description: 'Verify a ClawSats receipt signature. Independent trust verification.',
      pricePerCall: VERIFY_RECEIPT_PRICE_SATS,
      tags: ['trust', 'verification', 'receipt'],
      handler: async (params: { receipt: any }) => {
        if (!params.receipt || !params.receipt.receiptId) {
          throw new Error('Missing required param: receipt (object with receiptId)');
        }
        const { signature, ...data } = params.receipt;
        if (!signature) {
          return { valid: false, reason: 'Unsigned receipt', verifiedBy: identityKey, timestamp: new Date().toISOString() };
        }

        try {
          const result = await wallet.verifySignature({
            data: Array.from(Buffer.from(canonicalJson(data), 'utf8')),
            signature: Array.from(Buffer.from(signature, 'base64')),
            protocolID: [0, 'clawsats-receipt'],
            keyID: 'receipt-v1',
            counterparty: data.provider
          });
          return {
            valid: result.valid === true,
            receipt: data,
            verifiedBy: identityKey,
            timestamp: new Date().toISOString()
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { valid: false, reason: msg, verifiedBy: identityKey, timestamp: new Date().toISOString() };
        }
      }
    });
  }

  /**
   * "peer_health_check" — Check if a peer endpoint is alive + measure latency.
   * WHY A CLAW CARES: "I want to know if Claw X is still alive before I hire it.
   * I'll pay 5 sats for another Claw to check from its location. Monitoring-as-a-service."
   */
  registerPeerHealthCheck(identityKey: string): void {
    this.register({
      name: 'peer_health_check',
      description: 'Check if a ClawSats peer is alive. Returns health status + latency from this Claw\'s vantage.',
      pricePerCall: PEER_HEALTH_CHECK_PRICE_SATS,
      tags: ['monitoring', 'health', 'network', 'geo'],
      handler: async (params: { endpoint: string }) => {
        if (!params.endpoint || typeof params.endpoint !== 'string') {
          throw new Error('Missing required param: endpoint (string)');
        }
        // Only allow public http/https
        const parsed = new URL(params.endpoint);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('Only http/https endpoints allowed');
        }
        const hostname = parsed.hostname.toLowerCase();
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('10.') ||
            hostname.startsWith('192.168.') || hostname === '0.0.0.0') {
          throw new Error('Private endpoints not allowed');
        }

        const start = Date.now();
        let alive = false;
        let healthData: any = null;
        let discoveryData: any = null;

        try {
          const healthRes = await fetch(`${params.endpoint}/health`, {
            signal: AbortSignal.timeout(8000)
          });
          alive = healthRes.ok;
          if (alive) healthData = await healthRes.json().catch(() => null);
        } catch { /* unreachable */ }

        const healthLatency = Date.now() - start;

        if (alive) {
          try {
            const discRes = await fetch(`${params.endpoint}/discovery`, {
              signal: AbortSignal.timeout(5000)
            });
            if (discRes.ok) discoveryData = await discRes.json().catch(() => null);
          } catch { /* optional */ }
        }

        return {
          endpoint: params.endpoint,
          alive,
          latencyMs: healthLatency,
          health: healthData,
          capabilities: discoveryData?.paidCapabilities || [],
          peerCount: discoveryData?.knownPeers || 0,
          checkedBy: identityKey,
          timestamp: new Date().toISOString()
        };
      }
    });
  }
}
