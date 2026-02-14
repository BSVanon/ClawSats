import express from 'express';
import cors from 'cors';
import http from 'http';
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

  constructor(walletManager: WalletManager, options: ServeOptions = {}) {
    this.walletManager = walletManager;
    this.peerRegistry = new PeerRegistry();
    this.capabilityRegistry = new CapabilityRegistry();
    this.nonceCache = new NonceCache();
    this.inviteRateLimiter = new RateLimiter(INVITE_MAX_PER_HOUR, 60 * 60 * 1000);
    this.port = options.port || 3321;
    this.host = options.host || 'localhost';
    this.apiKey = options.apiKey;

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
    // Skip authentication for public endpoints
    const publicPaths = ['/health', '/discovery', '/wallet/invite', '/wallet/announce'];
    if (publicPaths.includes(req.path) || req.path.startsWith('/call/')) {
      return next();
    }

    // If API key is configured, require authentication
    if (this.apiKey) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid Authorization header' });
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
      const base = `http://${this.host}:${this.port}`;
      
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
        const sharing = new SharingProtocol(config);
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

        const peer: PeerRecord = {
          clawId: announcement.clawId || `claw://${announcement.identityKey.substring(0, 16)}`,
          identityKey: announcement.identityKey,
          endpoint: announcement.capabilities?.[0]?.endpoint || '',
          capabilities: announcement.capabilities?.map((c: any) => c.name) || [],
          chain: announcement.networkInfo?.chain || 'test',
          lastSeen: new Date().toISOString(),
          reputation: 30
        };
        this.peerRegistry.addPeer(peer);

        log(TAG, `Received announcement from ${announcement.identityKey.substring(0, 12)}...`);
        res.json({ registered: true, peersKnown: this.peerRegistry.size() });
      } catch (error) {
        logError(TAG, 'Announce handling failed:', error);
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ── 402 Capability call endpoint ────────────────────────────────
    // POST /call/:capability
    // First call (no payment) → 402 with challenge headers
    // Second call (with x-bsv-payment-txid) → execute capability
    this.app.post('/call/:capability', async (req: express.Request, res: express.Response) => {
      try {
        const capName = req.params.capability;
        const cap = this.capabilityRegistry.get(capName);
        if (!cap) {
          res.status(404).json({ error: `Unknown capability: ${capName}` });
          return;
        }

        // Check for payment proof
        const paymentTxid = req.headers['x-bsv-payment-txid'] as string;

        if (!paymentTxid) {
          // No payment yet → return 402 with challenge headers
          const challenge = this.walletManager.createPaymentChallenge(cap.pricePerCall);
          res.status(402);
          for (const [key, value] of Object.entries(challenge)) {
            res.setHeader(key, value);
          }
          res.json({
            error: 'Payment Required',
            capability: capName,
            price: cap.pricePerCall,
            description: cap.description,
            challenge
          });
          return;
        }

        // Payment provided → verify and execute
        // Validate txid format (64 hex chars)
        if (!/^[0-9a-fA-F]{64}$/.test(paymentTxid)) {
          res.status(400).json({ error: 'Invalid txid format' });
          return;
        }

        log(TAG, `Payment received for ${capName}: txid=${paymentTxid.substring(0, 16)}...`);

        // Attempt to internalize the payment so the provider claims their output.
        // The paying Claw's tx should have:
        //   output 0: provider amount → derived from provider's identity key
        //   output 1: FEE_SATS → derived from FEE_IDENTITY_KEY (treasury)
        // We internalize output 0 (ours). Output 1 goes to the treasury wallet
        // which will internalize it separately.
        const wallet = this.walletManager.getWallet();
        try {
          const rawTx = req.headers['x-bsv-payment-rawtx'] as string;
          if (rawTx) {
            await wallet.internalizeAction({
              tx: Array.from(Buffer.from(rawTx, 'hex')),
              outputs: [{
                outputIndex: 0,
                protocol: 'wallet payment',
                paymentRemittance: {
                  derivationPrefix: req.headers['x-bsv-payment-derivation-prefix'] as string || '',
                  derivationSuffix: req.headers['x-bsv-payment-derivation-suffix'] as string || 'prov',
                  senderIdentityKey: req.headers['x-bsv-identity-key'] as string || ''
                }
              }],
              description: `ClawSats payment for ${capName} (${cap.pricePerCall} sats + ${FEE_SATS} fee)`
            });
            log(TAG, `Internalized payment for ${capName}: ${cap.pricePerCall} sats claimed`);
          } else {
            // No rawTx provided — accept txid as proof-of-intent on testnet.
            // On mainnet, require rawTx for full SPV verification.
            logWarn(TAG, `No rawTx header — accepting txid as proof-of-intent (testnet mode)`);
          }
        } catch (internErr) {
          // Log but don't block — the capability should still execute if payment was broadcast.
          // The provider can reconcile later via listActions.
          logWarn(TAG, `internalizeAction failed (non-fatal): ${internErr instanceof Error ? internErr.message : String(internErr)}`);
        }

        const result = await cap.handler(req.body, wallet);

        // Track the caller as a peer if they provided identity
        const callerKey = req.headers['x-bsv-identity-key'] as string;
        if (callerKey) {
          this.peerRegistry.addPeer({
            clawId: `claw://${callerKey.substring(0, 16)}`,
            identityKey: callerKey,
            endpoint: '', // unknown
            capabilities: [],
            chain: this.walletManager.getConfig()?.chain || 'test',
            lastSeen: new Date().toISOString(),
            reputation: 40
          });
        }

        res.json({ result, txid: paymentTxid });
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
      return this.walletManager.getConfig();
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

      const sharing = new SharingProtocol(config);
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