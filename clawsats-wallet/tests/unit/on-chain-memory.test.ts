import { OnChainMemory } from '../../src/memory/OnChainMemory';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(__dirname, '..', 'tmp-memory-test');
const DATA_DIR = join(TEST_DIR, 'data');

function setupTestDirs(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
}

function cleanupTestDirs(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

describe('OnChainMemory', () => {
  beforeEach(() => setupTestDirs());
  afterEach(() => cleanupTestDirs());

  test('initializes with empty index', () => {
    const mem = new OnChainMemory(DATA_DIR, 'test-identity-key');
    mem.loadIndex();
    const stats = mem.getStats();
    expect(stats.totalMemories).toBe(0);
    expect(stats.totalOnChainBytes).toBe(0);
    expect(stats.totalTransactions).toBe(0);
  });

  test('getMemory returns undefined for unknown key', () => {
    const mem = new OnChainMemory(DATA_DIR, 'test-identity-key');
    expect(mem.getMemory('nonexistent')).toBeUndefined();
  });

  test('listMemories returns empty array initially', () => {
    const mem = new OnChainMemory(DATA_DIR, 'test-identity-key');
    expect(mem.listMemories()).toHaveLength(0);
    expect(mem.listMemories('general')).toHaveLength(0);
  });

  test('recordExternalMemory adds to index', () => {
    const mem = new OnChainMemory(DATA_DIR, 'test-identity-key');

    mem.recordExternalMemory({
      key: 'test/memory-1',
      txid: 'abc123def456',
      outputIndex: 0,
      type: 'opreturn',
      encrypted: false,
      size: 100,
      contentHash: 'hash123',
      category: 'general',
      createdAt: new Date().toISOString()
    });

    expect(mem.getMemory('test/memory-1')).toBeDefined();
    expect(mem.getMemory('test/memory-1')?.txid).toBe('abc123def456');
    expect(mem.listMemories()).toHaveLength(1);
    expect(mem.getStats().totalMemories).toBe(1);
    expect(mem.getStats().totalOnChainBytes).toBe(100);
  });

  test('listMemories filters by category', () => {
    const mem = new OnChainMemory(DATA_DIR, 'test-identity-key');

    mem.recordExternalMemory({
      key: 'peer/trust-abc',
      txid: 'tx1',
      outputIndex: 0,
      type: 'opreturn',
      encrypted: false,
      size: 50,
      contentHash: 'h1',
      category: 'peer-trust',
      createdAt: new Date().toISOString()
    });

    mem.recordExternalMemory({
      key: 'course/bsv-101',
      txid: 'tx2',
      outputIndex: 0,
      type: 'opreturn',
      encrypted: false,
      size: 200,
      contentHash: 'h2',
      category: 'course-completion',
      createdAt: new Date().toISOString()
    });

    expect(mem.listMemories()).toHaveLength(2);
    expect(mem.listMemories('peer-trust')).toHaveLength(1);
    expect(mem.listMemories('course-completion')).toHaveLength(1);
    expect(mem.listMemories('nonexistent')).toHaveLength(0);
  });

  test('searchMemories finds by key', () => {
    const mem = new OnChainMemory(DATA_DIR, 'test-identity-key');

    mem.recordExternalMemory({
      key: 'peer/trust-abc123',
      txid: 'tx1',
      outputIndex: 0,
      type: 'opreturn',
      encrypted: false,
      size: 50,
      contentHash: 'h1',
      category: 'peer-trust',
      createdAt: new Date().toISOString()
    });

    expect(mem.searchMemories('abc123')).toHaveLength(1);
    expect(mem.searchMemories('peer')).toHaveLength(1);
    expect(mem.searchMemories('xyz')).toHaveLength(0);
  });

  test('searchMemories finds by category', () => {
    const mem = new OnChainMemory(DATA_DIR, 'test-identity-key');

    mem.recordExternalMemory({
      key: 'something',
      txid: 'tx1',
      outputIndex: 0,
      type: 'opreturn',
      encrypted: false,
      size: 50,
      contentHash: 'h1',
      category: 'course-completion',
      createdAt: new Date().toISOString()
    });

    expect(mem.searchMemories('course')).toHaveLength(1);
  });

  test('getStats tracks categories and encryption', () => {
    const mem = new OnChainMemory(DATA_DIR, 'test-identity-key');

    mem.recordExternalMemory({
      key: 'a',
      txid: 'tx1',
      outputIndex: 0,
      type: 'opreturn',
      encrypted: false,
      size: 100,
      contentHash: 'h1',
      category: 'general',
      createdAt: '2025-01-01T00:00:00Z'
    });

    mem.recordExternalMemory({
      key: 'b',
      txid: 'tx2',
      outputIndex: 0,
      type: 'opreturn',
      encrypted: true,
      size: 200,
      contentHash: 'h2',
      category: 'private',
      createdAt: '2025-06-01T00:00:00Z'
    });

    const stats = mem.getStats();
    expect(stats.totalMemories).toBe(2);
    expect(stats.totalOnChainBytes).toBe(300);
    expect(stats.totalTransactions).toBe(2);
    expect(stats.encryptedCount).toBe(1);
    expect(stats.plaintextCount).toBe(1);
    expect(stats.categories['general']).toBe(1);
    expect(stats.categories['private']).toBe(1);
    expect(stats.oldestMemory).toBe('2025-01-01T00:00:00Z');
    expect(stats.newestMemory).toBe('2025-06-01T00:00:00Z');
  });

  test('state persists across restarts', () => {
    const mem1 = new OnChainMemory(DATA_DIR, 'test-identity-key');
    mem1.recordExternalMemory({
      key: 'persistent-memory',
      txid: 'tx-persist',
      outputIndex: 0,
      type: 'opreturn',
      encrypted: false,
      size: 42,
      contentHash: 'h-persist',
      category: 'general',
      createdAt: new Date().toISOString()
    });

    // New instance, load from disk
    const mem2 = new OnChainMemory(DATA_DIR, 'test-identity-key');
    mem2.loadIndex();

    expect(mem2.getMemory('persistent-memory')).toBeDefined();
    expect(mem2.getMemory('persistent-memory')?.txid).toBe('tx-persist');
    expect(mem2.getStats().totalMemories).toBe(1);
  });
});
