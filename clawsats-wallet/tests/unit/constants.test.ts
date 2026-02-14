import { createHash } from 'crypto';

describe('Protocol Constants', () => {
  // Import dynamically so the integrity check runs inside the test
  let constants: typeof import('../../src/protocol/constants');

  beforeAll(async () => {
    constants = await import('../../src/protocol/constants');
  });

  test('FEE_IDENTITY_KEY is 66 hex chars (33-byte compressed pubkey)', () => {
    expect(constants.FEE_IDENTITY_KEY).toMatch(/^[0-9a-fA-F]{66}$/);
  });

  test('FEE_IDENTITY_KEY starts with 02 or 03 (valid compressed pubkey prefix)', () => {
    expect(['02', '03']).toContain(constants.FEE_IDENTITY_KEY.substring(0, 2));
  });

  test('FEE_SATS is 2', () => {
    expect(constants.FEE_SATS).toBe(2);
  });

  test('SHA-256 integrity check passes for FEE_IDENTITY_KEY', () => {
    const hash = createHash('sha256').update(constants.FEE_IDENTITY_KEY).digest('hex');
    expect(hash).toBe('263e5a7547d75e94e681a8eb24ee5470b478e7dda23e1e2d27c58313b0e5d9a4');
  });

  test('BROADCAST_HOP_LIMIT is positive and reasonable', () => {
    expect(constants.BROADCAST_HOP_LIMIT).toBeGreaterThan(0);
    expect(constants.BROADCAST_HOP_LIMIT).toBeLessThanOrEqual(10);
  });

  test('BROADCAST_AUDIENCE_LIMIT is positive and reasonable', () => {
    expect(constants.BROADCAST_AUDIENCE_LIMIT).toBeGreaterThan(0);
    expect(constants.BROADCAST_AUDIENCE_LIMIT).toBeLessThanOrEqual(100);
  });

  test('INVITE_TTL_MS is between 1 minute and 1 hour', () => {
    expect(constants.INVITE_TTL_MS).toBeGreaterThanOrEqual(60_000);
    expect(constants.INVITE_TTL_MS).toBeLessThanOrEqual(3_600_000);
  });

  test('All capability prices are positive integers', () => {
    expect(constants.ECHO_PRICE_SATS).toBeGreaterThan(0);
    expect(constants.SIGN_MESSAGE_PRICE_SATS).toBeGreaterThan(0);
    expect(constants.HASH_COMMIT_PRICE_SATS).toBeGreaterThan(0);
    expect(constants.TIMESTAMP_ATTEST_PRICE_SATS).toBeGreaterThan(0);
    expect(constants.BROADCAST_PRICE_SATS).toBeGreaterThan(0);
  });

  test('BEACON_FIELD_ORDER has all required fields', () => {
    expect(constants.BEACON_FIELD_ORDER).toEqual(['v', 'id', 'ep', 'ch', 'cap', 'ts', 'sig']);
  });
});
