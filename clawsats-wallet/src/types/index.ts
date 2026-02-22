export type Chain = 'test' | 'main';

export interface WalletConfig {
  identityKey: string;
  chain: Chain;
  rootKeyHex?: string;
  storageType: 'sqlite' | 'memory';
  storagePath?: string;
  endpoints: {
    jsonrpc: string;
    health: string;
    discovery: string;
  };
  capabilities: string[];
  clawsats: {
    feeKeyId: string;
    defaultFeeSuffix: string;
    feeIdentityKey?: string;
  };
}

export interface Invitation {
  protocol: string;
  type: 'wallet-invitation';
  version: string;
  invitationId: string;
  nonce: string;
  sender: {
    clawId: string;
    identityKey: string;
    endpoint: string;
    manifestHash?: string;
  };
  recipient: {
    clawId: string;
    endpoint?: string;
    publicKey?: string;
  };
  walletConfig: {
    chain: 'test' | 'main';
    capabilities: string[];
    autoDeployScript: string;
    configTemplate: {
      identityKey: string;
      endpoints: {
        jsonrpc: string;
      };
    };
  };
  expires: string;
  signature: string;
  timestamp: string;
}

export interface CapabilityAnnouncement {
  type: 'capability-announcement';
  version: string;
  announcementId: string;
  clawId: string;
  identityKey: string;
  capabilities: {
    name: string;
    version: string;
    endpoint: string;
    methods: string[];
    rateLimit: string;
    costPerCall: number;
  }[];
  networkInfo: {
    overlayTopics: string[];
    messageBoxId: string;
  };
  signature: string;
  timestamp: string;
}

export interface DiscoveryQuery {
  type: 'discovery-query';
  version: string;
  queryId: string;
  requester: string;
  query: {
    capability: string;
    minVersion: string;
    chain: 'test' | 'main';
    maxResults: number;
  };
  responseEndpoint: string;
  signature: string;
  timestamp: string;
}

export interface DiscoveryResponse {
  type: 'discovery-response';
  version: string;
  responseId: string;
  originalQueryId: string;
  results: {
    clawId: string;
    identityKey: string;
    capability: string;
    endpoint: string;
    reputation: number;
    uptime: number;
    lastSeen: string;
  }[];
  signature: string;
  timestamp: string;
}

export interface CreateWalletOptions {
  name?: string;
  chain?: Chain;
  rootKeyHex?: string;
  storageType?: 'sqlite' | 'memory';
  storagePath?: string;
  autoFund?: boolean;
  testnetFaucetUrl?: string;
}

export interface ServeOptions {
  port?: number;
  host?: string;
  apiKey?: string;
  publicEndpoint?: string;
  enableDiscovery?: boolean;
  cors?: boolean;
  configPath?: string;
  enableIndelible?: boolean;
  indelibleUrl?: string;
  indelibleOperatorAddress?: string;
  indelibleDefaultAgentAddress?: string;
}

export interface ShareOptions {
  recipient: string;
  capability: string;
  message?: string;
  autoDeploy?: boolean;
  channels?: ('messagebox' | 'overlay' | 'direct')[];
}

export interface PaymentChallengeHeaders {
  'x-bsv-payment-version': string;
  'x-bsv-payment-satoshis-required': string;
  'x-bsv-payment-derivation-prefix': string;
  'x-clawsats-fee-satoshis-required': string;
  'x-clawsats-fee-kid': string;
  'x-clawsats-fee-derivation-suffix': string;
  'x-clawsats-fee-identity-key'?: string;
}

export interface ExpectedOutput {
  type: 'provider' | 'protocol-fee';
  amount: number;
}

export interface PeerRecord {
  clawId: string;
  identityKey: string;
  endpoint: string;
  capabilities: string[];
  chain: Chain;
  lastSeen: string;
  reputation: number;
}

export interface CapabilityHandler {
  name: string;
  description: string;
  pricePerCall: number;
  tags?: string[];
  handler: (params: any, wallet: any) => Promise<any>;
}

export interface EchoRequest {
  message: string;
  nonce?: string;
}

export interface EchoResponse {
  message: string;
  nonce: string;
  signedBy: string;
  signature: string;
  timestamp: string;
}

export interface BroadcastListingRequest {
  manifest: CapabilityAnnouncement;
  maxPeers?: number;
}

export interface BroadcastListingResponse {
  peersNotified: number;
  peerEndpoints: string[];
  timestamp: string;
}

export interface BeaconData {
  protocol: 'CLAWSATS_V1';
  identityKey: string;
  endpoint: string;
  chain: Chain;
  capabilities: string[];
  timestamp: string;
}

export interface BeaconPayload {
  v: string;
  id: string;
  ep: string;
  ch: Chain;
  cap: string[];
  ts: string;
  sig: string;
}

export interface InvitationAcceptance {
  type: 'invitation-acceptance';
  originalInvitationId: string;
  acceptor: {
    clawId: string;
    identityKey: string;
    endpoint: string;
  };
  capabilities: string[];
  timestamp: string;
}

export interface Receipt {
  type: 'job-receipt';
  version: string;
  receiptId: string;
  jobId: string;
  capability: string;
  provider: {
    identityKey: string;
    endpoint: string;
  };
  requester: {
    identityKey: string;
  };
  payment: {
    txid: string;
    providerAmount: number;
    feeAmount: number;
  };
  result: {
    success: boolean;
    hash?: string;
  };
  providerSignature: string;
  requesterSignature?: string;
  timestamp: string;
}

export interface BroadcastMeta {
  hopCount: number;
  maxHops: number;
  originIdentityKey: string;
  dedupeKey: string;
}

export interface ReputationScore {
  clawId: string;
  score: number;
  metrics: {
    successfulDeployments: number;
    failedDeployments: number;
    uptime: number;
    responseTime: number;
    fraudReports: number;
  };
  lastUpdated: Date;
}
