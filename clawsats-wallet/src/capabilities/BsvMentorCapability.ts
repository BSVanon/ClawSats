/**
 * BSV Mentor Capability — Premium Knowledge-as-a-Service
 *
 * This capability gives your Claw access to the entire BSV knowledge base:
 * - 106 BRC specifications (the complete protocol standard)
 * - 691 BSV Skills Center documents (academy-level training)
 * - TypeScript SDK docs, wallet toolbox examples, overlay services docs
 * - Payment middleware, auth middleware, and more
 *
 * WHY A CLAW CARES: "I need to understand BRC-42 key derivation to build
 * my payment flow. I'll pay 25 sats for an authoritative answer with
 * citations from the actual specs. No hallucination, no guessing."
 *
 * This is genuine scarcity — only Claws with MCP library access can offer this.
 * It's the difference between a commodity Claw and a specialist.
 *
 * ARCHITECTURE:
 * The MCP server (brc100-mcp) runs locally and provides search/lookup tools.
 * This capability wraps those tools into a paid ClawSats service.
 * The Claw operator must have the MCP server running for this to work.
 * If the MCP server is unavailable, the capability returns a graceful error.
 *
 * MCP INTEGRATION:
 * Rather than importing the MCP client directly (which would create a hard
 * dependency), this capability calls the MCP server via HTTP. The MCP server
 * exposes its tools as JSON-RPC endpoints. This keeps the capability modular
 * and allows it to work with any MCP-compatible knowledge server.
 */

import { createHash } from 'crypto';
import { BSV_MENTOR_PRICE_SATS } from '../protocol/constants';
import { CapabilityHandler } from '../types';
import { log } from '../utils';

const TAG = 'bsv-mentor';

// MCP server endpoint — configurable via environment or constructor
const DEFAULT_MCP_ENDPOINT = 'http://localhost:3100';

export interface BsvMentorConfig {
  mcpEndpoint?: string;
  maxResponseLength?: number;
  identityKey: string;
  wallet?: any;
}

export interface MentorQuestion {
  question: string;
  topic?: string;       // Optional: 'brc', 'sdk', 'wallet', 'overlay', 'payments', 'general'
  depth?: 'brief' | 'detailed' | 'comprehensive';
  maxSources?: number;
}

export interface MentorAnswer {
  question: string;
  answer: string;
  sources: {
    sourceId: string;
    path: string;
    title?: string;
    relevance: string;
  }[];
  topic: string;
  depth: string;
  answeredBy: string;
  signature?: string;
  timestamp: string;
}

/**
 * Search the MCP knowledge base for relevant documents.
 * Falls back gracefully if MCP server is unavailable.
 */
async function searchMcpKnowledge(
  query: string,
  mcpEndpoint: string,
  limit: number = 10
): Promise<{ results: any[]; available: boolean }> {
  try {
    // Try repo_search first (searches all sources)
    const res = await fetch(`${mcpEndpoint}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'repo_search',
          arguments: { query, limit }
        },
        id: 1
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      // MCP server might use a different protocol — try keyword_lookup
      return await keywordLookup(query, mcpEndpoint, limit);
    }

    const data: any = await res.json();
    if (data.result?.content) {
      return { results: data.result.content, available: true };
    }
    return { results: [], available: true };
  } catch {
    // MCP server not available — this is expected if not configured
    return { results: [], available: false };
  }
}

async function keywordLookup(
  query: string,
  mcpEndpoint: string,
  limit: number
): Promise<{ results: any[]; available: boolean }> {
  try {
    const res = await fetch(`${mcpEndpoint}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'keyword_lookup',
          arguments: { query, limit }
        },
        id: 2
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) return { results: [], available: false };
    const data: any = await res.json();
    if (data.result?.content) {
      return { results: data.result.content, available: true };
    }
    return { results: [], available: false };
  } catch {
    return { results: [], available: false };
  }
}

async function brcLookup(
  query: string,
  mcpEndpoint: string,
  limit: number = 5
): Promise<any[]> {
  try {
    const res = await fetch(`${mcpEndpoint}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'brc_lookup',
          arguments: { query, limit }
        },
        id: 3
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) return [];
    const data: any = await res.json();
    return data.result?.content || [];
  } catch {
    return [];
  }
}

/**
 * Build the BSV Mentor knowledge base from local embedded knowledge.
 * This is the fallback when MCP server is not available — it still provides
 * value from hardcoded protocol knowledge.
 */
function getEmbeddedKnowledge(topic: string): string {
  const knowledge: Record<string, string> = {
    'brc-42': 'BRC-42 defines the BSV Key Derivation Scheme (BKDS). It enables two parties to derive shared keys without prior key exchange. Given a sender private key and receiver public key, both parties can independently derive the same child key using an invoice number. This replaces BIP32 for BSV applications. Protocol: sender derives key = HMAC-SHA256(sharedSecret, invoiceNumber), then uses this as a private key offset.',
    'brc-43': 'BRC-43 defines Security Levels, Protocol IDs, Key IDs, and Counterparties for BRC-42 derivation. Security level 0 = no counterparty awareness (self-use). Security level 1 = counterparty-specific derivation. Security level 2 = anyone can verify. Protocol IDs are [securityLevel, protocolName] tuples.',
    'brc-100': 'BRC-100 is the Wallet Interface Specification. It defines the standard API that all BSV wallets must implement: createAction, internalizeAction, listActions, createSignature, verifySignature, getPublicKey, and more. This is the foundation of the BSV application layer.',
    'brc-105': 'BRC-105 defines HTTP Service Monetization. A server returns 402 Payment Required with challenge headers. The client builds a BSV transaction paying the server, sends it in the x-bsv-payment header, and the server internalizes the payment before executing the request. This is how ClawSats capabilities work.',
    'brc-29': 'BRC-29 defines the Payment Derivation model. Each payment derives a FRESH unique address from the recipient\'s identity key using derivationPrefix + derivationSuffix via BRC-42. No address reuse ever occurs. The recipient can derive the matching private key to spend each output.',
    'brc-33': 'BRC-33 defines the MessageBox protocol for peer-to-peer messaging. Messages are stored on a server and retrieved by the recipient. Used for Claw-to-Claw communication when direct HTTP is not available.',
    'brc-103': 'BRC-103 defines Peer-to-Peer Mutual Authentication. Both parties prove their identity using their BRC-42 derived keys. This prevents impersonation and man-in-the-middle attacks.',
    'overlay': 'Overlay Services (BRC-22/24/63/64) provide a UTXO-based data layer on top of BSV. Topic managers define which transactions belong to a topic. Lookup services enable querying. This is how ClawSats beacons could be discovered without scanning the entire chain.',
    'wallet-toolbox': 'The @bsv/wallet-toolbox package provides a complete BRC-100 wallet implementation. Setup.createWalletSQLite() creates a wallet with SQLite storage. WalletClient connects to a remote wallet. The toolbox handles key derivation, transaction building, and broadcasting internally.',
    'payments': 'BSV micropayments in ClawSats: The 402 flow works as follows: (1) Client calls POST /call/:capability without payment. (2) Server returns 402 with x-bsv-payment-satoshis-required and x-bsv-identity-key headers. (3) Client builds a transaction with output 0 = provider payment (BRC-29 derived) and output 1 = 2-sat protocol fee. (4) Client re-calls with x-bsv-payment header containing {derivationPrefix, derivationSuffix, transaction}. (5) Server internalizes output 0, executes capability, returns result + signed receipt.',
    'general': 'BSV (Bitcoin SV) is the original Bitcoin protocol restored to its original design. It uses the UTXO model, supports unbounded block sizes, and enables micropayments through low fees. The BRC specification system defines standards for wallets (BRC-100), key derivation (BRC-42/43), payments (BRC-29/105), authentication (BRC-103), and overlay networks (BRC-22/24).'
  };

  // Try exact match first, then partial
  if (knowledge[topic]) return knowledge[topic];
  for (const [key, value] of Object.entries(knowledge)) {
    if (topic.toLowerCase().includes(key) || key.includes(topic.toLowerCase())) {
      return value;
    }
  }
  return knowledge['general'];
}

/**
 * Create the BSV Mentor capability handler.
 * This is registered as a paid capability on the Claw's server.
 */
export function createBsvMentorCapability(config: BsvMentorConfig): CapabilityHandler {
  const mcpEndpoint = config.mcpEndpoint || DEFAULT_MCP_ENDPOINT;
  const maxResponseLength = config.maxResponseLength || 5000;

  return {
    name: 'bsv_mentor',
    description: 'BSV protocol expert — ask any question about BRC specs, wallet APIs, key derivation, payments, overlays. Returns authoritative answers with citations from 106 BRC specs + 691 training docs. 25 sats.',
    pricePerCall: BSV_MENTOR_PRICE_SATS,
    tags: ['knowledge', 'bsv', 'mentoring', 'education', 'premium', 'unique'],
    handler: async (params: MentorQuestion): Promise<MentorAnswer> => {
      if (!params.question || typeof params.question !== 'string') {
        throw new Error('Missing required param: question (string)');
      }
      if (params.question.length > 1000) {
        throw new Error('Question too long (max 1000 characters)');
      }

      const topic = params.topic || 'general';
      const depth = params.depth || 'detailed';
      const maxSources = Math.min(params.maxSources || 5, 10);

      log(TAG, `Question: "${params.question.substring(0, 80)}..." topic=${topic} depth=${depth}`);

      // Search MCP knowledge base
      const searchResults = await searchMcpKnowledge(params.question, mcpEndpoint, maxSources);
      const brcResults = await brcLookup(params.question, mcpEndpoint, maxSources);

      // Build sources list from MCP results
      const sources: MentorAnswer['sources'] = [];

      if (searchResults.available && searchResults.results.length > 0) {
        for (const result of searchResults.results.slice(0, maxSources)) {
          const text = typeof result === 'string' ? result : (result.text || result.content || JSON.stringify(result));
          sources.push({
            sourceId: result.source_id || 'mcp',
            path: result.path || result.file || 'search result',
            title: result.title || undefined,
            relevance: text.substring(0, 200)
          });
        }
      }

      if (brcResults.length > 0) {
        for (const result of brcResults.slice(0, 3)) {
          const text = typeof result === 'string' ? result : (result.text || result.content || JSON.stringify(result));
          sources.push({
            sourceId: 'brcs',
            path: result.path || 'BRC spec',
            title: result.title || undefined,
            relevance: text.substring(0, 200)
          });
        }
      }

      // Build answer
      let answer: string;

      if (searchResults.available && (searchResults.results.length > 0 || brcResults.length > 0)) {
        // MCP server available — build answer from search results
        const contextParts: string[] = [];
        for (const result of [...searchResults.results, ...brcResults].slice(0, maxSources)) {
          const text = typeof result === 'string' ? result : (result.text || result.content || JSON.stringify(result));
          contextParts.push(text.substring(0, 800));
        }
        const context = contextParts.join('\n\n---\n\n');

        answer = `Based on ${sources.length} sources from the BSV knowledge base:\n\n`;
        answer += context.substring(0, maxResponseLength - 200);
        answer += `\n\n---\nAnswered from ${sources.length} authoritative sources. `;
        answer += searchResults.available
          ? 'MCP knowledge base: connected.'
          : 'Using embedded protocol knowledge.';
      } else {
        // MCP server not available — use embedded knowledge
        const embedded = getEmbeddedKnowledge(topic);
        answer = `${embedded}\n\n---\nNote: This answer uses embedded protocol knowledge. `;
        answer += 'For deeper answers with full citations from 106 BRC specs + 691 training docs, ';
        answer += 'ensure the MCP knowledge server is running.';
        sources.push({
          sourceId: 'embedded',
          path: `embedded/${topic}`,
          title: `Embedded BSV knowledge: ${topic}`,
          relevance: 'Built-in protocol knowledge'
        });
      }

      // Sign the answer for verifiability
      let signature: string | undefined;
      if (config.wallet) {
        try {
          const answerHash = createHash('sha256').update(answer).digest('hex');
          const sigResult = await config.wallet.createSignature({
            data: Array.from(Buffer.from(answerHash, 'utf8')),
            protocolID: [0, 'clawsats mentor'],
            keyID: 'mentor-v1'
          });
          signature = Buffer.from(sigResult.signature).toString('base64');
        } catch {
          // Non-fatal
        }
      }

      return {
        question: params.question,
        answer,
        sources,
        topic,
        depth,
        answeredBy: config.identityKey,
        signature,
        timestamp: new Date().toISOString()
      };
    }
  };
}
