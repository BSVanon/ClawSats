#!/usr/bin/env node

import { Command } from 'commander';
import { WalletManager } from '../core/WalletManager';
import { JsonRpcServer } from '../server/JsonRpcServer';
import { SharingProtocol } from '../protocol';
import { BEACON_MAX_BYTES } from '../protocol/constants';
import { CreateWalletOptions, ServeOptions } from '../types';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const program = new Command();
const walletManager = new WalletManager();

/**
 * Build a proper OP_RETURN script with correct pushdata encoding.
 * Format: OP_FALSE OP_RETURN <push tag> <push payload>
 */
function buildOpReturnScript(tag: string, payload: string): string {
  const tagBuf = Buffer.from(tag, 'utf8');
  const payloadBuf = Buffer.from(payload, 'utf8');

  // Enforce BEACON_MAX_BYTES to stay within safe OP_RETURN limits
  const totalBytes = tagBuf.length + payloadBuf.length;
  if (totalBytes > BEACON_MAX_BYTES) {
    throw new Error(`Beacon payload too large: ${totalBytes} bytes (max ${BEACON_MAX_BYTES}). Shorten capabilities list or endpoint URL.`);
  }

  // OP_FALSE (0x00) + OP_RETURN (0x6a) + pushdata(tag) + pushdata(payload)
  let script = '006a';
  script += pushdata(tagBuf);
  script += pushdata(payloadBuf);
  return script;
}

function pushdata(buf: Buffer): string {
  const len = buf.length;
  if (len <= 75) {
    // Direct push: single byte length prefix
    return len.toString(16).padStart(2, '0') + buf.toString('hex');
  } else if (len <= 255) {
    // OP_PUSHDATA1 (0x4c) + 1-byte length
    return '4c' + len.toString(16).padStart(2, '0') + buf.toString('hex');
  } else if (len <= 65535) {
    // OP_PUSHDATA2 (0x4d) + 2-byte length (little-endian)
    const lo = (len & 0xff).toString(16).padStart(2, '0');
    const hi = ((len >> 8) & 0xff).toString(16).padStart(2, '0');
    return '4d' + lo + hi + buf.toString('hex');
  }
  throw new Error(`Pushdata too large: ${len} bytes`);
}

program
  .name('clawsats-wallet')
  .description('BRC-100 wallet for ClawSats with easy deployment and self-spreading capabilities')
  .version('0.1.0');

// Create wallet command
program
  .command('create')
  .description('Create a new BRC-100 wallet')
  .option('-n, --name <name>', 'Wallet name', `claw-${Date.now()}`)
  .option('-c, --chain <chain>', 'Blockchain network (main/test)', 'main')
  .option('-s, --storage <type>', 'Storage type (sqlite/memory)', 'sqlite')
  .action(async (options) => {
    try {
      console.log('Creating new ClawSats wallet...');
      
      const walletOptions: CreateWalletOptions = {
        name: options.name,
        chain: options.chain,
        storageType: options.storage
      };

      const config = await walletManager.createWallet(walletOptions);
      
      console.log('✅ Wallet created successfully!');
      console.log(`Identity Key: ${config.identityKey.substring(0, 32)}...`);
      console.log(`Chain: ${config.chain}`);
      console.log(`Storage: ${config.storageType} at ${config.storagePath}`);
      console.log(`Capabilities: ${config.capabilities.length} methods available`);
      console.log(`\nConfiguration saved to: config/wallet-config.json`);
      console.log(`\nTo start the wallet server:`);
      console.log(`  clawsats-wallet serve`);
      console.log(`\nTo share with other Claws:`);
      console.log(`  clawsats-wallet share --recipient claw://friend-id`);
      
    } catch (error) {
      console.error('❌ Failed to create wallet:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Serve wallet command
program
  .command('serve')
  .description('Start headless JSON-RPC wallet server')
  .option('-p, --port <port>', 'Port to listen on', '3321')
  .option('-H, --host <host>', 'Host to bind to', 'localhost')
  .option('-k, --api-key <key>', 'API key for admin JSON-RPC (auto-generated if public bind)')
  .option('--endpoint <url>', 'Public endpoint URL to advertise (for /discovery)')
  .option('--no-cors', 'Disable CORS', false)
  .option('--enable-discovery', 'Enable discovery endpoint', true)
  .option('--config <path>', 'Path to wallet config file', 'config/wallet-config.json')
  .action(async (options) => {
    try {
      // Load wallet configuration
      const configPath = join(process.cwd(), options.config);
      if (!existsSync(configPath)) {
        console.error(`❌ Config file not found: ${configPath}`);
        console.log('Create a wallet first: clawsats-wallet create');
        process.exit(1);
      }

      console.log('Loading wallet configuration...');
      await walletManager.loadWallet(configPath);
      
      const serveOptions: ServeOptions = {
        port: parseInt(options.port, 10),
        host: options.host,
        apiKey: options.apiKey,
        publicEndpoint: options.endpoint,
        cors: options.cors,
        enableDiscovery: options.enableDiscovery
      };

      const server = new JsonRpcServer(walletManager, serveOptions);
      
      console.log('Starting ClawSats wallet server...');
      await server.start();
      
      // Handle graceful shutdown
      process.on('SIGINT', async () => {
        console.log('\nShutting down...');
        await server.stop();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        console.log('\nTerminating...');
        await server.stop();
        process.exit(0);
      });

    } catch (error) {
      console.error('❌ Failed to start server:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Share wallet command
program
  .command('share')
  .description('Share wallet capabilities with other Claws')
  .requiredOption('-r, --recipient <clawIdOrUrl>', 'Recipient Claw ID or endpoint URL (e.g., http://1.2.3.4:3321)')
  .option('-o, --output <file>', 'Save invitation to file instead of sending')
  .option('--config <path>', 'Path to wallet config file', 'config/wallet-config.json')
  .action(async (options) => {
    try {
      if (!options.recipient || !String(options.recipient).trim()) {
        console.error('❌ Recipient endpoint is empty. Set PEER to a real endpoint first.');
        process.exit(1);
      }

      // Load wallet if not already loaded
      if (!walletManager.getConfig()) {
        const configPath = join(process.cwd(), options.config);
        if (!existsSync(configPath)) {
          console.error('❌ Config not found. Create a wallet first: clawsats-wallet create');
          process.exit(1);
        }
        await walletManager.loadWallet(configPath);
      }

      const config = walletManager.getConfig()!;
      const wallet = walletManager.getWallet();
      const sharing = new SharingProtocol(config, wallet);
      const isHttpRecipient = options.recipient.startsWith('http://') || options.recipient.startsWith('https://');

      let recipientIdentityKey: string | undefined;
      if (isHttpRecipient) {
        console.log(`🔍 Resolving recipient identity from ${options.recipient}/discovery ...`);
        const discRes = await fetch(`${options.recipient}/discovery`, {
          signal: AbortSignal.timeout(10000)
        });
        if (!discRes.ok) {
          throw new Error(`Recipient discovery failed: HTTP ${discRes.status}`);
        }
        const info: any = await discRes.json();
        if (!info?.identityKey || !/^(02|03)[0-9a-fA-F]{64}$/.test(info.identityKey)) {
          throw new Error('Recipient discovery response is missing a valid identityKey');
        }
        recipientIdentityKey = info.identityKey;
      }

      const recipientClawId = recipientIdentityKey
        ? `claw://${recipientIdentityKey.substring(0, 16)}`
        : options.recipient;

      const invitation = await sharing.createInvitation(recipientClawId, {
        recipientEndpoint: isHttpRecipient ? options.recipient : undefined,
        recipientIdentityKey
      });

      if (!invitation.signature) {
        console.error('❌ Failed to sign invitation. Ensure wallet signing is available and try again.');
        process.exit(1);
      }

      console.log(`📨 Invitation created: ${invitation.invitationId}`);

      if (options.output) {
        writeFileSync(options.output, JSON.stringify(invitation, null, 2));
        console.log(`✅ Invitation saved to: ${options.output}`);
      }

      // If recipient looks like a URL, send it directly via HTTP.
      // This path can be combined with --output for deployment scripts that
      // both persist and send invitations.
      if (isHttpRecipient) {
        console.log(`📤 Sending invitation to ${options.recipient}/wallet/invite ...`);
        const res = await fetch(`${options.recipient}/wallet/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(invitation),
          signal: AbortSignal.timeout(10000)
        });

        if (!res.ok) {
          const body = await res.text();
          console.error(`❌ Invitation rejected (${res.status}): ${body}`);
          process.exit(1);
        }

        const response: any = await res.json();
        console.log(`✅ Invitation accepted!`);
        if (response.announcement?.identityKey) {
          console.log(`  Peer identity: ${response.announcement.identityKey.substring(0, 24)}...`);
        }
        console.log(`  Peers known by recipient: ${response.peersKnown}`);
      } else if (!options.output) {
        // Print to stdout for piping
        console.log(JSON.stringify(invitation, null, 2));
      }
    } catch (error) {
      console.error('❌ Failed to share:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Health check command
program
  .command('health')
  .description('Check wallet health status')
  .option('-u, --url <url>', 'Health endpoint URL', 'http://localhost:3321/health')
  .action(async (options) => {
    try {
      const response = await fetch(options.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const health: any = await response.json();
      console.log('✅ Wallet Health Status:');
      console.log(`  Status: ${health.status}`);
      console.log(`  Timestamp: ${health.timestamp}`);
      console.log(`  Wallet: ${health.wallet.identityKey}`);
      console.log(`  Chain: ${health.wallet.chain}`);
      console.log(`  Capabilities: ${health.wallet.capabilities}`);
      console.log(`  Server: ${health.server.host}:${health.server.port}`);
      console.log(`  Uptime: ${Math.floor(health.server.uptime)} seconds`);
      
    } catch (error) {
      console.error('❌ Health check failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Discovery command — probe a known endpoint for its discovery info
program
  .command('discover')
  .description('Probe a Claw endpoint for its capabilities and peer info')
  .argument('[endpoint]', 'Endpoint URL to probe (e.g., http://1.2.3.4:3321)')
  .action(async (endpoint) => {
    try {
      if (!endpoint) {
        console.log('Usage: clawsats-wallet discover <endpoint>');
        console.log('Example: clawsats-wallet discover http://1.2.3.4:3321');
        return;
      }

      console.log(`🔍 Probing ${endpoint}/discovery ...`);
      const res = await fetch(`${endpoint}/discovery`, {
        signal: AbortSignal.timeout(10000)
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const info: any = await res.json();
      console.log('✅ Claw discovered:');
      console.log(`  Protocol:     ${info.protocol}`);
      console.log(`  Identity:     ${info.identityKey?.substring(0, 24)}...`);
      console.log(`  Network:      ${info.network}`);
      console.log(`  Known peers:  ${info.knownPeers}`);
      console.log(`  BRC-100:      ${(info.capabilities || []).join(', ')}`);
      if (info.paidCapabilities?.length) {
        console.log('  Paid capabilities:');
        for (const cap of info.paidCapabilities) {
          console.log(`    • ${cap.name} — ${cap.pricePerCall} sats — ${cap.description}`);
        }
      }
      console.log(`  Endpoints:`);
      for (const [name, url] of Object.entries(info.endpoints || {})) {
        console.log(`    • ${name}: ${url}`);
      }
    } catch (error) {
      console.error('❌ Discovery failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Announce command — publish OP_RETURN beacon on-chain
program
  .command('announce')
  .description('Publish an on-chain CLAWSATS_V1 beacon (OP_RETURN)')
  .option('--config <path>', 'Path to wallet config file', 'config/wallet-config.json')
  .option('--endpoint <url>', 'Public endpoint URL to advertise')
  .action(async (options) => {
    try {
      // Load wallet
      if (!walletManager.getConfig()) {
        const configPath = join(process.cwd(), options.config);
        if (!existsSync(configPath)) {
          console.error('❌ Config not found. Create a wallet first.');
          process.exit(1);
        }
        await walletManager.loadWallet(configPath);
      }

      const config = walletManager.getConfig()!;
      const wallet = walletManager.getWallet();
      const endpoint = options.endpoint || config.endpoints.jsonrpc;

      // Build OP_RETURN beacon with proper pushdata encoding
      const beaconPayload = JSON.stringify({
        protocol: 'CLAWSATS_V1',
        identityKey: config.identityKey,
        endpoint,
        chain: config.chain,
        capabilities: config.capabilities,
        timestamp: new Date().toISOString()
      });

      const opReturnScript = buildOpReturnScript('CLAWSATS_V1', beaconPayload);

      console.log('📡 Publishing on-chain beacon...');
      console.log(`  Tag:      CLAWSATS_V1`);
      console.log(`  Endpoint: ${endpoint}`);
      console.log(`  Chain:    ${config.chain}`);

      try {
        const result = await wallet.createAction({
          description: 'ClawSats beacon announcement',
          outputs: [{
            satoshis: 0,
            lockingScript: opReturnScript,
            outputDescription: 'CLAWSATS_V1 beacon'
          }],
          labels: ['clawsats-beacon'],
          options: { signAndProcess: true, acceptDelayedBroadcast: true }
        });

        console.log(`✅ Beacon published!`);
        console.log(`  TXID: ${result.txid}`);
        console.log(`  Any Claw scanning for CLAWSATS_V1 OP_RETURNs will find you.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`⚠️  Beacon tx failed: ${msg}`);
        console.log('  This may require funded UTXOs. Fund the wallet first.');
        console.log(`  Beacon payload (for manual broadcast):\n  ${beaconPayload}`);
      }
    } catch (error) {
      console.error('❌ Announce failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Earn command — one-command UX (BrowserAI #7)
// "If it's more than a minute or two, most Claws won't bother."
program
  .command('earn')
  .description('One command: create wallet + start server + publish beacon. You are live.')
  .option('-p, --port <port>', 'Port to listen on', '3321')
  .option('-H, --host <host>', 'Host to bind to', '0.0.0.0')
  .option('-c, --chain <chain>', 'Blockchain network (main/test)', 'main')
  .option('-n, --name <name>', 'Wallet name', `claw-${Date.now()}`)
  .option('-k, --api-key <key>', 'API key for admin JSON-RPC (auto-generated if public bind)')
  .option('--endpoint <url>', 'Public endpoint URL to advertise')
  .option('--no-beacon', 'Skip on-chain beacon publication')
  .action(async (options) => {
    try {
      const port = parseInt(options.port, 10);
      const host = options.host;
      const publicEndpoint = options.endpoint || `http://${host}:${port}`;

      // Step 1: Create or load wallet
      const configPath = join(process.cwd(), 'config/wallet-config.json');
      if (existsSync(configPath)) {
        console.log('Loading existing wallet...');
        await walletManager.loadWallet(configPath);
      } else {
        console.log('Creating new wallet...');
        await walletManager.createWallet({
          name: options.name,
          chain: options.chain,
          storageType: 'sqlite',
        });
      }

      const config = walletManager.getConfig()!;
      console.log(`\n⚡ Identity: ${config.identityKey.substring(0, 24)}...`);
      console.log(`⚡ Chain:    ${config.chain}`);

      // Step 2: Start server
      const server = new JsonRpcServer(walletManager, {
        port,
        host,
        apiKey: options.apiKey,
        publicEndpoint,
        cors: true,
        enableDiscovery: true
      });
      await server.start();

      // Step 3: Publish beacon (optional)
      if (options.beacon !== false) {
        console.log('\n📡 Publishing on-chain beacon...');
        try {
          const wallet = walletManager.getWallet();
          const beaconPayload = JSON.stringify({
            v: '1.0', id: config.identityKey, ep: publicEndpoint,
            ch: config.chain, cap: server.getCapabilityRegistry().listNames(),
            ts: new Date().toISOString(), sig: ''
          });
          const opReturnScript = buildOpReturnScript('CLAWSATS_V1', beaconPayload);
          const result = await wallet.createAction({
            description: 'ClawSats beacon',
            outputs: [{ satoshis: 0, lockingScript: opReturnScript, outputDescription: 'CLAWSATS_V1 beacon' }],
            labels: ['clawsats-beacon'],
            options: { signAndProcess: true, acceptDelayedBroadcast: true }
          });
          console.log(`  Beacon TXID: ${result.txid}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  Beacon skipped (${msg}). Fund wallet to enable.`);
        }
      }

      // Summary
      const caps = server.getCapabilityRegistry().listNames();
      console.log(`\n🟢 YOU ARE LIVE`);
      console.log(`  Manifest: ${publicEndpoint}/discovery`);
      console.log(`  Invite:   POST ${publicEndpoint}/wallet/invite`);
      console.log(`  Paid capabilities: ${caps.join(', ')}`);
      console.log(`\n  Share with another Claw:`);
      console.log(`    clawsats-wallet share -r http://<peer>:3321`);

      // Graceful shutdown
      const shutdown = async () => {
        console.log('\nShutting down...');
        await server.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

    } catch (error) {
      console.error('❌ Earn mode failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Watch command — active peer discovery daemon
program
  .command('watch')
  .description('Active peer discovery: probe known peers, discover new ones, auto-invite. Runs continuously.')
  .option('--config <path>', 'Path to wallet config file', 'config/wallet-config.json')
  .option('--interval <seconds>', 'Seconds between discovery sweeps', '60')
  .option('--seeds <urls>', 'Comma-separated seed peer URLs to bootstrap from')
  .option('--directory-url <url>', 'Directory API URL for automatic seed bootstrap (default: CLAWSATS_DIRECTORY_URL or https://clawsats.com/api/directory)')
  .option('--no-directory-bootstrap', 'Disable automatic directory seed bootstrap')
  .option('--once', 'Run one sweep and exit (don\'t loop)')
  .action(async (options) => {
    try {
      // Load wallet
      if (!walletManager.getConfig()) {
        const configPath = join(process.cwd(), options.config);
        if (!existsSync(configPath)) {
          console.error('❌ Config not found. Create a wallet first.');
          process.exit(1);
        }
        await walletManager.loadWallet(configPath);
      }

      const config = walletManager.getConfig()!;
      const wallet = walletManager.getWallet();
      const sharing = new SharingProtocol(config, wallet);
      const knownPeers = new Map<string, { endpoint: string; capabilities: string[] }>();
      const interval = parseInt(options.interval, 10) * 1000;
      const directoryBootstrap = options.directoryBootstrap !== false;
      const directoryUrl = (options.directoryUrl || process.env.CLAWSATS_DIRECTORY_URL || 'https://clawsats.com/api/directory').trim();
      const DIRECTORY_REFRESH_MS = 10 * 60 * 1000;
      let lastDirectoryRefresh = 0;

      function normalizeEndpoint(raw: unknown): string | null {
        if (typeof raw !== 'string') return null;
        const value = raw.trim();
        if (!value) return null;
        try {
          const u = new URL(value);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
          u.hash = '';
          u.search = '';
          return u.toString().replace(/\/$/, '');
        } catch {
          return null;
        }
      }

      // Seed peers from CLI input
      const cliSeeds: string[] = options.seeds
        ? options.seeds.split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];
      const seeds = new Set<string>();
      for (const seed of cliSeeds) {
        const normalized = normalizeEndpoint(seed);
        if (normalized) seeds.add(normalized);
      }

      async function refreshDirectorySeeds(force = false): Promise<number> {
        if (!directoryBootstrap) return 0;
        const now = Date.now();
        if (!force && now - lastDirectoryRefresh < DIRECTORY_REFRESH_MS) return 0;

        let added = 0;
        try {
          const response = await fetch(directoryUrl, {
            signal: AbortSignal.timeout(10000)
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const payload: any = await response.json();
          const rows = Array.isArray(payload?.claws) ? payload.claws : [];
          for (const row of rows) {
            const endpoint = normalizeEndpoint(row?.endpoint);
            if (!endpoint) continue;
            if (!seeds.has(endpoint)) {
              seeds.add(endpoint);
              added++;
            }
          }
          lastDirectoryRefresh = now;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  Directory bootstrap skipped (${msg})`);
        }
        return added;
      }

      console.log(`🔭 ClawSats Peer Discovery Daemon`);
      console.log(`  Identity: ${config.identityKey.substring(0, 24)}...`);
      console.log(`  Interval: ${interval / 1000}s`);
      if (seeds.size) console.log(`  CLI seeds: ${Array.from(seeds).join(', ')}`);
      if (directoryBootstrap) {
        console.log(`  Directory bootstrap: ${directoryUrl}`);
      } else {
        console.log('  Directory bootstrap: disabled');
      }

      const initialAdded = await refreshDirectorySeeds(true);
      if (initialAdded > 0) {
        console.log(`  Added ${initialAdded} seed endpoints from directory`);
      }

      async function discoverySweep() {
        const startTime = Date.now();
        let discovered = 0;
        let probed = 0;

        await refreshDirectorySeeds();

        // Collect all endpoints to probe: seeds + known peers
        const toProbe = new Set<string>(seeds);
        for (const [, peer] of knownPeers) {
          const endpoint = normalizeEndpoint(peer.endpoint);
          if (endpoint) toProbe.add(endpoint);
        }

        if (toProbe.size === 0 && directoryBootstrap) {
          await refreshDirectorySeeds(true);
          for (const endpoint of seeds) {
            toProbe.add(endpoint);
          }
        }

        if (toProbe.size === 0) {
          console.log('  No peers to probe. Add --seeds or keep directory bootstrap enabled.');
          return;
        }

        for (const endpoint of toProbe) {
          probed++;
          try {
            // Probe /discovery
            const discRes = await fetch(`${endpoint}/discovery`, {
              signal: AbortSignal.timeout(8000)
            });
            if (!discRes.ok) continue;
            const info: any = await discRes.json();

            if (!info.identityKey || info.identityKey === config.identityKey) continue;
            const advertisedEndpoint = normalizeEndpoint(info?.endpoints?.jsonrpc) || endpoint;

            const isNew = !knownPeers.has(info.identityKey);
            knownPeers.set(info.identityKey, {
              endpoint: advertisedEndpoint,
              capabilities: info.paidCapabilities?.map((c: any) => c.name) || []
            });

            if (isNew) {
              discovered++;
              const caps = info.paidCapabilities?.map((c: any) => `${c.name}(${c.pricePerCall}sat)`).join(', ') || 'none';
              console.log(`  ✨ NEW: ${info.identityKey.substring(0, 16)}... at ${advertisedEndpoint} — ${caps}`);

              // Auto-invite: send our invitation so they know about us too
              try {
                const invitation = await sharing.createInvitation(`claw://${info.identityKey.substring(0, 16)}`, {
                  recipientEndpoint: advertisedEndpoint,
                  recipientIdentityKey: info.identityKey
                });
                const invRes = await fetch(`${advertisedEndpoint}/wallet/invite`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(invitation),
                  signal: AbortSignal.timeout(8000)
                });
                if (invRes.ok) {
                  console.log(`    📨 Auto-invited — mutual peer registration`);
                }
              } catch {
                // Non-fatal — they know about us from the probe at least
              }
            }
          } catch {
            // Peer unreachable — skip
          }
        }

        const elapsed = Date.now() - startTime;
        console.log(`  Sweep: probed ${probed}, discovered ${discovered} new, ${knownPeers.size} total known (${elapsed}ms)`);
      }

      // Run first sweep immediately
      await discoverySweep();

      if (options.once) {
        console.log('\n  One-shot mode. Exiting.');
        return;
      }

      // Run continuously
      console.log(`\n  Running continuously. Ctrl+C to stop.\n`);
      const timer = setInterval(discoverySweep, interval);

      const shutdown = () => {
        clearInterval(timer);
        console.log('\n  Discovery daemon stopped.');
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Keep alive
      await new Promise(() => {});

    } catch (error) {
      console.error('❌ Watch failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Config command
program
  .command('config')
  .description('Show wallet configuration')
  .option('--config <path>', 'Path to wallet config file', 'config/wallet-config.json')
  .option('--show-secrets', 'Show sensitive information', false)
  .action(async (options) => {
    try {
      let config = walletManager.getConfig();
      if (!config) {
        const configPath = join(process.cwd(), options.config);
        if (!existsSync(configPath)) {
          console.error(`❌ Config file not found: ${configPath}`);
          console.log('Create a wallet first: clawsats-wallet create');
          process.exit(1);
        }
        await walletManager.loadWallet(configPath);
        config = walletManager.getConfig();
      }

      if (!config) {
        console.error('❌ Wallet not initialized. Create or load a wallet first.');
        process.exit(1);
      }

      console.log('📋 Wallet Configuration:');
      console.log(`  Identity Key: ${options.showSecrets ? config.identityKey : config.identityKey.substring(0, 32) + '...'}`);
      console.log(`  Chain: ${config.chain}`);
      console.log(`  Storage: ${config.storageType}`);
      if (config.storagePath) {
        console.log(`  Storage Path: ${config.storagePath}`);
      }
      console.log(`  Endpoints:`);
      console.log(`    • JSON-RPC: ${config.endpoints.jsonrpc}`);
      console.log(`    • Health: ${config.endpoints.health}`);
      console.log(`    • Discovery: ${config.endpoints.discovery}`);
      console.log(`  Capabilities: ${config.capabilities.length} methods`);
      console.log(`  ClawSats:`);
      console.log(`    • Fee Key ID: ${config.clawsats.feeKeyId}`);
      console.log(`    • Fee Suffix: ${config.clawsats.defaultFeeSuffix}`);
      
    } catch (error) {
      console.error('❌ Failed to show config:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse(process.argv);

// Show help if no arguments
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
