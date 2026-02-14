import { NonceCache } from '../../src/core/NonceCache';

describe('NonceCache', () => {
  let cache: NonceCache;

  beforeEach(() => {
    cache = new NonceCache(5);
  });

  test('fresh nonce returns true', () => {
    expect(cache.check('abc123')).toBe(true);
  });

  test('replayed nonce returns false', () => {
    cache.check('abc123');
    expect(cache.check('abc123')).toBe(false);
  });

  test('different nonces are all fresh', () => {
    expect(cache.check('a')).toBe(true);
    expect(cache.check('b')).toBe(true);
    expect(cache.check('c')).toBe(true);
  });

  test('evicts oldest when over capacity', () => {
    // Fill to capacity (5)
    cache.check('n1');
    cache.check('n2');
    cache.check('n3');
    cache.check('n4');
    cache.check('n5');
    expect(cache.size()).toBe(5);

    // Add one more — should evict oldest
    cache.check('n6');
    expect(cache.size()).toBe(5);
  });

  test('validate returns fresh:true for new nonce', () => {
    const result = cache.validate('new-nonce', 60000);
    expect(result.fresh).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test('validate returns fresh:false for replayed nonce', () => {
    cache.validate('replay-nonce', 60000);
    const result = cache.validate('replay-nonce', 60000);
    expect(result.fresh).toBe(false);
    expect(result.reason).toBe('Nonce replay detected');
  });

  test('validate returns fresh:false for empty nonce', () => {
    const result = cache.validate('', 60000);
    expect(result.fresh).toBe(false);
    expect(result.reason).toBe('Missing nonce');
  });
});
