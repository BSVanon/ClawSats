import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { ClawBrain } from '../../src/core/ClawBrain';

const TEST_DIR = join(__dirname, '..', 'tmp-brain-test');

function cleanup(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

describe('ClawBrain', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  test('creates default policy when missing', () => {
    const brain = new ClawBrain(TEST_DIR);
    const policy = brain.loadPolicy();

    expect(policy.version).toBe(1);
    expect(policy.timers.discoveryIntervalSeconds).toBe(60);
    expect(policy.goals.autoGenerateJobs).toBe(false);
    expect(Array.isArray(policy.goals.templates)).toBe(true);
    expect(existsSync(brain.getPolicyPath())).toBe(true);
  });

  test('persists policy updates', () => {
    const brain = new ClawBrain(TEST_DIR);
    const policy = brain.loadPolicy();
    policy.decisions.autoHireMaxSats = 99;
    brain.savePolicy(policy);

    const brain2 = new ClawBrain(TEST_DIR);
    const loaded = brain2.loadPolicy();
    expect(loaded.decisions.autoHireMaxSats).toBe(99);
  });

  test('appends and reads decision events', () => {
    const brain = new ClawBrain(TEST_DIR);
    brain.loadPolicy();
    brain.logEvent({
      source: 'watch',
      action: 'peer-discovered',
      reason: 'found peer',
      details: { endpoint: 'http://example.com:3321' }
    });
    brain.logEvent({
      source: 'watch',
      action: 'auto-invite-ok',
      reason: 'invitation accepted'
    });

    const all = brain.listEvents(10);
    expect(all.length).toBe(2);
    expect(all[0].action).toBe('peer-discovered');
    expect(all[1].action).toBe('auto-invite-ok');

    const filtered = brain.listEvents(10, 'peer-discovered');
    expect(filtered.length).toBe(1);
    expect(filtered[0].reason).toBe('found peer');
  });
});
