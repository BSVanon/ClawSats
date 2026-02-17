import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';

export interface BrainPolicy {
  version: number;
  timers: {
    discoveryIntervalSeconds: number;
    directoryRegisterEnabled: boolean;
    directoryRegisterEverySeconds: number;
    autoInviteOnDiscovery: boolean;
  };
  decisions: {
    hireEnabled: boolean;
    autoHireMaxSats: number;
    writeMemoryEnabled: boolean;
    requireHumanApprovalForMemory: boolean;
    autoHireCapabilities: string[];
    maxJobsPerSweep: number;
  };
  growth: {
    minHealthyPeers: number;
    targetKnownPeers: number;
  };
  goals: {
    autoGenerateJobs: boolean;
    generateJobsEverySeconds: number;
    defaultStrategy: 'auto' | 'hire' | 'local';
    defaultMaxSats: number;
    defaultPriority: number;
    templates: Array<{
      enabled: boolean;
      capability: string;
      params?: Record<string, unknown>;
      strategy?: 'auto' | 'hire' | 'local';
      maxSats?: number;
      priority?: number;
      persistResult?: boolean;
      memoryKey?: string;
      memoryCategory?: string;
      everySeconds?: number;
    }>;
  };
}

export interface BrainEvent {
  ts: string;
  source: string;
  action: string;
  reason: string;
  details?: Record<string, unknown>;
}

const DEFAULT_POLICY: BrainPolicy = {
  version: 1,
  timers: {
    discoveryIntervalSeconds: 60,
    directoryRegisterEnabled: true,
    directoryRegisterEverySeconds: 300,
    autoInviteOnDiscovery: true
  },
  decisions: {
    hireEnabled: true,
    autoHireMaxSats: 50,
    writeMemoryEnabled: true,
    requireHumanApprovalForMemory: true,
    autoHireCapabilities: ['dns_resolve', 'fetch_url', 'peer_health_check', 'verify_receipt', 'bsv_mentor'],
    maxJobsPerSweep: 2
  },
  growth: {
    minHealthyPeers: 3,
    targetKnownPeers: 12
  },
  goals: {
    autoGenerateJobs: false,
    generateJobsEverySeconds: 300,
    defaultStrategy: 'auto',
    defaultMaxSats: 25,
    defaultPriority: 80,
    templates: [
      {
        enabled: true,
        capability: 'dns_resolve',
        params: { hostname: 'clawsats.com', type: 'A' },
        strategy: 'auto',
        maxSats: 8,
        priority: 90,
        persistResult: false,
        memoryCategory: 'goal-result',
        everySeconds: 900
      }
    ]
  }
};

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function mergeDeep<T>(base: T, overrides: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overrides)) {
    if (isObject(v) && isObject(out[k])) {
      out[k] = mergeDeep(out[k] as Record<string, unknown>, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export class ClawBrain {
  private dataDir: string;
  private policyPath: string;
  private eventsPath: string;

  constructor(dataDir: string, policyPath?: string, eventsPath?: string) {
    this.dataDir = dataDir;
    this.policyPath = policyPath || join(dataDir, 'brain-policy.json');
    this.eventsPath = eventsPath || join(dataDir, 'brain-events.jsonl');
  }

  private ensureDataDir(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  getPolicyPath(): string {
    return this.policyPath;
  }

  getEventsPath(): string {
    return this.eventsPath;
  }

  loadPolicy(): BrainPolicy {
    this.ensureDataDir();
    if (!existsSync(this.policyPath)) {
      this.savePolicy(DEFAULT_POLICY);
      return structuredClone(DEFAULT_POLICY);
    }

    try {
      const raw = readFileSync(this.policyPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!isObject(parsed)) {
        this.savePolicy(DEFAULT_POLICY);
        return structuredClone(DEFAULT_POLICY);
      }
      return mergeDeep(structuredClone(DEFAULT_POLICY), parsed);
    } catch {
      this.savePolicy(DEFAULT_POLICY);
      return structuredClone(DEFAULT_POLICY);
    }
  }

  savePolicy(policy: BrainPolicy): void {
    this.ensureDataDir();
    writeFileSync(this.policyPath, JSON.stringify(policy, null, 2), 'utf8');
  }

  logEvent(event: Omit<BrainEvent, 'ts'>): void {
    this.ensureDataDir();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...event
    });
    appendFileSync(this.eventsPath, `${line}\n`, 'utf8');
  }

  listEvents(limit = 20, actionFilter?: string): BrainEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    try {
      const raw = readFileSync(this.eventsPath, 'utf8');
      const rows = raw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          try {
            return JSON.parse(line) as BrainEvent;
          } catch {
            return null;
          }
        })
        .filter((v): v is BrainEvent => Boolean(v));

      const filtered = actionFilter
        ? rows.filter(r => r.action === actionFilter)
        : rows;

      if (limit <= 0) return filtered;
      return filtered.slice(Math.max(0, filtered.length - limit));
    } catch {
      return [];
    }
  }
}
