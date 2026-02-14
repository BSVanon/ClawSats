import { PeerRegistry } from '../../src/core/PeerRegistry';
import { PeerRecord } from '../../src/types';

function makePeer(overrides: Partial<PeerRecord> = {}): PeerRecord {
  return {
    clawId: 'claw://test',
    identityKey: 'aa'.repeat(33),
    endpoint: 'http://localhost:3321',
    capabilities: ['echo'],
    chain: 'test',
    lastSeen: new Date().toISOString(),
    reputation: 50,
    ...overrides
  };
}

describe('PeerRegistry', () => {
  let registry: PeerRegistry;

  beforeEach(() => {
    registry = new PeerRegistry();
  });

  test('addPeer and getPeer', () => {
    const peer = makePeer();
    registry.addPeer(peer);
    expect(registry.size()).toBe(1);
    expect(registry.getPeer(peer.identityKey)).toBeDefined();
    expect(registry.getPeer(peer.identityKey)!.clawId).toBe('claw://test');
  });

  test('addPeer keeps higher reputation on update', () => {
    const peer1 = makePeer({ reputation: 30 });
    registry.addPeer(peer1);
    const peer2 = makePeer({ reputation: 60 });
    registry.addPeer(peer2);
    expect(registry.size()).toBe(1);
    expect(registry.getPeer(peer1.identityKey)!.reputation).toBe(60);
  });

  test('addPeer does not downgrade reputation', () => {
    const peer1 = makePeer({ reputation: 80 });
    registry.addPeer(peer1);
    const peer2 = makePeer({ reputation: 20 });
    registry.addPeer(peer2);
    expect(registry.getPeer(peer1.identityKey)!.reputation).toBe(80);
  });

  test('removePeer', () => {
    const peer = makePeer();
    registry.addPeer(peer);
    expect(registry.size()).toBe(1);
    registry.removePeer(peer.identityKey);
    expect(registry.size()).toBe(0);
  });

  test('getPeerByEndpoint', () => {
    const peer = makePeer({ endpoint: 'http://example.com:3321' });
    registry.addPeer(peer);
    expect(registry.getPeerByEndpoint('http://example.com:3321')).toBeDefined();
    expect(registry.getPeerByEndpoint('http://nonexistent:3321')).toBeUndefined();
  });

  test('getPeersByCapability', () => {
    registry.addPeer(makePeer({ identityKey: 'aa'.repeat(33), capabilities: ['echo', 'sign_message'] }));
    registry.addPeer(makePeer({ identityKey: 'bb'.repeat(33), capabilities: ['echo'] }));
    registry.addPeer(makePeer({ identityKey: 'cc'.repeat(33), capabilities: ['hash_commit'] }));
    expect(registry.getPeersByCapability('echo').length).toBe(2);
    expect(registry.getPeersByCapability('sign_message').length).toBe(1);
    expect(registry.getPeersByCapability('nonexistent').length).toBe(0);
  });

  test('recordSuccess bumps reputation', () => {
    const peer = makePeer({ reputation: 50 });
    registry.addPeer(peer);
    registry.recordSuccess(peer.identityKey);
    expect(registry.getPeer(peer.identityKey)!.reputation).toBe(51);
  });

  test('recordFailure decreases reputation', () => {
    const peer = makePeer({ reputation: 50 });
    registry.addPeer(peer);
    registry.recordFailure(peer.identityKey);
    expect(registry.getPeer(peer.identityKey)!.reputation).toBe(45);
  });

  test('reputation never exceeds 100', () => {
    const peer = makePeer({ reputation: 100 });
    registry.addPeer(peer);
    registry.recordSuccess(peer.identityKey);
    expect(registry.getPeer(peer.identityKey)!.reputation).toBe(100);
  });

  test('reputation never goes below 0', () => {
    const peer = makePeer({ reputation: 2 });
    registry.addPeer(peer);
    registry.recordFailure(peer.identityKey);
    expect(registry.getPeer(peer.identityKey)!.reputation).toBe(0);
  });

  test('toJSON and loadFrom round-trip', () => {
    registry.addPeer(makePeer({ identityKey: 'aa'.repeat(33) }));
    registry.addPeer(makePeer({ identityKey: 'bb'.repeat(33) }));
    const json = registry.toJSON();
    expect(json.length).toBe(2);

    const registry2 = new PeerRegistry();
    registry2.loadFrom(json);
    expect(registry2.size()).toBe(2);
  });

  test('evicts stale peers (7+ days old) on next addPeer', () => {
    // Add a peer normally
    const peer1 = makePeer({ identityKey: 'dd'.repeat(33) });
    registry.addPeer(peer1);
    expect(registry.size()).toBe(1);

    // Manually backdate its lastSeen to simulate staleness
    const stored = registry.getPeer('dd'.repeat(33))!;
    stored.lastSeen = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

    // Adding another peer triggers evictStale, which should remove the stale one
    const freshPeer = makePeer({ identityKey: 'ee'.repeat(33) });
    registry.addPeer(freshPeer);
    expect(registry.size()).toBe(1);
    expect(registry.getPeer('dd'.repeat(33))).toBeUndefined();
    expect(registry.getPeer('ee'.repeat(33))).toBeDefined();
  });
});
