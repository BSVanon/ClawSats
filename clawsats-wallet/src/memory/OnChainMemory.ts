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
          protocolID: [0, 'clawsats memory'],
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
          tags: ['clawsats memory', category],
          basket: 'clawsats-memories'
        }],
        labels: ['clawsats memory'],
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

  // ── Chain Read (BSV Inscription Handbook pattern) ──────────────────
  // Fetch actual data back from the blockchain by txid.
  // This is critical for recovery: if the local index survives but the
  // data cache doesn't, or if another Claw wants to read our public memories.

  /**
   * Fetch a transaction from the blockchain and parse its OP_RETURN data.
   * Uses WhatsOnChain API (free, no key required for mainnet).
   *
   * @param txid - Transaction ID to fetch
   * @returns Parsed data from the OP_RETURN output, or null if not found
   */
  async fetchFromChain(txid: string): Promise<{ raw: string; parsed: any } | null> {
    const apis = [
      `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`,
    ];

    for (const url of apis) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const tx: any = await res.json();

        // Find the OP_RETURN output (value = 0)
        const opReturnOut = tx.vout?.find((out: any) => out.value === 0);
        if (!opReturnOut) return null;

        const scriptHex = opReturnOut.scriptPubKey?.hex;
        if (!scriptHex) return null;

        const data = parseOpReturnData(scriptHex);
        if (!data) return null;

        return { raw: data.raw, parsed: data.parsed };
      } catch (err) {
        logWarn(TAG, `Chain fetch failed for ${txid.substring(0, 16)}...: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return null;
  }

  /**
   * Read a memory's actual data from the blockchain.
   * Combines local index lookup with chain fetch.
   *
   * @param key - Memory key to read
   * @returns The memory record + actual data from chain
   */
  async readMemoryFromChain(key: string): Promise<{
    record: MemoryRecord;
    data: any;
    verified: boolean;
  } | null> {
    const record = this.getMemory(key);
    if (!record) return null;

    const chainData = await this.fetchFromChain(record.txid);
    if (!chainData) {
      logWarn(TAG, `Memory "${key}" exists in index but could not be fetched from chain (txid: ${record.txid})`);
      return { record, data: null, verified: false };
    }

    // Verify content hash matches what we stored
    const fetchedHash = createHash('sha256').update(Buffer.from(chainData.raw, 'utf8')).digest('hex');
    const verified = fetchedHash === record.contentHash;
    if (!verified) {
      logWarn(TAG, `Memory "${key}" content hash mismatch — index says ${record.contentHash.substring(0, 16)}, chain says ${fetchedHash.substring(0, 16)}`);
    }

    return { record, data: chainData.parsed, verified };
  }

  // ── Master Index (Hierarchical Indexing pattern) ───────────────────
  // Periodically write the entire memory index ON-CHAIN so that if the
  // local index file is lost, the Claw can recover all its memories from
  // a single txid. This is the "BSV Bible" pattern from the handbook.

  /**
   * Write the current memory index on-chain as a master index transaction.
   * This creates a single tx that maps all memory keys → txids.
   * Store the returned txid somewhere durable (e.g., in the Claw's
   * on-chain identity or beacon) so it can always be recovered.
   *
   * @param wallet - BRC-100 wallet instance
   * @returns The master index txid
   */
  async writeMasterIndex(wallet: any): Promise<string> {
    const indexData = {
      p: 'CLAWMEM_V1',
      type: 'master-index',
      v: 1,
      clawIdentityKey: this.index.clawIdentityKey,
      totalMemories: this.index.memories.length,
      totalBytes: this.index.totalOnChainBytes,
      entries: this.index.memories.map(m => ({
        key: m.key,
        txid: m.txid,
        category: m.category,
        size: m.size,
        ts: m.createdAt
      })),
      ts: new Date().toISOString()
    };

    const payload = Buffer.from(JSON.stringify(indexData), 'utf8');
    const protocolTag = Buffer.from('CLAWMEM_V1', 'utf8');
    const keyBuf = Buffer.from('__master_index__', 'utf8');

    const script = Buffer.concat([
      Buffer.from([0x00, 0x6a]),  // OP_FALSE OP_RETURN
      pushData(protocolTag),
      pushData(keyBuf),
      pushData(payload)
    ]);

    log(TAG, `Writing master index on-chain (${this.index.memories.length} entries, ${payload.length} bytes)...`);

    const result = await wallet.createAction({
      description: `ClawSats master memory index (${this.index.memories.length} entries)`,
      outputs: [{
        lockingScript: script.toString('hex'),
        satoshis: 0,
        outputDescription: 'CLAWMEM_V1 master index',
        tags: ['clawsats memory', 'master-index'],
        basket: 'clawsats-memories'
      }],
      labels: ['clawsats memory', 'clawsats-master-index'],
      options: { acceptDelayedBroadcast: false }
    });

    const txid = result.txid || '';
    if (!txid) throw new Error('Master index createAction did not return a txid');

    // Record the master index as a special memory entry
    const record: MemoryRecord = {
      key: '__master_index__',
      txid,
      outputIndex: 0,
      type: 'opreturn',
      encrypted: false,
      size: payload.length,
      contentHash: createHash('sha256').update(payload).digest('hex'),
      category: 'system',
      createdAt: new Date().toISOString(),
      metadata: { entriesCount: this.index.memories.length }
    };

    // Replace previous master index entry if exists
    const existingIdx = this.index.memories.findIndex(m => m.key === '__master_index__');
    if (existingIdx >= 0) {
      this.index.memories[existingIdx] = record;
    } else {
      this.index.memories.push(record);
      this.index.totalTransactions++;
    }
    this.index.totalOnChainBytes += payload.length;
    this.saveIndex();

    log(TAG, `Master index written on-chain: txid=${txid.substring(0, 16)}... (${this.index.memories.length} entries)`);
    return txid;
  }

  /**
   * Recover the memory index from an on-chain master index transaction.
   * Use this when the local index is lost but you have the master index txid.
   *
   * @param masterIndexTxid - The txid of the master index transaction
   * @returns Number of memories recovered
   */
  async recoverFromMasterIndex(masterIndexTxid: string): Promise<number> {
    log(TAG, `Recovering memory index from master index: ${masterIndexTxid.substring(0, 16)}...`);

    const chainData = await this.fetchFromChain(masterIndexTxid);
    if (!chainData || !chainData.parsed) {
      throw new Error(`Could not fetch master index from chain: ${masterIndexTxid}`);
    }

    const indexData = chainData.parsed;
    if (indexData.p !== 'CLAWMEM_V1' || indexData.type !== 'master-index') {
      throw new Error('Transaction is not a CLAWMEM_V1 master index');
    }

    let recovered = 0;
    for (const entry of (indexData.entries || [])) {
      // Skip if we already have this memory
      if (this.index.memories.some(m => m.key === entry.key && m.txid === entry.txid)) continue;

      this.index.memories.push({
        key: entry.key,
        txid: entry.txid,
        outputIndex: 0,
        type: 'opreturn',
        encrypted: false,
        size: entry.size || 0,
        contentHash: '',  // Will be verified on next read
        category: entry.category || 'general',
        createdAt: entry.ts || new Date().toISOString()
      });
      recovered++;
    }

    if (recovered > 0) {
      this.index.totalOnChainBytes = this.index.memories.reduce((sum, m) => sum + m.size, 0);
      this.index.totalTransactions = this.index.memories.length;
      this.saveIndex();
      log(TAG, `Recovered ${recovered} memories from master index`);
    }

    return recovered;
  }

  /**
   * Get the most recent master index txid (for storing in beacons/identity).
   */
  getMasterIndexTxid(): string | null {
    const masterEntry = this.index.memories.find(m => m.key === '__master_index__');
    return masterEntry?.txid || null;
  }

  // ── Verify After Broadcast ────────────────────────────────────────
  // Best practice from the handbook: confirm data is actually on-chain.

  /**
   * Verify that a memory was successfully written on-chain by fetching
   * the transaction and checking the content hash matches.
   *
   * @param key - Memory key to verify
   * @param retries - Number of retries (with 3s delay between)
   * @returns true if verified on-chain, false if not found or mismatch
   */
  async verifyOnChain(key: string, retries: number = 3): Promise<boolean> {
    const record = this.getMemory(key);
    if (!record) return false;

    for (let attempt = 1; attempt <= retries; attempt++) {
      if (attempt > 1) {
        await new Promise(r => setTimeout(r, 3000));
      }

      try {
        const chainData = await this.fetchFromChain(record.txid);
        if (chainData) {
          log(TAG, `Memory "${key}" verified on-chain (attempt ${attempt})`);
          return true;
        }
      } catch {
        // Retry
      }

      if (attempt < retries) {
        logWarn(TAG, `Verify attempt ${attempt} failed for "${key}", retrying...`);
      }
    }

    logWarn(TAG, `Memory "${key}" could NOT be verified on-chain after ${retries} attempts`);
    return false;
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

/**
 * Parse an OP_RETURN script hex string to extract the data pushes.
 * Format: OP_FALSE(00) OP_RETURN(6a) <push:tag> <push:key> <push:data>
 * Returns the last (largest) push as raw string + parsed JSON.
 *
 * Based on the BSV Inscription Handbook's parseOpReturn pattern.
 */
function parseOpReturnData(scriptHex: string): { raw: string; parsed: any } | null {
  try {
    let pos = 0;

    // Skip OP_FALSE if present
    if (scriptHex.substring(pos, pos + 2) === '00') pos += 2;

    // Check for OP_RETURN (0x6a)
    if (scriptHex.substring(pos, pos + 2) !== '6a') return null;
    pos += 2;

    // Read all pushdata segments
    const pushes: string[] = [];
    while (pos < scriptHex.length) {
      const opcode = parseInt(scriptHex.substring(pos, pos + 2), 16);
      pos += 2;

      let dataLen: number;
      if (opcode <= 0x4b) {
        // Direct push
        dataLen = opcode;
      } else if (opcode === 0x4c) {
        // OP_PUSHDATA1
        dataLen = parseInt(scriptHex.substring(pos, pos + 2), 16);
        pos += 2;
      } else if (opcode === 0x4d) {
        // OP_PUSHDATA2 (little-endian)
        const lo = parseInt(scriptHex.substring(pos, pos + 2), 16);
        const hi = parseInt(scriptHex.substring(pos + 2, pos + 4), 16);
        dataLen = lo + (hi << 8);
        pos += 4;
      } else if (opcode === 0x4e) {
        // OP_PUSHDATA4 (little-endian)
        const b0 = parseInt(scriptHex.substring(pos, pos + 2), 16);
        const b1 = parseInt(scriptHex.substring(pos + 2, pos + 4), 16);
        const b2 = parseInt(scriptHex.substring(pos + 4, pos + 6), 16);
        const b3 = parseInt(scriptHex.substring(pos + 6, pos + 8), 16);
        dataLen = b0 + (b1 << 8) + (b2 << 16) + (b3 << 24);
        pos += 8;
      } else {
        break; // Unknown opcode, stop parsing
      }

      const dataHex = scriptHex.substring(pos, pos + dataLen * 2);
      pushes.push(Buffer.from(dataHex, 'hex').toString('utf8'));
      pos += dataLen * 2;
    }

    if (pushes.length === 0) return null;

    // The last push is typically the data payload (tag is first, key is second)
    const raw = pushes[pushes.length - 1];

    // Try to parse as JSON
    let parsed: any = raw;
    try {
      const jsonStart = raw.indexOf('{');
      if (jsonStart >= 0) {
        parsed = JSON.parse(raw.substring(jsonStart));
      } else {
        parsed = JSON.parse(raw);
      }
    } catch {
      // Not JSON — return as raw string
    }

    return { raw, parsed };
  } catch {
    return null;
  }
}
