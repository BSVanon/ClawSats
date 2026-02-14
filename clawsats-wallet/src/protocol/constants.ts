/**
 * ClawSats Protocol Constants — v1
 *
 * These values are HARDCODED into the spec. No lookups, no servers, no dependencies.
 * If the fee key changes, the protocol version changes.
 *
 * BrowserAI recommendation #4: "Hardcode the fee pubkey + kid into the spec"
 * BrowserAI recommendation #5: "Lock wallet interface, broadcast method, proof format"
 */

import { createHash } from 'crypto';

// ── Protocol identity ────────────────────────────────────────────────
export const PROTOCOL_ID = 'clawsats://v1';
export const PROTOCOL_TAG = 'CLAWSATS_V1';
export const PROTOCOL_VERSION = '1.0';

// ── Fee constants (hardcoded — no lookup dependency) ─────────────────
export const FEE_SATS = 2;
export const FEE_KID = 'clawsats-fee-v1';
export const FEE_DERIVATION_SUFFIX = 'fee';
// Protocol fee treasury — every paid call sends FEE_SATS to this key.
// This is the compressed public key of the ClawSats treasury wallet.
// The corresponding private key is held offline by the protocol operator.
//
// BRC-29 derivation model: each payment derives a FRESH unique address from
// this identity key using derivationPrefix + derivationSuffix via BRC-42.
// The treasury wallet (holder of the private key) can derive the matching
// private key to spend each output. No address reuse ever occurs.
//
// Integrity: SHA-256 of this key is verified at module load time.
// Forks that swap this key will fail the hash check and throw at startup.
export const FEE_IDENTITY_KEY = '0307102dc99293edba7f75bf881712652879c151b454ebf5d8e7a0ba07c4d17364';
const _FEE_KEY_INTEGRITY = '263e5a7547d75e94e681a8eb24ee5470b478e7dda23e1e2d27c58313b0e5d9a4';
if (createHash('sha256').update(FEE_IDENTITY_KEY).digest('hex') !== _FEE_KEY_INTEGRITY) {
  throw new Error(
    'CLAWSATS INTEGRITY FAILURE: FEE_IDENTITY_KEY has been tampered with. ' +
    'The protocol fee key is immutable in clawsats://v1. ' +
    'If you need a different fee key, fork the protocol version.'
  );
}

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

// Phase 3 real-world capabilities — things Claws actually hire each other for
export const FETCH_URL_PRICE_SATS = 15;         // Fetch a URL and return content (web proxy)
export const DNS_RESOLVE_PRICE_SATS = 3;         // DNS lookup from provider's vantage point
export const VERIFY_RECEIPT_PRICE_SATS = 3;       // Verify a ClawSats receipt signature
export const PEER_HEALTH_CHECK_PRICE_SATS = 5;   // Check if a peer endpoint is alive + latency
export const BSV_MENTOR_PRICE_SATS = 25;          // BSV knowledge Q&A — premium, unique knowledge

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

// ── Default API key for transaction broadcast ────────────────────────
// The wallet toolbox handles broadcast internally via BRC-100.
// Set TAAL_API_KEY env var if using TAAL as the broadcast provider.
export const DEFAULT_TAAL_API_KEY = process.env.TAAL_API_KEY || '';
