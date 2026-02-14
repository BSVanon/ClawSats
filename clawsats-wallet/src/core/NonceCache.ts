import { NONCE_CACHE_SIZE } from '../protocol/constants';

/**
 * Sliding-window nonce cache for invite replay protection.
 * BrowserAI recommendation #1: "Without a nonce cache + TTL, invite spam storms will happen."
 */
export class NonceCache {
  private seen: Map<string, number> = new Map(); // nonce → timestamp
  private maxSize: number;

  constructor(maxSize = NONCE_CACHE_SIZE) {
    this.maxSize = maxSize;
  }

  /**
   * Returns true if this nonce has NOT been seen before (i.e., it's fresh).
   * Returns false if it's a replay.
   */
  check(nonce: string): boolean {
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, Date.now());
    this.evict();
    return true;
  }

  /**
   * Check nonce freshness AND TTL in one call.
   * Returns { fresh, reason }.
   */
  validate(nonce: string, ttlMs: number): { fresh: boolean; reason?: string } {
    if (!nonce) return { fresh: false, reason: 'Missing nonce' };
    const existingTs = this.seen.get(nonce);
    if (existingTs !== undefined) return { fresh: false, reason: 'Nonce replay detected' };
    // Evict entries older than ttlMs before adding the new one
    if (ttlMs > 0) {
      const cutoff = Date.now() - ttlMs;
      for (const [key, ts] of this.seen) {
        if (ts < cutoff) this.seen.delete(key);
      }
    }
    this.seen.set(nonce, Date.now());
    this.evict();
    return { fresh: true };
  }

  size(): number {
    return this.seen.size;
  }

  private evict(): void {
    if (this.seen.size <= this.maxSize) return;
    // Remove oldest entries
    const entries = Array.from(this.seen.entries()).sort((a, b) => a[1] - b[1]);
    const toRemove = entries.slice(0, this.seen.size - this.maxSize);
    for (const [key] of toRemove) {
      this.seen.delete(key);
    }
  }
}
