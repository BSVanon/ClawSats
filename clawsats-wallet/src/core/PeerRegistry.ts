import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PeerRecord, Chain } from '../types';
import { log, logWarn } from '../utils';

const TAG = 'peers';
const MAX_PEERS = 500;
const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SAVE_DEBOUNCE_MS = 5000;

/**
 * In-memory registry of known Claws.
 * Auto-persisted to data/peers.json on every mutation (debounced).
 */
export class PeerRegistry {
  private peers: Map<string, PeerRecord> = new Map();
  private persistPath: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Enable disk persistence. Call once at startup.
   */
  enablePersistence(dataDir: string): void {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    this.persistPath = join(dataDir, 'peers.json');
    if (existsSync(this.persistPath)) {
      try {
        const data = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
        if (Array.isArray(data)) {
          this.loadFrom(data);
          log(TAG, `Restored ${this.peers.size} peers from ${this.persistPath}`);
        }
      } catch {
        logWarn(TAG, `Failed to load peers from ${this.persistPath}, starting fresh`);
      }
    }
  }

  addPeer(peer: PeerRecord): void {
    const existing = this.peers.get(peer.identityKey);
    if (existing) {
      // Update — keep higher reputation
      peer.reputation = Math.max(existing.reputation, peer.reputation);
    }
    peer.lastSeen = new Date().toISOString();
    this.peers.set(peer.identityKey, peer);
    this.evictStale();
    this.scheduleSave();
    log(TAG, `Peer ${peer.identityKey.substring(0, 12)}... registered (${this.peers.size} total)`);
  }

  removePeer(identityKey: string): boolean {
    return this.peers.delete(identityKey);
  }

  getPeer(identityKey: string): PeerRecord | undefined {
    return this.peers.get(identityKey);
  }

  getPeerByEndpoint(endpoint: string): PeerRecord | undefined {
    for (const peer of this.peers.values()) {
      if (peer.endpoint === endpoint) return peer;
    }
    return undefined;
  }

  getAllPeers(): PeerRecord[] {
    return Array.from(this.peers.values());
  }

  getPeersByCapability(capability: string): PeerRecord[] {
    return this.getAllPeers().filter(p => p.capabilities.includes(capability));
  }

  getPeersByChain(chain: Chain): PeerRecord[] {
    return this.getAllPeers().filter(p => p.chain === chain);
  }

  size(): number {
    return this.peers.size;
  }

  /**
   * Bump a peer's reputation after a successful interaction.
   */
  recordSuccess(identityKey: string): void {
    const peer = this.peers.get(identityKey);
    if (peer) {
      peer.reputation = Math.min(100, peer.reputation + 1);
      peer.lastSeen = new Date().toISOString();
    }
  }

  /**
   * Decrease a peer's reputation after a failed interaction.
   */
  recordFailure(identityKey: string): void {
    const peer = this.peers.get(identityKey);
    if (peer) {
      peer.reputation = Math.max(0, peer.reputation - 5);
    }
  }

  /**
   * Serialize for persistence.
   */
  toJSON(): PeerRecord[] {
    return this.getAllPeers();
  }

  /**
   * Load from persisted data.
   */
  loadFrom(peers: PeerRecord[]): void {
    for (const peer of peers) {
      this.peers.set(peer.identityKey, peer);
    }
    this.evictStale();
    log(TAG, `Loaded ${this.peers.size} peers from storage`);
  }

  private scheduleSave(): void {
    if (!this.persistPath) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveToDisk(), SAVE_DEBOUNCE_MS);
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      writeFileSync(this.persistPath, JSON.stringify(this.toJSON(), null, 2));
    } catch {
      logWarn(TAG, `Failed to save peers to ${this.persistPath}`);
    }
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [key, peer] of this.peers) {
      if (now - new Date(peer.lastSeen).getTime() > STALE_MS) {
        this.peers.delete(key);
      }
    }
    // Cap at MAX_PEERS — evict lowest reputation first
    if (this.peers.size > MAX_PEERS) {
      const sorted = this.getAllPeers().sort((a, b) => a.reputation - b.reputation);
      const toRemove = sorted.slice(0, this.peers.size - MAX_PEERS);
      for (const peer of toRemove) {
        this.peers.delete(peer.identityKey);
      }
      logWarn(TAG, `Evicted ${toRemove.length} low-reputation peers (cap: ${MAX_PEERS})`);
    }
  }
}
