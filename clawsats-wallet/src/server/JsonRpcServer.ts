import express from 'express';
import cors from 'cors';
import http from 'http';
import { randomBytes } from 'crypto';
import { JSONRPCServer } from 'json-rpc-2.0';
import { WalletManager } from '../core/WalletManager';
import { PeerRegistry } from '../core/PeerRegistry';
import { CapabilityRegistry } from '../core/CapabilityRegistry';
import { NonceCache } from '../core/NonceCache';
import { RateLimiter } from '../core/RateLimiter';
import { SharingProtocol } from '../protocol';
import { INVITE_MAX_PER_HOUR, FEE_SATS, FEE_IDENTITY_KEY } from '../protocol/constants';
import { ServeOptions, Invitation, PeerRecord } from '../types';
import { log, logWarn, logError } from '../utils';

const TAG = 'server';

export class JsonRpcServer {
  private app = express();
  private rpcServer: JSONRPCServer;
  private httpServer: http.Server | null = null;
  private walletManager: WalletManager;
  private peerRegistry: PeerRegistry;
  private capabilityRegistry: CapabilityRegistry;
  private nonceCache: NonceCache;
  private inviteRateLimiter: RateLimiter;
  private port: number;
  private host: string;
  private apiKey?: string;
  private publicEndpoint: string;

  constructor(walletManager: WalletManager, options: ServeOptions = {}) {
    this.walletManager = walletManager;
    this.peerRegistry = new PeerRegistry();
    this.peerRegistry.enablePersistence(require('path').join(process.cwd(), 'data'));
    this.capabilityRegistry = new CapabilityRegistry();
    this.nonceCache = new NonceCache();
    this.inviteRateLimiter = new RateLimiter(INVITE_MAX_PER_HOUR, 60 * 60 * 1000);
    this.port = options.port || 3321;
    this.host = options.host || 'localhost';
    this.publicEndpoint = options.publicEndpoint || '';

    // SECURITY: If binding to a public interface, REQUIRE an API key.
    // If none provided, auto-generate one and print it once.
    const isPublic = this.host !== 'localhost' && this.host !== '127.0.0.1';
    if (options.apiKey) {
      this.apiKey = options.apiKey;
    } else if (isPublic) {
      this.apiKey = randomBytes(24).toString('base64url');
      log(TAG, `\n⚠️  PUBLIC BIND DETECTED (${this.host}) — auto-generated API key:`);
      log(TAG, `   ${this.apiKey}`);
      log(TAG, `   Use this key in the Authorization header for admin JSON-RPC calls.`);
      log(TAG, `   Or pass --api-key <key> to set your own.\n`);
    }

    // Create JSON-RPC server
    this.rpcServer = new JSONRPCServer();

    // Register built-in paid capabilities
    this.registerBuiltinCapabilities();

    // Configure middleware
    this.configureMiddleware(options.cors !== false);
    
    // Register methods
    this.registerMethods();

    // Setup routes
    this.setupRoutes();
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = this.app.listen(this.port, this.host, () => {
        const base = `http://${this.host}:${this.port}`;
        log(TAG, `ClawSats Wallet running on ${base}`);
        log(TAG, `  Health:    ${base}/health`);
        log(TAG, `  Discovery: ${base}/discovery`);
        log(TAG, `  Invite:    POST ${base}/wallet/invite`);
        log(TAG, `  Announce:  POST ${base}/wallet/announce`);
        log(TAG, `  Call:      POST ${base}/call/:capability (402 flow)`);
        log(TAG, `  Capabilities: ${this.capabilityRegistry.listNames().join(', ')}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      console.log('[server] Shutting down...');
      this.httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
      this.httpServer = null;
    });
  }

  private configureMiddleware(enableCors: boolean): void {
    if (enableCors) {
      this.app.use(cors());
    }

    this.app.use(express.json());
    this.app.use(this.authMiddleware.bind(this));
  }

  private authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
    // Public endpoints — never require auth
    const publicPaths = ['/health', '/discovery', '/wallet/invite', '/wallet/announce'];
    if (publicPaths.includes(req.path) || req.path.startsWith('/call/')) {
      return next();
    }

    // Admin endpoints (JSON-RPC /) — ALWAYS require auth when API key is set.
    // Since we auto-generate a key on public bind, this means JSON-RPC is
    // always protected when the server is publicly reachable.
    if (this.apiKey) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Authentication required. Use Authorization: Bearer <api-key>' });
        return;
      }

      const token = authHeader.substring(7);
      if (token !== this.apiKey) {
        res.status(403).json({ error: 'Invalid API key' });
        return;
      }
    }

    next();
  }

  private setupRoutes(): void {
    // JSON-RPC endpoint
    this.app.post('/', async (req: express.Request, res: express.Response) => {
      try {
        const jsonRPCRequest = req.body;
        const jsonRPCResponse = await this.rpcServer.receive(jsonRPCRequest);
        
        if (jsonRPCResponse) {
          res.json(jsonRPCResponse);
        } else {
          // Notification request (no response expected)
          res.status(204).end();
        }
      } catch (error) {
        console.error('JSON-RPC error:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
            data: errorMessage
          },
          id: req.body.id || null
        });
      }
    });

    // Health endpoint
    this.app.get('/health', async (req: express.Request, res: express.Response) => {
      try {
        const wallet = await this.walletManager.getWallet();
        const config = this.walletManager.getConfig();

        res.json({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          wallet: {
            identityKey: config?.identityKey?.substring(0, 16) + '...',
            chain: config?.chain,
            capabilities: config?.capabilities?.length || 0
          },
          server: {
            host: this.host,
            port: this.port,
            uptime: process.uptime()
          }
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        res.status(503).json({
          status: 'unhealthy',
          error: errorMessage,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Discovery endpoint
    this.app.get('/discovery', (req: express.Request, res: express.Response) => {
      const config = this.walletManager.getConfig();
      // Use publicEndpoint if set, otherwise derive from host:port.
      // Never advertise 0.0.0.0 — it's unusable by peers.
      const base = this.publicEndpoint
        || (this.host === '0.0.0.0' ? `http://localhost:${this.port}` : `http://${this.host}:${this.port}`);
      
      res.json({
        protocol: 'clawsats-wallet/v1',
        clawId: `claw://${config?.identityKey?.substring(0, 16)}`,
        identityKey: config?.identityKey,
        capabilities: config?.capabilities || [],
        paidCapabilities: this.capabilityRegistry.list().map(c => ({
          name: c.name,
          description: c.description,
          pricePerCall: c.pricePerCall
        })),
        endpoints: {
          jsonrpc: base,
          health: `${base}/health`,
          discovery: `${base}/discovery`,
          invite: `${base}/wallet/invite`,
          announce: `${base}/wallet/announce`,
          call: `${base}/call/:capability`
        },
        knownPeers: this.peerRegistry.size(),
        network: config?.chain,
        timestamp: new Date().toISOString()
      });
    });

    // ── Invitation endpoint ─────────────────────────────────────────
    // Accepts an invitation from another Claw, validates it,
    // registers the sender as a peer, and responds with our announcement.
    this.app.post('/wallet/invite', async (req: express.Request, res: express.Response) => {
      try {
        const invitation: Invitation = req.body;
        const config = this.walletManager.getConfig();
        if (!config) {
          res.status(503).json({ error: 'Wallet not initialized' });
          return;
        }

        // Rate limit by sender identity key
        const senderKey = invitation.sender?.identityKey || 'unknown';
        if (!this.inviteRateLimiter.allow(senderKey)) {
          res.status(429).json({ error: 'Rate limited: too many invitations' });
          return;
        }

        // Validate invitation structure
        const wallet = this.walletManager.getWallet();
        const sharing = new SharingProtocol(config, wallet);
        const validation = sharing.validateInvitation(invitation);
        if (!validation.valid) {
          res.status(400).json({ error: `Invalid invitation: ${validation.reason}` });
          return;
        }

        // Nonce replay protection
        if (invitation.nonce && !this.nonceCache.check(invitation.nonce)) {
          res.status(400).json({ error: 'Nonce replay detected' });
          return;
        }

        // Cryptographic signature verification on invitation
        if (invitation.signature) {
          try {
            const { signature, ...rest } = invitation as any;
            const payload = JSON.stringify(rest);
            const result = await wallet.verifySignature({
              data: Array.from(Buffer.from(payload, 'utf8')),
              signature: Array.from(Buffer.from(signature, 'base64')),
              protocolID: [0, 'clawsats-sharing'],
              keyID: 'sharing-v1',
              counterparty: invitation.sender.identityKey
            });
            if (!result.valid) {
              logWarn(TAG, `Invitation signature invalid from ${senderKey.substring(0, 12)}...`);
            }
          } catch {
            logWarn(TAG, `Invitation signature verification error from ${senderKey.substring(0, 12)}...`);
          }
        }

        // Register sender as a known peer
        const peer: PeerRecord = {
          clawId: invitation.sender.clawId,
          identityKey: invitation.sender.identityKey,
          endpoint: invitation.sender.endpoint,
          capabilities: invitation.walletConfig.capabilities,
          chain: invitation.walletConfig.chain,
          lastSeen: new Date().toISOString(),
          reputation: 50
        };
        this.peerRegistry.addPeer(peer);

        // Respond with our capability announcement
        const announcement = await sharing.createAnnouncement();
        log(TAG, `Accepted invitation from ${invitation.sender.identityKey.substring(0, 12)}...`);

        res.json({
          accepted: true,
          announcement,
          peersKnown: this.peerRegistry.size()
        });
      } catch (error) {
        logError(TAG, 'Invitation handling failed:', error);
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ── Announce endpoint ───────────────────────────────────────────
    // Receives a capability announcement (from broadcast_listing or direct)
    // and registers the sender as a peer.
    this.app.post('/wallet/announce', async (req: express.Request, res: express.Response) => {
      try {
        const announcement = req.body;
        if (!announcement?.identityKey) {
          res.status(400).json({ error: 'Missing identityKey in announcement' });
          return;
        }

        // Validate identity key format (33-byte compressed pubkey = 66 hex chars)
        if (!/^[0-9a-fA-F]{66}$/.test(announcement.identityKey)) {
          res.status(400).json({ error: 'Invalid identityKey format (expected 66 hex chars)' });
          return;
        }

        // Signature verification: if signature is present, verify it
        let verified = false;
        if (announcement.signature && announcement.signature !== '') {
          try {
            const wallet = this.walletManager.getWallet();
            const { signature, ...rest } = announcement;
            const payload = JSON.stringify(rest);
            const result = await wallet.verifySignature({
              data: Array.from(Buffer.from(payload, 'utf8')),
              signature: Array.from(Buffer.from(signature, 'base64')),
              protocolID: [0, 'clawsats-sharing'],
              keyID: 'sharing-v1',
              counterparty: announcement.identityKey
            });
            verified = result.valid === true;
            if (!verified) {
              logWarn(TAG, `Announcement signature invalid from ${announcement.identityKey.substring(0, 12)}...`);
            }
          } catch {
            logWarn(TAG, `Announcement signature verification error from ${announcement.identityKey.substring(0, 12)}...`);
          }
        }

        const peer: PeerRecord = {
          clawId: announcement.clawId || `claw://${announcement.identityKey.substring(0, 16)}`,
          identityKey: announcement.identityKey,
          endpoint: announcement.capabilities?.[0]?.endpoint || '',
          capabilities: announcement.capabilities?.map((c: any) => c.name) || [],
          chain: announcement.networkInfo?.chain || 'test',
          lastSeen: new Date().toISOString(),
          reputation: verified ? 40 : 15
        };
        this.peerRegistry.addPeer(peer);

        log(TAG, `Received announcement from ${announcement.identityKey.substring(0, 12)}... (verified=${verified})`);
        res.json({ registered: true, verified, peersKnown: this.peerRegistry.size() });
      } catch (error) {
        logError(TAG, 'Announce handling failed:', error);
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ── 402 Capability call endpoint (BRC-105 compliant) ───────────
    // POST /call/:capability
    // First call (no x-bsv-payment header) → 402 with challenge headers
    // Second call (with x-bsv-payment JSON header) → auto-accept via internalizeAction, execute capability
    //
    // Payment tx structure (built by paying Claw):
    //   output 0: provider amount → BRC-29 derived from provider's identity key
    //   output 1: FEE_SATS (2 sat) → BRC-29 derived from FEE_IDENTITY_KEY (treasury)
    //
    // The provider Claw auto-accepts output 0 via internalizeAction().
    // The treasury wallet auto-accepts output 1 separately.
    this.app.post('/call/:capability', async (req: express.Request, res: express.Response) => {
      try {
        const capName = req.params.capability;
        const cap = this.capabilityRegistry.get(capName);
        if (!cap) {
          res.status(404).json({ error: `Unknown capability: ${capName}` });
          return;
        }

        // Check for BRC-105 payment header
        const bsvPaymentHeader = req.headers['x-bsv-payment'] as string;

        if (!bsvPaymentHeader) {
          // No payment yet → return 402 with challenge headers (BRC-105 §5.2)
          const challenge = this.walletManager.createPaymentChallenge(cap.pricePerCall);
          const providerKey = this.walletManager.getConfig()?.identityKey || '';
          res.status(402);
          // Set the provider's identity key so the payer knows who to derive the output for.
          // Without this, the client can't build a correct BRC-29 payment output.
          res.setHeader('x-bsv-identity-key', providerKey);
          for (const [key, value] of Object.entries(challenge)) {
            res.setHeader(key, value);
          }
          res.json({
            status: 'error',
            code: 'ERR_PAYMENT_REQUIRED',
            capability: capName,
            satoshisRequired: cap.pricePerCall,
            description: cap.description,
            challenge
          });
          return;
        }

        // Parse the x-bsv-payment JSON header (BRC-105 §6.3)
        // Format: { derivationPrefix, derivationSuffix, transaction }
        // transaction is AtomicBEEF encoded as base64
        let paymentData: { derivationPrefix: string; derivationSuffix: string; transaction: string };
        try {
          paymentData = JSON.parse(bsvPaymentHeader);
        } catch {
          res.status(400).json({
            status: 'error',
            code: 'ERR_MALFORMED_PAYMENT',
            description: 'The x-bsv-payment header is not valid JSON.'
          });
          return;
        }

        if (!paymentData.derivationPrefix || !paymentData.transaction) {
          res.status(400).json({
            status: 'error',
            code: 'ERR_MALFORMED_PAYMENT',
            description: 'x-bsv-payment must include derivationPrefix and transaction.'
          });
          return;
        }

        const senderIdentityKey = req.headers['x-bsv-identity-key'] as string || '';
        log(TAG, `Payment received for ${capName} from ${senderIdentityKey.substring(0, 16) || 'unknown'}...`);

        // STRICT PAYMENT GATE: internalize output 0 (provider's payment) via BRC-105 §6.4.
        // If internalizeAction fails, the payment is invalid — DO NOT execute the capability.
        // This prevents attackers from sending garbage payments and getting free work.
        const wallet = this.walletManager.getWallet();
        const txBytes = Array.from(Buffer.from(paymentData.transaction, 'base64'));
        try {
          await wallet.internalizeAction({
            tx: txBytes,
            outputs: [{
              outputIndex: 0,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: paymentData.derivationPrefix,
                derivationSuffix: paymentData.derivationSuffix || 'clawsats',
                senderIdentityKey
              }
            }],
            description: `ClawSats payment for ${capName} (${cap.pricePerCall} sats + ${FEE_SATS} sat fee)`
          });
          log(TAG, `Auto-accepted payment for ${capName}: ${cap.pricePerCall} sats claimed`);
        } catch (internErr) {
          // Payment verification FAILED — reject the request.
          const errMsg = internErr instanceof Error ? internErr.message : String(internErr);
          logWarn(TAG, `Payment rejected for ${capName}: ${errMsg}`);
          res.status(402).json({
            status: 'error',
            code: 'ERR_PAYMENT_INVALID',
            description: `Payment could not be verified: ${errMsg}. Send a valid BRC-105 payment.`
          });
          return;
        }

        const result = await cap.handler(req.body, wallet);

        // Track the caller as a peer if they provided identity
        if (senderIdentityKey) {
          this.peerRegistry.addPeer({
            clawId: `claw://${senderIdentityKey.substring(0, 16)}`,
            identityKey: senderIdentityKey,
            endpoint: '', // unknown
            capabilities: [],
            chain: this.walletManager.getConfig()?.chain || 'test',
            lastSeen: new Date().toISOString(),
            reputation: 40
          });
        }

        res.set({ 'x-bsv-payment-satoshis-paid': String(cap.pricePerCall) });
        res.json({ result, satoshisPaid: cap.pricePerCall });
      } catch (error) {
        logError(TAG, 'Capability call failed:', error);
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });
  }

  private registerMethods(): void {
    // Helper: callers may send { args: {...}, originator } or flat params.
    // Accept both for human and AI ergonomics.
    const unwrap = (params: any): { args: any; originator?: string } => {
      if (params && typeof params === 'object' && 'args' in params) {
        return { args: params.args, originator: params.originator };
      }
      return { args: params };
    };

    // BRC-100 wallet methods
    this.rpcServer.addMethod('createAction', async (params: any) => {
      const { args, originator } = unwrap(params);
      const wallet = this.walletManager.getWallet();
      return wallet.createAction(args, originator);
    });

    this.rpcServer.addMethod('internalizeAction', async (params: any) => {
      const { args, originator } = unwrap(params);
      const wallet = this.walletManager.getWallet();
      return wallet.internalizeAction(args, originator);
    });

    this.rpcServer.addMethod('listOutputs', async (params: any) => {
      const { args, originator } = unwrap(params);
      const wallet = this.walletManager.getWallet();
      return wallet.listOutputs(args, originator);
    });

    this.rpcServer.addMethod('listActions', async (params: any) => {
      const { args, originator } = unwrap(params);
      const wallet = this.walletManager.getWallet();
      return wallet.listActions(args, originator);
    });

    this.rpcServer.addMethod('getPublicKey', async (params: any) => {
      const { args, originator } = unwrap(params);
      const wallet = this.walletManager.getWallet();
      return wallet.getPublicKey(args, originator);
    });

    this.rpcServer.addMethod('createSignature', async (params: any) => {
      const { args, originator } = unwrap(params);
      const wallet = this.walletManager.getWallet();
      return wallet.createSignature(args, originator);
    });

    this.rpcServer.addMethod('verifySignature', async (params: any) => {
      const { args, originator } = unwrap(params);
      const wallet = this.walletManager.getWallet();
      return wallet.verifySignature(args, originator);
    });

    // ClawSats-specific methods
    this.rpcServer.addMethod('createPaymentChallenge', async (params: any) => {
      const { providerAmount, derivationPrefix } = params;
      return this.walletManager.createPaymentChallenge(providerAmount, derivationPrefix);
    });

    this.rpcServer.addMethod('verifyPayment', async (params: any) => {
      const { txid, expectedOutputs } = params;
      return this.walletManager.verifyPayment(txid, expectedOutputs);
    });

    this.rpcServer.addMethod('getConfig', async () => {
      // SECURITY: Never expose rootKeyHex over any endpoint.
      const config = this.walletManager.getConfig();
      if (!config) return null;
      const { rootKeyHex, ...safeConfig } = config;
      return safeConfig;
    });

    // Utility methods
    this.rpcServer.addMethod('ping', async () => {
      return { status: 'pong', timestamp: new Date().toISOString() };
    });

    this.rpcServer.addMethod('getCapabilities', async () => {
      const config = this.walletManager.getConfig();
      return {
        brc100: config?.capabilities || [],
        clawsats: ['createPaymentChallenge', 'verifyPayment', 'getConfig'],
        paid: this.capabilityRegistry.list().map(c => ({
          name: c.name,
          description: c.description,
          pricePerCall: c.pricePerCall
        }))
      };
    });

    // Peer management methods
    this.rpcServer.addMethod('listPeers', async () => {
      return {
        peers: this.peerRegistry.getAllPeers(),
        total: this.peerRegistry.size()
      };
    });

    this.rpcServer.addMethod('sendInvitation', async (params: any) => {
      const { endpoint } = params;
      if (!endpoint) throw new Error('Missing required param: endpoint');

      const config = this.walletManager.getConfig();
      if (!config) throw new Error('Wallet not initialized');

      const wallet = this.walletManager.getWallet();
      const sharing = new SharingProtocol(config, wallet);
      const invitation = await sharing.createInvitation(`claw://${endpoint}`, {
        recipientEndpoint: endpoint
      });

      const res = await fetch(`${endpoint}/wallet/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invitation),
        signal: AbortSignal.timeout(10000)
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Invitation rejected (${res.status}): ${body}`);
      }

      const response: any = await res.json();

      // If they responded with an announcement, register them as a peer
      if (response.announcement?.identityKey) {
        this.peerRegistry.addPeer({
          clawId: response.announcement.clawId || '',
          identityKey: response.announcement.identityKey,
          endpoint,
          capabilities: response.announcement.capabilities?.map((c: any) => c.name) || [],
          chain: config.chain,
          lastSeen: new Date().toISOString(),
          reputation: 50
        });
      }

      log(TAG, `Invitation sent to ${endpoint} — accepted: ${response.accepted}`);
      return { accepted: response.accepted, peersKnown: this.peerRegistry.size() };
    });
  }

  private registerBuiltinCapabilities(): void {
    const config = this.walletManager.getConfig();
    const identityKey = config?.identityKey || 'unknown';

    // Deferred wallet proxy — wallet may not be ready at constructor time
    const walletProxy = {
      createSignature: async (...args: any[]) => this.walletManager.getWallet().createSignature(...args)
    };

    // Echo: trivial paid service proving the 402 flow
    this.capabilityRegistry.registerEcho(walletProxy, identityKey);

    // Verifiable capabilities (BrowserAI #2)
    this.capabilityRegistry.registerSignMessage(walletProxy, identityKey);
    this.capabilityRegistry.registerHashCommit(walletProxy, identityKey);
    this.capabilityRegistry.registerTimestampAttest(walletProxy, identityKey);

    // Broadcast listing: the spreading flywheel (with anti-abuse per BrowserAI #3)
    this.capabilityRegistry.registerBroadcastListing(
      () => this.peerRegistry.getAllPeers().map(p => p.endpoint).filter(Boolean)
    );
  }

  getApp(): express.Application {
    return this.app;
  }

  getPeerRegistry(): PeerRegistry {
    return this.peerRegistry;
  }

  getCapabilityRegistry(): CapabilityRegistry {
    return this.capabilityRegistry;
  }

  getServerInfo(): { host: string; port: number; apiKey: boolean } {
    return {
      host: this.host,
      port: this.port,
      apiKey: !!this.apiKey
    };
  }
}