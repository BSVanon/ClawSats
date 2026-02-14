#!/usr/bin/env node

import { Command } from 'commander';
import { WalletManager } from '../core/WalletManager';
import { JsonRpcServer } from '../server/JsonRpcServer';
import { CreateWalletOptions, ServeOptions } from '../types';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const program = new Command();
const walletManager = new WalletManager();

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
  .option('-k, --api-key <key>', 'API key for authentication (optional)')
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
  .requiredOption('-r, --recipient <clawId>', 'Recipient Claw ID (e.g., claw://friend-id)')
  .option('-c, --capability <type>', 'Capability to share', 'payment')
  .option('-m, --message <text>', 'Optional message to include')
  .option('--auto-deploy', 'Include auto-deployment script', true)
  .option('--channels <channels>', 'Channels to use (comma-separated: messagebox,overlay,direct)', 'messagebox,overlay')
  .option('-o, --output <file>', 'Output invitation file (optional)')
  .action(async (options) => {
    try {
      const config = walletManager.getConfig();
      if (!config) {
        console.error('❌ Wallet not initialized. Create or load a wallet first.');
        process.exit(1);
      }

      console.log('Creating wallet invitation...');
      
      // Generate invitation
      const invitation = {
        type: 'wallet-invitation',
        version: '1.0',
        invitationId: `invite-${Date.now()}`,
        sender: {
          clawId: `claw://${config.identityKey.substring(0, 16)}`,
          identityKey: config.identityKey,
          endpoint: config.endpoints.jsonrpc
        },
        recipient: {
          clawId: options.recipient
        },
        walletConfig: {
          chain: config.chain,
          capabilities: config.capabilities,
          autoDeployScript: 'https://clawsats.org/deploy/v1.sh',
          configTemplate: {
            identityKey: '{{GENERATED}}',
            endpoints: {
              jsonrpc: 'http://localhost:3321'
            }
          }
        },
        expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
        signature: 'TODO: Generate signature',
        timestamp: new Date().toISOString()
      };

      // Save to file if output specified
      if (options.output) {
        writeFileSync(options.output, JSON.stringify(invitation, null, 2));
        console.log(`✅ Invitation saved to: ${options.output}`);
      } else {
        console.log(JSON.stringify(invitation, null, 2));
      }

      console.log('\n📤 Sharing via channels:');
      options.channels.split(',').forEach((channel: string) => {
        switch (channel.trim()) {
          case 'messagebox':
            console.log('  • BRC-33 MessageBox: Direct Claw-to-Claw messaging');
            break;
          case 'overlay':
            console.log('  • Overlay Network: Broadcast to multiple Claws');
            break;
          case 'direct':
            console.log('  • Direct HTTP: Send invitation via HTTP');
            break;
        }
      });

      console.log('\n📋 Next steps for recipient:');
      console.log('  1. Save invitation to file: invitation.json');
      console.log('  2. Run auto-deployment:');
      console.log(`     curl -s https://clawsats.org/deploy/v1.sh | bash -s -- ${options.recipient} invitation.json`);
      console.log('  3. Or manually deploy:');
      console.log('     clawsats-wallet create --config invitation.json');

    } catch (error) {
      console.error('❌ Failed to create invitation:', error instanceof Error ? error.message : String(error));
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

// Discovery command
program
  .command('discover')
  .description('Discover nearby Claws with wallet capabilities')
  .option('-c, --capability <type>', 'Capability to search for', 'payment')
  .option('-n, --network <chain>', 'Network to search (test/main)', 'test')
  .option('-l, --limit <number>', 'Maximum results', '10')
  .action(async (options) => {
    try {
      console.log(`🔍 Discovering Claws with ${options.capability} capability...`);
      
      // In production, this would query overlay networks, DHT, or registries
      console.log('Discovery service coming soon!');
      console.log('\nPlanned discovery methods:');
      console.log('  • Local network broadcast');
      console.log('  • Overlay network queries');
      console.log('  • Distributed Hash Table (DHT)');
      console.log('  • On-chain announcements');
      console.log('\nFor now, share invitations directly with known Claws.');
      
    } catch (error) {
      console.error('❌ Discovery failed:', error instanceof Error ? error.message : String(error));
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