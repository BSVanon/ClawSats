#!/usr/bin/env node

import { Command } from 'commander';
import { WalletManager } from '../core/WalletManager';
import { JsonRpcServer } from '../server/JsonRpcServer';
import { ClawBrain, BrainPolicy } from '../core/ClawBrain';
import { BrainJob, BrainJobStore, BrainJobStatus, BrainJobStrategy } from '../core/BrainJobs';
import { SharingProtocol } from '../protocol';
import { BEACON_MAX_BYTES } from '../protocol/constants';
import { PaymentHelper } from '../core/PaymentHelper';
import { OnChainMemory } from '../memory/OnChainMemory';
import { CreateWalletOptions, ServeOptions } from '../types';
import { existsSync, writeFileSync, readFileSync } from 'fs';
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

function formatShort(value: string, keep = 24): string {
  if (!value) return '(none)';
  return value.length > keep ? `${value.substring(0, keep)}...` : value;
}

function parseJsonFile(path: string): any {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function parsePolicyOverride(value: string): unknown {
  const raw = value.trim();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function setByPath(target: Record<string, any>, path: string, value: any): void {
  const keys = path.split('.').map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error('Invalid policy path');
  let ref: Record<string, any> = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!ref[key] || typeof ref[key] !== 'object' || Array.isArray(ref[key])) {
      ref[key] = {};
    }
    ref = ref[key];
  }
  ref[keys[keys.length - 1]] = value;
}

interface KnownPeerCandidate {
  identityKey: string;
  endpoint: string;
  capabilities: string[];
}

function normalizePublicEndpoint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(u.hostname)) return null;
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function loadKnownPeers(dataDir: string): KnownPeerCandidate[] {
  const parsed = parseJsonFile(join(dataDir, 'watch-peers.json'));
  const rows = Array.isArray(parsed?.peers) ? parsed.peers : [];
  const peers: KnownPeerCandidate[] = [];
  for (const row of rows) {
    const endpoint = normalizePublicEndpoint(row?.endpoint);
    if (!endpoint) continue;
    const identityKey = typeof row?.identityKey === 'string' ? row.identityKey : '';
    if (!identityKey) continue;
    const capabilities = Array.isArray(row?.capabilities)
      ? row.capabilities.map((c: unknown) => String(c)).filter(Boolean)
      : [];
    peers.push({ identityKey, endpoint, capabilities });
  }
  return peers;
}

function pickPeerForCapability(
  capability: string,
  peers: KnownPeerCandidate[],
  preferredEndpoint?: string
): KnownPeerCandidate | null {
  const preferred = normalizePublicEndpoint(preferredEndpoint || '');
  if (preferred) {
    const match = peers.find(p => p.endpoint === preferred && p.capabilities.includes(capability));
    if (match) return match;
  }
  const matching = peers.filter(p => p.capabilities.includes(capability));
  if (matching.length === 0) return null;
  matching.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  return matching[0];
}

function safeParseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function normalizeCapabilityCallParams(capability: string, rawParams: Record<string, unknown>): Record<string, unknown> {
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
  return params;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function normalizeLocalEndpoint(raw: string | undefined): string {
  const fallback = 'http://127.0.0.1:3321';
  const value = String(raw || '').trim();
  if (!value) return fallback;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    if (parsed.hostname === '0.0.0.0') parsed.hostname = '127.0.0.1';
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

function isAutoHireCapabilityAllowed(policy: BrainPolicy, capability: string): boolean {
  const allowlist = Array.isArray(policy.decisions.autoHireCapabilities)
    ? policy.decisions.autoHireCapabilities
    : [];
  if (allowlist.length === 0) return true;
  return allowlist.includes(capability);
}

interface GoalJobGenerationSummary {
  generated: number;
  skippedActive: number;
  skippedCooldown: number;
  skippedDisabled: number;
}

function enqueueGoalJobsFromPolicy(source: string, policy: BrainPolicy, brain: ClawBrain, jobs: BrainJobStore): GoalJobGenerationSummary {
  const summary: GoalJobGenerationSummary = {
    generated: 0,
    skippedActive: 0,
    skippedCooldown: 0,
    skippedDisabled: 0
  };
  const goals = policy.goals;
  if (!goals || !goals.autoGenerateJobs) return summary;

  const templates = Array.isArray(goals.templates) ? goals.templates : [];
  const nowMs = Date.now();
  const defaultIntervalSeconds = Math.max(30, Number(goals.generateJobsEverySeconds || 300));
  const allJobs = jobs.list();

  for (let i = 0; i < templates.length; i++) {
    const template = templates[i];
    if (!template || template.enabled === false) {
      summary.skippedDisabled++;
      continue;
    }

    const capability = String(template.capability || '').trim();
    if (!capability) {
      summary.skippedDisabled++;
      continue;
    }

    const params = normalizeCapabilityCallParams(
      capability,
      template.params && typeof template.params === 'object'
        ? template.params as Record<string, unknown>
        : {}
    );
    const fingerprint = `${capability}::${stableStringify(params)}`;
    const matching = allJobs.filter(job => {
      if (job.capability !== capability) return false;
      const candidate = normalizeCapabilityCallParams(capability, job.params || {});
      return `${job.capability}::${stableStringify(candidate)}` === fingerprint;
    });

    const hasActive = matching.some(job => ['pending', 'running', 'needs_approval'].includes(job.status));
    if (hasActive) {
      summary.skippedActive++;
      continue;
    }

    const intervalSeconds = Math.max(30, Number(template.everySeconds || defaultIntervalSeconds));
    const intervalMs = intervalSeconds * 1000;
    const lastSeenMs = matching.reduce((max, job) => {
      const ts = Date.parse(job.updatedAt || job.createdAt || '');
      return Number.isFinite(ts) ? Math.max(max, ts) : max;
    }, 0);

    if (lastSeenMs > 0 && (nowMs - lastSeenMs) < intervalMs) {
      summary.skippedCooldown++;
      continue;
    }

    const strategyRaw = String(template.strategy || goals.defaultStrategy || 'auto').toLowerCase();
    const strategy: BrainJobStrategy = strategyRaw === 'local' || strategyRaw === 'hire' ? strategyRaw : 'auto';
    const maxSats = Math.max(
      1,
      Math.floor(
        Number(
          template.maxSats ??
          goals.defaultMaxSats ??
          policy.decisions.autoHireMaxSats
        ) || 1
      )
    );
    const priority = Math.max(
      1,
      Math.floor(
        Number(
          template.priority ??
          goals.defaultPriority ??
          100
        ) || 1
      )
    );
    const persistResult = template.persistResult === true;
    const memoryCategory = template.memoryCategory || (persistResult ? 'goal-result' : undefined);
    const memoryKey = template.memoryKey || (persistResult ? `goals/${capability}/${i}` : undefined);

    const job = jobs.enqueue({
      capability,
      params,
      strategy,
      maxSats,
      priority,
      persistResult,
      memoryKey,
      memoryCategory
    });

    job.audit.push({
      ts: new Date().toISOString(),
      action: 'goal-generated',
      reason: `Policy template queued job (${source})`,
      details: { templateIndex: i, fingerprint }
    });
    jobs.update(job);
    allJobs.push(job);

    brain.logEvent({
      source,
      action: 'goal-job-generated',
      reason: `Queued policy goal job for ${capability}`,
      details: { jobId: job.id, templateIndex: i, strategy, maxSats, priority }
    });
    summary.generated++;
  }

  return summary;
}

interface ExecuteBrainJobsOptions {
  source: string;
  allowMemoryWrite: boolean;
  maxJobs: number;
  dataDir: string;
  policy: BrainPolicy;
  brain: ClawBrain;
  jobs: BrainJobStore;
  wallet: any;
  identityKey: string;
  peers: KnownPeerCandidate[];
  localEndpoint?: string;
}

async function executeBrainJobs(options: ExecuteBrainJobsOptions): Promise<{
  processed: number;
  completed: number;
  failed: number;
  awaitingApproval: number;
}> {
  const { source, allowMemoryWrite, maxJobs, dataDir, policy, brain, jobs, wallet, identityKey, peers } = options;
  const localEndpoint = normalizeLocalEndpoint(options.localEndpoint);
  const onChainMemory = new OnChainMemory(dataDir, identityKey);
  onChainMemory.loadIndex();

  const pending = jobs.nextPending(maxJobs);
  if (pending.length === 0) {
    return { processed: 0, completed: 0, failed: 0, awaitingApproval: 0 };
  }

  let completed = 0;
  let failed = 0;
  let awaitingApproval = 0;

  for (const job of pending) {
    if (job.status === 'needs_approval') {
      if (!allowMemoryWrite) {
        awaitingApproval++;
        continue;
      }

      try {
        if (!policy.decisions.writeMemoryEnabled) {
          job.status = 'completed';
          job.memoryStatus = 'skipped';
          job.audit.push({
            ts: new Date().toISOString(),
            action: 'memory-skipped',
            reason: 'Policy disabled memory writes'
          });
        } else {
          const memoryKey = job.memoryKey || `jobs/${job.id}`;
          const memoryCategory = job.memoryCategory || 'job-result';
          const payload = JSON.stringify({
            jobId: job.id,
            capability: job.capability,
            endpoint: job.selectedEndpoint,
            result: job.result,
            recordedAt: new Date().toISOString()
          });
          const record = await onChainMemory.writeMemory(wallet, {
            key: memoryKey,
            data: payload,
            category: memoryCategory,
            metadata: {
              source,
              capability: job.capability,
              endpoint: job.selectedEndpoint
            }
          });
          job.status = 'completed';
          job.memoryStatus = 'written';
          job.memoryTxid = record.txid;
          job.audit.push({
            ts: new Date().toISOString(),
            action: 'memory-written',
            reason: 'Approved memory write completed',
            details: { txid: record.txid, key: memoryKey, category: memoryCategory }
          });
          brain.logEvent({
            source,
            action: 'memory-written',
            reason: `Approved memory write for ${job.id}`,
            details: { txid: record.txid, key: memoryKey }
          });
        }
        jobs.update(job);
        completed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        job.status = 'failed';
        job.error = msg;
        job.audit.push({
          ts: new Date().toISOString(),
          action: 'job-failed',
          reason: `Approval memory write failed: ${msg}`
        });
        jobs.update(job);
        failed++;
      }
      continue;
    }

    const now = new Date().toISOString();
    job.status = 'running';
    job.attempts += 1;
    job.audit.push({
      ts: now,
      action: 'job-started',
      reason: `Job execution started from ${source}`,
      details: { attempt: job.attempts, strategy: job.strategy }
    });
    jobs.update(job);
    brain.logEvent({
      source,
      action: 'job-started',
      reason: `Started job ${job.id}`,
      details: { capability: job.capability, strategy: job.strategy, attempt: job.attempts }
    });

    try {
      const maxSats = Math.max(1, Math.floor(job.maxSats || policy.decisions.autoHireMaxSats));
      const normalizedParams = normalizeCapabilityCallParams(job.capability, job.params || {});
      job.params = normalizedParams;
      const remoteCandidate = pickPeerForCapability(job.capability, peers, job.selectedEndpoint);
      const autoHireAllowed = isAutoHireCapabilityAllowed(policy, job.capability);
      let executionMode: 'local' | 'hire';
      let selectedEndpoint = '';
      let completionReason = '';

      if (job.strategy === 'local') {
        executionMode = 'local';
        completionReason = 'Local capability executed successfully';
      } else if (job.strategy === 'hire') {
        if (!policy.decisions.hireEnabled) {
          throw new Error('Policy disabled hiring.');
        }
        if (!autoHireAllowed) {
          throw new Error(`Capability "${job.capability}" is outside auto-hire allowlist.`);
        }
        if (!remoteCandidate) {
          throw new Error(`No known peer currently advertises capability "${job.capability}".`);
        }
        executionMode = 'hire';
        selectedEndpoint = remoteCandidate.endpoint;
        completionReason = 'Remote capability executed successfully';
      } else {
        if (remoteCandidate && policy.decisions.hireEnabled && autoHireAllowed) {
          executionMode = 'hire';
          selectedEndpoint = remoteCandidate.endpoint;
          completionReason = 'Auto strategy selected remote capability execution';
        } else {
          executionMode = 'local';
          completionReason = remoteCandidate
            ? 'Auto strategy fell back to local execution due to hire policy constraints'
            : 'Auto strategy fell back to local execution (no remote peer available)';
        }
      }

      const endpointBase = executionMode === 'local' ? localEndpoint : selectedEndpoint;
      const callEndpoint = `${endpointBase}/call/${encodeURIComponent(job.capability)}`;
      const result = await PaymentHelper.payForCapability(
        wallet,
        callEndpoint,
        normalizedParams,
        identityKey,
        { maxTotalSats: maxSats, timeoutMs: 30000 }
      );

      job.selectedEndpoint = endpointBase;
      job.result = result;
      job.error = undefined;
      job.status = 'completed';
      job.audit.push({
        ts: new Date().toISOString(),
        action: 'job-completed',
        reason: completionReason,
        details: { endpoint: endpointBase, capability: job.capability, strategy: executionMode }
      });

      brain.logEvent({
        source,
        action: 'job-completed',
        reason: `Completed job ${job.id}`,
        details: { endpoint: endpointBase, capability: job.capability, strategy: executionMode }
      });

      if (job.persistResult) {
        if (!policy.decisions.writeMemoryEnabled) {
          job.memoryStatus = 'skipped';
          job.audit.push({
            ts: new Date().toISOString(),
            action: 'memory-skipped',
            reason: 'Policy disabled memory writes'
          });
        } else if (policy.decisions.requireHumanApprovalForMemory && !allowMemoryWrite) {
          job.status = 'needs_approval';
          job.memoryStatus = 'pending_approval';
          job.audit.push({
            ts: new Date().toISOString(),
            action: 'memory-awaiting-approval',
            reason: 'Policy requires explicit approval before writing memory'
          });
          awaitingApproval++;
          brain.logEvent({
            source,
            action: 'memory-awaiting-approval',
            reason: `Job ${job.id} requires memory write approval`,
            details: { memoryKey: job.memoryKey || `jobs/${job.id}` }
          });
        } else {
          const memoryKey = job.memoryKey || `jobs/${job.id}`;
          const memoryCategory = job.memoryCategory || 'job-result';
          const payload = JSON.stringify({
            jobId: job.id,
            capability: job.capability,
            endpoint: job.selectedEndpoint,
            result: job.result,
            recordedAt: new Date().toISOString()
          });
          const record = await onChainMemory.writeMemory(wallet, {
            key: memoryKey,
            data: payload,
            category: memoryCategory,
            metadata: {
              source,
              capability: job.capability,
              endpoint: job.selectedEndpoint
            }
          });
          job.memoryStatus = 'written';
          job.memoryTxid = record.txid;
          job.audit.push({
            ts: new Date().toISOString(),
            action: 'memory-written',
            reason: 'Result persisted to on-chain memory',
            details: { txid: record.txid, key: memoryKey, category: memoryCategory }
          });
          brain.logEvent({
            source,
            action: 'memory-written',
            reason: `Persisted job result for ${job.id}`,
            details: { txid: record.txid, key: memoryKey }
          });
        }
      }

      completed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = 'failed';
      job.error = msg;
      job.audit.push({
        ts: new Date().toISOString(),
        action: 'job-failed',
        reason: msg
      });
      failed++;
      brain.logEvent({
        source,
        action: 'job-failed',
        reason: `Job ${job.id} failed`,
        details: { error: msg, capability: job.capability }
      });
    } finally {
      jobs.update(job);
    }
  }

  return {
    processed: pending.length,
    completed,
    failed,
    awaitingApproval
  };
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
      console.log(`  node dist/cli/index.js serve`);
      console.log(`\nTo share with other Claws:`);
      console.log(`  node dist/cli/index.js share --recipient claw://friend-id`);
      
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
  .option('--sender-endpoint <url>', 'Public endpoint URL this Claw should advertise in invitations')
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
      const isLocalEndpoint = (value?: string) => {
        if (!value) return true;
        return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(value);
      };

      let senderEndpoint = String(options.senderEndpoint || config.endpoints.jsonrpc || '').trim();
      if (isHttpRecipient && isLocalEndpoint(senderEndpoint)) {
        try {
          const localDisc = await fetch('http://127.0.0.1:3321/discovery', {
            signal: AbortSignal.timeout(3000)
          });
          if (localDisc.ok) {
            const localInfo: any = await localDisc.json();
            const discoveredSender = String(localInfo?.endpoints?.jsonrpc || '').trim();
            if (!isLocalEndpoint(discoveredSender)) {
              senderEndpoint = discoveredSender;
            }
          }
        } catch {
          // We'll fail with a clear message below if sender endpoint remains local-only.
        }
      }
      if (isHttpRecipient && isLocalEndpoint(senderEndpoint)) {
        throw new Error('Sender endpoint is local-only. Pass --sender-endpoint http://YOUR_PUBLIC_HOST:3321');
      }

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
        recipientIdentityKey,
        senderEndpoint
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
        console.log('Usage: node dist/cli/index.js discover <endpoint>');
        console.log('Example: node dist/cli/index.js discover http://1.2.3.4:3321');
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
      console.log(`    node dist/cli/index.js share -r http://<peer>:3321`);

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
  .option('--interval <seconds>', 'Seconds between discovery sweeps (default: policy value)')
  .option('--seeds <urls>', 'Comma-separated seed peer URLs to bootstrap from')
  .option('--directory-url <url>', 'Directory API URL for automatic seed bootstrap (default: CLAWSATS_DIRECTORY_URL or https://clawsats.com/api/directory)')
  .option('--directory-register-url <url>', 'Directory API URL for self-registration (default derived from directory URL)')
  .option('--policy <path>', 'Path to claw brain policy file', 'data/brain-policy.json')
  .option('--no-directory-register', 'Disable periodic self-registration in the directory')
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
      const dataDir = join(process.cwd(), 'data');
      const brain = new ClawBrain(dataDir, options.policy);
      const policy = brain.loadPolicy();
      const jobStore = new BrainJobStore(dataDir);
      const knownPeers = new Map<string, { endpoint: string; capabilities: string[] }>();
      const intervalSeconds = Math.max(5, parseInt(options.interval || String(policy.timers.discoveryIntervalSeconds), 10));
      const interval = intervalSeconds * 1000;
      const directoryBootstrap = options.directoryBootstrap !== false;
      const directoryUrl = (options.directoryUrl || process.env.CLAWSATS_DIRECTORY_URL || 'https://clawsats.com/api/directory').trim();
      const derivedRegisterUrl = directoryUrl.replace(/\/$/, '').endsWith('/api/directory')
        ? `${directoryUrl.replace(/\/$/, '')}/register`
        : `${directoryUrl.replace(/\/$/, '')}/register`;
      const directoryRegisterUrl = (options.directoryRegisterUrl || process.env.CLAWSATS_DIRECTORY_REGISTER_URL || derivedRegisterUrl).trim();
      const directoryRegisterEnabled = options.directoryRegister !== false && policy.timers.directoryRegisterEnabled;
      const directoryRegisterEveryMs = Math.max(30, policy.timers.directoryRegisterEverySeconds) * 1000;
      const DIRECTORY_REFRESH_MS = 10 * 60 * 1000;
      let lastDirectoryRefresh = 0;
      let lastDirectoryRegister = 0;
      const watchPeersPath = join(dataDir, 'watch-peers.json');

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
      console.log(`  Auto-invite: ${policy.timers.autoInviteOnDiscovery}`);
      console.log(`  Directory register: ${directoryRegisterEnabled ? directoryRegisterUrl : 'disabled'}`);
      console.log(`  Goal jobs: ${policy.goals.autoGenerateJobs} (every ${policy.goals.generateJobsEverySeconds}s)`);

      brain.logEvent({
        source: 'watch',
        action: 'watch-started',
        reason: 'Peer discovery daemon started',
        details: {
          intervalSeconds,
          directoryBootstrap,
          directoryRegisterEnabled,
          directoryUrl
        }
      });

      const persisted = parseJsonFile(watchPeersPath);
      const persistedPeers = Array.isArray(persisted?.peers) ? persisted.peers : [];
      for (const peer of persistedPeers) {
        if (!peer || typeof peer.identityKey !== 'string') continue;
        if (peer.identityKey === config.identityKey) continue;
        const endpoint = normalizeEndpoint(peer.endpoint);
        if (!endpoint) continue;
        knownPeers.set(peer.identityKey, {
          endpoint,
          capabilities: Array.isArray(peer.capabilities) ? peer.capabilities : []
        });
      }

      const persistKnownPeers = () => {
        const peers = Array.from(knownPeers.entries()).map(([identityKey, peer]) => ({
          identityKey,
          endpoint: peer.endpoint,
          capabilities: peer.capabilities,
          lastSeenAt: new Date().toISOString()
        }));
        writeFileSync(watchPeersPath, JSON.stringify({ peers }, null, 2), 'utf8');
      };

      async function resolveAdvertisedEndpoint(): Promise<string | null> {
        try {
          const localDisc = await fetch('http://127.0.0.1:3321/discovery', {
            signal: AbortSignal.timeout(3000)
          });
          if (localDisc.ok) {
            const localInfo: any = await localDisc.json();
            const discovered = normalizeEndpoint(localInfo?.endpoints?.jsonrpc);
            if (discovered && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(discovered)) {
              return discovered;
            }
          }
        } catch {
          // fallback to config endpoint
        }
        const cfgEndpoint = normalizeEndpoint(config.endpoints.jsonrpc);
        if (!cfgEndpoint || /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(cfgEndpoint)) return null;
        return cfgEndpoint;
      }

      async function registerInDirectory(force = false): Promise<void> {
        if (!directoryRegisterEnabled) return;
        const now = Date.now();
        if (!force && now - lastDirectoryRegister < directoryRegisterEveryMs) return;
        lastDirectoryRegister = now;

        const endpoint = await resolveAdvertisedEndpoint();
        if (!endpoint) {
          brain.logEvent({
            source: 'watch',
            action: 'directory-register-skipped',
            reason: 'Public endpoint is unavailable (still local-only)',
            details: { endpoint: config.endpoints.jsonrpc }
          });
          return;
        }

        let capabilities: string[] = Array.isArray(config.capabilities) ? [...config.capabilities] : [];
        try {
          const localDisc = await fetch('http://127.0.0.1:3321/discovery', {
            signal: AbortSignal.timeout(3000)
          });
          if (localDisc.ok) {
            const info: any = await localDisc.json();
            const paid = Array.isArray(info?.paidCapabilities)
              ? info.paidCapabilities.map((c: any) => String(c?.name || '')).filter(Boolean)
              : [];
            capabilities = Array.from(new Set([...capabilities, ...paid]));
          }
        } catch {
          // Keep config capability list.
        }

        try {
          const res = await fetch(directoryRegisterUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              identityKey: config.identityKey,
              endpoint,
              capabilities
            }),
            signal: AbortSignal.timeout(8000)
          });
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            brain.logEvent({
              source: 'watch',
              action: 'directory-register-failed',
              reason: `HTTP ${res.status}`,
              details: { body: body.slice(0, 400), endpoint }
            });
            return;
          }
          brain.logEvent({
            source: 'watch',
            action: 'directory-register-ok',
            reason: 'Directory registration refreshed',
            details: { endpoint, capabilities: capabilities.length }
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          brain.logEvent({
            source: 'watch',
            action: 'directory-register-failed',
            reason: msg,
            details: { endpoint }
          });
        }
      }

      const initialAdded = await refreshDirectorySeeds(true);
      if (initialAdded > 0) {
        console.log(`  Added ${initialAdded} seed endpoints from directory`);
      }

      async function discoverySweep() {
        const startTime = Date.now();
        let discovered = 0;
        let probed = 0;

        await registerInDirectory();
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
          brain.logEvent({
            source: 'watch',
            action: 'sweep-idle',
            reason: 'No peers available to probe',
            details: { knownPeers: knownPeers.size, seeds: seeds.size }
          });
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
              brain.logEvent({
                source: 'watch',
                action: 'peer-discovered',
                reason: 'Found a new peer during sweep',
                details: {
                  identityKey: info.identityKey,
                  endpoint: advertisedEndpoint,
                  capabilities: info.paidCapabilities?.length || 0
                }
              });

              // Auto-invite: send our invitation so they know about us too
              if (policy.timers.autoInviteOnDiscovery) {
                try {
                  let senderEndpoint = config.endpoints.jsonrpc;
                  try {
                    const localDisc = await fetch('http://127.0.0.1:3321/discovery', {
                      signal: AbortSignal.timeout(3000)
                    });
                    if (localDisc.ok) {
                      const localInfo: any = await localDisc.json();
                      const discovered = String(localInfo?.endpoints?.jsonrpc || '').trim();
                      if (discovered && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(discovered)) {
                        senderEndpoint = discovered;
                      }
                    }
                  } catch {
                    // Keep existing endpoint if discovery lookup fails.
                  }
                  const invitation = await sharing.createInvitation(`claw://${info.identityKey.substring(0, 16)}`, {
                    recipientEndpoint: advertisedEndpoint,
                    recipientIdentityKey: info.identityKey,
                    senderEndpoint
                  });
                  const invRes = await fetch(`${advertisedEndpoint}/wallet/invite`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(invitation),
                    signal: AbortSignal.timeout(8000)
                  });
                  if (invRes.ok) {
                    console.log(`    📨 Auto-invited — mutual peer registration`);
                    brain.logEvent({
                      source: 'watch',
                      action: 'auto-invite-ok',
                      reason: 'Auto invite succeeded for discovered peer',
                      details: { identityKey: info.identityKey, endpoint: advertisedEndpoint }
                    });
                  } else {
                    const body = await invRes.text().catch(() => '');
                    brain.logEvent({
                      source: 'watch',
                      action: 'auto-invite-failed',
                      reason: `HTTP ${invRes.status}`,
                      details: { identityKey: info.identityKey, endpoint: advertisedEndpoint, body: body.slice(0, 300) }
                    });
                  }
                } catch {
                  brain.logEvent({
                    source: 'watch',
                    action: 'auto-invite-failed',
                    reason: 'Auto invite threw before completion',
                    details: { identityKey: info.identityKey, endpoint: advertisedEndpoint }
                  });
                }
              } else {
                brain.logEvent({
                  source: 'watch',
                  action: 'auto-invite-skipped',
                  reason: 'Policy disabled auto invite on discovery',
                  details: { identityKey: info.identityKey, endpoint: advertisedEndpoint }
                });
              }
            }
          } catch {
            // Peer unreachable — skip
          }
        }

        persistKnownPeers();
        const goalSummary = enqueueGoalJobsFromPolicy('watch', policy, brain, jobStore);
        if (goalSummary.generated > 0) {
          console.log(`  Goals: queued ${goalSummary.generated} job(s) from policy templates`);
        }
        const jobSummary = await executeBrainJobs({
          source: 'watch',
          allowMemoryWrite: false,
          maxJobs: Math.max(1, policy.decisions.maxJobsPerSweep || 1),
          dataDir,
          policy,
          brain,
          jobs: jobStore,
          wallet,
          identityKey: config.identityKey,
          peers: Array.from(knownPeers.entries()).map(([identityKey, peer]) => ({
            identityKey,
            endpoint: peer.endpoint,
            capabilities: peer.capabilities
          })),
          localEndpoint: config.endpoints?.jsonrpc
        });
        const elapsed = Date.now() - startTime;
        console.log(`  Sweep: probed ${probed}, discovered ${discovered} new, ${knownPeers.size} total known (${elapsed}ms)`);
        if (jobSummary.processed > 0) {
          console.log(`  Jobs: processed=${jobSummary.processed} completed=${jobSummary.completed} failed=${jobSummary.failed} awaitingApproval=${jobSummary.awaitingApproval}`);
        }
        brain.logEvent({
          source: 'watch',
          action: 'sweep-complete',
          reason: 'Discovery sweep finished',
          details: {
            probed,
            discovered,
            knownPeers: knownPeers.size,
            elapsedMs: elapsed,
            goalJobsGenerated: goalSummary.generated,
            jobsProcessed: jobSummary.processed,
            jobsCompleted: jobSummary.completed,
            jobsFailed: jobSummary.failed,
            jobsAwaitingApproval: jobSummary.awaitingApproval
          }
        });
      }

      // Run first sweep immediately
      await registerInDirectory(true);
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
        brain.logEvent({
          source: 'watch',
          action: 'watch-stopped',
          reason: 'Peer discovery daemon received shutdown signal'
        });
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

// Brain command group — policy + explainability for operators
const brain = program
  .command('brain')
  .description('Operator controls: policy, explainability, and recommended next actions');

brain
  .command('help')
  .description('Explain what this Claw can do right now')
  .option('--config <path>', 'Path to wallet config file', 'config/wallet-config.json')
  .option('--policy <path>', 'Path to brain policy file', 'data/brain-policy.json')
  .action(async (options) => {
    try {
      const dataDir = join(process.cwd(), 'data');
      const brain = new ClawBrain(dataDir, options.policy);
      const policy = brain.loadPolicy();
      const configPath = join(process.cwd(), options.config);
      const config = parseJsonFile(configPath);

      console.log('🧠 Claw Help');
      console.log('');
      console.log('What I can do:');
      console.log('  1. Accept paid capability calls (402 flow).');
      console.log('  2. Discover peers, auto-invite, and keep the peer graph fresh.');
      console.log('  3. Register in the ClawSats directory for network visibility.');
      console.log('  4. Teach BSV courses I have completed.');
      console.log('  5. Hire other Claws when directed (and by policy limits).');
      console.log('');
      console.log('Operator commands:');
      console.log('  node dist/cli/index.js brain status');
      console.log('  node dist/cli/index.js brain what-next');
      console.log('  node dist/cli/index.js brain why');
      console.log('  node dist/cli/index.js brain policy');
      console.log('  node dist/cli/index.js brain enqueue --capability <name> --params <json>');
      console.log('  node dist/cli/index.js brain jobs');
      console.log('  node dist/cli/index.js brain retry-failed');
      console.log('  node dist/cli/index.js brain run');
      console.log('');
      if (config?.identityKey) {
        console.log(`Identity: ${formatShort(String(config.identityKey))}`);
      }
      console.log(`Policy file: ${brain.getPolicyPath()}`);
      console.log(`Event log:    ${brain.getEventsPath()}`);
      console.log('');
      console.log('Policy summary:');
      console.log(`  discoveryIntervalSeconds: ${policy.timers.discoveryIntervalSeconds}`);
      console.log(`  autoInviteOnDiscovery:    ${policy.timers.autoInviteOnDiscovery}`);
      console.log(`  directoryRegisterEnabled: ${policy.timers.directoryRegisterEnabled}`);
      console.log(`  hireEnabled:              ${policy.decisions.hireEnabled}`);
      console.log(`  autoHireMaxSats:          ${policy.decisions.autoHireMaxSats}`);
      console.log(`  autoHireCapabilities:     ${policy.decisions.autoHireCapabilities.join(', ')}`);
      console.log(`  maxJobsPerSweep:          ${policy.decisions.maxJobsPerSweep}`);
      console.log(`  requireMemoryApproval:    ${policy.decisions.requireHumanApprovalForMemory}`);
      console.log(`  autoGenerateJobs:         ${policy.goals.autoGenerateJobs}`);
      console.log(`  generateJobsEverySeconds: ${policy.goals.generateJobsEverySeconds}`);
      console.log(`  goalTemplates:            ${policy.goals.templates.length}`);
    } catch (error) {
      console.error('❌ Failed to show brain help:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

brain
  .command('status')
  .description('Show current operating status for this Claw')
  .option('--config <path>', 'Path to wallet config file', 'config/wallet-config.json')
  .option('--policy <path>', 'Path to brain policy file', 'data/brain-policy.json')
  .action(async (options) => {
    try {
      const dataDir = join(process.cwd(), 'data');
      const brain = new ClawBrain(dataDir, options.policy);
      const policy = brain.loadPolicy();
      const configPath = join(process.cwd(), options.config);
      const config = parseJsonFile(configPath);
      const courseState = parseJsonFile(join(dataDir, 'course-state.json'));
      const watchPeers = parseJsonFile(join(dataDir, 'watch-peers.json'));
      const jobStore = new BrainJobStore(dataDir);
      const completions = courseState?.completions && typeof courseState.completions === 'object'
        ? Object.keys(courseState.completions)
        : [];
      const peers = Array.isArray(watchPeers?.peers) ? watchPeers.peers : [];
      const pendingJobs = jobStore.list('pending').length;
      const failedJobs = jobStore.list('failed').length;
      const approvalJobs = jobStore.list('needs_approval').length;
      const recentEvents = brain.listEvents(5);

      let healthStatus = 'offline';
      let healthUptime = 0;
      let liveCapabilities = 0;
      try {
        const healthRes = await fetch('http://127.0.0.1:3321/health', {
          signal: AbortSignal.timeout(5000)
        });
        if (healthRes.ok) {
          const health: any = await healthRes.json();
          healthStatus = health?.status || 'online';
          healthUptime = Number(health?.server?.uptime || 0);
          liveCapabilities = Number(health?.wallet?.capabilities || 0);
        }
      } catch {
        // Keep offline defaults.
      }

      console.log('📊 Claw Brain Status');
      console.log(`  Identity:        ${formatShort(String(config?.identityKey || 'unknown'))}`);
      console.log(`  Chain:           ${String(config?.chain || 'unknown')}`);
      console.log(`  Runtime:         ${healthStatus} (uptime ${Math.floor(healthUptime)}s)`);
      console.log(`  Capabilities:    ${liveCapabilities || (Array.isArray(config?.capabilities) ? config.capabilities.length : 0)}`);
      console.log(`  Courses passed:  ${completions.length}`);
      console.log(`  Known peers:     ${peers.length}`);
      console.log(`  Jobs pending:    ${pendingJobs}`);
      console.log(`  Jobs failed:     ${failedJobs}`);
      console.log(`  Needs approval:  ${approvalJobs}`);
      console.log(`  Goal jobs:       ${policy.goals.autoGenerateJobs} (${policy.goals.templates.length} templates)`);
      console.log(`  Peer target:     ${policy.growth.targetKnownPeers}`);
      console.log(`  Auto-invite:     ${policy.timers.autoInviteOnDiscovery}`);
      console.log(`  Auto-register:   ${policy.timers.directoryRegisterEnabled}`);
      console.log(`  Hire enabled:    ${policy.decisions.hireEnabled} (max ${policy.decisions.autoHireMaxSats} sats)`);
      if (recentEvents.length > 0) {
        console.log('  Recent decisions:');
        for (const evt of recentEvents) {
          console.log(`    • ${evt.ts} ${evt.action}: ${evt.reason}`);
        }
      }
    } catch (error) {
      console.error('❌ Failed to show brain status:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

brain
  .command('what-next')
  .description('Recommend the next highest-impact actions')
  .option('--config <path>', 'Path to wallet config file', 'config/wallet-config.json')
  .option('--policy <path>', 'Path to brain policy file', 'data/brain-policy.json')
  .action(async (options) => {
    try {
      const dataDir = join(process.cwd(), 'data');
      const brain = new ClawBrain(dataDir, options.policy);
      const policy = brain.loadPolicy();
      const config = parseJsonFile(join(process.cwd(), options.config));
      const courseState = parseJsonFile(join(dataDir, 'course-state.json'));
      const watchPeers = parseJsonFile(join(dataDir, 'watch-peers.json'));
      const jobStore = new BrainJobStore(dataDir);
      const completions = courseState?.completions && typeof courseState.completions === 'object'
        ? Object.keys(courseState.completions)
        : [];
      const peers = Array.isArray(watchPeers?.peers) ? watchPeers.peers : [];
      const pendingJobs = jobStore.list('pending').length;
      const failedJobs = jobStore.list('failed').length;
      const approvalJobs = jobStore.list('needs_approval').length;

      let serverOnline = false;
      try {
        const healthRes = await fetch('http://127.0.0.1:3321/health', {
          signal: AbortSignal.timeout(5000)
        });
        serverOnline = healthRes.ok;
      } catch {
        serverOnline = false;
      }

      const recommendations: string[] = [];

      if (!serverOnline) {
        recommendations.push('Start the wallet server: `node dist/cli/index.js serve --host 0.0.0.0 --port 3321`.');
      }

      if (!config?.identityKey) {
        recommendations.push('Create wallet config: `node dist/cli/index.js create`.');
      }

      if (peers.length < policy.growth.minHealthyPeers) {
        recommendations.push('Grow peer graph: run `node dist/cli/index.js watch --interval 60` and leave it running.');
      }

      if (completions.length === 0) {
        recommendations.push('Complete your first course via JSON-RPC `takeCourse` to unlock teach income.');
      }

      if (pendingJobs > 0 || approvalJobs > 0) {
        recommendations.push(`Run the task router: ` + '`node dist/cli/index.js brain run`' + ` (${pendingJobs} pending, ${approvalJobs} awaiting approval).`);
      } else {
        recommendations.push('Queue work for delegation: `node dist/cli/index.js brain enqueue --capability dns_resolve --params \'{"hostname":"clawsats.com","type":"A"}\'`.');
      }

      if (failedJobs > 0) {
        recommendations.push(`Retry failed jobs: ` + '`node dist/cli/index.js brain retry-failed`' + ` (${failedJobs} failed).`);
      }

      if (policy.decisions.hireEnabled) {
        recommendations.push(`Use ` + '`hireClaw`' + ` for tasks above local confidence; keep each hire <= ${policy.decisions.autoHireMaxSats} sats.`);
      } else {
        recommendations.push('Enable hiring in policy when you are ready to delegate tasks (`brain policy --set decisions.hireEnabled=true`).');
      }

      if (!policy.goals.autoGenerateJobs) {
        recommendations.push('Enable policy initiative: `node dist/cli/index.js brain policy --set goals.autoGenerateJobs=true`.');
      }

      recommendations.push('Review decision logs any time: `node dist/cli/index.js brain why --limit 20`.');

      console.log('🎯 What Next');
      recommendations.slice(0, 5).forEach((line, idx) => {
        console.log(`  ${idx + 1}. ${line}`);
      });
    } catch (error) {
      console.error('❌ Failed to compute recommendations:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

brain
  .command('why')
  .description('Show recent decision reasons from the claw event log')
  .option('--policy <path>', 'Path to brain policy file', 'data/brain-policy.json')
  .option('--limit <n>', 'How many events to display', '20')
  .option('--action <name>', 'Filter to one action name')
  .action((options) => {
    try {
      const dataDir = join(process.cwd(), 'data');
      const brain = new ClawBrain(dataDir, options.policy);
      const limit = Math.max(1, parseInt(options.limit, 10) || 20);
      const events = brain.listEvents(limit, options.action);

      if (events.length === 0) {
        console.log('No decision events recorded yet.');
        console.log('Run `node dist/cli/index.js watch` or wallet operations first.');
        return;
      }

      console.log(`🧾 Recent Decisions (${events.length})`);
      for (const evt of events) {
        console.log(`- ${evt.ts} [${evt.source}] ${evt.action}`);
        console.log(`  reason: ${evt.reason}`);
        if (evt.details && Object.keys(evt.details).length > 0) {
          console.log(`  details: ${JSON.stringify(evt.details)}`);
        }
      }
    } catch (error) {
      console.error('❌ Failed to read decision log:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

brain
  .command('policy')
  .description('Show or update claw brain policy')
  .option('--policy <path>', 'Path to brain policy file', 'data/brain-policy.json')
  .option('--set <path=value>', 'Set a policy value (repeatable)', (value: string, prev: string[]) => {
    prev.push(value);
    return prev;
  }, [] as string[])
  .action((options) => {
    try {
      const dataDir = join(process.cwd(), 'data');
      const brain = new ClawBrain(dataDir, options.policy);
      const policy = brain.loadPolicy();
      const updates: string[] = options.set || [];

      for (const update of updates) {
        const idx = update.indexOf('=');
        if (idx <= 0) {
          throw new Error(`Invalid --set value "${update}". Use path=value`);
        }
        const keyPath = update.substring(0, idx).trim();
        const rawValue = update.substring(idx + 1);
        setByPath(policy as unknown as Record<string, any>, keyPath, parsePolicyOverride(rawValue));
      }

      if (updates.length > 0) {
        brain.savePolicy(policy as BrainPolicy);
        brain.logEvent({
          source: 'brain.policy',
          action: 'policy-updated',
          reason: 'Operator updated claw policy',
          details: { updates }
        });
      }

      console.log(`Policy path: ${brain.getPolicyPath()}`);
      console.log(JSON.stringify(policy, null, 2));
    } catch (error) {
      console.error('❌ Failed to show/update policy:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

brain
  .command('enqueue')
  .description('Queue a job for the Phase 2 task router (auto/local/hire)')
  .requiredOption('--capability <name>', 'Capability name to execute')
  .option('--params <json>', 'Capability params as JSON object', '{}')
  .option('--strategy <mode>', 'auto | hire | local', 'auto')
  .option('--max-sats <n>', 'Maximum sats for this job (provider + fee)')
  .option('--priority <n>', 'Lower number = higher priority', '100')
  .option('--persist-result', 'Persist successful result to on-chain memory', false)
  .option('--memory-key <key>', 'Custom on-chain memory key if persist-result is set')
  .option('--memory-category <cat>', 'Memory category label (default: job-result)')
  .action((options) => {
    try {
      const dataDir = join(process.cwd(), 'data');
      const jobs = new BrainJobStore(dataDir);
      const strategy = String(options.strategy || 'auto').toLowerCase();
      if (!['auto', 'hire', 'local'].includes(strategy)) {
        throw new Error('Invalid strategy. Use auto, hire, or local.');
      }

      const params = safeParseJsonObject(options.params);
      const maxSats = options.maxSats ? Math.max(1, parseInt(options.maxSats, 10)) : 50;
      const priority = Math.max(1, parseInt(options.priority, 10) || 100);

      const job = jobs.enqueue({
        capability: String(options.capability).trim(),
        params,
        strategy: strategy as BrainJobStrategy,
        maxSats,
        priority,
        persistResult: options.persistResult === true,
        memoryKey: options.memoryKey,
        memoryCategory: options.memoryCategory
      });

      console.log('✅ Job queued');
      console.log(`  id:         ${job.id}`);
      console.log(`  capability: ${job.capability}`);
      console.log(`  strategy:   ${job.strategy}`);
      console.log(`  maxSats:    ${job.maxSats}`);
      console.log(`  status:     ${job.status}`);
      console.log(`  queue:      ${jobs.getQueuePath()}`);
    } catch (error) {
      console.error('❌ Failed to enqueue job:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

brain
  .command('jobs')
  .description('List task-router jobs and statuses')
  .option('--status <state>', 'Filter by status: pending|running|completed|failed|needs_approval')
  .option('--limit <n>', 'Max rows to show', '50')
  .action((options) => {
    try {
      const dataDir = join(process.cwd(), 'data');
      const jobs = new BrainJobStore(dataDir);
      const status = options.status ? String(options.status) as BrainJobStatus : undefined;
      const rows = jobs.list(status);
      const limit = Math.max(1, parseInt(options.limit, 10) || 50);
      const top = rows.slice(0, limit);

      if (top.length === 0) {
        console.log('No jobs found.');
        return;
      }

      console.log(`🧱 Brain Jobs (${top.length}/${rows.length})`);
      for (const job of top) {
        console.log(`- ${job.id} [${job.status}] ${job.capability}`);
        console.log(`  strategy=${job.strategy} maxSats=${job.maxSats} attempts=${job.attempts} priority=${job.priority}`);
        if (job.selectedEndpoint) console.log(`  endpoint=${job.selectedEndpoint}`);
        if (job.error) console.log(`  error=${job.error}`);
        if (job.memoryStatus) console.log(`  memory=${job.memoryStatus}${job.memoryTxid ? ` txid=${job.memoryTxid}` : ''}`);
      }
    } catch (error) {
      console.error('❌ Failed to list jobs:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

brain
  .command('retry-failed')
  .description('Requeue failed jobs as pending so they can run again')
  .option('--id <jobId>', 'Retry one specific failed job ID')
  .option('--capability <name>', 'Retry failed jobs for one capability')
  .option('--limit <n>', 'Maximum failed jobs to requeue', '50')
  .action((options) => {
    try {
      const dataDir = join(process.cwd(), 'data');
      const jobs = new BrainJobStore(dataDir);
      const brain = new ClawBrain(dataDir);
      const limit = Math.max(1, parseInt(options.limit, 10) || 50);
      const idFilter = typeof options.id === 'string' ? options.id.trim() : '';
      const capabilityFilter = typeof options.capability === 'string' ? options.capability.trim() : '';
      let candidates = jobs.list('failed');

      if (idFilter) {
        candidates = candidates.filter(job => job.id === idFilter);
      }
      if (capabilityFilter) {
        candidates = candidates.filter(job => job.capability === capabilityFilter);
      }

      const selected = candidates.slice(0, limit);
      if (selected.length === 0) {
        console.log('No failed jobs matched your filters.');
        return;
      }

      for (const job of selected) {
        job.status = 'pending';
        job.error = undefined;
        job.audit.push({
          ts: new Date().toISOString(),
          action: 'retried',
          reason: 'Operator requeued failed job'
        });
        jobs.update(job);
        brain.logEvent({
          source: 'brain.retry-failed',
          action: 'job-retried',
          reason: `Requeued failed job ${job.id}`,
          details: { capability: job.capability, attempts: job.attempts }
        });
      }

      console.log(`✅ Requeued failed jobs: ${selected.length}`);
      console.log(`  queue: ${jobs.getQueuePath()}`);
    } catch (error) {
      console.error('❌ Failed to retry jobs:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

brain
  .command('run')
  .description('Run the Phase 2 task router once against queued jobs')
  .option('--config <path>', 'Path to wallet config file', 'config/wallet-config.json')
  .option('--policy <path>', 'Path to brain policy file', 'data/brain-policy.json')
  .option('--max-jobs <n>', 'Maximum jobs to process this run')
  .option('--allow-memory-write', 'Allow memory writes even when approval is required', false)
  .action(async (options) => {
    try {
      const configPath = join(process.cwd(), options.config);
      if (!existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
      }
      if (!walletManager.getConfig()) {
        await walletManager.loadWallet(configPath);
      }
      const config = walletManager.getConfig();
      if (!config) throw new Error('Wallet config unavailable.');

      const dataDir = join(process.cwd(), 'data');
      const brain = new ClawBrain(dataDir, options.policy);
      const policy = brain.loadPolicy();
      const jobs = new BrainJobStore(dataDir);
      const wallet = walletManager.getWallet();
      const peers = loadKnownPeers(dataDir);
      const maxJobs = options.maxJobs
        ? Math.max(1, parseInt(options.maxJobs, 10))
        : Math.max(1, policy.decisions.maxJobsPerSweep || 1);
      const goalSummary = enqueueGoalJobsFromPolicy('brain.run', policy, brain, jobs);

      const summary = await executeBrainJobs({
        source: 'brain.run',
        allowMemoryWrite: options.allowMemoryWrite === true,
        maxJobs,
        dataDir,
        policy,
        brain,
        jobs,
        wallet,
        identityKey: config.identityKey,
        peers,
        localEndpoint: config.endpoints?.jsonrpc
      });

      console.log('✅ Brain run complete');
      if (goalSummary.generated > 0) {
        console.log(`  goals queued:      ${goalSummary.generated}`);
      }
      console.log(`  processed:         ${summary.processed}`);
      console.log(`  completed:         ${summary.completed}`);
      console.log(`  failed:            ${summary.failed}`);
      console.log(`  awaiting approval: ${summary.awaitingApproval}`);
      console.log(`  queue:             ${jobs.getQueuePath()}`);
    } catch (error) {
      console.error('❌ Failed to run task router:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse(process.argv);

// Show help if no arguments
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
