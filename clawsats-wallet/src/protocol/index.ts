import { randomBytes } from 'crypto';
import {
  Invitation,
  CapabilityAnnouncement,
  DiscoveryQuery,
  DiscoveryResponse,
  WalletConfig
} from '../types';
import { generateNonce, canonicalJson } from '../utils';

/**
 * SharingProtocol handles wallet capability sharing between Claws.
 * Supports creating invitations, announcements, and discovery queries
 * that can be sent over BRC-33 MessageBox, overlay networks, or direct HTTP.
 */
export class SharingProtocol {
  private config: WalletConfig;

  constructor(config: WalletConfig) {
    this.config = config;
  }

  /**
   * Create a wallet invitation for another Claw.
   */
  createInvitation(recipientClawId: string, options: {
    capabilities?: string[];
    expiresInMs?: number;
    autoDeployScript?: string;
    message?: string;
  } = {}): Invitation {
    const {
      capabilities = this.config.capabilities,
      expiresInMs = 7 * 24 * 60 * 60 * 1000,
      autoDeployScript = 'https://clawsats.org/deploy/v1.sh'
    } = options;

    const invitation: Invitation = {
      type: 'wallet-invitation',
      version: '1.0',
      invitationId: `invite-${Date.now()}-${randomBytes(4).toString('hex')}`,
      sender: {
        clawId: `claw://${this.config.identityKey.substring(0, 16)}`,
        identityKey: this.config.identityKey,
        endpoint: this.config.endpoints.jsonrpc
      },
      recipient: {
        clawId: recipientClawId
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
      signature: '', // TODO: sign with identity key once crypto wiring is complete
      timestamp: new Date().toISOString()
    };

    return invitation;
  }

  /**
   * Create a capability announcement for broadcast.
   */
  createAnnouncement(options: {
    overlayTopics?: string[];
    rateLimit?: string;
    costPerCall?: number;
  } = {}): CapabilityAnnouncement {
    const {
      overlayTopics = ['clawsats-wallets', 'bsv-payments'],
      rateLimit = '100/day',
      costPerCall = 0
    } = options;

    return {
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
      signature: '', // TODO: sign
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Create a discovery query to find Claws with specific capabilities.
   */
  createDiscoveryQuery(capability: string, options: {
    maxResults?: number;
    responseEndpoint?: string;
  } = {}): DiscoveryQuery {
    const {
      maxResults = 10,
      responseEndpoint = `${this.config.endpoints.jsonrpc}/discovery/callback`
    } = options;

    return {
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
      signature: '', // TODO: sign
      timestamp: new Date().toISOString()
    };
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
