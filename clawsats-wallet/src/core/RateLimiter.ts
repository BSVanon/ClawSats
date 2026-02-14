import { logWarn } from '../utils';

const TAG = 'ratelimit';

/**
 * Sliding-window rate limiter.
 * BrowserAI recommendation #3: "Autonomous spreading will also autonomously spam unless you bake in throttles."
 */
export class RateLimiter {
  private windows: Map<string, number[]> = new Map(); // key → timestamps
  private maxPerWindow: number;
  private windowMs: number;

  constructor(maxPerWindow: number, windowMs: number) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
  }

  /**
   * Returns true if the action is allowed, false if rate-limited.
   */
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(key) || [];
    timestamps = timestamps.filter(t => t > cutoff);

    if (timestamps.length >= this.maxPerWindow) {
      logWarn(TAG, `Rate limited: ${key} (${timestamps.length}/${this.maxPerWindow} in window)`);
      return false;
    }

    timestamps.push(now);
    this.windows.set(key, timestamps);
    return true;
  }

  /**
   * Get remaining allowance for a key.
   */
  remaining(key: string): number {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.windows.get(key) || []).filter(t => t > cutoff);
    return Math.max(0, this.maxPerWindow - timestamps.length);
  }

  /**
   * Clean up old entries.
   */
  cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      const fresh = timestamps.filter(t => t > cutoff);
      if (fresh.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, fresh);
      }
    }
  }
}
