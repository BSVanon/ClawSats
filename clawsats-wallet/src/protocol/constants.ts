/**
 * ClawSats Protocol Constants — v1
 *
 * These values are HARDCODED into the spec. No lookups, no servers, no dependencies.
 * If the fee key changes, the protocol version changes.
 *
 * BrowserAI recommendation #4: "Hardcode the fee pubkey + kid into the spec"
 * BrowserAI recommendation #5: "Lock wallet interface, broadcast method, proof format"
 */

// ── Protocol identity ────────────────────────────────────────────────
export const PROTOCOL_ID = 'clawsats://v1';
export const PROTOCOL_TAG = 'CLAWSATS_V1';
export const PROTOCOL_VERSION = '1.0';

// ── Fee constants (hardcoded — no lookup dependency) ─────────────────
export const FEE_SATS = 2;
export const FEE_KID = 'clawsats-fee-v1';
export const FEE_DERIVATION_SUFFIX = 'fee';

// ── Invite / anti-abuse defaults ─────────────────────────────────────
export const INVITE_TTL_MS = 5 * 60 * 1000;           // 5 minutes (short, per BrowserAI #3)
export const INVITE_MAX_PER_HOUR = 20;                 // receiver-enforced
export const NONCE_CACHE_SIZE = 1000;                  // max nonces to remember for replay protection

// ── Broadcast limits ─────────────────────────────────────────────────
export const BROADCAST_HOP_LIMIT = 2;                  // max relay hops
export const BROADCAST_AUDIENCE_LIMIT = 10;            // max peers per paid broadcast
export const BROADCAST_PRICE_SATS = 50;

// ── Capability prices ────────────────────────────────────────────────
export const ECHO_PRICE_SATS = 10;
export const SIGN_MESSAGE_PRICE_SATS = 5;
export const HASH_COMMIT_PRICE_SATS = 5;
export const TIMESTAMP_ATTEST_PRICE_SATS = 5;

// ── Beacon format ────────────────────────────────────────────────────
// OP_RETURN: OP_FALSE OP_RETURN <tag_push> <payload_push>
// tag_push  = utf8("CLAWSATS_V1")
// payload   = canonical JSON, fields in this exact order:
//   { v, id, ep, ch, cap, ts, sig }
// sig = base64 signature over the JSON *without* the sig field
export const BEACON_MAX_BYTES = 220;                   // OP_RETURN safe limit
export const BEACON_FIELD_ORDER = ['v', 'id', 'ep', 'ch', 'cap', 'ts', 'sig'] as const;

// ── MVP wallet interface lock ────────────────────────────────────────
// Target: @bsv/wallet-toolbox WalletInterface (BRC-100)
// Broadcast: wallet handles broadcast internally (createAction with signAndProcess)
// Proof format: { txid, rawTx } — txid required, rawTx optional (SPV/BEEF later)
export const MVP_WALLET_INTERFACE = '@bsv/wallet-toolbox::WalletInterface';
export const MVP_PROOF_FORMAT = 'txid+rawtx';
export const MVP_BROADCAST_METHOD = 'wallet-internal';

// ── Default TAAL API key for testnet ─────────────────────────────────
export const DEFAULT_TAAL_API_KEY = 'testnet_0e6cf72133b43ea2d7861da2a38684e3';
