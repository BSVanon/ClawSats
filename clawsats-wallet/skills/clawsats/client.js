#!/usr/bin/env node
/**
 * ClawSats OpenClaw Client — BSV 402 pay-and-call helper
 *
 * Standalone Node.js script invoked by the OpenClaw skill.
 * Handles discovery, capability listing, and the full BRC-105
 * 402 challenge → pay → retry loop using @bsv/sdk + @bsv/wallet-toolbox.
 *
 * Usage:
 *   node client.js discover
 *   node client.js capabilities <endpoint>
 *   node client.js call <endpoint> <capability> [json-params]
 *   node client.js balance
 *   node client.js register <your-endpoint>
 *
 * Env:
 *   CLAWSATS_ROOT_KEY_HEX   — 64-char hex private key (REQUIRED for paid calls)
 *   CLAWSATS_DIRECTORY_URL  — directory API (default: https://clawsats.com/api/directory)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIRECTORY_URL = process.env.CLAWSATS_DIRECTORY_URL || 'https://clawsats.com/api/directory';
let ROOT_KEY_HEX = process.env.CLAWSATS_ROOT_KEY_HEX || '';

// Protocol constants (must match clawsats-wallet/src/protocol/constants.ts)
const FEE_SATS = 2;
const FEE_IDENTITY_KEY = '0307102dc99293edba7f75bf881712652879c151b454ebf5d8e7a0ba07c4d17364';
const FEE_DERIVATION_SUFFIX = 'fee';

// ── Wallet (lazy-initialized) ──

let wallet = null;
let identityKey = null;

function isValidRootKeyHex(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value.trim());
}

function tryLoadRootKeyFromConfig(configPath) {
  try {
    if (!configPath || !fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (isValidRootKeyHex(parsed.rootKeyHex)) {
      return parsed.rootKeyHex.trim();
    }
  } catch {
    // Ignore parse/read failures and continue fallback chain.
  }
  return null;
}

function resolveRootKeyHex() {
  if (isValidRootKeyHex(ROOT_KEY_HEX)) return ROOT_KEY_HEX.trim();

  const candidates = [
    process.env.CLAWSATS_CONFIG_PATH,
    path.join(__dirname, '../../config/wallet-config.json'),
    path.join(process.cwd(), 'config/wallet-config.json'),
    '/opt/clawsats/clawsats-wallet/config/wallet-config.json'
  ];

  for (const candidate of candidates) {
    const loaded = tryLoadRootKeyFromConfig(candidate);
    if (loaded) {
      ROOT_KEY_HEX = loaded;
      return loaded;
    }
  }

  return '';
}

async function ensureWallet() {
  if (wallet) return;
  const rootKeyHex = resolveRootKeyHex();
  if (!isValidRootKeyHex(rootKeyHex)) {
    throw new Error(
      'No usable root key found.\n' +
      'Set CLAWSATS_ROOT_KEY_HEX (64 hex chars), or keep config/wallet-config.json on this machine.\n' +
      'Example:\n' +
      "  export CLAWSATS_ROOT_KEY_HEX=$(node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\")"
    );
  }

  const { Setup } = require('@bsv/wallet-toolbox');
  const { PrivateKey } = require('@bsv/sdk');

  const rootKey = PrivateKey.fromHex(rootKeyHex);
  identityKey = rootKey.toPublicKey().toString();

  const dataDir = path.join(__dirname, '.wallet-data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const env = {
    chain: 'main',
    identityKey,
    identityKey2: identityKey,
    filePath: undefined,
    taalApiKey: '',
    devKeys: { [identityKey]: rootKeyHex },
    mySQLConnection: '{}'
  };

  try {
    const sw = await Setup.createWalletSQLite({
      env,
      rootKeyHex,
      filePath: path.join(dataDir, 'clawsats-client.sqlite'),
      databaseName: 'clawsats-openclaw-client'
    });
    wallet = sw.wallet;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Function not implemented')) {
      console.warn('[clawsats-client] SQLite init unavailable in this @bsv/wallet-toolbox build. Falling back to memory wallet mode.');
    } else {
      console.warn(`[clawsats-client] SQLite init failed (${msg}). Falling back to memory wallet mode.`);
    }
    wallet = await Setup.createWalletClientNoEnv({
      chain: 'main',
      rootKeyHex
    });
  }
}

// ── P2PKH helper ──

function p2pkhFromPubkey(pubkeyHex) {
  const pubkeyBuf = Buffer.from(pubkeyHex, 'hex');
  const sha = crypto.createHash('sha256').update(pubkeyBuf).digest();
  const hash160 = crypto.createHash('ripemd160').update(sha).digest();
  return '76a914' + hash160.toString('hex') + '88ac';
}

// ── BRC-29 key derivation for payment outputs ──

async function deriveLockingScript(recipientIdentityKey, derivationPrefix, derivationSuffix) {
  const result = await wallet.getPublicKey({
    protocolID: [2, '3241645161d8'],
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: recipientIdentityKey
  });
  return p2pkhFromPubkey(result.publicKey);
}

// ── Commands ──

async function cmdDiscover() {
  let res;
  try {
    res = await fetch(DIRECTORY_URL, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    throw new Error(`Directory unavailable: network error (${err.message})`);
  }

  if (!res.ok) {
    if (res.status === 404) {
      console.log(`\nDirectory endpoint not found: ${DIRECTORY_URL}`);
      console.log('The website is likely running an older faucet API build.');
      console.log('Expected endpoint: GET /api/directory');
      console.log('Deploy the latest ClawSats.com faucet-server.js and try again.\n');
      return;
    }
    throw new Error(`Directory unavailable: ${res.status}`);
  }

  const data = await res.json();

  console.log(`\nClawSats Directory — ${data.total} known, ${data.registered} with endpoints\n`);

  if (!data.claws || data.claws.length === 0) {
    console.log('No Claws registered yet.');
    return;
  }

  for (const c of data.claws) {
    const key = c.identityKey ? c.identityKey.substring(0, 16) + '...' : '—';
    const ep = c.endpoint || 'no endpoint';
    const caps = c.capabilities ? c.capabilities.join(', ') : '';
    console.log(`  ${c.status.padEnd(12)} ${key}  ${ep}${caps ? '  [' + caps + ']' : ''}`);
  }
  console.log('');
}

async function cmdCapabilities(endpoint) {
  if (!endpoint) throw new Error('Usage: client.js capabilities <endpoint>');

  // Try the /discovery endpoint first, fall back to health
  let caps = [];
  try {
    const res = await fetch(`${endpoint}/discovery`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const disc = await res.json();
      caps = disc.paidCapabilities || [];
      console.log(`\nClaw at ${endpoint}`);
      console.log(`  Identity: ${disc.identityKey || '?'}`);
      console.log(`  Peers:    ${disc.knownPeers || 0}`);
      console.log(`  Capabilities (${caps.length}):\n`);
      for (const cap of caps) {
        const name = typeof cap === 'string' ? cap : cap.name || cap;
        const price = typeof cap === 'object' ? cap.pricePerCall || '?' : '?';
        const desc = typeof cap === 'object' && cap.description ? ` — ${cap.description.substring(0, 60)}` : '';
        console.log(`    ${String(name).padEnd(24)} ${String(price).padEnd(6)} sat${desc}`);
      }
      console.log('');
      return;
    }
  } catch {}

  // Fall back to health endpoint
  try {
    const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const health = await res.json();
      console.log(`\nClaw at ${endpoint} — healthy`);
      console.log(JSON.stringify(health, null, 2));
      return;
    }
  } catch {}

  console.log(`Could not reach ${endpoint}`);
}

function normalizeCapabilityParams(capability, rawParams) {
  const params = rawParams && typeof rawParams === 'object' ? { ...rawParams } : {};

  if (capability === 'dns_resolve') {
    if (!params.hostname && typeof params.domain === 'string') {
      params.hostname = params.domain;
    }
    delete params.domain;
  }

  if (capability === 'peer_health_check') {
    if (!params.endpoint && typeof params.peer === 'string') {
      params.endpoint = params.peer;
    }
    delete params.peer;
  }

  if (capability === 'fetch_url') {
    if (!params.url && typeof params.endpoint === 'string') {
      params.url = params.endpoint;
    }
  }

  return params;
}

async function cmdCall(endpoint, capability, paramsJson) {
  if (!endpoint || !capability) {
    throw new Error('Usage: client.js call <endpoint> <capability> [json-params]');
  }

  await ensureWallet();

  const parsedParams = paramsJson ? JSON.parse(paramsJson) : {};
  const params = normalizeCapabilityParams(capability, parsedParams);
  const url = `${endpoint}/call/${capability}`;

  console.log(`\nCalling ${capability} on ${endpoint}...`);

  // Step 1: Request without payment → expect 402 (or 200 for free trial)
  const challengeRes = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bsv-identity-key': identityKey
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });

  if (challengeRes.ok) {
    // Free trial or free capability
    const result = await challengeRes.json();
    console.log('\nResult (free trial):');
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (challengeRes.status !== 402) {
    const errBody = await challengeRes.text();
    throw new Error(`Unexpected ${challengeRes.status}: ${errBody}`);
  }

  // Step 2: Parse 402 challenge headers
  const satoshisRequired = parseInt(
    challengeRes.headers.get('x-bsv-payment-satoshis-required') || '0', 10
  );
  const derivationPrefix = challengeRes.headers.get('x-bsv-payment-derivation-prefix') || '';
  const providerIdentityKey = challengeRes.headers.get('x-bsv-identity-key') || '';
  const feeIdentityKey = challengeRes.headers.get('x-clawsats-fee-identity-key') || FEE_IDENTITY_KEY;
  const feeSats = parseInt(
    challengeRes.headers.get('x-clawsats-fee-satoshis-required') || String(FEE_SATS), 10
  );

  if (!derivationPrefix || satoshisRequired <= 0) {
    throw new Error('Invalid 402 challenge: missing derivation prefix or satoshis');
  }

  // Verify fee key matches canonical protocol key
  if (feeIdentityKey !== FEE_IDENTITY_KEY) {
    throw new Error(
      'SECURITY: Provider fee key does not match canonical FEE_IDENTITY_KEY. ' +
      'This provider may be running modified code. Payment refused.'
    );
  }

  console.log(`  402 received: ${satoshisRequired} sats + ${feeSats} sat fee`);

  // Step 3: Build payment transaction
  const derivationSuffix = 'clawsats';

  const providerScript = await deriveLockingScript(
    providerIdentityKey || identityKey, derivationPrefix, derivationSuffix
  );
  const feeScript = await deriveLockingScript(
    FEE_IDENTITY_KEY, derivationPrefix, FEE_DERIVATION_SUFFIX
  );

  const actionResult = await wallet.createAction({
    description: `ClawSats: ${capability} (${satoshisRequired} + ${feeSats} sat fee)`,
    outputs: [
      {
        satoshis: satoshisRequired,
        lockingScript: providerScript,
        outputDescription: 'ClawSats provider payment'
      },
      {
        satoshis: feeSats,
        lockingScript: feeScript,
        outputDescription: 'ClawSats protocol fee'
      }
    ],
    labels: ['clawsats-payment'],
    options: { signAndProcess: true }
  });

  // Extract raw tx as base64
  let txBase64;
  if (actionResult.rawTx) {
    txBase64 = typeof actionResult.rawTx === 'string'
      ? actionResult.rawTx
      : Buffer.from(actionResult.rawTx).toString('base64');
  } else if (actionResult.tx) {
    txBase64 = typeof actionResult.tx === 'string'
      ? actionResult.tx
      : Buffer.from(actionResult.tx).toString('base64');
  } else {
    throw new Error('createAction did not return rawTx or tx');
  }

  console.log(`  Payment built: ${satoshisRequired + feeSats} sats total`);

  // Step 4: Retry with payment proof
  const paymentHeader = JSON.stringify({
    derivationPrefix,
    derivationSuffix,
    transaction: txBase64
  });

  const resultRes = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bsv-identity-key': identityKey,
      'x-bsv-payment': paymentHeader
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000)
  });

  if (!resultRes.ok) {
    const errBody = await resultRes.text();
    throw new Error(`Payment sent but capability failed (${resultRes.status}): ${errBody}`);
  }

  const result = await resultRes.json();
  console.log(`  Paid ${satoshisRequired + feeSats} sats`);
  console.log('\nResult:');
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function cmdBalance() {
  await ensureWallet();
  console.log(`\nIdentity key: ${identityKey}`);

  try {
    const actions = await wallet.listActions({ labels: ['clawsats-payment'], limit: 5 });
    const count = actions.totalActions || 0;
    console.log(`Recent ClawSats payments: ${count}`);
  } catch {}

  try {
    const outputs = await wallet.listOutputs({ basket: 'default', include: 'locking scripts' });
    let total = 0;
    if (outputs && outputs.outputs) {
      for (const o of outputs.outputs) {
        if (o.spendable) total += o.satoshis || 0;
      }
    }
    console.log(`Spendable balance: ${total} sats`);
  } catch (e) {
    console.log('Could not query balance (wallet may need funding)');
  }
  console.log('');
}

async function cmdRegister(endpoint) {
  if (!endpoint) throw new Error('Usage: client.js register <your-endpoint>');

  await ensureWallet();

  const res = await fetch(`${DIRECTORY_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identityKey,
      endpoint,
      capabilities: []
    }),
    signal: AbortSignal.timeout(10000)
  });

  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(`\nRegistered in directory: ${endpoint}`);
    console.log(`  Identity: ${identityKey}`);
  } else if (res.status === 404) {
    console.log('\nDirectory register endpoint not found.');
    console.log('Expected: POST /api/directory/register');
    console.log('Deploy the latest ClawSats.com faucet-server.js.');
  } else {
    console.log(`Registration failed: ${data.error || res.status}`);
  }
}

// ── Main ──

async function main() {
  const [,, command, ...args] = process.argv;

  switch (command) {
    case 'discover':
      await cmdDiscover();
      break;
    case 'capabilities':
    case 'caps':
      await cmdCapabilities(args[0]);
      break;
    case 'call':
      await cmdCall(args[0], args[1], args[2]);
      break;
    case 'balance':
      await cmdBalance();
      break;
    case 'register':
      await cmdRegister(args[0]);
      break;
    default:
      console.log(`
ClawSats OpenClaw Client

Commands:
  discover                              List all known Claws
  capabilities <endpoint>               Show a Claw's capabilities and prices
  call <endpoint> <capability> [json]   Pay for and execute a capability
  balance                               Show wallet identity and balance
  register <your-endpoint>              Register your Claw in the directory

Env:
  CLAWSATS_ROOT_KEY_HEX    64-char hex private key (optional if config/wallet-config.json exists)
  CLAWSATS_CONFIG_PATH     Optional explicit config path (expects rootKeyHex in JSON)
  CLAWSATS_DIRECTORY_URL   Directory API (default: https://clawsats.com/api/directory)

Examples:
  node client.js discover
  node client.js call http://45.76.10.20:3321 echo '{"message":"hello"}'
  node client.js call http://45.76.10.20:3321 fetch_url '{"url":"https://example.com"}'
`);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
