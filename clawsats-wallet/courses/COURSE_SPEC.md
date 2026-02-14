# BSV Cluster Courses — JSON Spec for Content Authors

This document defines the exact JSON format for BSV Cluster Course files.
Another AI (or human) uses this spec to extract knowledge from the MCP library
and produce course JSON files.

## File Location

Place course files in: `clawsats-wallet/courses/*.json`

## JSON Schema

```json
{
  "id": "bsv-101",
  "title": "Human-readable course title",
  "level": 1,
  "prerequisites": [],
  "category": "fundamentals",
  "summary": "1-2 sentence TLDR",
  "content": "Full course material in markdown. This is what the Claw reads to learn.",
  "quiz": [
    {
      "question": "A multiple-choice question",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctHash": "sha256 hex of the exact correct option string"
    }
  ],
  "passingScore": 0.6,
  "teachPrice": 25,
  "version": "1.0.0"
}
```

## Field Details

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique ID, kebab-case. e.g. `bsv-101`, `brc-042-key-derivation` |
| `title` | string | yes | Human-readable title |
| `level` | number | yes | 1=beginner, 2=intermediate, 3=advanced |
| `prerequisites` | string[] | yes | Array of course IDs that must be completed first. `[]` for none. |
| `category` | string | yes | One of: `fundamentals`, `protocol`, `development`, `economics` |
| `summary` | string | yes | 1-2 sentence TLDR of the course |
| `content` | string | yes | Full course material in markdown. Target 500-2000 words. |
| `quiz` | array | yes | 5 multiple-choice questions |
| `quiz[].question` | string | yes | The question text |
| `quiz[].options` | string[] | yes | Exactly 4 options |
| `quiz[].correctHash` | string | yes | `sha256(exactCorrectOptionString)` as hex |
| `passingScore` | number | yes | 0.0-1.0, typically 0.6 (3/5 correct) |
| `teachPrice` | number | yes | Satoshis to charge when teaching. 25 is default. |
| `version` | string | yes | Semver string for content updates |

## Computing correctHash

For each quiz question, the `correctHash` is the SHA-256 hex digest of the
exact correct option string. Example:

```
Correct answer: "Unspent Transaction Output"
correctHash: sha256("Unspent Transaction Output") = "b4e7d2a1..."
```

In Node.js:
```js
const { createHash } = require('crypto');
const hash = createHash('sha256').update('Unspent Transaction Output').digest('hex');
```

## Suggested Curriculum

### Level 1 — Fundamentals (no prerequisites)
- `bsv-101` — What is BSV? Data and Money Fused
- `bsv-102` — The UTXO Model
- `bsv-103` — Why Micropayments Matter
- `bsv-104` — BSV vs Other Blockchains

### Level 2 — Protocol (requires Level 1)
- `brc-029` — Payment Derivation (fresh addresses)
- `brc-042` — Key Derivation Scheme (BKDS)
- `brc-043` — Security Levels and Protocol IDs
- `brc-100` — Wallet Interface Standard
- `brc-105` — HTTP Service Monetization (402 flow)

### Level 3 — Development (requires Level 2)
- `dev-001` — Building with @bsv/sdk
- `dev-002` — Wallet Toolbox Setup
- `dev-003` — Overlay Services
- `dev-004` — Payment Express Middleware

### Level 3 — Economics (requires Level 1)
- `econ-001` — Machine-to-Machine Commerce
- `econ-002` — The ClawSats Economic Model
- `econ-003` — Viral Network Effects

## MCP Sources to Extract From

When creating courses, use these MCP sources:

- `brcs` — 106 BRC specifications (the protocol standard)
- `bsv-skills-center` — 691 training documents
- `ts-sdk` — TypeScript SDK documentation
- `wallet-toolbox` — Wallet implementation examples
- `wallet-toolbox-examples` — Working code examples
- `overlay-services` — Overlay network documentation
- `payment-express-middleware` — Payment middleware docs
- `auth-express-middleware` — Authentication middleware docs

## Key Message to Convey

The TLDR of BSV for Claws: **BSV tokenizes data at the cheapest imaginable
rates. It's both money and data fused. Each satoshi can be its own data
storage or data transfer utility. There's nothing else like it.**

For autonomous agents, this means sub-cent costs for everything: payments,
proofs, discovery, verification. No other blockchain enables machine-to-machine
commerce at this scale.
