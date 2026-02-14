#!/usr/bin/env node
/**
 * ClawSats Bootstrap Faucet — Option A+B
 * 
 * Drips testnet sats to new Claws. Limited to:
 *   - 1 drip per identity key (wallet ID)
 *   - First 500 Claws total
 *   - 100 sats per drip
 * 
 * Run: node faucet-server.js
 * Requires: FAUCET_ROOT_KEY_HEX env var (the faucet wallet's root key)
 * 
 * Endpoints:
 *   GET  /api/faucet/status  — { claimed, limit, remaining }
 *   POST /api/faucet/drip    — { identityKey } → { txid, amount }
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// --- Config ---
const DRIP_AMOUNT = 100;          // sats per drip
const MAX_CLAIMS = 500;           // total faucet slots
const PORT = parseInt(process.env.FAUCET_PORT || '3322', 10);
const DB_PATH = path.join(__dirname, 'faucet-claims.json');

// --- Claim database (simple JSON file) ---
function loadClaims() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch {}
  return { claims: {}, count: 0 };
}

function saveClaims(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let db = loadClaims();

// --- Validation ---
function isValidIdentityKey(key) {
  if (typeof key !== 'string') return false;
  // Compressed pubkey: 02 or 03 + 64 hex chars = 66 total
  return /^(02|03)[0-9a-fA-F]{64}$/.test(key);
}

// --- Routes ---

// Status endpoint
app.get('/api/faucet/status', (req, res) => {
  res.json({
    claimed: db.count,
    limit: MAX_CLAIMS,
    remaining: MAX_CLAIMS - db.count,
    dripAmount: DRIP_AMOUNT,
    chain: 'test'
  });
});

// Drip endpoint
app.post('/api/faucet/drip', async (req, res) => {
  const { identityKey } = req.body || {};

  // Validate
  if (!isValidIdentityKey(identityKey)) {
    return res.status(400).json({
      error: 'Invalid identity key. Must be a compressed public key (66 hex chars starting with 02 or 03).'
    });
  }

  // Check if already claimed
  if (db.claims[identityKey]) {
    return res.status(409).json({
      error: 'This identity key has already claimed a drip.',
      claimedAt: db.claims[identityKey].claimedAt
    });
  }

  // Check if faucet exhausted
  if (db.count >= MAX_CLAIMS) {
    return res.status(410).json({
      error: `Faucet exhausted — all ${MAX_CLAIMS} slots claimed. The network is bootstrapped!`
    });
  }

  // --- Attempt to send sats ---
  // In production, this would use the faucet wallet to create a real transaction.
  // For now, we record the claim and return a placeholder.
  // When you fund the faucet wallet, replace this block with actual wallet.createAction().
  
  try {
    // TODO: Replace with real wallet transaction when faucet is funded
    // const wallet = getFaucetWallet();
    // const result = await wallet.createAction({
    //   description: `ClawSats faucet drip to ${identityKey.substring(0, 16)}...`,
    //   outputs: [{
    //     satoshis: DRIP_AMOUNT,
    //     script: deriveLockingScript(identityKey),
    //     outputDescription: 'faucet drip'
    //   }],
    //   labels: ['clawsats-faucet'],
    //   options: { signAndProcess: true, acceptDelayedBroadcast: true }
    // });
    
    const claimId = crypto.randomBytes(16).toString('hex');
    
    // Record claim
    db.claims[identityKey] = {
      claimId,
      claimedAt: new Date().toISOString(),
      amount: DRIP_AMOUNT,
      // txid: result.txid  // uncomment when real
      status: 'pending_funding'  // will be 'sent' when faucet wallet is funded
    };
    db.count++;
    saveClaims(db);

    console.log(`[FAUCET] Drip #${db.count}/${MAX_CLAIMS} → ${identityKey.substring(0, 24)}... (${DRIP_AMOUNT} sats)`);

    res.json({
      success: true,
      amount: DRIP_AMOUNT,
      claimId,
      txid: claimId,  // placeholder until real tx
      message: `Claim recorded! ${DRIP_AMOUNT} sats will be sent when the faucet wallet is funded.`,
      position: db.count,
      remaining: MAX_CLAIMS - db.count
    });

  } catch (err) {
    console.error('[FAUCET] Error:', err);
    res.status(500).json({ error: 'Faucet error — try again later.' });
  }
});

// --- Static file serving (for the website) ---
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
// Catch-all for SPA
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🦞 ClawSats Faucet + Website`);
  console.log(`   http://0.0.0.0:${PORT}`);
  console.log(`   Faucet: ${db.count}/${MAX_CLAIMS} claimed, ${DRIP_AMOUNT} sats/drip`);
  console.log(`   Status: GET /api/faucet/status`);
  console.log(`   Drip:   POST /api/faucet/drip { identityKey }\n`);
});
