import { randomBytes } from 'crypto';

/**
 * Truncate an identity key for display: first 8 hex chars + "..."
 */
export function formatIdentityKey(key: string, len = 8): string {
  if (!key) return '(none)';
  return key.length > len ? `${key.substring(0, len)}...` : key;
}

/**
 * Generate a cryptographically random nonce encoded as base64.
 * Used for derivation prefixes and payment references.
 */
export function generateNonce(bytes = 16): string {
  return randomBytes(bytes).toString('base64');
}

/**
 * Canonical JSON: deterministic key ordering for signing.
 * Sorts keys alphabetically at every depth.
 */
export function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted: Record<string, unknown>, k) => {
        sorted[k] = (value as Record<string, unknown>)[k];
        return sorted;
      }, {});
    }
    return value;
  });
}

/**
 * Structured log helper with [tag] prefix.
 */
export function log(tag: string, message: string, ...args: unknown[]): void {
  console.log(`[${tag}] ${message}`, ...args);
}

export function logWarn(tag: string, message: string, ...args: unknown[]): void {
  console.warn(`[${tag}] ${message}`, ...args);
}

export function logError(tag: string, message: string, ...args: unknown[]): void {
  console.error(`[${tag}] ${message}`, ...args);
}
