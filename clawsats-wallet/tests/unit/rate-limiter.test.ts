import { RateLimiter } from '../../src/core/RateLimiter';

describe('RateLimiter', () => {
  test('allows requests under the limit', () => {
    const limiter = new RateLimiter(3, 60000);
    expect(limiter.allow('user1')).toBe(true);
    expect(limiter.allow('user1')).toBe(true);
    expect(limiter.allow('user1')).toBe(true);
  });

  test('blocks requests over the limit', () => {
    const limiter = new RateLimiter(2, 60000);
    expect(limiter.allow('user1')).toBe(true);
    expect(limiter.allow('user1')).toBe(true);
    expect(limiter.allow('user1')).toBe(false);
  });

  test('different keys have independent limits', () => {
    const limiter = new RateLimiter(1, 60000);
    expect(limiter.allow('user1')).toBe(true);
    expect(limiter.allow('user2')).toBe(true);
    expect(limiter.allow('user1')).toBe(false);
    expect(limiter.allow('user2')).toBe(false);
  });

  test('remaining returns correct count', () => {
    const limiter = new RateLimiter(5, 60000);
    expect(limiter.remaining('user1')).toBe(5);
    limiter.allow('user1');
    expect(limiter.remaining('user1')).toBe(4);
    limiter.allow('user1');
    limiter.allow('user1');
    expect(limiter.remaining('user1')).toBe(2);
  });

  test('cleanup removes expired entries', () => {
    const limiter = new RateLimiter(10, 1); // 1ms window
    limiter.allow('user1');
    // Wait for window to expire
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    limiter.cleanup();
    // After cleanup, user1 should have full allowance again
    expect(limiter.remaining('user1')).toBe(10);
  });
});
