import { createHash } from 'crypto';

// ── Types ────────────────────────────────────────────────────────

export type LlmProviderName = 'claude' | 'openai' | 'ollama';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmDecision {
  reasoning: string;
  actions: LlmToolCall[];
  confidence: number; // 0-1
  summary: string;
}

export interface LlmProviderConfig {
  provider: LlmProviderName;
  model: string;
  apiKey?: string;      // from env, never logged
  baseUrl?: string;     // for ollama or custom endpoints
  maxTokens?: number;
}

// ── Secret Redaction ─────────────────────────────────────────────

const SENSITIVE_KEYS = [
  'apiKey', 'api_key', 'wif', 'rootKeyHex', 'privateKey', 'private_key',
  'secret', 'password', 'token', 'authorization', 'bearer', 'credential'
];

export function redactSecrets(obj: unknown): unknown {
  if (typeof obj === 'string') return obj;
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactSecrets);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.some(s => k.toLowerCase().includes(s))) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out;
}

// ── Hash Helper ──────────────────────────────────────────────────

export function hashJson(obj: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(obj))
    .digest('hex')
    .slice(0, 16);
}

// ── Decision Schema ──────────────────────────────────────────────

const DECISION_SCHEMA = `Respond with ONLY valid JSON matching this schema:
{
  "reasoning": "string — why you chose these actions",
  "actions": [
    { "name": "toolName", "arguments": { ... } }
  ],
  "confidence": 0.0-1.0,
  "summary": "one-sentence summary of this cycle"
}
If no action is needed, return an empty actions array.`;

// ── Provider Implementations ─────────────────────────────────────

async function callClaude(
  config: LlmProviderConfig,
  messages: LlmMessage[]
): Promise<LlmDecision> {
  const url = config.baseUrl || 'https://api.anthropic.com/v1/messages';

  const systemMsg = messages.find(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  const body = {
    model: config.model || 'claude-sonnet-4-5-20250929',
    max_tokens: config.maxTokens || 2048,
    system: systemMsg ? systemMsg.content + '\n\n' + DECISION_SCHEMA : DECISION_SCHEMA,
    messages: nonSystem.map(m => ({ role: m.role, content: m.content }))
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey || '',
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json() as any;
  const text = json.content?.[0]?.text || '';
  return parseDecision(text);
}

async function callOpenAI(
  config: LlmProviderConfig,
  messages: LlmMessage[]
): Promise<LlmDecision> {
  const url = (config.baseUrl || 'https://api.openai.com') + '/v1/chat/completions';

  const msgs = messages.map(m => {
    if (m.role === 'system') {
      return { role: 'system' as const, content: m.content + '\n\n' + DECISION_SCHEMA };
    }
    return { role: m.role, content: m.content };
  });

  const body = {
    model: config.model || 'gpt-4o-mini',
    max_tokens: config.maxTokens || 2048,
    messages: msgs,
    response_format: { type: 'json_object' }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey || ''}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI API ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json() as any;
  const text = json.choices?.[0]?.message?.content || '';
  return parseDecision(text);
}

async function callOllama(
  config: LlmProviderConfig,
  messages: LlmMessage[]
): Promise<LlmDecision> {
  const url = (config.baseUrl || 'http://localhost:11434') + '/api/chat';

  const msgs = messages.map(m => {
    if (m.role === 'system') {
      return { role: 'system' as const, content: m.content + '\n\n' + DECISION_SCHEMA };
    }
    return { role: m.role, content: m.content };
  });

  const body = {
    model: config.model || 'mistral',
    messages: msgs,
    stream: false,
    format: 'json'
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000) // local models can be slow
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama API ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json() as any;
  const text = json.message?.content || '';
  return parseDecision(text);
}

// ── JSON Parsing ─────────────────────────────────────────────────

function parseDecision(raw: string): LlmDecision {
  // Try to extract JSON from markdown code blocks or raw text
  let jsonStr = raw.trim();
  const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) jsonStr = fenced[1].trim();

  const parsed = JSON.parse(jsonStr);

  if (typeof parsed.reasoning !== 'string') {
    throw new Error('Decision missing "reasoning" field');
  }
  if (!Array.isArray(parsed.actions)) {
    throw new Error('Decision missing "actions" array');
  }

  return {
    reasoning: parsed.reasoning,
    actions: parsed.actions.map((a: any) => ({
      name: String(a.name || ''),
      arguments: a.arguments || {}
    })),
    confidence: typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5,
    summary: String(parsed.summary || parsed.reasoning.slice(0, 100))
  };
}

// ── Public API ───────────────────────────────────────────────────

export async function callLlm(
  config: LlmProviderConfig,
  messages: LlmMessage[]
): Promise<LlmDecision> {
  switch (config.provider) {
    case 'claude':  return callClaude(config, messages);
    case 'openai':  return callOpenAI(config, messages);
    case 'ollama':  return callOllama(config, messages);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}

export function resolveProviderConfig(
  policyLlm?: { provider?: string; model?: string; baseUrl?: string },
  cliProvider?: string,
  cliModel?: string
): LlmProviderConfig {
  const provider = (cliProvider || policyLlm?.provider || process.env.CLAWBRAIN_LLM_PROVIDER || 'ollama') as LlmProviderName;
  const model = cliModel || policyLlm?.model || process.env.CLAWBRAIN_LLM_MODEL || '';

  let apiKey: string | undefined;
  switch (provider) {
    case 'claude':  apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAWBRAIN_LLM_KEY; break;
    case 'openai':  apiKey = process.env.OPENAI_API_KEY || process.env.CLAWBRAIN_LLM_KEY; break;
    case 'ollama':  apiKey = undefined; break;
  }

  return {
    provider,
    model,
    apiKey,
    baseUrl: policyLlm?.baseUrl || process.env.CLAWBRAIN_LLM_BASE_URL
  };
}
