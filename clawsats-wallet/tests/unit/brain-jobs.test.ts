import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { BrainJobStore } from '../../src/core/BrainJobs';

const TEST_DIR = join(__dirname, '..', 'tmp-brain-jobs-test');

function cleanup(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

describe('BrainJobStore', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  test('enqueues and lists jobs', () => {
    const store = new BrainJobStore(TEST_DIR);
    const job = store.enqueue({
      capability: 'dns_resolve',
      params: { hostname: 'clawsats.com', type: 'A' },
      strategy: 'auto',
      maxSats: 10,
      priority: 5
    });

    expect(job.id).toMatch(/^job-/);
    expect(job.status).toBe('pending');

    const list = store.list();
    expect(list.length).toBe(1);
    expect(list[0].capability).toBe('dns_resolve');
  });

  test('nextPending returns pending and needs_approval sorted by priority', () => {
    const store = new BrainJobStore(TEST_DIR);
    const low = store.enqueue({ capability: 'echo', priority: 100 });
    const high = store.enqueue({ capability: 'fetch_url', priority: 1 });
    const approval = store.enqueue({ capability: 'peer_health_check', priority: 2 });
    approval.status = 'needs_approval';
    store.update(approval);
    low.status = 'completed';
    store.update(low);

    const next = store.nextPending(5);
    expect(next.length).toBe(2);
    expect(next[0].id).toBe(high.id);
    expect(next[1].id).toBe(approval.id);
  });
});
