import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

export type BrainJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'needs_approval';
export type BrainJobStrategy = 'auto' | 'hire' | 'local';

export interface BrainJobAuditEntry {
  ts: string;
  action: string;
  reason: string;
  details?: Record<string, unknown>;
}

export interface BrainJob {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: BrainJobStatus;
  strategy: BrainJobStrategy;
  capability: string;
  params: Record<string, unknown>;
  maxSats: number;
  priority: number;
  attempts: number;
  selectedEndpoint?: string;
  persistResult: boolean;
  memoryKey?: string;
  memoryCategory?: string;
  result?: unknown;
  error?: string;
  memoryStatus?: 'pending_approval' | 'written' | 'skipped';
  memoryTxid?: string;
  audit: BrainJobAuditEntry[];
}

export interface BrainJobQueueState {
  jobs: BrainJob[];
}

export interface EnqueueBrainJobInput {
  capability: string;
  params?: Record<string, unknown>;
  strategy?: BrainJobStrategy;
  maxSats?: number;
  priority?: number;
  persistResult?: boolean;
  memoryKey?: string;
  memoryCategory?: string;
}

const DEFAULT_QUEUE_STATE: BrainJobQueueState = { jobs: [] };

export class BrainJobStore {
  private dataDir: string;
  private queuePath: string;

  constructor(dataDir: string, queuePath?: string) {
    this.dataDir = dataDir;
    this.queuePath = queuePath || join(dataDir, 'brain-jobs.json');
  }

  getQueuePath(): string {
    return this.queuePath;
  }

  private ensureDataDir(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  load(): BrainJobQueueState {
    this.ensureDataDir();
    if (!existsSync(this.queuePath)) {
      this.save(DEFAULT_QUEUE_STATE);
      return { jobs: [] };
    }
    try {
      const raw = readFileSync(this.queuePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.jobs)) {
        this.save(DEFAULT_QUEUE_STATE);
        return { jobs: [] };
      }
      return { jobs: parsed.jobs as BrainJob[] };
    } catch {
      this.save(DEFAULT_QUEUE_STATE);
      return { jobs: [] };
    }
  }

  save(state: BrainJobQueueState): void {
    this.ensureDataDir();
    writeFileSync(this.queuePath, JSON.stringify(state, null, 2), 'utf8');
  }

  enqueue(input: EnqueueBrainJobInput): BrainJob {
    const now = new Date().toISOString();
    const job: BrainJob = {
      id: `job-${Date.now()}-${randomBytes(4).toString('hex')}`,
      createdAt: now,
      updatedAt: now,
      status: 'pending',
      strategy: input.strategy || 'auto',
      capability: input.capability,
      params: input.params || {},
      maxSats: Math.max(1, Math.floor(input.maxSats || 50)),
      priority: Math.max(1, Math.floor(input.priority || 100)),
      attempts: 0,
      persistResult: Boolean(input.persistResult),
      memoryKey: input.memoryKey,
      memoryCategory: input.memoryCategory,
      audit: [{
        ts: now,
        action: 'enqueued',
        reason: 'Job created by operator/automation'
      }]
    };

    const state = this.load();
    state.jobs.push(job);
    this.save(state);
    return job;
  }

  update(job: BrainJob): void {
    const state = this.load();
    const idx = state.jobs.findIndex(j => j.id === job.id);
    if (idx === -1) return;
    job.updatedAt = new Date().toISOString();
    state.jobs[idx] = job;
    this.save(state);
  }

  list(status?: BrainJobStatus): BrainJob[] {
    const state = this.load();
    const rows = status ? state.jobs.filter(j => j.status === status) : state.jobs;
    return rows.sort((a, b) => {
      if (a.status !== b.status) return a.status.localeCompare(b.status);
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  nextPending(limit: number): BrainJob[] {
    const state = this.load();
    return state.jobs
      .filter(j => j.status === 'pending' || j.status === 'needs_approval')
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt.localeCompare(b.createdAt);
      })
      .slice(0, Math.max(1, limit));
  }
}
