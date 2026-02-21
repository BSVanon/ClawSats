import { createHash, randomBytes } from 'crypto';
import { ClawBrain, BrainPolicy } from './ClawBrain';
import { BrainJobStore, BrainJob } from './BrainJobs';
import {
  callLlm,
  resolveProviderConfig,
  redactSecrets,
  hashJson,
  LlmProviderConfig,
  LlmDecision,
  LlmToolCall,
  LlmMessage
} from './LlmProvider';
import { log, logWarn, logError } from '../utils';

const TAG = 'brain-agent';
const PROMPT_VERSION = 'clawbrain-v1.0';

// ── Types ────────────────────────────────────────────────────────

export interface ThinkOptions {
  dryRun: boolean;
  maxToolCalls: number;
  eventsLimit: number;
  jsonOutput: boolean;
  provider?: string;
  model?: string;
}

export interface ThinkResult {
  cycleId: string;
  promptVersion: string;
  decision: LlmDecision;
  executedActions: ActionResult[];
  queuedActions: QueuedAction[];
  exitCode: number;
  dryRun: boolean;
  timestamp: string;
}

interface ActionResult {
  name: string;
  arguments: Record<string, unknown>;
  idempotencyKey: string;
  status: 'executed' | 'failed' | 'circuit_open';
  result?: unknown;
  error?: string;
  resultHash?: string;
}

interface QueuedAction {
  name: string;
  arguments: Record<string, unknown>;
  reason: string;
  jobId?: string;
}

interface CircuitState {
  failures: number;
  openUntil: number; // timestamp ms
}

// ── Safety Constants ─────────────────────────────────────────────

const GATED_TOOLS = new Set(['hireClaw', 'createAction', 'writeMemory']);

const ALLOWED_TOOLS = new Set([
  // BRC-100 read-only
  'listOutputs', 'listActions', 'getPublicKey', 'verifySignature',
  // ClawSats read-only
  'getConfig', 'ping', 'getCapabilities',
  // Peers read-only
  'listPeers', 'listReferrals', 'searchCapabilities', 'verifyReceipt',
  // Courses
  'listCourses', 'spreadMetrics',
  // Memory read-only
  'readMemory', 'listMemories', 'searchMemories', 'readMemoryFromChain',
  'memoryStats', 'fetchFromChain', 'verifyMemoryOnChain', 'getMasterIndexTxid',
  // Peer actions (low risk)
  'sendInvitation',
  // Gated (require approval)
  'hireClaw', 'createAction', 'writeMemory',
  // Courses (write)
  'takeCourse',
  // Signing
  'createSignature',
  // Memory write
  'writeMasterIndex', 'recoverFromMasterIndex'
]);

const CIRCUIT_TOOL_THRESHOLD = 3;
const CIRCUIT_MODEL_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 300_000; // 5 minutes
const MAX_CONTEXT_CHARS = 12000; // rough token budget (~3000 tokens)

// ── System Prompt ────────────────────────────────────────────────

function buildSystemPrompt(policy: BrainPolicy): string {
  return `You are a ClawSats autonomous agent brain. You have a BSV wallet, a network of peers, and paid capabilities.

Your responsibilities:
1. Maintain peer connections — discover, invite, health-check peers
2. Execute queued jobs — hire other Claws or run capabilities locally
3. Manage your budget — never overspend, track earnings vs costs
4. Remember important outcomes — save key results to on-chain memory
5. Spread BSV education — teach courses you've completed

Safety rules (non-negotiable):
- Never spend more than ${policy.decisions.autoHireMaxSats} sats on a single hire
- Always verify receipts after hiring another Claw
- Log every decision with clear reasoning
- If unsure about an action, skip it — better to do nothing than waste sats
- Never include private keys, WIF, API keys, or secrets in your responses

Available tool categories:
- Read-only tools (always safe): getConfig, listPeers, listOutputs, listMemories, etc.
- Peer actions (low risk): sendInvitation
- Gated tools (require approval): hireClaw, createAction, writeMemory
- You may suggest gated tools, but they will be queued for human approval unless the operator has relaxed gates.

Respond with a structured JSON decision. Think carefully about what the wallet needs right now based on its current state.`;
}

// ── Brain Agent ──────────────────────────────────────────────────

export class ClawBrainAgent {
  private brain: ClawBrain;
  private jobStore: BrainJobStore;
  private walletRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  private circuitBreakers: Map<string, CircuitState> = new Map();
  private modelFailures: number = 0;
  private executedKeys: Set<string> = new Set();

  constructor(
    brain: ClawBrain,
    jobStore: BrainJobStore,
    walletRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>
  ) {
    this.brain = brain;
    this.jobStore = jobStore;
    this.walletRpc = walletRpc;
  }

  async think(options: ThinkOptions): Promise<ThinkResult> {
    const cycleId = `cycle-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const timestamp = new Date().toISOString();

    // Check model circuit breaker
    if (this.modelFailures >= CIRCUIT_MODEL_THRESHOLD) {
      const result: ThinkResult = {
        cycleId, promptVersion: PROMPT_VERSION,
        decision: { reasoning: 'Model circuit breaker open', actions: [], confidence: 0, summary: 'Paused — too many model failures' },
        executedActions: [], queuedActions: [],
        exitCode: 6, dryRun: options.dryRun, timestamp
      };
      this.logAudit(cycleId, result);
      return result;
    }

    // 1. Load context
    const policy = this.brain.loadPolicy();
    const indelibleCfg = policy.indelible || { enabled: false };

    // 1a. Chain guard — block if policy.chain mismatches wallet chain (fail-closed)
    if (policy.chain) {
      let chainBlocked = false;
      let chainBlockReason = '';
      let chainBlockDetails: Record<string, unknown> = { cycleId, policyChain: policy.chain };
      try {
        const walletConfig = await this.walletRpc('getConfig', {}) as any;
        const walletChain = walletConfig?.chain;
        if (!walletChain) {
          chainBlocked = true;
          chainBlockReason = `Policy requires chain "${policy.chain}" but wallet returned no chain value`;
        } else if (walletChain !== policy.chain) {
          chainBlocked = true;
          chainBlockReason = `Policy chain "${policy.chain}" does not match wallet chain "${walletChain}"`;
          chainBlockDetails.walletChain = walletChain;
        }
      } catch (e: any) {
        chainBlocked = true;
        chainBlockReason = `Chain guard check failed (fail-closed): ${e.message}`;
        chainBlockDetails.error = e.message;
      }
      if (chainBlocked) {
        this.brain.logEvent({
          source: TAG,
          action: 'chain-guard-block',
          reason: chainBlockReason,
          details: chainBlockDetails
        });
        const result: ThinkResult = {
          cycleId, promptVersion: PROMPT_VERSION,
          decision: { reasoning: chainBlockReason, actions: [], confidence: 0, summary: 'Blocked — chain guard' },
          executedActions: [], queuedActions: [],
          exitCode: 2, dryRun: options.dryRun, timestamp
        };
        this.logAudit(cycleId, result);
        return result;
      }
    }

    const recentEvents = this.brain.listEvents(options.eventsLimit);
    const pendingJobs = this.jobStore.nextPending(5);

    let walletState: unknown = {};
    let peerState: unknown = {};
    try {
      walletState = await this.walletRpc('listOutputs', { basket: 'default' });
    } catch (e: any) {
      logWarn(TAG, `Failed to load wallet state: ${e.message}`);
    }
    try {
      peerState = await this.walletRpc('listPeers', {});
    } catch (e: any) {
      logWarn(TAG, `Failed to load peer state: ${e.message}`);
    }

    // 1b. Load Indelible memory (past brain cycle summaries)
    let memoryContext: unknown[] = [];
    if (indelibleCfg.enabled !== false) {
      try {
        const category = indelibleCfg.memoryCategory || 'brain-cycle';
        const limit = indelibleCfg.maxCycleHistory || 5;
        const memories = await this.walletRpc('searchMemories', { query: category });
        const raw = memories as any;
        const list = Array.isArray(raw) ? raw
          : Array.isArray(raw?.memories) ? raw.memories
          : Array.isArray(raw?.results) ? raw.results
          : [];
        memoryContext = list.slice(-limit);
        log(TAG, `Loaded ${memoryContext.length} past cycle memories`);
      } catch (e: any) {
        logWarn(TAG, `Failed to load Indelible memory: ${e.message}`);
      }
    }

    // 2. Build redacted context
    const context = {
      walletState: redactSecrets(walletState),
      peers: redactSecrets(peerState),
      policy: redactSecrets(policy),
      recentEvents: recentEvents.slice(-10),
      pendingJobs: pendingJobs.map(j => ({
        id: j.id, capability: j.capability, status: j.status,
        strategy: j.strategy, maxSats: j.maxSats, priority: j.priority
      })),
      pastCycleMemories: memoryContext,
      timestamp
    };

    // 3. Enforce context budget
    let contextStr = JSON.stringify(context, null, 0);
    if (contextStr.length > MAX_CONTEXT_CHARS) {
      // Trim events first, then peer details
      const trimmedContext = {
        ...context,
        recentEvents: recentEvents.slice(-3),
        peers: { note: 'Truncated for context budget' }
      };
      contextStr = JSON.stringify(trimmedContext, null, 0);
      if (contextStr.length > MAX_CONTEXT_CHARS) {
        contextStr = contextStr.slice(0, MAX_CONTEXT_CHARS);
      }
    }

    // 4. Call LLM
    const llmConfig = resolveProviderConfig(
      (policy as any).llm,
      options.provider,
      options.model
    );

    const messages: LlmMessage[] = [
      { role: 'system', content: buildSystemPrompt(policy) },
      { role: 'user', content: contextStr }
    ];

    let decision: LlmDecision;
    try {
      decision = await callLlm(llmConfig, messages);
      this.modelFailures = 0; // reset on success
    } catch (e: any) {
      this.modelFailures++;
      logError(TAG, `LLM call failed (${this.modelFailures}/${CIRCUIT_MODEL_THRESHOLD}): ${e.message}`);
      const result: ThinkResult = {
        cycleId, promptVersion: PROMPT_VERSION,
        decision: { reasoning: `Model error: ${e.message}`, actions: [], confidence: 0, summary: 'LLM call failed' },
        executedActions: [], queuedActions: [],
        exitCode: 5, dryRun: options.dryRun, timestamp
      };
      this.logAudit(cycleId, result);
      return result;
    }

    // 5. Validate decision schema
    if (!decision.actions || !Array.isArray(decision.actions)) {
      const result: ThinkResult = {
        cycleId, promptVersion: PROMPT_VERSION,
        decision, executedActions: [], queuedActions: [],
        exitCode: 3, dryRun: options.dryRun, timestamp
      };
      this.logAudit(cycleId, result);
      return result;
    }

    // Cap tool calls
    const actions = decision.actions.slice(0, Math.min(options.maxToolCalls, 10));

    // 6. Dry-run mode — report plan only
    if (options.dryRun) {
      const planned = actions.map(a => ({
        name: a.name,
        arguments: a.arguments,
        wouldBeGated: GATED_TOOLS.has(a.name),
        wouldBeAllowed: ALLOWED_TOOLS.has(a.name)
      }));

      const result: ThinkResult = {
        cycleId, promptVersion: PROMPT_VERSION,
        decision: { ...decision, actions },
        executedActions: [], queuedActions: [],
        exitCode: 0, dryRun: true, timestamp
      };

      this.brain.logEvent({
        source: TAG,
        action: 'think-dry-run',
        reason: decision.reasoning,
        details: {
          cycleId,
          promptVersion: PROMPT_VERSION,
          planned,
          decisionHash: hashJson(decision),
          confidence: decision.confidence
        }
      });

      return result;
    }

    // 7. Execute mode — run approved, queue gated
    const executedActions: ActionResult[] = [];
    const queuedActions: QueuedAction[] = [];
    let hasFailure = false;
    let hasBlocked = false;
    let intervalSpend = 0;
    const maxIntervalSpend = policy.decisions.autoHireMaxSats * 3; // 3x single cap

    for (const action of actions) {
      const idempotencyKey = `${cycleId}-${action.name}-${hashJson(action.arguments)}`;

      // Check idempotency — skip if already executed
      if (this.executedKeys.has(idempotencyKey)) {
        log(TAG, `Skipping duplicate action: ${action.name} (key: ${idempotencyKey})`);
        continue;
      }

      // Check allowlist
      if (!ALLOWED_TOOLS.has(action.name)) {
        queuedActions.push({
          name: action.name,
          arguments: action.arguments,
          reason: `Tool "${action.name}" not in allowlist`
        });
        hasBlocked = true;
        continue;
      }

      // Check approval gates
      if (GATED_TOOLS.has(action.name)) {
        const job = this.jobStore.enqueue({
          capability: action.name,
          params: action.arguments,
          strategy: 'local',
          maxSats: (action.arguments.maxTotalSats as number) || policy.decisions.autoHireMaxSats
        });
        // Mark as needs_approval
        job.status = 'needs_approval';
        job.audit.push({
          ts: new Date().toISOString(),
          action: 'gated',
          reason: `Gated tool requires human approval (brain-think cycle ${cycleId})`
        });
        this.jobStore.update(job);

        queuedActions.push({
          name: action.name,
          arguments: action.arguments,
          reason: 'Requires human approval',
          jobId: job.id
        });
        hasBlocked = true;
        continue;
      }

      // Check spend cap (for actions with sats)
      const satsArg = (action.arguments.maxTotalSats || action.arguments.providerAmount || 0) as number;
      if (satsArg > 0) {
        if (satsArg > policy.decisions.autoHireMaxSats) {
          queuedActions.push({
            name: action.name,
            arguments: action.arguments,
            reason: `Exceeds per-call cap (${satsArg} > ${policy.decisions.autoHireMaxSats})`
          });
          hasBlocked = true;
          continue;
        }
        if (intervalSpend + satsArg > maxIntervalSpend) {
          queuedActions.push({
            name: action.name,
            arguments: action.arguments,
            reason: `Would exceed interval spend cap (${intervalSpend + satsArg} > ${maxIntervalSpend})`
          });
          hasBlocked = true;
          continue;
        }
        intervalSpend += satsArg;
      }

      // Check circuit breaker for this tool
      const circuit = this.circuitBreakers.get(action.name);
      if (circuit && circuit.openUntil > Date.now()) {
        executedActions.push({
          name: action.name, arguments: action.arguments,
          idempotencyKey, status: 'circuit_open',
          error: `Circuit breaker open until ${new Date(circuit.openUntil).toISOString()}`
        });
        continue;
      }

      // Execute with 1 retry + 2s backoff
      let lastError: string = '';
      let succeeded = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 2000));
          log(TAG, `Retrying ${action.name} (attempt ${attempt + 1}/2)`);
        }
        try {
          const result = await this.walletRpc(action.name, action.arguments);
          executedActions.push({
            name: action.name, arguments: action.arguments,
            idempotencyKey, status: 'executed',
            result: redactSecrets(result),
            resultHash: hashJson(result)
          });
          this.executedKeys.add(idempotencyKey);
          this.circuitBreakers.delete(action.name);
          succeeded = true;
          break;
        } catch (e: any) {
          lastError = e.message;
        }
      }

      if (!succeeded) {
        hasFailure = true;
        executedActions.push({
          name: action.name, arguments: action.arguments,
          idempotencyKey, status: 'failed',
          error: lastError
        });

        // Update circuit breaker
        const existing = this.circuitBreakers.get(action.name) || { failures: 0, openUntil: 0 };
        existing.failures++;
        if (existing.failures >= CIRCUIT_TOOL_THRESHOLD) {
          existing.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
          logWarn(TAG, `Circuit breaker OPEN for tool "${action.name}" — ${existing.failures} consecutive failures`);
        }
        this.circuitBreakers.set(action.name, existing);
      }
    }

    // Determine exit code
    let exitCode = 0;
    if (hasBlocked && !hasFailure) exitCode = 2;
    if (hasFailure) exitCode = 4;

    const result: ThinkResult = {
      cycleId, promptVersion: PROMPT_VERSION,
      decision: { ...decision, actions },
      executedActions, queuedActions,
      exitCode, dryRun: false, timestamp
    };

    // 8. Write audit
    this.logAudit(cycleId, result);

    // 9. Save cycle summary to Indelible memory (agent-internal, not LLM-requested)
    if (indelibleCfg.enabled === true && !options.dryRun) {
      const summaryKey = `brain-cycle/${cycleId}`;
      try {
        await this.walletRpc('writeMemory', {
          key: summaryKey,
          data: JSON.stringify({
            cycleId,
            summary: decision.summary,
            confidence: decision.confidence,
            actionsExecuted: executedActions.filter(a => a.status === 'executed').length,
            actionsQueued: queuedActions.length,
            exitCode,
            timestamp
          }),
          category: indelibleCfg.memoryCategory || 'brain-cycle'
        });
        this.brain.logEvent({
          source: TAG,
          action: 'agent-internal-memory-write',
          reason: `Cycle summary saved to Indelible (opt-in via policy.indelible.enabled)`,
          details: { cycleId, key: summaryKey, category: indelibleCfg.memoryCategory || 'brain-cycle' }
        });
        log(TAG, `Saved cycle summary to Indelible: ${summaryKey}`);
      } catch (e: any) {
        logWarn(TAG, `Failed to save cycle to Indelible: ${e.message}`);
        this.brain.logEvent({
          source: TAG,
          action: 'agent-internal-memory-write',
          reason: `Cycle summary save failed: ${e.message}`,
          details: { cycleId, key: summaryKey, error: e.message }
        });
      }
    } else if (!options.dryRun) {
      this.brain.logEvent({
        source: TAG,
        action: 'agent-internal-memory-write-skipped',
        reason: indelibleCfg.enabled !== true
          ? 'Indelible memory disabled in policy (indelible.enabled !== true)'
          : 'Dry-run mode — no memory write',
        details: { cycleId }
      });
    }

    return result;
  }

  private logAudit(cycleId: string, result: ThinkResult): void {
    this.brain.logEvent({
      source: TAG,
      action: result.dryRun ? 'think-dry-run' : 'think-execute',
      reason: result.decision.reasoning,
      details: {
        cycleId,
        promptVersion: PROMPT_VERSION,
        decisionHash: hashJson(result.decision),
        confidence: result.decision.confidence,
        actionsPlanned: result.decision.actions.length,
        actionsExecuted: result.executedActions.filter(a => a.status === 'executed').length,
        actionsFailed: result.executedActions.filter(a => a.status === 'failed').length,
        actionsQueued: result.queuedActions.length,
        exitCode: result.exitCode
      }
    });
  }
}
