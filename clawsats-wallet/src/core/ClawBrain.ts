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
  };
  growth: {
    minHealthyPeers: number;
    targetKnownPeers: number;
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
    requireHumanApprovalForMemory: true
  },
  growth: {
    minHealthyPeers: 3,
    targetKnownPeers: 12
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
