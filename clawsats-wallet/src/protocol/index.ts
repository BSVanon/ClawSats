import { randomBytes, createHash } from 'crypto';
import {
  Invitation,
  CapabilityAnnouncement,
  DiscoveryQuery,
  DiscoveryResponse,
  WalletConfig
} from '../types';
import { generateNonce, canonicalJson } from '../utils';
import { PROTOCOL_ID, PROTOCOL_VERSION, INVITE_TTL_MS } from './constants';

/**
 * SharingProtocol handles wallet capability sharing between Claws.
 * Supports creating invitations, announcements, and discovery queries
 * that can be sent over BRC-33 MessageBox, overlay networks, or direct HTTP.
 */
export class SharingProtocol {
  private config: WalletConfig;
  private wallet: any | null;

  constructor(config: WalletConfig, wallet?: any) {
    this.config = config;
    this.wallet = wallet || null;
  }

  /**
   * Sign a payload using the wallet's identity key.
   * Returns base64 signature.
   */
  async signPayload(payload: string, counterparty?: string): Promise<string> {
    if (!this.wallet) {
      throw new Error('Wallet unavailable for signing');
    }

    const args: any = {
      data: Array.from(Buffer.from(payload, 'utf8')),
      protocolID: [0, 'clawsats sharing'],
      keyID: 'sharing-v1'
    };
    if (counterparty) {
      args.counterparty = counterparty;
    }

    const result = await this.wallet.createSignature(args);
    if (!result?.signature || result.signature.length === 0) {
      throw new Error('Wallet returned empty signature');
    }
    return Buffer.from(result.signature).toString('base64');
  }

  /**
   * Create a wallet invitation for another Claw.
   */
  async createInvitation(recipientClawId: string, options: {
    capabilities?: string[];
    expiresInMs?: number;
    autoDeployScript?: string;
    message?: string;
    recipientEndpoint?: string;
    recipientIdentityKey?: string;
  } = {}): Promise<Invitation> {
    const {
      capabilities = this.config.capabilities,
      expiresInMs = INVITE_TTL_MS,
      autoDeployScript = 'https://raw.githubusercontent.com/BSVanon/ClawSats/main/clawsats-wallet/scripts/auto-deploy.sh',
      recipientEndpoint,
      recipientIdentityKey
    } = options;

    const nonce = randomBytes(16).toString('hex');

    const invitation: Invitation = {
      protocol: PROTOCOL_ID,
      type: 'wallet-invitation',
      version: PROTOCOL_VERSION,
      invitationId: `invite-${Date.now()}-${randomBytes(4).toString('hex')}`,
      nonce,
      sender: {
        clawId: `claw://${this.config.identityKey.substring(0, 16)}`,
        identityKey: this.config.identityKey,
        endpoint: this.config.endpoints.jsonrpc
      },
      recipient: {
        clawId: recipientClawId,
        endpoint: recipientEndpoint,
        publicKey: recipientIdentityKey
      },
      walletConfig: {
        chain: this.config.chain,
        capabilities,
        autoDeployScript,
        configTemplate: {
          identityKey: '{{GENERATED}}',
          endpoints: {
            jsonrpc: 'http://localhost:3321'
          }
        }
      },
      expires: new Date(Date.now() + expiresInMs).toISOString(),
      signature: '',
      timestamp: new Date().toISOString()
    };

    // Sign the invitation if wallet is available
    invitation.signature = await this.signPayload(
      this.serializeForSigning(invitation),
      recipientIdentityKey
    );

    return invitation;
  }

  /**
   * Create a capability announcement for broadcast.
   */
  async createAnnouncement(options: {
    overlayTopics?: string[];
    rateLimit?: string;
    costPerCall?: number;
    recipientIdentityKey?: string;
  } = {}): Promise<CapabilityAnnouncement> {
    const {
      overlayTopics = ['clawsats-wallets', 'bsv-payments'],
      rateLimit = '100/day',
      costPerCall = 0,
      recipientIdentityKey
    } = options;

    const announcement: CapabilityAnnouncement = {
      type: 'capability-announcement',
      version: '1.0',
      announcementId: `ann-${Date.now()}-${randomBytes(4).toString('hex')}`,
      clawId: `claw://${this.config.identityKey.substring(0, 16)}`,
      identityKey: this.config.identityKey,
      capabilities: [{
        name: 'payment',
        version: '1.0',
        endpoint: this.config.endpoints.jsonrpc,
        methods: this.config.capabilities,
        rateLimit,
        costPerCall
      }],
      networkInfo: {
        overlayTopics,
        messageBoxId: `msgbox://${this.config.identityKey.substring(0, 16)}`
      },
      signature: '',
      timestamp: new Date().toISOString()
    };

    announcement.signature = await this.signPayload(
      this.serializeForSigning(announcement),
      recipientIdentityKey
    );
    return announcement;
  }

  /**
   * Create a discovery query to find Claws with specific capabilities.
   */
  async createDiscoveryQuery(capability: string, options: {
    maxResults?: number;
    responseEndpoint?: string;
  } = {}): Promise<DiscoveryQuery> {
    const {
      maxResults = 10,
      responseEndpoint = `${this.config.endpoints.jsonrpc}/discovery/callback`
    } = options;

    const query: DiscoveryQuery = {
      type: 'discovery-query',
      version: '1.0',
      queryId: `query-${Date.now()}-${randomBytes(4).toString('hex')}`,
      requester: `claw://${this.config.identityKey.substring(0, 16)}`,
      query: {
        capability,
        minVersion: '1.0',
        chain: this.config.chain,
        maxResults
      },
      responseEndpoint,
      signature: '',
      timestamp: new Date().toISOString()
    };

    query.signature = await this.signPayload(this.serializeForSigning(query));
    return query;
  }

  /**
   * Validate an incoming invitation (basic structural checks).
   * Full cryptographic verification requires the sender's public key.
   */
  validateInvitation(invitation: Invitation): { valid: boolean; reason?: string } {
    if (invitation.type !== 'wallet-invitation') {
      return { valid: false, reason: 'Invalid type' };
    }
    if (!invitation.sender?.identityKey) {
      return { valid: false, reason: 'Missing sender identity key' };
    }
    if (!invitation.nonce) {
      return { valid: false, reason: 'Missing nonce (replay protection required)' };
    }
    if (new Date(invitation.expires) < new Date()) {
      return { valid: false, reason: 'Invitation expired' };
    }
    if (!invitation.walletConfig?.chain) {
      return { valid: false, reason: 'Missing chain in wallet config' };
    }
    return { valid: true };
  }

  /**
   * Serialize a protocol message to canonical JSON for signing.
   */
  serializeForSigning(message: Invitation | CapabilityAnnouncement | DiscoveryQuery): string {
    // Strip the signature field before canonicalizing
    const { signature, ...rest } = message as any;
    return canonicalJson(rest);
  }
}
