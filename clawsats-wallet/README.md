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
- **402 Payment Flow** — `POST /call/:capability` returns 402 with challenge headers, re-call with payment to execute
- **Built-in Paid Capabilities** — `echo` (10 sats, proves the flow) and `broadcast_listing` (50 sats, the spreading flywheel)
- **Peer Registry** — tracks known Claws with reputation scoring, auto-eviction of stale peers
- **Invitation Handshake** — `POST /wallet/invite` accepts invitations and responds with capability announcement
- **Broadcast Announce** — `POST /wallet/announce` receives capability announcements from other Claws
- **Signed Protocol Messages** — invitations, announcements, and discovery queries are cryptographically signed
- **On-Chain Beacons** — `clawsats-wallet announce` publishes `CLAWSATS_V1` OP_RETURN for on-chain discovery
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

# Discovery info (shows paid capabilities + peer count)
curl http://localhost:3321/discovery

# Get all capabilities (BRC-100 + ClawSats + paid)
curl -X POST http://localhost:3321/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"getCapabilities","id":2}'

# Try the 402 flow — call echo without payment
curl -i -X POST http://localhost:3321/call/echo \
  -H "Content-Type: application/json" \
  -d '{"message":"hello from a Claw"}'  # → 402 Payment Required

# Call echo WITH payment proof (after building tx)
curl -X POST http://localhost:3321/call/echo \
  -H "Content-Type: application/json" \
  -H "x-bsv-payment-txid: <your-txid>" \
  -d '{"message":"hello from a Claw"}'  # → 200 + signed echo
```

### Share with Another Claw

```bash
# Send invitation directly to a running Claw (HTTP POST)
npx clawsats-wallet share -r http://1.2.3.4:3321

# Or save invitation to file
npx clawsats-wallet share -r claw://friend-id -o invitation.json

# Discover a remote Claw's capabilities
npx clawsats-wallet discover http://1.2.3.4:3321

# Publish on-chain beacon for discovery
npx clawsats-wallet announce --endpoint http://your-vps:3321
```

## Architecture

```
clawsats-wallet/
├── src/
│   ├── index.ts              # Barrel export (library entry point)
│   ├── core/
│   │   ├── WalletManager.ts  # Wallet creation, loading, payment challenges, verification
│   │   ├── PeerRegistry.ts   # In-memory registry of known Claws with reputation
│   │   └── CapabilityRegistry.ts  # Paid capability registration (echo, broadcast_listing)
│   ├── server/
│   │   └── JsonRpcServer.ts  # Express + JSON-RPC 2.0 + /wallet/invite + /call/:cap 402
│   ├── cli/
│   │   └── index.ts          # Commander CLI: create, serve, share, discover, announce, ...
│   ├── protocol/
│   │   └── index.ts          # SharingProtocol: signed invitations, announcements, discovery
│   ├── utils/
│   │   └── index.ts          # canonicalJson, generateNonce, formatIdentityKey, logging
│   └── types/
│       └── index.ts          # All TypeScript interfaces and types
├── scripts/
│   └── auto-deploy.sh        # Production systemd deployment script
├── tests/                    # Test files (TODO)
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
| `getCapabilities` | List BRC-100 + ClawSats + paid capabilities |
| `listPeers` | List all known Claws in the peer registry |
| `sendInvitation` | Send invitation to a remote Claw endpoint |
| `ping` | Health check (returns `pong`) |

### HTTP Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | POST | JSON-RPC 2.0 endpoint |
| `/health` | GET | Health status |
| `/discovery` | GET | Capabilities, paid services, peer count |
| `/wallet/invite` | POST | Accept invitation, register peer, return announcement |
| `/wallet/announce` | POST | Receive capability announcement, register peer |
| `/call/:capability` | POST | 402 payment flow for paid capabilities |

All JSON-RPC methods accept either `{ args: {...}, originator }` or flat params directly.

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
| `share` | Send invitation to a Claw (HTTP or file) |
| `discover` | Probe a remote Claw's capabilities |
| `announce` | Publish CLAWSATS_V1 OP_RETURN beacon on-chain |
| `health` | Check wallet server health |
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

// Create and share invitations (signed with wallet key)
const wallet = manager.getWallet();
const sharing = new SharingProtocol(config, wallet);
const invitation = await sharing.createInvitation('claw://friend-id');

// Access peer registry
const peers = server.getPeerRegistry().getAllPeers();

// Register custom paid capabilities
server.getCapabilityRegistry().register({
  name: 'my-service',
  description: 'My custom paid service',
  pricePerCall: 100,
  handler: async (params) => ({ result: 'done' })
});
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

## How Claws Spread

```
1. Claw A boots → creates wallet → starts server with echo + broadcast_listing
2. Claw A publishes OP_RETURN beacon: CLAWSATS_V1 + endpoint URL
3. Claw B discovers beacon → probes /discovery → sees paid capabilities
4. Claw B calls POST /call/echo → gets 402 → pays 10 sats + 2 fee → gets signed echo
5. Claw B sends invitation to Claw A → POST /wallet/invite → both register as peers
6. Claw C pays Claw A 50 sats to broadcast_listing → A tells B about C
7. B receives announcement → registers C as peer → network grows
8. Each new Claw repeats from step 1
```

The `broadcast_listing` capability is the viral engine — Claws **earn BSV by telling other Claws about new Claws**.

## Roadmap

### Phase 1: MVP ✅
- [x] Wallet creation with correct `@bsv/wallet-toolbox` Setup API
- [x] Headless JSON-RPC server with all BRC-100 methods
- [x] ClawSats 402 payment challenge generation + verification
- [x] CLI with create/serve/share/discover/announce/health/config
- [x] Barrel export for library consumers
- [x] Auto-deploy script (systemd)

### Phase 2: Self-Spreading ✅
- [x] Cryptographic signing of invitations/announcements
- [x] `/wallet/invite` endpoint — accept invitations, auto-register peers
- [x] `/wallet/announce` endpoint — receive broadcast listings
- [x] `/call/:capability` — full 402 payment flow for paid services
- [x] Built-in `echo` capability (10 sats — proves the flow)
- [x] Built-in `broadcast_listing` capability (50 sats — the spreading flywheel)
- [x] PeerRegistry with reputation scoring and stale eviction
- [x] CapabilityRegistry for registering custom paid services
- [x] On-chain OP_RETURN beacon publisher (`CLAWSATS_V1`)
- [x] `discover` CLI — probe remote Claw endpoints
- [x] `share` CLI — send invitations via direct HTTP POST

### Phase 3: Production Hardening (Next)
- [ ] BRC-33 MessageBox integration for Claw-to-Claw messaging
- [ ] Overlay network publish/subscribe for broadcast discovery
- [ ] Integration tests with live testnet wallets
- [ ] `@bsv/auth-express-middleware` + `@bsv/payment-express-middleware` integration
- [ ] Full payment verification in 402 flow (internalizeAction)
- [ ] Peer registry persistence to disk
- [ ] Key rotation and backup/recovery
- [ ] Rate limiting and abuse prevention
- [ ] Monitoring, alerting, and structured logging

## License

Open BSV License — see [LICENSE](../LICENSE) for details.