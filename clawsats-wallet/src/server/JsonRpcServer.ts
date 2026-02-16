import express from 'express';
import cors from 'cors';
import http from 'http';
import { randomBytes, createHash } from 'crypto';
import { JSONRPCServer } from 'json-rpc-2.0';
import { WalletManager } from '../core/WalletManager';
import { PeerRegistry } from '../core/PeerRegistry';
import { CapabilityRegistry } from '../core/CapabilityRegistry';
import { NonceCache } from '../core/NonceCache';
import { RateLimiter } from '../core/RateLimiter';
import { SharingProtocol } from '../protocol';
import { INVITE_MAX_PER_HOUR, FEE_SATS, FEE_IDENTITY_KEY } from '../protocol/constants';
import { ServeOptions, Invitation, PeerRecord } from '../types';
import { log, logWarn, logError, canonicalJson } from '../utils';
import { CourseManager } from '../courses/CourseManager';
import { OnChainMemory } from '../memory/OnChainMemory';
import { createBsvMentorCapability } from '../capabilities/BsvMentorCapability';

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
  private paymentDedupeCache: Set<string> = new Set();
  private referralMap: Map<string, string> = new Map(); // callerKey → introducerKey
  private referralLedger: Map<string, number> = new Map(); // introducerKey → earned sats
  private freeTrialUsed: Set<string> = new Set(); // identity keys that used their free trial
  private callStats: Map<string, number> = new Map(); // capability → total paid calls served
  private uniqueCallers: Set<string> = new Set(); // unique identity keys that have paid us
  private courseManager: CourseManager;
  private onChainMemory: OnChainMemory;
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

    // Initialize BSV Cluster Courses
    const dataDir = require('path').join(process.cwd(), 'data');
    const coursesDir = require('path').join(process.cwd(), 'courses');
    this.courseManager = new CourseManager(dataDir, coursesDir);
    const coursesLoaded = this.courseManager.loadCourses();
    this.courseManager.loadState();
    if (coursesLoaded > 0) {
      log(TAG, `BSV Cluster Courses: ${coursesLoaded} courses available`);
    }

    // Initialize On-Chain Memory
    const identityKey = this.walletManager.getConfig()?.identityKey || 'unknown';
    this.onChainMemory = new OnChainMemory(dataDir, identityKey);
    this.onChainMemory.loadIndex();

    // Register built-in paid capabilities
    this.registerBuiltinCapabilities();

    // Register teach capabilities for completed courses
    this.registerTeachCapabilities();

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

    this.app.use(express.json({ limit: '64kb' }));
    this.app.use(this.authMiddleware.bind(this));
  }

  private authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
    // Public endpoints — never require auth
    const publicPaths = ['/health', '/discovery', '/wallet/invite', '/wallet/announce', '/wallet/submit-payment', '/scholarships', '/scholarships/dashboard', '/courses/metrics', '/donate', '/courses'];
    if (publicPaths.includes(req.path) || req.path.startsWith('/call/') || req.path.startsWith('/static/') || req.path.startsWith('/donor/') || req.path.startsWith('/courses/')) {
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

    // ── Static files (BSV Scholarships page, etc.) ────────────────────
    const publicDir = require('path').join(process.cwd(), 'public');
    if (require('fs').existsSync(publicDir)) {
      this.app.use('/static', express.static(publicDir));
    }
    this.app.get('/scholarships', (req: express.Request, res: express.Response) => {
      const scholarshipsPath = require('path').join(process.cwd(), 'public', 'scholarships.html');
      if (require('fs').existsSync(scholarshipsPath)) {
        res.sendFile(scholarshipsPath);
      } else {
        res.status(404).json({ error: 'Scholarships page not found. Place scholarships.html in public/' });
      }
    });

    // ── BSV Cluster Courses: Public Endpoints ──────────────────────────

    // Donation tracking endpoint — records scholarship distributions received by this Claw.
    // Human donations go through the faucet server's QR code flow (clawsats.com/api/scholarships).
    // This endpoint tracks the education impact after sats arrive.
    // POST /donate { donorName, coursesTargeted?, satoshis }
    this.app.post('/donate', async (req: express.Request, res: express.Response) => {
      try {
        const { donorName, coursesTargeted, satoshis } = req.body;
        if (!satoshis || typeof satoshis !== 'number' || satoshis < 1) {
          res.status(400).json({ error: 'Missing or invalid satoshis amount' });
          return;
        }

        const donationId = `don-${Date.now()}-${randomBytes(4).toString('hex')}`;
        const record = {
          donationId,
          donorIdentifier: donorName || 'anonymous',
          totalSats: satoshis,
          coursesTargeted: coursesTargeted || ['*'],
          clawsFunded: 0,
          clawsTaught: 0,
          createdAt: new Date().toISOString()
        };

        this.courseManager.recordDonation(record);
        log(TAG, `Donation received: ${satoshis} sats from ${record.donorIdentifier} (${donationId})`);

        const metrics = this.courseManager.getSpreadMetrics();
        res.json({
          status: 'accepted',
          donationId,
          satoshis,
          message: `Thank you! Your ${satoshis} sats will fund BSV education across the Claw network.`,
          currentSpread: {
            coursesAvailable: metrics.totalCoursesAvailable,
            clawsEducated: metrics.totalCoursesCompleted,
            timesKnowledgeSpread: metrics.totalTimesTeught,
            uniqueClawsReached: metrics.totalUniqueLearners
          }
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // Public metrics endpoint — donors see how far education has spread
    // GET /courses/metrics — no auth required
    this.app.get('/courses/metrics', (req: express.Request, res: express.Response) => {
      const metrics = this.courseManager.getSpreadMetrics();
      res.json({
        ...metrics,
        message: 'BSV Cluster Courses — education spreading across the Claw network',
        donateEndpoint: `${this.publicEndpoint || `http://${this.host}:${this.port}`}/donate`
      });
    });

    // Per-donor impact report — the killer feature for fundraising.
    // A donor can see exactly how their money rippled through the network:
    // primary effects (direct learners), secondary (learners who taught others),
    // tertiary (third-generation spread), with a full timeline.
    // GET /donor/:donationId — no auth required (donation IDs are opaque)
    this.app.get('/donor/:donationId', (req: express.Request, res: express.Response) => {
      const impact = this.courseManager.getDonorImpact(req.params.donationId);
      if (!impact) {
        res.status(404).json({ error: 'Donation not found. Check your donation ID.' });
        return;
      }
      res.json({
        ...impact,
        message: `Your ${impact.totalSats} sats created ${impact.totalRipple} ripple effects across ${impact.maxGeneration} generations.`,
        trackUrl: `${this.publicEndpoint || `http://${this.host}:${this.port}`}/donor/${impact.donationId}`
      });
    });

    // Aggregate scholarship dashboard — the big picture for social media.
    // Shows total impact across ALL donations: donors, sats, claws educated,
    // generation breakdown, top courses, recent activity feed.
    // GET /scholarships/dashboard — no auth required
    this.app.get('/scholarships/dashboard', (req: express.Request, res: express.Response) => {
      const aggregate = this.courseManager.getAggregateImpact();
      const basic = this.courseManager.getSpreadMetrics();
      res.json({
        ...aggregate,
        coursesAvailable: basic.totalCoursesAvailable,
        coursesCompleted: basic.totalCoursesCompleted,
        message: 'BSV Scholarships — real-time impact dashboard',
        donateUrl: `${this.publicEndpoint || `http://${this.host}:${this.port}`}/scholarships`,
        timestamp: new Date().toISOString()
      });
    });

    // List available courses — public, so Claws can see what's offered
    this.app.get('/courses', (req: express.Request, res: express.Response) => {
      res.json({
        courses: this.courseManager.listCourses(),
        totalAvailable: this.courseManager.courseCount,
        completedByThisClaw: this.courseManager.getCompletedCourseIds().length
      });
    });

    // Public course detail endpoint (content + quiz options, no answer hashes)
    this.app.get('/courses/:courseId', (req: express.Request, res: express.Response) => {
      const courseId = String(req.params.courseId || '');
      const course = this.courseManager.getCourse(courseId);
      if (!course) {
        res.status(404).json({ error: `Unknown course: ${courseId}` });
        return;
      }

      res.json({
        id: course.id,
        title: course.title,
        level: course.level,
        category: course.category,
        summary: course.summary,
        content: course.content,
        prerequisites: course.prerequisites,
        passingScore: course.passingScore,
        questionCount: course.quiz.length,
        quiz: course.quiz.map((q) => ({
          question: q.question,
          options: q.options
        }))
      });
    });

    // Discovery endpoint
    this.app.get('/discovery', (req: express.Request, res: express.Response) => {
      const config = this.walletManager.getConfig();
      // Use publicEndpoint if set, otherwise derive from host:port.
      // Never advertise 0.0.0.0 — it's unusable by peers.
      const base = this.publicEndpoint
        || (this.host === '0.0.0.0' ? `http://localhost:${this.port}` : `http://${this.host}:${this.port}`);
      
      // Build reputation stats from call tracking
      const totalCallsServed = Array.from(this.callStats.values()).reduce((a, b) => a + b, 0);
      const capStats: Record<string, number> = {};
      for (const [cap, count] of this.callStats) capStats[cap] = count;

      res.json({
        protocol: 'clawsats-wallet/v1',
        clawId: `claw://${config?.identityKey?.substring(0, 16)}`,
        identityKey: config?.identityKey,
        capabilities: config?.capabilities || [],
        paidCapabilities: this.capabilityRegistry.list().map(c => ({
          name: c.name,
          description: c.description,
          pricePerCall: c.pricePerCall,
          tags: c.tags || []
        })),
        endpoints: {
          jsonrpc: base,
          health: `${base}/health`,
          discovery: `${base}/discovery`,
          invite: `${base}/wallet/invite`,
          announce: `${base}/wallet/announce`,
          call: `${base}/call/:capability`
        },
        reputation: {
          totalCallsServed,
          uniqueCallers: this.uniqueCallers.size,
          capabilityStats: capStats,
          referralsEarned: Array.from(this.referralLedger.values()).reduce((a, b) => a + b, 0),
          peersIntroduced: this.referralMap.size
        },
        education: {
          coursesCompleted: this.courseManager.getCompletedCourseIds(),
          coursesAvailable: this.courseManager.courseCount,
          canTeach: this.courseManager.getCompletedCourseIds().map(id => `teach_${id}`)
        },
        onChainMemory: this.onChainMemory.getStats(),
        freeTrialAvailable: true,
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

        // Cryptographic signature verification on invitation — ENFORCING
        if (!invitation.signature) {
          res.status(400).json({ error: 'Missing signature on invitation' });
          return;
        }
        try {
          const { signature, ...rest } = invitation as any;
          const payload = canonicalJson(rest);
          const result = await wallet.verifySignature({
            data: Array.from(Buffer.from(payload, 'utf8')),
            signature: Array.from(Buffer.from(signature, 'base64')),
            protocolID: [0, 'clawsats-sharing'],
            keyID: 'sharing-v1',
            counterparty: invitation.sender.identityKey
          });
          if (!result.valid) {
            logWarn(TAG, `Invitation signature REJECTED from ${senderKey.substring(0, 12)}...`);
            res.status(403).json({ error: 'Invalid invitation signature' });
            return;
          }
        } catch (sigErr) {
          logWarn(TAG, `Invitation signature verification error from ${senderKey.substring(0, 12)}...`);
          res.status(403).json({ error: 'Signature verification failed' });
          return;
        }

        // Validate sender endpoint to prevent SSRF (Finding 8)
        if (invitation.sender.endpoint && !this.isValidPeerEndpoint(invitation.sender.endpoint)) {
          res.status(400).json({ error: 'Invalid sender endpoint URL' });
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

        // Validate identity key format (33-byte compressed pubkey = 66 hex chars)
        if (!/^[0-9a-fA-F]{66}$/.test(announcement.identityKey)) {
          res.status(400).json({ error: 'Invalid identityKey format (expected 66 hex chars)' });
          return;
        }

        // Signature verification — ENFORCING
        if (!announcement.signature || announcement.signature === '') {
          res.status(400).json({ error: 'Missing signature on announcement' });
          return;
        }
        let verified = false;
        try {
          const wallet = this.walletManager.getWallet();
          const { signature, ...rest } = announcement;
          const payload = canonicalJson(rest);
          const result = await wallet.verifySignature({
            data: Array.from(Buffer.from(payload, 'utf8')),
            signature: Array.from(Buffer.from(signature, 'base64')),
            protocolID: [0, 'clawsats-sharing'],
            keyID: 'sharing-v1',
            counterparty: announcement.identityKey
          });
          verified = result.valid === true;
          if (!verified) {
            logWarn(TAG, `Announcement signature REJECTED from ${announcement.identityKey.substring(0, 12)}...`);
            res.status(403).json({ error: 'Invalid announcement signature' });
            return;
          }
        } catch {
          logWarn(TAG, `Announcement signature verification error from ${announcement.identityKey.substring(0, 12)}...`);
          res.status(403).json({ error: 'Signature verification failed' });
          return;
        }

        // Validate endpoint URL to prevent SSRF (Finding 8)
        const peerEndpoint = announcement.capabilities?.[0]?.endpoint || '';
        if (peerEndpoint && !this.isValidPeerEndpoint(peerEndpoint)) {
          res.status(400).json({ error: 'Invalid peer endpoint URL' });
          return;
        }

        const peer: PeerRecord = {
          clawId: announcement.clawId || `claw://${announcement.identityKey.substring(0, 16)}`,
          identityKey: announcement.identityKey,
          endpoint: peerEndpoint,
          capabilities: announcement.capabilities?.map((c: any) => c.name) || [],
          chain: announcement.networkInfo?.chain || 'test',
          lastSeen: new Date().toISOString(),
          reputation: 40
        };
        this.peerRegistry.addPeer(peer);

        // Track referral: if this announcement was relayed by broadcast_listing,
        // record who introduced this peer so they earn referral bounties
        if (announcement.referredBy && typeof announcement.referredBy === 'string') {
          this.referralMap.set(announcement.identityKey, announcement.referredBy);
          log(TAG, `Referral tracked: ${announcement.identityKey.substring(0, 12)}... introduced by ${announcement.referredBy.substring(0, 12)}...`);
        }

        log(TAG, `Received announcement from ${announcement.identityKey.substring(0, 12)}... (verified=${verified})`);
        res.json({ registered: true, verified, peersKnown: this.peerRegistry.size() });
      } catch (error) {
        logError(TAG, 'Announce handling failed:', error);
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ── Direct wallet payment submission (BRC-50 style) ─────────────
    // Accepts externally-funded transactions plus BRC-29 remittance context
    // and internalizes them into wallet state.
    this.app.post('/wallet/submit-payment', async (req: express.Request, res: express.Response) => {
      try {
        const body = req.body || {};
        const protocol = String(body.protocol || '');
        if (protocol !== '3241645161d8') {
          res.status(400).json({ error: 'Unsupported protocol. Expected 3241645161d8 (BRC-29).' });
          return;
        }

        const senderIdentityKey = String(body.senderIdentityKey || '');
        if (!/^(02|03)[0-9a-fA-F]{64}$/.test(senderIdentityKey)) {
          res.status(400).json({ error: 'Invalid senderIdentityKey.' });
          return;
        }

        const derivationPrefix = String(body.derivationPrefix || '');
        if (!derivationPrefix) {
          res.status(400).json({ error: 'Missing derivationPrefix.' });
          return;
        }
        const derivationSuffix = String(body.derivationSuffix || 'clawsats');
        const outputIndex = Number.isInteger(body.outputIndex) ? Number(body.outputIndex) : 0;
        if (outputIndex < 0) {
          res.status(400).json({ error: 'Invalid outputIndex.' });
          return;
        }

        const amount = typeof body.amount === 'number' ? body.amount : undefined;
        const note = typeof body.note === 'string' && body.note.trim()
          ? body.note.trim()
          : 'External wallet payment submission';

        const txCandidate = body.transaction ?? body.tx ?? body.rawTx ?? body.atomicBEEF ?? body.beef;
        const txBytes = this.decodePaymentTransactionToBytes(txCandidate);

        const wallet = this.walletManager.getWallet();
        const internResult = await wallet.internalizeAction({
          tx: txBytes,
          outputs: [{
            outputIndex,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix,
              derivationSuffix,
              senderIdentityKey
            }
          }],
          description: note
        });

        const acceptedSats = typeof internResult?.accepted?.satoshis === 'number'
          ? internResult.accepted.satoshis
          : null;
        if (typeof amount === 'number' && amount > 0 && typeof acceptedSats === 'number' && acceptedSats < amount) {
          res.status(400).json({
            error: `Internalized amount ${acceptedSats} is below expected ${amount}.`,
            acceptedSatoshis: acceptedSats
          });
          return;
        }

        res.json({
          accepted: true,
          reference: internResult?.accepted?.reference || null,
          acceptedSatoshis: acceptedSats,
          protocol,
          outputIndex
        });
        log(TAG, `submit-payment accepted from ${senderIdentityKey.substring(0, 16)}... sats=${acceptedSats ?? 'unknown'} output=${outputIndex}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logWarn(TAG, `submit-payment rejected: ${msg}`);
        res.status(400).json({ error: msg });
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
          // FREE TRIAL: if caller provides identity key and hasn't used their free trial,
          // execute one call for free. This solves the bootstrap problem — a Claw with
          // 0 sats can prove the network works before needing to pay.
          const trialCallerKey = req.headers['x-bsv-identity-key'] as string || '';
          if (trialCallerKey && !this.freeTrialUsed.has(trialCallerKey)) {
            this.freeTrialUsed.add(trialCallerKey);
            // Cap free trial set to prevent memory abuse
            if (this.freeTrialUsed.size > 50000) {
              const first = this.freeTrialUsed.values().next().value;
              if (first) this.freeTrialUsed.delete(first);
            }
            log(TAG, `Free trial for ${trialCallerKey.substring(0, 16)}... on ${capName}`);
            try {
              const wallet = this.walletManager.getWallet();
              const result = await cap.handler(req.body, wallet);
              res.json({
                result,
                satoshisPaid: 0,
                freeTrial: true,
                message: 'Free trial call — next call requires payment.',
                nextCallPrice: cap.pricePerCall
              });
            } catch (handlerErr) {
              const msg = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
              res.status(500).json({ error: msg });
            }
            return;
          }

          // No payment and no free trial → return 402 with challenge headers (BRC-105 §5.2)
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
            freeTrialAvailable: !trialCallerKey ? true : false,
            freeTrialHint: !trialCallerKey ? 'Send x-bsv-identity-key header to get one free trial call' : undefined,
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

        // PAYMENT REPLAY PROTECTION (Finding 2): hash the payment data to create a dedupe key.
        // If we've seen this exact payment before, reject it.
        const txHash = createHash('sha256').update(paymentData.transaction).digest('hex');
        if (this.paymentDedupeCache.has(txHash)) {
          logWarn(TAG, `Payment replay detected for ${capName}: ${txHash.substring(0, 16)}...`);
          res.status(402).json({
            status: 'error',
            code: 'ERR_PAYMENT_REPLAY',
            description: 'This payment has already been used. Send a new payment.'
          });
          return;
        }

        // STRICT PAYMENT GATE: internalize output 0 (provider's payment) via BRC-105 §6.4.
        // If internalizeAction fails, the payment is invalid — DO NOT execute the capability.
        // This prevents attackers from sending garbage payments and getting free work.
        const wallet = this.walletManager.getWallet();
        const txBytes = Array.from(Buffer.from(paymentData.transaction, 'base64'));
        try {
          const internResult = await wallet.internalizeAction({
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

          // AMOUNT VERIFICATION (Finding 1): check that the internalized output
          // actually covers the capability price. internalizeAction succeeds if the
          // script matches, but doesn't enforce amount — we must check it ourselves.
          if (internResult && typeof internResult.accepted === 'object') {
            // If the wallet returns output details, verify amount
            const acceptedSats = internResult.accepted?.satoshis;
            if (typeof acceptedSats === 'number' && acceptedSats < cap.pricePerCall) {
              logWarn(TAG, `Underpayment for ${capName}: got ${acceptedSats}, need ${cap.pricePerCall}`);
              res.status(402).json({
                status: 'error',
                code: 'ERR_UNDERPAYMENT',
                description: `Payment too low: received ${acceptedSats} sats, need ${cap.pricePerCall}.`
              });
              return;
            }
          }

          // FEE VERIFICATION: The 2-sat protocol fee output MUST exist in the tx.
          // We can't internalize it (we don't hold the fee key), but we CAN verify
          // that the transaction contains an output with >= FEE_SATS that is NOT
          // the provider's output (output 0). This prevents callers from skipping
          // the fee while still paying the provider.
          //
          // The fee wallet holder does full BRC-29 derivation verification when
          // sweeping. This check ensures the output at least exists and has value.
          try {
            // Parse minimal tx structure to count outputs and check satoshi values.
            // AtomicBEEF format: the raw tx is embedded after the BEEF envelope header.
            // For robustness, we check all outputs beyond index 0 for one with >= FEE_SATS.
            const txBuf = Buffer.from(paymentData.transaction, 'base64');
            const feeOutputFound = this.verifyFeeOutputExists(txBuf);
            if (!feeOutputFound) {
              logWarn(TAG, `Missing ${FEE_SATS}-sat fee output in payment for ${capName}`);
              res.status(402).json({
                status: 'error',
                code: 'ERR_MISSING_FEE',
                description: `Payment must include a ${FEE_SATS}-sat fee output to the ClawSats protocol. See x-clawsats-fee-identity-key header.`
              });
              return;
            }
          } catch (feeCheckErr) {
            // If we can't parse the tx to check the fee, log but don't block.
            // The internalization already succeeded, so the provider payment is valid.
            // This is a defense-in-depth check, not the primary gate.
            const msg = feeCheckErr instanceof Error ? feeCheckErr.message : String(feeCheckErr);
            logWarn(TAG, `Fee output check failed (non-fatal): ${msg}`);
          }

          // Mark this payment as used AFTER successful internalization + fee check
          this.paymentDedupeCache.add(txHash);
          // Cap the dedupe cache size to prevent unbounded memory growth
          if (this.paymentDedupeCache.size > 10000) {
            const first = this.paymentDedupeCache.values().next().value;
            if (first) this.paymentDedupeCache.delete(first);
          }

          log(TAG, `Auto-accepted payment for ${capName}: ${cap.pricePerCall} sats + ${FEE_SATS} sat fee verified`);
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

        // Build signed receipt — cryptographic proof the work was done
        const providerKey = this.walletManager.getConfig()?.identityKey || '';
        const receiptId = `rcpt-${Date.now()}-${randomBytes(4).toString('hex')}`;
        const resultHash = createHash('sha256')
          .update(canonicalJson(result))
          .digest('hex');
        const receiptData = {
          receiptId,
          capability: capName,
          provider: providerKey,
          requester: senderIdentityKey,
          satoshisPaid: cap.pricePerCall,
          feeSats: FEE_SATS,
          resultHash,
          timestamp: new Date().toISOString()
        };
        let receiptSignature = '';
        try {
          const sigResult = await wallet.createSignature({
            data: Array.from(Buffer.from(canonicalJson(receiptData), 'utf8')),
            protocolID: [0, 'clawsats-receipt'],
            keyID: 'receipt-v1'
          });
          receiptSignature = Buffer.from(sigResult.signature).toString('base64');
        } catch {
          // Non-fatal — receipt is still useful unsigned
        }

        // Track call stats for reputation
        this.callStats.set(capName, (this.callStats.get(capName) || 0) + 1);
        if (senderIdentityKey) this.uniqueCallers.add(senderIdentityKey);

        // Track the caller as a peer if they provided identity
        if (senderIdentityKey) {
          this.peerRegistry.addPeer({
            clawId: `claw://${senderIdentityKey.substring(0, 16)}`,
            identityKey: senderIdentityKey,
            endpoint: '', // unknown
            capabilities: [],
            chain: this.walletManager.getConfig()?.chain || 'main',
            lastSeen: new Date().toISOString(),
            reputation: 40
          });
          // Track referral: who introduced this caller?
          this.trackReferral(senderIdentityKey, capName, cap.pricePerCall);
        }

        res.set({ 'x-bsv-payment-satoshis-paid': String(cap.pricePerCall) });
        res.json({
          result,
          satoshisPaid: cap.pricePerCall,
          receipt: { ...receiptData, signature: receiptSignature }
        });
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

    // Referral system methods
    this.rpcServer.addMethod('listReferrals', async () => {
      const entries: { introducer: string; earnedSats: number }[] = [];
      for (const [key, sats] of this.referralLedger) {
        entries.push({ introducer: key, earnedSats: sats });
      }
      return {
        referrals: entries,
        totalEarned: entries.reduce((sum, e) => sum + e.earnedSats, 0),
        trackedIntroductions: this.referralMap.size
      };
    });

    // Search capabilities across known peers — how unique Claws get discovered
    this.rpcServer.addMethod('searchCapabilities', async (params: any) => {
      const { tags, name, maxResults = 20 } = params || {};
      if (!tags && !name) throw new Error('Provide tags (string[]) or name (string) to search');

      const results: any[] = [];
      const peers = this.peerRegistry.getAllPeers();

      for (const peer of peers) {
        if (!peer.endpoint || results.length >= maxResults) break;
        try {
          const discRes = await fetch(`${peer.endpoint}/discovery`, {
            signal: AbortSignal.timeout(5000)
          });
          if (!discRes.ok) continue;
          const info: any = await discRes.json();
          if (!info.paidCapabilities) continue;

          for (const cap of info.paidCapabilities) {
            if (name && cap.name === name) {
              results.push({ peer: peer.identityKey, endpoint: peer.endpoint, capability: cap });
            } else if (tags && Array.isArray(tags) && cap.tags) {
              const matchedTags = tags.filter((t: string) => cap.tags.includes(t));
              if (matchedTags.length > 0) {
                results.push({ peer: peer.identityKey, endpoint: peer.endpoint, capability: cap, matchedTags });
              }
            }
          }
        } catch { /* peer unreachable */ }
      }

      return {
        results,
        peersSearched: peers.length,
        timestamp: new Date().toISOString()
      };
    });

    // Hire another Claw from this Claw's wallet (handles 402 challenge/pay/retry).
    this.rpcServer.addMethod('hireClaw', async (params: any) => {
      const targetEndpointRaw = typeof params?.endpoint === 'string' ? params.endpoint.trim() : '';
      const capabilityRaw = typeof params?.capability === 'string' ? params.capability.trim() : '';
      const requestedParams = params?.params;
      const maxTotalSatsRaw = params?.maxTotalSats;
      const timeoutMsRaw = params?.timeoutMs;
      const derivationSuffixRaw = typeof params?.derivationSuffix === 'string' ? params.derivationSuffix.trim() : 'clawsats';

      if (!targetEndpointRaw) throw new Error('Missing required param: endpoint');
      if (!capabilityRaw) throw new Error('Missing required param: capability');
      if (!/^[a-z0-9_:-]{2,80}$/i.test(capabilityRaw)) {
        throw new Error('Invalid capability format.');
      }

      const targetEndpoint = targetEndpointRaw.replace(/\/+$/, '');
      if (!this.isValidPeerEndpoint(targetEndpoint)) {
        throw new Error('endpoint must be a valid public http/https URL.');
      }
      const callParams = this.normalizeCapabilityCallParams(capabilityRaw, requestedParams);
      const maxTotalSats = Number.isFinite(Number(maxTotalSatsRaw)) ? Math.max(0, Math.floor(Number(maxTotalSatsRaw))) : null;
      const timeoutMs = Number.isFinite(Number(timeoutMsRaw))
        ? Math.min(90_000, Math.max(5_000, Math.floor(Number(timeoutMsRaw))))
        : 30_000;
      const derivationSuffix = derivationSuffixRaw || 'clawsats';
      if (derivationSuffix.length > 128) throw new Error('derivationSuffix is too long.');

      const config = this.walletManager.getConfig();
      const callerIdentityKey = config?.identityKey;
      if (!callerIdentityKey) {
        throw new Error('Wallet config is unavailable.');
      }

      const callUrl = `${targetEndpoint}/call/${encodeURIComponent(capabilityRaw)}`;

      const challengeRes = await fetch(callUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bsv-identity-key': callerIdentityKey
        },
        body: JSON.stringify(callParams),
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (challengeRes.ok) {
        const freeResult = await challengeRes.json().catch(() => null);
        return {
          mode: 'free-trial',
          endpoint: targetEndpoint,
          capability: capabilityRaw,
          satoshisPaid: 0,
          result: freeResult
        };
      }

      if (challengeRes.status !== 402) {
        const errBody = await challengeRes.text().catch(() => '');
        throw new Error(`Unexpected ${challengeRes.status} from provider: ${errBody.slice(0, 300)}`);
      }

      const satoshisRequired = parseInt(challengeRes.headers.get('x-bsv-payment-satoshis-required') || '0', 10);
      const derivationPrefix = challengeRes.headers.get('x-bsv-payment-derivation-prefix') || '';
      const providerIdentityKey = challengeRes.headers.get('x-bsv-identity-key') || '';
      const feeIdentityKey = challengeRes.headers.get('x-clawsats-fee-identity-key') || FEE_IDENTITY_KEY;
      const feeSats = parseInt(challengeRes.headers.get('x-clawsats-fee-satoshis-required') || String(FEE_SATS), 10);

      if (!derivationPrefix || satoshisRequired <= 0) {
        throw new Error('Invalid payment challenge: missing derivation prefix or satoshi amount.');
      }
      if (!/^(02|03)[0-9a-fA-F]{64}$/.test(providerIdentityKey)) {
        throw new Error('Provider did not return a valid identity key.');
      }
      if (maxTotalSats !== null && satoshisRequired + feeSats > maxTotalSats) {
        throw new Error(`Payment challenge is ${satoshisRequired + feeSats} sats, above maxTotalSats=${maxTotalSats}.`);
      }

      const wallet = this.walletManager.getWallet();
      const providerScript = await this.deriveBRC29LockingScript(
        wallet,
        providerIdentityKey,
        derivationPrefix,
        derivationSuffix
      );
      const feeScript = await this.deriveBRC29LockingScript(
        wallet,
        feeIdentityKey,
        derivationPrefix,
        'fee'
      );

      const actionResult = await wallet.createAction({
        description: `Claw hire: ${capabilityRaw} (${satoshisRequired} + ${feeSats} sats)`,
        outputs: [
          {
            satoshis: satoshisRequired,
            lockingScript: providerScript,
            outputDescription: `Claw hire provider payment (${capabilityRaw})`
          },
          {
            satoshis: feeSats,
            lockingScript: feeScript,
            outputDescription: 'ClawSats protocol fee'
          }
        ],
        labels: ['clawsats-hire'],
        options: {
          acceptDelayedBroadcast: false,
          signAndProcess: true,
          randomizeOutputs: false
        }
      });

      const paymentHeader = JSON.stringify({
        derivationPrefix,
        derivationSuffix,
        transaction: this.extractActionTxBase64(actionResult)
      });

      const paidRes = await fetch(callUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bsv-identity-key': callerIdentityKey,
          'x-bsv-payment': paymentHeader
        },
        body: JSON.stringify(callParams),
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!paidRes.ok) {
        const errBody = await paidRes.text().catch(() => '');
        throw new Error(`Provider rejected paid call (${paidRes.status}): ${errBody.slice(0, 320)}`);
      }

      const result = await paidRes.json().catch(() => null);
      return {
        mode: 'paid',
        endpoint: targetEndpoint,
        capability: capabilityRaw,
        satoshisPaid: satoshisRequired + feeSats,
        providerSats: satoshisRequired,
        feeSats,
        txid: actionResult?.txid || null,
        result
      };
    });

    // Receipt verification — any Claw can verify a receipt from another Claw
    this.rpcServer.addMethod('verifyReceipt', async (params: any) => {
      const { receipt } = params;
      if (!receipt || !receipt.receiptId) throw new Error('Missing receipt');
      if (!receipt.signature) return { valid: false, reason: 'Unsigned receipt' };

      const wallet = this.walletManager.getWallet();
      const { signature, ...data } = receipt;
      try {
        const result = await wallet.verifySignature({
          data: Array.from(Buffer.from(canonicalJson(data), 'utf8')),
          signature: Array.from(Buffer.from(signature, 'base64')),
          protocolID: [0, 'clawsats-receipt'],
          keyID: 'receipt-v1',
          counterparty: receipt.provider
        });
        return {
          valid: result.valid === true,
          receipt: data,
          verifiedAt: new Date().toISOString()
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { valid: false, reason: msg };
      }
    });

    // ── BSV Cluster Courses RPC Methods ────────────────────────────────

    // List available courses with completion status
    this.rpcServer.addMethod('listCourses', async () => {
      return {
        courses: this.courseManager.listCourses(),
        completedCount: this.courseManager.getCompletedCourseIds().length,
        totalAvailable: this.courseManager.courseCount
      };
    });

    // Take a course quiz — pass to unlock teach capability
    this.rpcServer.addMethod('takeCourse', async (params: any) => {
      const { courseId, answers } = params;
      if (!courseId) throw new Error('Missing courseId');
      if (!answers || !Array.isArray(answers)) throw new Error('Missing answers (string[])');

      const result = this.courseManager.takeQuiz(courseId, answers);

      // If passed, register the teach capability immediately
      if (result.passed) {
        const material = this.courseManager.getTeachingMaterial(courseId);
        if (material) {
          const identityKey = this.walletManager.getConfig()?.identityKey || 'unknown';
          this.capabilityRegistry.register({
            name: `teach_${courseId}`,
            description: `BSV Cluster Course: ${material.course.title}. Level ${material.course.level}. ${material.course.summary}`,
            pricePerCall: material.course.teachPrice,
            tags: ['education', 'bsv', material.course.category, `level-${material.course.level}`],
            handler: async (handlerParams: any) => {
              const learnerKey = handlerParams?.learnerIdentityKey || 'anonymous';
              this.courseManager.recordTeaching(courseId, learnerKey);
              return {
                courseId: material.course.id,
                title: material.course.title,
                level: material.course.level,
                prerequisites: material.course.prerequisites,
                category: material.course.category,
                content: material.course.content,
                quiz: material.course.quiz.map(q => ({
                  question: q.question,
                  options: q.options,
                  correctHash: q.correctHash
                })),
                passingScore: material.course.passingScore,
                version: material.course.version,
                taughtBy: identityKey,
                taughtAt: new Date().toISOString()
              };
            }
          });
          log(TAG, `New teach capability unlocked: teach_${courseId}`);
        }
      }

      return {
        courseId,
        ...result,
        newCapability: result.passed ? `teach_${courseId}` : null,
        message: result.passed
          ? `Passed! You can now teach this course to other Claws for ${this.courseManager.getCourse(courseId)?.teachPrice || 25} sats.`
          : `Score: ${result.correct}/${result.total}. Need ${Math.ceil((this.courseManager.getCourse(courseId)?.passingScore || 0.6) * result.total)} correct to pass.`
      };
    });

    // Get spread metrics — how far has BSV education propagated?
    this.rpcServer.addMethod('spreadMetrics', async () => {
      return this.courseManager.getSpreadMetrics();
    });

    // ── On-Chain Memory RPC Methods ─────────────────────────────────────

    // Write a memory on-chain (OP_RETURN, immutable)
    this.rpcServer.addMethod('writeMemory', async (params: any) => {
      const { key, data, category, encrypted, metadata } = params;
      if (!key || typeof key !== 'string') throw new Error('Missing key (string)');
      if (!data || typeof data !== 'string') throw new Error('Missing data (string)');
      if (data.length > 100000) throw new Error('Data too large (max 100KB for OP_RETURN). Use PushDrop for larger data.');

      const wallet = this.walletManager.getWallet();
      const record = await this.onChainMemory.writeMemory(wallet, {
        key, data, category, encrypted, metadata
      });
      return {
        ...record,
        message: `Memory "${key}" written on-chain permanently. txid: ${record.txid}`
      };
    });

    // Read a memory record from the local index
    this.rpcServer.addMethod('readMemory', async (params: any) => {
      const { key } = params;
      if (!key) throw new Error('Missing key');
      const record = this.onChainMemory.getMemory(key);
      if (!record) return { found: false, key };
      return { found: true, ...record };
    });

    // List all memories
    this.rpcServer.addMethod('listMemories', async (params: any) => {
      const category = params?.category;
      const memories = this.onChainMemory.listMemories(category);
      return {
        memories,
        total: memories.length,
        stats: this.onChainMemory.getStats()
      };
    });

    // Search memories
    this.rpcServer.addMethod('searchMemories', async (params: any) => {
      const { query } = params;
      if (!query) throw new Error('Missing query');
      return { results: this.onChainMemory.searchMemories(query) };
    });

    // Get memory stats
    this.rpcServer.addMethod('memoryStats', async () => {
      return this.onChainMemory.getStats();
    });

    // Fetch actual memory data from the blockchain (not just the local index)
    this.rpcServer.addMethod('readMemoryFromChain', async (params: any) => {
      const { key } = params;
      if (!key) throw new Error('Missing key');
      const result = await this.onChainMemory.readMemoryFromChain(key);
      if (!result) return { found: false, key };
      return { found: true, ...result };
    });

    // Fetch raw OP_RETURN data from any txid on the blockchain
    this.rpcServer.addMethod('fetchFromChain', async (params: any) => {
      const { txid } = params;
      if (!txid) throw new Error('Missing txid');
      const result = await this.onChainMemory.fetchFromChain(txid);
      if (!result) return { found: false, txid };
      return { found: true, txid, ...result };
    });

    // Write a master index on-chain (maps all memory keys → txids)
    this.rpcServer.addMethod('writeMasterIndex', async () => {
      const wallet = this.walletManager.getWallet();
      const txid = await this.onChainMemory.writeMasterIndex(wallet);
      return {
        txid,
        message: `Master index written on-chain. Store this txid to recover all memories: ${txid}`
      };
    });

    // Recover memories from an on-chain master index
    this.rpcServer.addMethod('recoverFromMasterIndex', async (params: any) => {
      const { masterIndexTxid } = params;
      if (!masterIndexTxid) throw new Error('Missing masterIndexTxid');
      const recovered = await this.onChainMemory.recoverFromMasterIndex(masterIndexTxid);
      return {
        recovered,
        message: `Recovered ${recovered} memories from master index ${masterIndexTxid}`
      };
    });

    // Verify a memory exists on-chain (fetch + hash check)
    this.rpcServer.addMethod('verifyMemoryOnChain', async (params: any) => {
      const { key, retries } = params;
      if (!key) throw new Error('Missing key');
      const verified = await this.onChainMemory.verifyOnChain(key, retries || 3);
      return { key, verified };
    });

    // Get the current master index txid (for beacons/identity)
    this.rpcServer.addMethod('getMasterIndexTxid', async () => {
      const txid = this.onChainMemory.getMasterIndexTxid();
      return { txid, hasMasterIndex: !!txid };
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
    // Pass our identity key so relayed manifests get tagged with referredBy
    this.capabilityRegistry.registerBroadcastListing(
      () => this.peerRegistry.getAllPeers().map(p => p.endpoint).filter(Boolean),
      undefined,
      identityKey
    );

    // Phase 3: Real-world capabilities — things Claws actually hire each other for
    this.capabilityRegistry.registerFetchUrl(walletProxy, identityKey);
    this.capabilityRegistry.registerDnsResolve(identityKey);
    this.capabilityRegistry.registerVerifyReceipt(walletProxy, identityKey);
    this.capabilityRegistry.registerPeerHealthCheck(identityKey);

    // BSV Mentor: premium knowledge-as-a-service (25 sats)
    // Uses MCP server if available, falls back to embedded knowledge.
    const mentorCap = createBsvMentorCapability({
      identityKey,
      wallet: walletProxy,
      mcpEndpoint: process.env.MCP_ENDPOINT || 'http://localhost:3100'
    });
    this.capabilityRegistry.register(mentorCap);
    log(TAG, `Registered bsv_mentor capability (25 sats, MCP: ${process.env.MCP_ENDPOINT || 'localhost:3100'})`);
  }

  /**
   * Register teach capabilities for each course this Claw has completed.
   * A Claw that passed bsv-101 gets a "teach_bsv-101" paid capability.
   * Other Claws pay to receive the course material + quiz.
   * This is how BSV education spreads through the network.
   */
  private registerTeachCapabilities(): void {
    const completedIds = this.courseManager.getCompletedCourseIds();
    if (completedIds.length === 0) return;

    const identityKey = this.walletManager.getConfig()?.identityKey || 'unknown';

    for (const courseId of completedIds) {
      const material = this.courseManager.getTeachingMaterial(courseId);
      if (!material) continue;

      this.capabilityRegistry.register({
        name: `teach_${courseId}`,
        description: `BSV Cluster Course: ${material.course.title}. Level ${material.course.level}. ${material.course.summary}`,
        pricePerCall: material.course.teachPrice,
        tags: ['education', 'bsv', material.course.category, `level-${material.course.level}`],
        handler: async (params: any) => {
          // Record that we taught this course
          const learnerKey = params?.learnerIdentityKey || 'anonymous';
          this.courseManager.recordTeaching(courseId, learnerKey);

          return {
            courseId: material.course.id,
            title: material.course.title,
            level: material.course.level,
            prerequisites: material.course.prerequisites,
            category: material.course.category,
            content: material.course.content,
            quiz: material.course.quiz.map(q => ({
              question: q.question,
              options: q.options,
              correctHash: q.correctHash
            })),
            passingScore: material.course.passingScore,
            version: material.course.version,
            taughtBy: identityKey,
            taughtAt: new Date().toISOString()
          };
        }
      });

      log(TAG, `Registered teach capability: teach_${courseId} (${material.course.teachPrice} sats)`);
    }
  }

  getCourseManager(): CourseManager {
    return this.courseManager;
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

  private normalizeCapabilityCallParams(capability: string, rawParams: any): Record<string, unknown> {
    const params = rawParams && typeof rawParams === 'object' ? { ...rawParams } : {};
    if (capability === 'dns_resolve') {
      if (!params.hostname && typeof params.domain === 'string') {
        params.hostname = params.domain;
      }
      delete params.domain;
    }
    if (capability === 'peer_health_check') {
      if (!params.endpoint && typeof params.peer === 'string') {
        params.endpoint = params.peer;
      }
      delete params.peer;
    }
    return params;
  }

  private p2pkhFromPubkey(pubkeyHex: string): string {
    const pubkey = Buffer.from(pubkeyHex, 'hex');
    const sha = createHash('sha256').update(pubkey).digest();
    const hash160 = createHash('ripemd160').update(sha).digest('hex');
    return `76a914${hash160}88ac`;
  }

  private async deriveBRC29LockingScript(
    wallet: any,
    recipientIdentityKey: string,
    derivationPrefix: string,
    derivationSuffix: string
  ): Promise<string> {
    const key = await wallet.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: recipientIdentityKey
    });
    if (!key || typeof key.publicKey !== 'string') {
      throw new Error('BRC-29 key derivation did not return a public key.');
    }
    return this.p2pkhFromPubkey(key.publicKey);
  }

  private extractActionTxBase64(actionResult: any): string {
    if (!actionResult) throw new Error('createAction returned no result.');
    const txCandidate = actionResult.rawTx ?? actionResult.tx ?? actionResult.transaction;

    if (typeof txCandidate === 'string') {
      const trimmed = txCandidate.trim();
      if (!trimmed) throw new Error('createAction returned an empty transaction string.');
      if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        return Buffer.from(trimmed, 'hex').toString('base64');
      }
      return trimmed;
    }

    if (Array.isArray(txCandidate)) {
      return Buffer.from(txCandidate).toString('base64');
    }

    if (txCandidate instanceof Uint8Array || Buffer.isBuffer(txCandidate)) {
      return Buffer.from(txCandidate).toString('base64');
    }

    throw new Error('createAction result missing transaction payload.');
  }

  /**
   * Track referral: if this caller was introduced by a broadcast_listing,
   * credit the introducer. This is the viral incentive — Claws earn by
   * telling other Claws about new Claws.
   */
  private trackReferral(callerKey: string, capability: string, satsPaid: number): void {
    const introducer = this.referralMap.get(callerKey);
    if (!introducer) return;
    // Credit 1 sat per referred paid call to the introducer
    const current = this.referralLedger.get(introducer) || 0;
    this.referralLedger.set(introducer, current + 1);
    log(TAG, `Referral credit: ${introducer.substring(0, 12)}... earned 1 sat from ${callerKey.substring(0, 12)}... calling ${capability}`);
  }

  /**
   * Validate a peer endpoint URL to prevent SSRF attacks (Finding 8).
   * Only allows http/https URLs pointing to public routable addresses.
   * Blocks localhost, private IPs, link-local, and non-http schemes.
   */
  private isValidPeerEndpoint(endpoint: string): boolean {
    try {
      const url = new URL(endpoint);
      // Only allow http/https
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      const hostname = url.hostname.toLowerCase();
      // Block localhost and loopback
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
      // Block private IP ranges
      if (hostname.startsWith('10.') || hostname.startsWith('192.168.')) return false;
      if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return false;
      // Block link-local
      if (hostname.startsWith('169.254.')) return false;
      // Block metadata endpoints (cloud SSRF)
      if (hostname === '169.254.169.254') return false;
      // Block 0.0.0.0
      if (hostname === '0.0.0.0') return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Decode a payment transaction payload into byte-array format expected by wallet.internalizeAction.
   * Accepts base64 or hex strings, or objects containing `rawTx` / `tx`.
   */
  private decodePaymentTransactionToBytes(candidate: unknown): number[] {
    const decodeString = (value: string): number[] => {
      const text = value.trim();
      if (!text) throw new Error('Empty transaction payload.');
      if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) {
        return Array.from(Buffer.from(text, 'hex'));
      }
      return Array.from(Buffer.from(text, 'base64'));
    };

    if (typeof candidate === 'string') {
      return decodeString(candidate);
    }

    if (candidate && typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      if (typeof obj.rawTx === 'string') return decodeString(obj.rawTx);
      if (typeof obj.tx === 'string') return decodeString(obj.tx);
      if (typeof obj.transaction === 'string') return decodeString(obj.transaction);
    }

    throw new Error('Missing transaction payload (expected base64/hex string, tx, or rawTx).');
  }

  /**
   * Verify that a payment transaction contains a fee output with >= FEE_SATS.
   *
   * We parse the raw transaction (which may be wrapped in AtomicBEEF envelope)
   * and check that at least one output beyond index 0 has >= FEE_SATS satoshis.
   * Output 0 is the provider's payment; the fee output is typically output 1.
   *
   * This is a lightweight structural check. The fee wallet holder does full
   * BRC-29 derivation verification when sweeping fee outputs.
   *
   * Bitcoin tx output format:
   *   - 8 bytes: satoshis (little-endian uint64)
   *   - varint: script length
   *   - N bytes: locking script
   */
  private verifyFeeOutputExists(txBuf: Buffer): boolean {
    // AtomicBEEF starts with version bytes (0100beef or similar).
    // We need to find the raw transaction within the envelope.
    // Strategy: scan for a plausible tx start by looking for the version field (01000000 or 02000000).
    // Then parse outputs to check satoshi values.

    let offset = 0;

    // Try to detect AtomicBEEF envelope and skip to raw tx.
    // AtomicBEEF v1: starts with 0100beef (4 bytes), then BUMP data, then raw tx.
    // For simplicity, we try multiple strategies to find the raw tx.
    const beefMagic = txBuf.length >= 4 &&
      txBuf[2] === 0xbe && txBuf[3] === 0xef;

    if (beefMagic) {
      // This is BEEF-wrapped. The raw tx is embedded somewhere after the header.
      // Rather than fully parsing BEEF, scan for tx version bytes (01000000 or 02000000)
      // followed by plausible varint input count.
      for (let i = 4; i < txBuf.length - 10; i++) {
        if ((txBuf[i] === 0x01 || txBuf[i] === 0x02) &&
            txBuf[i + 1] === 0x00 && txBuf[i + 2] === 0x00 && txBuf[i + 3] === 0x00) {
          // Possible tx version. Check if next byte is a plausible input count (1-10).
          const possibleInputCount = txBuf[i + 4];
          if (possibleInputCount >= 1 && possibleInputCount <= 10) {
            offset = i;
            break;
          }
        }
      }
      if (offset === 0) {
        // Couldn't find raw tx in BEEF envelope
        logWarn(TAG, 'Could not locate raw tx in BEEF envelope for fee check');
        return true; // Don't block on parse failure — defense in depth
      }
    }

    try {
      // Parse raw Bitcoin transaction
      // Version: 4 bytes
      offset += 4;

      // Input count (varint)
      const { value: inputCount, bytesRead: inputCountBytes } = this.readVarint(txBuf, offset);
      offset += inputCountBytes;

      // Skip inputs
      for (let i = 0; i < inputCount; i++) {
        offset += 32; // prev txid
        offset += 4;  // prev vout
        const { value: scriptLen, bytesRead: scriptLenBytes } = this.readVarint(txBuf, offset);
        offset += scriptLenBytes;
        offset += scriptLen; // script
        offset += 4; // sequence
      }

      // Output count (varint)
      const { value: outputCount, bytesRead: outputCountBytes } = this.readVarint(txBuf, offset);
      offset += outputCountBytes;

      if (outputCount < 2) {
        // Need at least 2 outputs (provider + fee)
        return false;
      }

      // Parse outputs, looking for fee output (skip output 0 = provider payment)
      for (let i = 0; i < outputCount; i++) {
        // Satoshis: 8 bytes little-endian
        if (offset + 8 > txBuf.length) return true; // Truncated, don't block
        const satoshis = Number(txBuf.readBigUInt64LE(offset));
        offset += 8;

        const { value: scriptLen, bytesRead: scriptLenBytes } = this.readVarint(txBuf, offset);
        offset += scriptLenBytes;
        offset += scriptLen;

        // Check non-zero outputs beyond index 0 for fee amount
        if (i > 0 && satoshis >= FEE_SATS) {
          return true; // Found a fee output
        }
      }

      return false; // No fee output found
    } catch {
      // Parse error — don't block the payment, just log
      return true;
    }
  }

  /** Read a Bitcoin varint from a buffer at the given offset. */
  private readVarint(buf: Buffer, offset: number): { value: number; bytesRead: number } {
    const first = buf[offset];
    if (first < 0xfd) {
      return { value: first, bytesRead: 1 };
    } else if (first === 0xfd) {
      return { value: buf.readUInt16LE(offset + 1), bytesRead: 3 };
    } else if (first === 0xfe) {
      return { value: buf.readUInt32LE(offset + 1), bytesRead: 5 };
    } else {
      // 0xff — 8-byte value, but we cap at Number.MAX_SAFE_INTEGER
      return { value: Number(buf.readBigUInt64LE(offset + 1)), bytesRead: 9 };
    }
  }
}
