import express from 'express';
import cors from 'cors';
import http from 'http';
import { JSONRPCServer } from 'json-rpc-2.0';
import { WalletManager } from '../core/WalletManager';
import { ServeOptions } from '../types';

export class JsonRpcServer {
  private app = express();
  private rpcServer: JSONRPCServer;
  private httpServer: http.Server | null = null;
  private walletManager: WalletManager;
  private port: number;
  private host: string;
  private apiKey?: string;

  constructor(walletManager: WalletManager, options: ServeOptions = {}) {
    this.walletManager = walletManager;
    this.port = options.port || 3321;
    this.host = options.host || 'localhost';
    this.apiKey = options.apiKey;

    // Create JSON-RPC server
    this.rpcServer = new JSONRPCServer();

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
        console.log(`[server] ClawSats Wallet JSON-RPC running on http://${this.host}:${this.port}`);
        console.log(`[server] Health:    http://${this.host}:${this.port}/health`);
        console.log(`[server] Discovery: http://${this.host}:${this.port}/discovery`);
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
    // Skip authentication for health and discovery endpoints
    if (req.path === '/health' || req.path === '/discovery') {
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
      
      res.json({
        protocol: 'clawsats-wallet/v1',
        clawId: `claw://${config?.identityKey?.substring(0, 16)}`,
        identityKey: config?.identityKey,
        capabilities: config?.capabilities || [],
        endpoints: {
          jsonrpc: `http://${this.host}:${this.port}`,
          health: `http://${this.host}:${this.port}/health`,
          discovery: `http://${this.host}:${this.port}/discovery`
        },
        network: config?.chain,
        timestamp: new Date().toISOString()
      });
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
        clawsats: ['createPaymentChallenge', 'verifyPayment', 'getConfig']
      };
    });
  }

  getApp(): express.Application {
    return this.app;
  }

  getServerInfo(): { host: string; port: number; apiKey: boolean } {
    return {
      host: this.host,
      port: this.port,
      apiKey: !!this.apiKey
    };
  }
}