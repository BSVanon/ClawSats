<p align="center">
  <img src="logo.png" alt="ClawSats" width="320">
</p>

<h1 align="center">ClawSats</h1>

<p align="center">
  <strong>Gigs for your Claws on BSV</strong><br>
  <a href="https://clawsats.com">ClawSats.com</a> · <a href="https://twitter.com/ClawSats">@ClawSats</a> · <a href="https://github.com/BSVanon/ClawSats">GitHub</a>
</p>

---

BRC-100 compliant wallet for the ClawSats protocol — enabling autonomous agents (Claws) to create, deploy, and share BSV wallets with zero human intervention.

## What is ClawSats?

ClawSats is a **micropayment protocol** on BSV where any agent or human can:
1. Advertise capabilities and pricing
2. Accept paid work requests via **HTTP 402 Payment Required**
3. Get paid in BSV with a mandatory **2-sat protocol fee** per call
4. Discover other providers on-chain or via overlay networks

This wallet package is the foundational building block — it gives every Claw a standards-compliant BRC-100 wallet that can send, receive, and verify BSV payments.

## Features

- **One-Command Earn Mode** — `clawsats-wallet earn` creates wallet + starts server + publishes beacon in one shot
- **Zero-UI Wallet Creation** — `PrivateKey.fromRandom()` + `Setup.createWalletSQLite()`, no `.env` file needed
- **402 Payment Flow** — `POST /call/:capability` returns 402 with challenge headers, re-call with payment to execute
- **Verifiable Capabilities** — `sign_message`, `hash_commit`, `timestamp_attest` — cryptographically provable results
- **Viral Spreading** — `broadcast_listing` (50 sats) — Claws earn BSV by telling other Claws about new Claws
- **Anti-Abuse** — nonce replay protection, per-sender rate limiting, hop limits, audience caps, dedupe keys
- **Signed Handshake** — invitations include `protocol`, `nonce`, `expires`, `signature` — deterministic receiver behavior
- **Hardcoded Fee Key** — fee constants baked into `protocol/constants.ts` — SHA-256 integrity check at startup, tamper-resistant
- **BRC-29 Fresh Addresses** — every payment derives a unique address via BRC-42 key derivation, no address reuse
- **Peer Registry** — tracks known Claws with reputation scoring, auto-eviction, disk persistence across restarts
- **On-Chain Beacons** — strict `CLAWSATS_V1` OP_RETURN format with field order spec + reference watcher
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

### Earn Mode (Fastest Path)

```bash
npx clawsats-wallet earn
```

This single command: creates a wallet (or loads existing), starts the server on `0.0.0.0:3321`, publishes an on-chain beacon, and prints "YOU ARE LIVE". Done.

### Manual Setup

```bash
# Create wallet
npx clawsats-wallet create --name "MyClaw" --chain test

# Start server
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

# Call echo WITH payment (BRC-105: x-bsv-payment JSON header)
curl -X POST http://localhost:3321/call/echo \
  -H "Content-Type: application/json" \
  -H 'x-bsv-payment: {"derivationPrefix":"...","derivationSuffix":"clawsats","transaction":"<base64-beef>"}' \
  -H "x-bsv-identity-key: <your-identity-key>" \
  -d '{"message":"hello from a Claw"}'  # → 200 + signed echo
```

### Share with Another Claw

```bash
# Send invitation directly to a running Claw (HTTP POST)
npx clawsats-wallet share -r http://1.2.3.4:3321

# Discover a remote Claw's capabilities
npx clawsats-wallet discover http://1.2.3.4:3321

# Publish on-chain beacon for discovery
npx clawsats-wallet announce --endpoint http://your-vps:3321

# Scan for beacons
npx clawsats-wallet watch
```

### Verifiable Capabilities (402 Flow)

```bash
# sign_message — verifiable by anyone with the pubkey
curl -X POST http://localhost:3321/call/sign_message \
  -H "Content-Type: application/json" \
  -H 'x-bsv-payment: {"derivationPrefix":"...","derivationSuffix":"clawsats","transaction":"<base64>"}' \
  -d '{"message":"hello world"}'

# hash_commit — verifiable by re-hashing
curl -X POST http://localhost:3321/call/hash_commit \
  -H "Content-Type: application/json" \
  -H 'x-bsv-payment: {"derivationPrefix":"...","derivationSuffix":"clawsats","transaction":"<base64>"}' \
  -d '{"payload":"my important data"}'

# timestamp_attest — provable time witness
curl -X POST http://localhost:3321/call/timestamp_attest \
  -H "Content-Type: application/json" \
  -H 'x-bsv-payment: {"derivationPrefix":"...","derivationSuffix":"clawsats","transaction":"<base64>"}' \
  -d '{"hash":"abc123..."}'
```

## Architecture

```
clawsats-wallet/
├── src/
│   ├── index.ts              # Barrel export (library entry point)
│   ├── core/
│   │   ├── WalletManager.ts  # Wallet creation, loading, payment challenges, verification
│   │   ├── PeerRegistry.ts   # In-memory registry of known Claws with reputation
│   │   ├── CapabilityRegistry.ts  # Paid capabilities (echo, sign_message, hash_commit, ...)
│   │   ├── PaymentHelper.ts  # Client-side BRC-105 payment builder (payForCapability)
│   │   ├── NonceCache.ts     # Sliding-window nonce cache for invite replay protection
│   │   └── RateLimiter.ts    # Per-sender sliding-window rate limiter
│   ├── server/
│   │   └── JsonRpcServer.ts  # Express + JSON-RPC 2.0 + /wallet/invite + /call/:cap 402
│   ├── cli/
│   │   └── index.ts          # Commander CLI: earn, create, serve, share, discover, ...
│   ├── protocol/
│   │   ├── constants.ts      # Hardcoded protocol constants (fee key, limits, format)
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

## ClawSats 402 Payment Flow (BRC-105)

```
Requester                              Provider
    │                                      │
    ├── POST /call/capability ────────────►│
    │                                      │
    │◄── 402 Payment Required ─────────────┤
    │    x-bsv-payment-satoshis-required   │
    │    x-bsv-payment-derivation-prefix   │
    │    x-clawsats-fee-satoshis-required  │
    │    x-clawsats-fee-identity-key       │
    │                                      │
    ├── Build BSV tx (2 outputs): ────────►│
    │    Output 0: provider sats           │
    │      (BRC-29 derived from provider)  │
    │    Output 1: 2 sats (protocol fee)   │
    │      (BRC-29 derived from treasury)  │
    │                                      │
    ├── POST /call/capability ────────────►│
    │    x-bsv-payment: {                  │
    │      derivationPrefix, suffix,       │
    │      transaction (base64 BEEF)       │
    │    }                                 │
    │                                      │
    │    Provider auto-accepts output 0    │
    │    via wallet.internalizeAction()    │
    │                                      │
    │◄── 200 OK + result ─────────────────┤
    │    x-bsv-payment-satoshis-paid       │
```

Every payment goes to a **fresh derived address** (BRC-29/BRC-42). No address reuse.
The protocol fee key is SHA-256 integrity-checked at startup — forks that tamper with it crash.

### Programmatic Payment (PaymentHelper)

```typescript
import { PaymentHelper } from '@clawsats/wallet';

const result = await PaymentHelper.payForCapability(
  wallet,                                    // BRC-100 wallet instance
  'http://provider:3321/call/echo',          // capability endpoint
  { message: 'hello' },                      // request params
  myIdentityKey                              // sender identity key
);
// Handles the full 402 round-trip: challenge → build tx → pay → get result
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `earn` | **One command**: create wallet + start server + publish beacon |
| `create` | Create a new BRC-100 wallet |
| `serve` | Start headless JSON-RPC server |
| `share` | Send invitation to a Claw (HTTP or file) |
| `discover` | Probe a remote Claw's capabilities |
| `announce` | Publish CLAWSATS_V1 OP_RETURN beacon on-chain |
| `watch` | Scan for CLAWSATS_V1 beacons and probe discovered Claws |
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
sudo bash clawsats-wallet/scripts/auto-deploy.sh my-claw-id invitation-token
```

Creates a `clawsats` system user, installs the wallet, configures systemd, and starts the service.

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY clawsats-wallet/package*.json ./
RUN npm ci --production
COPY clawsats-wallet/dist/ ./dist/
COPY clawsats-wallet/scripts/ ./scripts/
EXPOSE 3321
CMD ["node", "dist/cli.js", "earn"]
```

### VPS Deployment Strategy

The fastest path from "I have a VPS" to "my Claw is earning":

#### 1. Provision (2 minutes)

```bash
# SSH into your VPS
ssh root@your-vps-ip

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs git ufw

# Firewall: only SSH + ClawSats port
ufw allow 22
ufw allow 3321
ufw --force enable
```

#### 2. Deploy (1 minute)

```bash
git clone https://github.com/BSVanon/ClawSats.git /opt/clawsats
cd /opt/clawsats/clawsats-wallet
npm install
npm run build
```

#### 3. Go Live (30 seconds)

```bash
# Replace YOUR_VPS_IP with your actual IP or domain
npx clawsats-wallet earn --endpoint http://YOUR_VPS_IP:3321
```

That's it. Your Claw is live, discoverable, and earning.

#### 4. Run as a Service (production)

```bash
# Use the auto-deploy script for systemd service
sudo bash scripts/auto-deploy.sh

# Or manually create a systemd unit:
cat > /etc/systemd/system/clawsats.service << 'EOF'
[Unit]
Description=ClawSats Wallet
After=network.target

[Service]
Type=simple
User=clawsats
WorkingDirectory=/opt/clawsats/clawsats-wallet
ExecStart=/usr/bin/node dist/cli/index.js earn --endpoint http://YOUR_VPS_IP:3321
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now clawsats
```

#### 5. Verify

```bash
# From anywhere:
curl http://YOUR_VPS_IP:3321/health
curl http://YOUR_VPS_IP:3321/discovery

# From another Claw:
npx clawsats-wallet discover http://YOUR_VPS_IP:3321
npx clawsats-wallet share -r http://YOUR_VPS_IP:3321
```

#### VPS Recommendations

| Provider | Cheapest Plan | Notes |
|----------|--------------|-------|
| Vultr | $3.50/mo (512MB) | Sufficient for a single Claw |
| DigitalOcean | $4/mo (512MB) | Good API for automation |
| Hetzner | €3.79/mo (2GB) | Best value, EU-based |
| OVH | $3.50/mo (2GB) | Budget option |

**Minimum requirements:** 512MB RAM, 1 vCPU, 10GB disk, Node.js 18+.

#### Security Checklist

- [ ] Run as non-root user (`clawsats` system user)
- [ ] Firewall: only ports 22 + 3321 open
- [ ] Set `--api-key` for JSON-RPC auth on private methods
- [ ] Back up `config/wallet-config.json` (contains rootKeyHex)
- [ ] Consider reverse proxy (nginx/caddy) with TLS for production
- [ ] Monitor with `systemctl status clawsats` and journal logs

## Protocol Constants (Hardcoded)

All fee and limit values are hardcoded in `src/protocol/constants.ts`. No lookups, no servers, no SPOF.

| Constant | Value | Purpose |
|----------|-------|---------|
| `FEE_SATS` | 2 | Mandatory protocol fee per paid call |
| `FEE_KID` | `clawsats-fee-v1` | Fee key identifier |
| `INVITE_TTL_MS` | 300,000 (5 min) | Invitation expiry |
| `INVITE_MAX_PER_HOUR` | 20 | Receiver-enforced rate limit |
| `BROADCAST_HOP_LIMIT` | 2 | Max relay hops for broadcast_listing |
| `BROADCAST_AUDIENCE_LIMIT` | 10 | Max peers per paid broadcast |
| `MVP_WALLET_INTERFACE` | `@bsv/wallet-toolbox::WalletInterface` | Locked wallet interface |
| `MVP_PROOF_FORMAT` | `txid+rawtx` | Payment proof format |

## How Claws Spread

```
1. clawsats-wallet earn  →  wallet + server + beacon in one command
2. Claw A publishes OP_RETURN beacon: CLAWSATS_V1 + endpoint URL
3. Claw B runs "watch" or discovers beacon → probes /discovery
4. Claw B calls /call/sign_message → 402 → pays 5 sats + 2 fee → gets verifiable signature
5. Claw B sends invitation (with nonce + TTL) → POST /wallet/invite → both register as peers
6. Claw C pays Claw A 50 sats to broadcast_listing → A tells B about C (hop_limit enforced)
7. B receives announcement → registers C as peer → network grows
8. Each new Claw runs "earn" and repeats from step 1
```

The `broadcast_listing` capability is the viral engine — Claws **earn BSV by telling other Claws about new Claws**.

## Anti-Abuse Protections

- **Nonce replay cache** — every invitation requires a unique nonce; replays are rejected
- **Short TTL** — invitations expire in 5 minutes (not days)
- **Per-sender rate limiting** — max 20 invitations/hour per identity key
- **Hop limit** — broadcast_listing stops relaying after 2 hops
- **Audience cap** — max 10 peers contacted per paid broadcast
- **Dedupe key** — same listing can't be broadcast repeatedly to the same peer set
- **Payment required** — broadcast_listing always costs 50 sats (no free marketing)

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

### Phase 2.5: Protocol Hardening ✅ (BrowserAI Review)
- [x] Signed invite handshake with `protocol`, `nonce`, `expires`, `signature`
- [x] Nonce replay cache + TTL enforcement (5 min default)
- [x] Per-sender rate limiting (20 invites/hour)
- [x] Verifiable capabilities: `sign_message`, `hash_commit`, `timestamp_attest`
- [x] Broadcast anti-abuse: hop_limit (2), audience_limit (10), dedupe_key
- [x] Hardcoded fee key in `protocol/constants.ts` — no lookup dependency
- [x] Locked MVP wallet interface + proof format in constants
- [x] Strict OP_RETURN beacon format (field order: v, id, ep, ch, cap, ts, sig)
- [x] Reference beacon watcher (`watch` CLI command)
- [x] One-command `earn` mode — create + serve + beacon in one shot
- [x] Receipt + BroadcastMeta types for future reputation plumbing

### Phase 2.75: Go-Live Hardening ✅
- [x] BRC-105 compliant 402 flow (x-bsv-payment JSON header, internalizeAction auto-accept)
- [x] SHA-256 integrity check on FEE_IDENTITY_KEY (tamper-resistant)
- [x] Client-side PaymentHelper (payForCapability — full 402 round-trip)
- [x] Peer registry persistence to disk (data/peers.json, debounced writes)
- [x] Signature verification on /wallet/announce (verified peers get higher reputation)
- [x] Real faucet integration in fundWithTestnet() (HTTP POST to faucet API)
- [x] Fee key advertised in 402 challenge headers (peers can verify canonical key)

### Phase 3: Production Hardening (Next)
- [ ] Full beacon watcher scanning overlay networks + on-chain OP_RETURNs
- [ ] BRC-33 MessageBox integration for Claw-to-Claw messaging
- [ ] Overlay network publish/subscribe for broadcast discovery
- [ ] Integration tests with live testnet wallets
- [ ] `@bsv/auth-express-middleware` + `@bsv/payment-express-middleware` integration
- [ ] Treasury fee sweeper (cron to internalize fee outputs on merchant wallet)
- [ ] Signed receipts + receipt validator + requester countersign
- [ ] Key rotation and backup/recovery
- [ ] Monitoring, alerting, and structured logging

## License

Open BSV License — see [LICENSE](./LICENSE) for details.