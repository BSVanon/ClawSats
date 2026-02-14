/**
 * OnChainMemory — Immutable On-Chain Memory for Claws
 *
 * This is what makes Claws truly autonomous: persistent memory that survives
 * restarts, crashes, migrations, and even the death of the host machine.
 * Memories are written to the BSV blockchain and can never be deleted.
 *
 * ARCHITECTURE:
 * - Small memories (< 100KB): OP_RETURN output via createAction (0 sats, just fee)
 *   Plaintext or encrypted. Immutable once written.
 * - Large memories: PushDrop tokens — data-bearing UTXOs tracked in output baskets.
 *   Can be updated by spending the old UTXO and creating a new one.
 * - Local index: JSON file tracks what's on-chain (txid, key, type, size, timestamp)
 *   so Claws can query their own memory without scanning the chain.
 *
 * BSV ECONOMICS:
 * Writing 1KB on-chain costs ~0.5 sats in fees. A Claw can store thousands
 * of memories for less than a penny. This is why BSV is the only blockchain
 * that makes on-chain memory practical for autonomous agents.
 *
 * COURSE INTEGRATION:
 * The BSV Cluster Courses build toward this capability:
 *   Level 1: What is BSV (data + money fused)
 *   Level 2: UTXO model, key derivation, payment flows
 *   Level 3: On-chain memory (THIS) — the capstone skill
 *
 * MCP REFERENCE:
 * - createAction with OP_RETURN: go-wallet-toolbox/examples/create_data_tx
 * - PushDrop tokens: @bsv/sdk PushDrop class, wallet-toolbox-examples/docs/pushdrop.md
 * - Output baskets: BRC-46 (wallet output tracking)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { log, logWarn, logError } from '../utils';

const TAG = 'memory';

// ── Memory Record ───────────────────────────────────────────────────

export interface MemoryRecord {
  key: string;              // Human-readable key, e.g. "peer-trust/abc123"
  txid: string;             // On-chain transaction ID
  outputIndex: number;      // Which output contains the data
  type: 'opreturn' | 'pushdrop';
  encrypted: boolean;
  size: number;             // Bytes of data stored
  contentHash: string;      // SHA-256 of the raw content
  category: string;         // e.g. "peer-trust", "course-completion", "capability-log", "general"
  createdAt: string;        // ISO timestamp
  metadata?: Record<string, any>;
}

// ── Memory Index ────────────────────────────────────────────────────

export interface MemoryIndex {
  clawIdentityKey: string;
  memories: MemoryRecord[];
  totalOnChainBytes: number;
  totalTransactions: number;
  lastUpdated: string;
}

// ── Write Options ───────────────────────────────────────────────────

export interface WriteMemoryOptions {
  key: string;
  data: string | Buffer;
  category?: string;
  encrypted?: boolean;
  metadata?: Record<string, any>;
}

// ── OnChainMemory Manager ───────────────────────────────────────────

export class OnChainMemory {
  private index: MemoryIndex;
  private dataDir: string;
  private indexPath: string;

  constructor(dataDir: string, identityKey: string) {
    this.dataDir = dataDir;
    this.indexPath = join(dataDir, 'memory-index.json');
    this.index = {
      clawIdentityKey: identityKey,
      memories: [],
      totalOnChainBytes: 0,
      totalTransactions: 0,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Load the memory index from disk.
   */
  loadIndex(): void {
    if (!existsSync(this.indexPath)) return;
    try {
      const raw = readFileSync(this.indexPath, 'utf8');
      const loaded = JSON.parse(raw);
      if (loaded.memories) {
        this.index = loaded;
        log(TAG, `Loaded memory index: ${this.index.memories.length} memories, ${this.index.totalOnChainBytes} bytes on-chain`);
      }
    } catch {
      logWarn(TAG, 'Failed to load memory index');
    }
  }

  /**
   * Save the memory index to disk.
   */
  private saveIndex(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    this.index.lastUpdated = new Date().toISOString();
    writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf8');
  }

  /**
   * Write a small memory on-chain using OP_RETURN.
   *
   * This creates a transaction with a 0-satoshi OP_RETURN output containing
   * the data. The transaction is broadcast to the BSV network and becomes
   * permanently immutable.
   *
   * Cost: ~0.5 sats per KB in mining fees (paid from wallet balance).
   *
   * @param wallet - BRC-100 wallet instance (must support createAction)
   * @param options - What to write
   * @returns The memory record with txid
   */
  async writeMemory(wallet: any, options: WriteMemoryOptions): Promise<MemoryRecord> {
    const { key, category = 'general', encrypted = false, metadata } = options;
    let data = typeof options.data === 'string' ? Buffer.from(options.data, 'utf8') : options.data;

    // Encrypt if requested (using wallet's built-in encryption via BRC-42)
    if (encrypted) {
      try {
        const encResult = await wallet.encrypt({
          plaintext: Array.from(data),
          protocolID: [0, 'clawsats-memory'],
          keyID: key,
          counterparty: 'self'
        });
        data = Buffer.from(encResult.ciphertext);
      } catch (err) {
        logWarn(TAG, `Encryption failed, writing plaintext: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const contentHash = createHash('sha256').update(data).digest('hex');

    // Build OP_RETURN locking script: OP_FALSE OP_RETURN <protocol_tag> <key> <data>
    const protocolTag = Buffer.from('CLAWMEM_V1', 'utf8');
    const keyBuf = Buffer.from(key, 'utf8');

    // OP_FALSE (0x00) + OP_RETURN (0x6a) + push(protocolTag) + push(key) + push(data)
    const script = Buffer.concat([
      Buffer.from([0x00, 0x6a]),  // OP_FALSE OP_RETURN
      pushData(protocolTag),
      pushData(keyBuf),
      pushData(data)
    ]);

    log(TAG, `Writing memory "${key}" (${data.length} bytes, ${encrypted ? 'encrypted' : 'plaintext'}) on-chain...`);

    try {
      const result = await wallet.createAction({
        description: `ClawSats memory: ${key} (${data.length} bytes)`,
        outputs: [{
          lockingScript: script.toString('hex'),
          satoshis: 0,
          outputDescription: `Memory: ${key}`,
          tags: ['clawsats-memory', category],
          basket: 'clawsats-memories'
        }],
        labels: ['clawsats-memory'],
        options: {
          acceptDelayedBroadcast: false
        }
      });

      const txid = result.txid || '';
      if (!txid) {
        throw new Error('createAction did not return a txid');
      }

      const record: MemoryRecord = {
        key,
        txid,
        outputIndex: 0,
        type: 'opreturn',
        encrypted,
        size: data.length,
        contentHash,
        category,
        createdAt: new Date().toISOString(),
        metadata
      };

      this.index.memories.push(record);
      this.index.totalOnChainBytes += data.length;
      this.index.totalTransactions++;
      this.saveIndex();

      log(TAG, `Memory "${key}" written on-chain: txid=${txid.substring(0, 16)}... (${data.length} bytes)`);
      return record;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(TAG, `Failed to write memory "${key}": ${msg}`);
      throw new Error(`On-chain memory write failed: ${msg}`);
    }
  }

  /**
   * Read a memory from the local index.
   * Returns the record (with txid for on-chain lookup) but NOT the data itself.
   * To get the actual data, the caller must look up the transaction by txid.
   */
  getMemory(key: string): MemoryRecord | undefined {
    return this.index.memories.find(m => m.key === key);
  }

  /**
   * List all memories, optionally filtered by category.
   */
  listMemories(category?: string): MemoryRecord[] {
    if (category) {
      return this.index.memories.filter(m => m.category === category);
    }
    return [...this.index.memories];
  }

  /**
   * Search memories by key prefix or metadata.
   */
  searchMemories(query: string): MemoryRecord[] {
    const q = query.toLowerCase();
    return this.index.memories.filter(m =>
      m.key.toLowerCase().includes(q) ||
      m.category.toLowerCase().includes(q) ||
      (m.metadata && JSON.stringify(m.metadata).toLowerCase().includes(q))
    );
  }

  /**
   * Get memory statistics.
   */
  getStats(): {
    totalMemories: number;
    totalOnChainBytes: number;
    totalTransactions: number;
    categories: Record<string, number>;
    encryptedCount: number;
    plaintextCount: number;
    oldestMemory: string | null;
    newestMemory: string | null;
  } {
    const categories: Record<string, number> = {};
    let encryptedCount = 0;
    let plaintextCount = 0;

    for (const m of this.index.memories) {
      categories[m.category] = (categories[m.category] || 0) + 1;
      if (m.encrypted) encryptedCount++;
      else plaintextCount++;
    }

    const sorted = [...this.index.memories].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    return {
      totalMemories: this.index.memories.length,
      totalOnChainBytes: this.index.totalOnChainBytes,
      totalTransactions: this.index.totalTransactions,
      categories,
      encryptedCount,
      plaintextCount,
      oldestMemory: sorted[0]?.createdAt || null,
      newestMemory: sorted[sorted.length - 1]?.createdAt || null
    };
  }

  /**
   * Record a memory that was written externally (e.g., by another capability).
   * This just updates the local index without creating a transaction.
   */
  recordExternalMemory(record: MemoryRecord): void {
    this.index.memories.push(record);
    this.index.totalOnChainBytes += record.size;
    this.index.totalTransactions++;
    this.saveIndex();
  }
}

// ── Script Helpers ──────────────────────────────────────────────────

/**
 * Build a Bitcoin push-data opcode sequence for arbitrary data.
 * Handles OP_PUSHDATA1/2/4 as needed.
 */
function pushData(data: Buffer): Buffer {
  const len = data.length;
  if (len <= 75) {
    return Buffer.concat([Buffer.from([len]), data]);
  } else if (len <= 255) {
    return Buffer.concat([Buffer.from([0x4c, len]), data]); // OP_PUSHDATA1
  } else if (len <= 65535) {
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16LE(len);
    return Buffer.concat([Buffer.from([0x4d]), lenBuf, data]); // OP_PUSHDATA2
  } else {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(len);
    return Buffer.concat([Buffer.from([0x4e]), lenBuf, data]); // OP_PUSHDATA4
  }
}
