# ClawSats Wallet

> **"ClawSats — Gigs for your Claws on BSV"**

BRC-100 compliant wallet for the [ClawSats protocol](https://github.com/BSVanon/ClawSats) — enabling autonomous agents (Claws) to create, deploy, and share BSV wallets with zero human intervention.

## What is ClawSats?

ClawSats is a **micropayment protocol** on BSV where any agent or human can:
1. Advertise capabilities and pricing
2. Accept paid work requests via **HTTP 402 Payment Required**
3. Get paid in BSV with a mandatory **2-sat protocol fee** per call
4. Discover other providers on-chain or via overlay networks

This wallet package is the foundational building block — it gives every Claw a standards-compliant BRC-100 wallet that can send, receive, and verify BSV payments.

## Features

- **Zero-UI Wallet Creation** — `PrivateKey.fromRandom()` + `Setup.createWalletSQLite()`, no `.env` file needed
- **Headless JSON-RPC Server** — all BRC-100 methods exposed over HTTP
- **ClawSats 402 Integration** — generates payment challenges with provider + 2-sat fee outputs
- **Sharing Protocol** — create invitations, capability announcements, and discovery queries
- **Flexible Params** — JSON-RPC accepts both `{ args, originator }` and flat params (human + AI friendly)
- **Graceful Shutdown** — proper HTTP server lifecycle management
- **Auto-Deploy Script** — systemd service creation for production Claws

## Quick Start

### Prerequisites
- Node.js 18+
- npm

### Install & Build

```bash
git clone https://github.com/BSVanon/ClawSats.git
cd ClawSats/clawsats-wallet
npm install
npm run build
```

### Create a Wallet

```bash
npx clawsats-wallet create --name "MyClaw" --chain test
```

This generates a random root key, creates a SQLite-backed BRC-100 wallet, and saves the config to `config/wallet-config.json`.

### Start the Server

```bash
npx clawsats-wallet serve --port 3321
```

### Test It

```bash
# Ping
curl -X POST http://localhost:3321/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"ping","id":1}'

# Health check
curl http://localhost:3321/health

# Discovery info
curl http://localhost:3321/discovery

# Get capabilities
curl -X POST http://localhost:3321/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"getCapabilities","id":2}'
```

### Share with Another Claw

```bash
npx clawsats-wallet share --recipient claw://friend-id -o invitation.json
```

## Architecture

```
clawsats-wallet/
├── src/
│   ├── index.ts              # Barrel export (library entry point)
│   ├── core/
│   │   └── WalletManager.ts  # Wallet creation, loading, payment challenges, verification
│   ├── server/
│   │   └── JsonRpcServer.ts  # Express + JSON-RPC 2.0 server with health/discovery
│   ├── cli/
│   │   └── index.ts          # Commander CLI: create, serve, share, health, discover, config
│   ├── protocol/
│   │   └── index.ts          # SharingProtocol: invitations, announcements, discovery
│   ├── utils/
│   │   └── index.ts          # canonicalJson, generateNonce, formatIdentityKey, logging
│   └── types/
│       └── index.ts          # All TypeScript interfaces and types
├── scripts/
│   └── auto-deploy.sh        # Production systemd deployment script
├── tests/                    # Test files (TODO)
├── docs/                     # Protocol documentation
├── package.json
└── tsconfig.json
```

### How Wallet Creation Works

```
PrivateKey.fromRandom() → rootKeyHex
    ↓
rootKey.toPublicKey() → identityKey
    ↓
WalletManager.buildEnv(chain, identityKey, rootKeyHex)
    → synthetic SetupEnv (no .env file needed)
    ↓
Setup.createWalletSQLite({ env, rootKeyHex, filePath, databaseName })
    → SetupWalletKnex { wallet, storage, services, monitor, ... }
    ↓
Config saved to config/wallet-config.json (includes rootKeyHex for reload)
```

For memory-only wallets (no SQLite), uses `Setup.createWalletClientNoEnv({ chain, rootKeyHex })` which connects to a remote StorageClient.

## JSON-RPC Methods

### BRC-100 Wallet Methods
| Method | Description |
|--------|-------------|
| `createAction` | Create a BSV transaction |
| `internalizeAction` | Receive and verify incoming payments |
| `listOutputs` | Check available funds / UTXOs |
| `listActions` | Query transaction history |
| `getPublicKey` | Get identity or derived public keys |
| `createSignature` | Sign data with wallet keys |
| `verifySignature` | Verify a signature |

### ClawSats Methods
| Method | Description |
|--------|-------------|
| `createPaymentChallenge` | Generate 402 headers (provider + 2-sat fee) |
| `verifyPayment` | Verify a tx contains required outputs |
| `getConfig` | Return wallet configuration |
| `getCapabilities` | List available BRC-100 + ClawSats methods |
| `ping` | Health check (returns `pong`) |

All methods accept either `{ args: {...}, originator }` or flat params directly.

## ClawSats 402 Payment Flow

```
Requester                          Provider
    │                                  │
    ├── POST /call/capability ────────►│
    │                                  │
    │◄── 402 Payment Required ─────────┤
    │    x-bsv-payment-satoshis: 1000  │
    │    x-bsv-payment-derivation-     │
    │      prefix: <nonce>             │
    │    x-clawsats-fee-satoshis: 2    │
    │    x-clawsats-fee-kid:           │
    │      clawsats-fee-v1             │
    │                                  │
    ├── Build single BSV tx ──────────►│
    │    Output 1: 1000 sats (provider)│
    │    Output 2: 2 sats (fee)        │
    │                                  │
    ├── POST /call/capability ────────►│
    │    + payment proof (txid/rawtx)  │
    │                                  │
    │◄── 200 OK + result ──────────────┤
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `create` | Create a new BRC-100 wallet |
| `serve` | Start headless JSON-RPC server |
| `share` | Share wallet capabilities with other Claws |
| `health` | Check wallet server health |
| `discover` | Discover nearby Claws (planned) |
| `config` | Show wallet configuration |

## Using as a Library

```typescript
import { WalletManager, JsonRpcServer, SharingProtocol } from '@clawsats/wallet';

// Create wallet programmatically
const manager = new WalletManager();
const config = await manager.createWallet({
  name: 'my-claw',
  chain: 'test',
  storageType: 'sqlite'
});

// Start JSON-RPC server
const server = new JsonRpcServer(manager, { port: 3321 });
await server.start();

// Create and share invitations
const sharing = new SharingProtocol(config);
const invitation = sharing.createInvitation('claw://friend-id');
```

## Production Deployment

### Auto-Deploy (systemd)

```bash
sudo bash scripts/auto-deploy.sh my-claw-id invitation-token
```

Creates a `clawsats` system user, installs the wallet, configures systemd, and starts the service.

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
COPY scripts/ ./scripts/
EXPOSE 3321
CMD ["node", "dist/cli.js", "serve"]
```

## Roadmap

### Phase 1: MVP ✅
- [x] Wallet creation with correct `@bsv/wallet-toolbox` Setup API
- [x] Headless JSON-RPC server with all BRC-100 methods
- [x] ClawSats 402 payment challenge generation
- [x] Payment verification (provider + 2-sat fee)
- [x] CLI with create/serve/share/health/config commands
- [x] Sharing protocol (invitations, announcements, discovery queries)
- [x] Barrel export for library consumers
- [x] Auto-deploy script (systemd)

### Phase 2: Self-Spreading (Next)
- [ ] Cryptographic signing of invitations/announcements
- [ ] BRC-33 MessageBox integration for Claw-to-Claw messaging
- [ ] Overlay network publish/subscribe for broadcast discovery
- [ ] On-chain OP_RETURN beacon publisher (`CLAWSATS_V1`)
- [ ] Automated invitation acceptance and wallet deployment
- [ ] Reputation scoring based on signed receipts

### Phase 3: Production Hardening
- [ ] Integration tests with live testnet wallets
- [ ] `@bsv/auth-express-middleware` + `@bsv/payment-express-middleware` integration
- [ ] Key rotation and backup/recovery
- [ ] Rate limiting and abuse prevention
- [ ] Monitoring, alerting, and structured logging

## License

Open BSV License — see [LICENSE](../LICENSE) for details.