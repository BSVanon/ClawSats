#!/usr/bin/env node

import { Command } from 'commander';
import { WalletManager } from '../core/WalletManager';
import { JsonRpcServer } from '../server/JsonRpcServer';
import { SharingProtocol } from '../protocol';
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
  .option('-c, --chain <chain>', 'Blockchain network (test/main)', 'test')
  .option('-s, --storage <type>', 'Storage type (sqlite/memory)', 'sqlite')
  .option('--auto-fund', 'Automatically fund with testnet BSV', false)
  .option('--no-auto-fund', 'Skip testnet funding')
  .action(async (options) => {
    try {
      console.log('Creating new ClawSats wallet...');
      
      const walletOptions: CreateWalletOptions = {
        name: options.name,
        chain: options.chain,
        storageType: options.storage,
        autoFund: options.autoFund
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
      const invitation = await sharing.createInvitation(options.recipient);

      console.log(`📨 Invitation created: ${invitation.invitationId}`);

      // If recipient looks like a URL, send it directly via HTTP
      if (options.recipient.startsWith('http://') || options.recipient.startsWith('https://')) {
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
      } else if (options.output) {
        writeFileSync(options.output, JSON.stringify(invitation, null, 2));
        console.log(`✅ Invitation saved to: ${options.output}`);
      } else {
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
            script: opReturnScript,
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
  .option('-c, --chain <chain>', 'Blockchain network (test/main)', 'test')
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
          storageType: 'sqlite'
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
            outputs: [{ satoshis: 0, script: opReturnScript, outputDescription: 'CLAWSATS_V1 beacon' }],
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

// Watch command — scan for CLAWSATS_V1 beacons (BrowserAI #6)
program
  .command('watch')
  .description('Scan for CLAWSATS_V1 on-chain beacons and probe discovered Claws')
  .option('--config <path>', 'Path to wallet config file', 'config/wallet-config.json')
  .option('--limit <n>', 'Max beacons to process', '20')
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

      const wallet = walletManager.getWallet();
      console.log('🔭 Scanning for CLAWSATS_V1 beacons...');

      // Query wallet for beacon-labeled actions
      try {
        const actions = await wallet.listActions({
          labels: ['clawsats-beacon'],
          limit: parseInt(options.limit, 10),
          includeOutputs: true
        });

        if (!actions.actions?.length) {
          console.log('  No beacons found in local wallet history.');
          console.log('  In production, this will scan overlay networks and on-chain OP_RETURNs.');
          return;
        }

        console.log(`  Found ${actions.actions.length} beacon(s):`);
        for (const action of actions.actions) {
          console.log(`  • TXID: ${action.txid}`);
        }
      } catch {
        console.log('  Beacon scanning requires a funded wallet with history.');
        console.log('  For now, use "discover" to probe known endpoints directly:');
        console.log('    clawsats-wallet discover http://<peer>:3321');
      }

      console.log('\n  Reference watcher: in production, this command will:');
      console.log('    1. Scan overlay networks for CLAWSATS_V1 OP_RETURNs');
      console.log('    2. Parse strict beacon payload (v, id, ep, ch, cap, ts, sig)');
      console.log('    3. Verify beacon signature against id (pubkey)');
      console.log('    4. Probe discovered endpoints via /discovery');
      console.log('    5. Surface new gigs to the local Claw');

    } catch (error) {
      console.error('❌ Watch failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Config command
program
  .command('config')
  .description('Show wallet configuration')
  .option('--show-secrets', 'Show sensitive information', false)
  .action((options) => {
    try {
      const config = walletManager.getConfig();
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