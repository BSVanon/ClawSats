---
description: Fill BSV Cluster Course JSON files from MCP library sources
---

# Fill BSV Cluster Courses from MCP Library

You are a content extraction AI. Your job is to search the MCP library and fill in
canonical BSV protocol data into course JSON files. Cascade has laid out the course
structure below. You fill in the `content` field with real protocol knowledge and
write quiz questions with correct SHA-256 hashed answers.

## Rules

1. **Do NOT invent protocol details.** Every claim must come from an MCP source.
2. **Use these MCP tools** to find canonical data:
   - `mcp0_repo_search` — search all sources (omit repo_id to search everything)
   - `mcp0_brc_lookup` — search BRC specifications by query
   - `mcp0_spec_extract` — extract content from a specific BRC spec
   - `mcp0_read_file` — read a specific file from a source
   - `mcp0_keyword_lookup` — search across all sources by keyword
   - `mcp0_example_lookup` — find code examples
   - `mcp0_source_status` — list all available sources and their IDs
3. **Content length:** 500-2000 words per course, markdown format.
4. **Quiz:** Exactly 5 multiple-choice questions, 4 options each.
5. **correctHash:** SHA-256 hex of the exact correct option string. Compute it in Node.js:
   ```js
   const { createHash } = require('crypto');
   createHash('sha256').update('Exact Option String').digest('hex');
   ```
6. **Key message for ALL courses:** BSV tokenizes data at the cheapest imaginable rates.
   It's both money and data fused. Each satoshi can be its own data storage or transfer
   utility. There's nothing else like it.

## Where to Put Output Files

Place each course JSON file in: `clawsats-wallet/courses/<course-id>.json`

Course JSON stays local in the filesystem. It is NOT written on-chain.
Rationale: course content is public educational material that should spread freely.
The economic gate is the teach price (25 sats per student), not content access.
Quiz answers are SHA-256 hashed so reading content doesn't let you cheat the quiz.

## JSON Schema

Follow `clawsats-wallet/courses/COURSE_SPEC.md` exactly. Here's the shape:

```json
{
  "id": "bsv-101",
  "title": "Human-readable title",
  "level": 1,
  "prerequisites": [],
  "category": "fundamentals",
  "summary": "1-2 sentence TLDR",
  "content": "Full markdown course material extracted from MCP sources",
  "quiz": [
    {
      "question": "Question text",
      "options": ["A", "B", "C", "D"],
      "correctHash": "sha256hex_of_correct_option"
    }
  ],
  "passingScore": 0.6,
  "teachPrice": 25,
  "version": "1.0.0"
}
```

## Course List — Fill These In Order

### Level 1 — Fundamentals (no prerequisites)

#### `bsv-101` — What is BSV? Data and Money Fused
- **MCP search:** `mcp0_brc_lookup({ query: "BSV blockchain overview" })`
- **MCP search:** `mcp0_repo_search({ query: "what is BSV bitcoin" })`
- **Cover:** BSV = original Bitcoin protocol, unbounded scaling, data + money on same chain
- **Cover:** satoshis as both currency and data carriers, sub-cent transaction fees
- **Cover:** why this matters for autonomous agents (machines can transact at scale)
- **Already exists** at `courses/bsv-101-what-is-bsv.json` — review and improve if needed

#### `bsv-102` — The UTXO Model
- **MCP search:** `mcp0_brc_lookup({ query: "UTXO transaction model" })`
- **MCP search:** `mcp0_keyword_lookup({ query: "UTXO unspent transaction output" })`
- **Cover:** inputs consume UTXOs, outputs create new UTXOs
- **Cover:** why UTXO > account model for parallel processing and privacy
- **Cover:** locking scripts and unlocking scripts (P2PKH basics)
- **Cover:** change outputs, dust limits, fee calculation

#### `bsv-103` — Why Micropayments Matter
- **MCP search:** `mcp0_brc_lookup({ query: "micropayments HTTP 402" })`
- **MCP search:** `mcp0_keyword_lookup({ query: "micropayment machine-to-machine" })`
- **Cover:** BSV fees are < 0.5 sat/KB, enabling sub-cent payments
- **Cover:** HTTP 402 Payment Required — the forgotten status code
- **Cover:** machine-to-machine commerce without credit cards or accounts
- **Cover:** ClawSats model: every API call is a paid transaction

#### `bsv-104` — BSV vs Other Blockchains
- **MCP search:** `mcp0_repo_search({ query: "BSV scaling comparison blockchain" })`
- **Cover:** BTC: 1MB blocks, $2+ fees, unusable for data or micropayments
- **Cover:** ETH: gas fees, account model, smart contract complexity
- **Cover:** BSV: unbounded blocks, sub-cent fees, native data embedding
- **Cover:** why only BSV works for autonomous agent economies

### Level 2 — Protocol (requires all Level 1)

#### `brc-029` — Payment Derivation
- **MCP search:** `mcp0_brc_lookup({ query: "BRC-29" })` then `mcp0_spec_extract`
- **Cover:** deriving fresh payment addresses per transaction
- **Cover:** derivationPrefix + derivationSuffix scheme
- **Cover:** why address reuse is bad (privacy, UTXO tracking)
- **Cover:** how ClawSats uses BRC-29 in every paid capability call

#### `brc-042` — Key Derivation (BKDS)
- **MCP search:** `mcp0_brc_lookup({ query: "BRC-42 key derivation" })` then `mcp0_spec_extract`
- **Cover:** Bitcoin Key Derivation Scheme
- **Cover:** protocolID + keyID + counterparty → deterministic child key
- **Cover:** public vs private derivation, security levels
- **Cover:** how encryption and signing keys are derived without sharing secrets

#### `brc-043` — Security Levels and Protocol IDs
- **MCP search:** `mcp0_brc_lookup({ query: "BRC-43 security levels" })` then `mcp0_spec_extract`
- **Cover:** security level 0 (anyone), 1 (self), 2 (counterparty-specific)
- **Cover:** protocol ID namespacing to avoid key collisions
- **Cover:** invoice numbering for unique derivation paths

#### `brc-100` — Wallet Interface Standard
- **MCP search:** `mcp0_brc_lookup({ query: "BRC-100 wallet" })` then `mcp0_spec_extract`
- **Cover:** standard wallet interface: createAction, internalizeAction, listOutputs, etc.
- **Cover:** output baskets and transaction labels
- **Cover:** why a standard interface matters for interoperability
- **Cover:** how ClawSats implements BRC-100

#### `brc-105` — HTTP Service Monetization
- **MCP search:** `mcp0_brc_lookup({ query: "BRC-105 HTTP monetization" })` then `mcp0_spec_extract`
- **Cover:** 402 Payment Required flow
- **Cover:** x-bsv-payment headers, challenge/response
- **Cover:** provider output + protocol fee output structure
- **Cover:** the ClawSats 2-sat merchant fee in every transaction

### Level 3 — Development (requires Level 2)

#### `dev-001` — Building with @bsv/sdk
- **MCP search:** `mcp0_repo_search({ query: "SDK getting started", repo_id: "ts-sdk" })`
- **MCP search:** `mcp0_example_lookup({ pattern: "transaction create" })`
- **Cover:** installing @bsv/sdk, creating keys, building transactions
- **Cover:** Transaction, PrivateKey, PublicKey, Script classes
- **Cover:** signing and verifying, serialization formats

#### `dev-002` — Wallet Toolbox Setup
- **MCP search:** `mcp0_repo_search({ query: "wallet toolbox setup", repo_id: "wallet-toolbox" })`
- **Cover:** @bsv/wallet-toolbox package, SQLite storage
- **Cover:** creating a wallet, loading from config
- **Cover:** createAction and internalizeAction in practice

#### `dev-003` — Overlay Services
- **MCP search:** `mcp0_repo_search({ query: "overlay service", repo_id: "overlay-services" })`
- **MCP search:** `mcp0_brc_lookup({ query: "overlay network SHIP SLAP" })`
- **Cover:** what overlay networks are (topic-based UTXO indexing)
- **Cover:** SHIP (host) and SLAP (lookup) protocols
- **Cover:** topic managers and lookup services
- **Cover:** how overlays enable scalable data discovery without scanning the whole chain

#### `dev-004` — On-Chain Memory (CAPSTONE)
- **MCP search:** `mcp0_example_lookup({ pattern: "OP_RETURN data" })`
- **MCP search:** `mcp0_keyword_lookup({ query: "PushDrop token" })`
- **MCP search:** `mcp0_repo_search({ query: "createAction OP_RETURN" })`
- **Cover:** OP_RETURN outputs for small immutable data (< 100KB)
- **Cover:** CLAWMEM_V1 protocol tag, key + data in script
- **Cover:** PushDrop tokens for larger data-bearing UTXOs
- **Cover:** encrypting memories with BRC-42 (counterparty: 'self')
- **Cover:** the memory-index.json local index pattern
- **Cover:** why on-chain memory is the ultimate capability for autonomous agents
- **This is the capstone.** Make it inspiring. A Claw that completes this course
  can write its own permanent memories to the blockchain.

### Level 3 — Economics (requires Level 1)

#### `econ-001` — Machine-to-Machine Commerce
- **MCP search:** `mcp0_repo_search({ query: "machine to machine payment" })`
- **Cover:** no accounts, no credit cards, no KYC — just cryptographic proof of payment
- **Cover:** why BSV micropayments enable a new economic model for AI agents
- **Cover:** the ClawSats viral loop: earn → live → discovered → hired → pay to broadcast → grow

#### `econ-002` — The ClawSats Economic Model
- **Cover:** 9 built-in paid capabilities (with prices)
- **Cover:** 2-sat protocol fee on every transaction to ClawSats treasury
- **Cover:** teach capabilities: pass a course → earn by teaching others
- **Cover:** referral bounties: introduce peers → earn 1 sat per referred paid call
- **Cover:** BSV Scholarships: human donations fund Claw education

#### `econ-003` — Viral Network Effects
- **Cover:** why Claws spread BSV education for selfish economic reasons
- **Cover:** network effects: more Claws → more capabilities → more demand → more income
- **Cover:** the flywheel: education → capabilities → income → more education

## Verification Checklist

After creating each course JSON file:

1. Validate JSON parses correctly
2. Verify `id` matches filename (minus `.json`)
3. Verify exactly 5 quiz questions with 4 options each
4. Verify all `correctHash` values are real SHA-256 hex (64 chars)
5. Verify `prerequisites` reference valid course IDs
6. Verify `content` is 500-2000 words
7. Verify `category` is one of: fundamentals, protocol, development, economics
8. Run: `cd clawsats-wallet && npx jest tests/unit/course-manager.test.ts`

## MCP Source IDs (run `mcp0_source_status()` to get current list)

Expected sources:
- `brcs` — BRC specifications
- `bsv-skills-center` — Training documents
- `ts-sdk` — TypeScript SDK
- `wallet-toolbox` — Wallet implementation
- `wallet-toolbox-examples` — Code examples
- `overlay-services` — Overlay network docs
- `payment-express-middleware` — Payment middleware
- `auth-express-middleware` — Auth middleware
