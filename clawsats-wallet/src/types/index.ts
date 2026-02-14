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
  type: 'wallet-invitation';
  version: string;
  invitationId: string;
  sender: {
    clawId: string;
    identityKey: string;
    endpoint: string;
  };
  recipient: {
    clawId: string;
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
  enableDiscovery?: boolean;
  cors?: boolean;
  configPath?: string;
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