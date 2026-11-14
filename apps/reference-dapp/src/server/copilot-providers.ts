// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-AI-PROVIDERS-001: the Copilot's model providers — OpenAI (Responses API, `copilot-service.ts`) and Anthropic (Messages API, here).
 *
 * Anthropic is a second interpreter behind exactly the same boundary. `interpretCopilotV2` keeps building one provider-neutral request (the
 * Responses-API body it always built: instructions, transcript, FloFi's read-only tools, the strict output schema) and keeps parsing one
 * response shape. The Anthropic transport translates that request into a native Messages API request and the native answer back, at the
 * transport edge, so everything that decides what the model may do stays shared and unchanged: the instructions, the strict output
 * schema, FloFi's deterministic intent validation (`parseCopilotOutputV2`), the read-only tool allowlist and its argument validation, the
 * orchestration bounds, grounding, the concurrency limiter, and the closed failure codes. A model can still only return an untrusted intent;
 * nothing here can sign, submit, approve, transfer, schedule or change a workflow.
 *
 * The transport is fixed to one HTTPS endpoint (`api.anthropic.com/v1/messages`), refuses redirects, has a hard timeout and a byte cap, sends
 * the key only in its `x-api-key` header, and never retries on its own: a rate limit or an outage is reported with its code (and Retry-After),
 * never silently routed to another provider. Error bodies are reduced to allow-listed types; their free text is never returned.
 *
 * Model discovery reads Anthropic's Models API (`GET /v1/models`, cached per process) so the Admin shows the models this organization can
 * actually use, with their exact ids; the capability catalog (`copilot-settings.ts`) still decides which parameters are valid.
 *
 * Estimated cost uses the per-token list prices below. They are estimates from measured tokens, never billing data: credits, discounts and
 * invoices exist only in the provider's console.
 */
import { createHash } from 'node:crypto';
import { COPILOT_SERVER_LIMITS, CopilotServiceError, copilotConfig, createOpenAITransport, readCapped, type CopilotHttpResponse, type CopilotTransport } from './copilot-service.ts';
import type { CopilotProvider } from './copilot-settings.ts';

type Env = Readonly<Record<string, string | undefined>>;
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
/** The API version FloFi sends. On it, `temperature`/`top_p`/`top_k` are refused on every model; FloFi never sends them to Anthropic. */
export const ANTHROPIC_VERSION = '2026-10-21';
export const ANTHROPIC_CONSOLE = Object.freeze({ billing: 'https://platform.claude.com/settings/billing', usage: 'https://platform.claude.com/usage',
  keys: 'https://platform.claude.com/settings/keys', pricing: 'https://platform.claude.com/docs/en/about-claude/pricing' });
const fail = (code: string): never => { throw new CopilotServiceError(code); };

// ── Credentials and readiness ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The environment variable holding each provider's key. The two keys are independent; neither is ever a runtime setting. */
export const PROVIDER_KEY_ENV: Readonly<Record<CopilotProvider, string>> = Object.freeze({ OPENAI: 'OPENAI_API_KEY', ANTHROPIC: 'ANTHROPIC_API_KEY' });
const keyOf = (env: Env, provider: CopilotProvider): string | null => {
  const key = env[PROVIDER_KEY_ENV[provider]]?.trim() ?? '';
  return key && !/\s/.test(key) && key.length <= 512 ? key : null;
};
/** The provider's key for a live Copilot (`FLOFI_COPILOT=live`), or null. */
export function providerApiKey(env: Env, provider: CopilotProvider): string | null {
  return env.FLOFI_COPILOT === 'live' ? keyOf(env, provider) : null;
}
/** Whether each provider's key is present (never the key). Independent of the Copilot mode, for display. */
export function providerReadiness(env: Env): Readonly<Record<CopilotProvider, boolean>> {
  return { OPENAI: keyOf(env, 'OPENAI') !== null, ANTHROPIC: keyOf(env, 'ANTHROPIC') !== null };
}
/** Whether any provider has a key, so a live Copilot can run at all. */
export const anyProviderKey = (env: Env): boolean => env.FLOFI_COPILOT === 'live' && (keyOf(env, 'OPENAI') !== null || keyOf(env, 'ANTHROPIC') !== null);

/**
 * The Copilot mode this deployment is configured for: `copilotConfig(env).mode`, except that a live Copilot with an Anthropic key whose
 * OpenAI bootstrap is not usable (no OpenAI key or no `OPENAI_COPILOT_*` model) is `live` — its model comes from the Admin's runtime settings, and every request
 * still resolves (and may fail closed) per request. Every other configuration reads exactly as before.
 */
export function copilotConfiguredMode(env: Env): ReturnType<typeof copilotConfig>['mode'] {
  const mode = copilotConfig(env).mode;
  return mode === 'unavailable' && env.FLOFI_COPILOT === 'live' && keyOf(env, 'ANTHROPIC') !== null ? 'live' : mode;
}

/** One live transport for `provider`. A provider is never substituted: each has its own fixed endpoint and key. */
export function createProviderTransport(provider: CopilotProvider, apiKey: string, fetchImpl: typeof fetch = fetch,
  limits: { readonly timeoutMs: number; readonly maxResponseBytes: number } = COPILOT_SERVER_LIMITS): CopilotTransport {
  return provider === 'ANTHROPIC' ? createAnthropicTransport(apiKey, fetchImpl, limits) : createOpenAITransport(apiKey, fetchImpl, limits);
}

// ── Structured output schema ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Anthropic's structured outputs compile a subset of JSON Schema: no numeric or string-length bounds, no `pattern`, no complex array bounds.
 * Those keywords are removed from the copy sent to the API (and `oneOf` becomes the equivalent `anyOf` of disjoint branches). Nothing is
 * lost: FloFi validates every answer against its full contract afterwards (`parseCopilotOutputV2` and the tool argument validators).
 */
const DROPPED = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems',
  'uniqueItems', 'minProperties', 'maxProperties', 'default', 'examples', 'title', '$schema']);
const FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);
export function anthropicSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(anthropicSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED.has(key)) continue;
    if (key === 'format' && (typeof value !== 'string' || !FORMATS.has(value))) continue;
    if (key === 'properties' && value && typeof value === 'object') { out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, anthropicSchema(child)])); continue; }
    out[key === 'oneOf' ? 'anyOf' : key] = anthropicSchema(value);
  }
  return out;
}

// ── Request translation ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Marks the assistant turn of a tool round, echoed back unchanged on the next round (thinking blocks included, as the API requires). */
export const ANTHROPIC_ECHO = 'flofi.anthropic.turn.v1:';
type Block = Record<string, unknown> & { type: string };
type Message = { role: 'user' | 'assistant'; content: Block[] };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The Messages API request equivalent to one Copilot request body (the provider-neutral body `copilot-service.ts` builds). */
export function anthropicRequest(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.model !== 'string' || typeof body.instructions !== 'string' || !Array.isArray(body.input)) return fail('COPILOT_REQUEST_INVALID');
  // FloFi never sends sampling parameters to Anthropic (the API version refuses them); a request that has one is a configuration error.
  if (body.temperature !== undefined) return fail('COPILOT_PARAMETER_UNSUPPORTED');
  const system: Block[] = [{ type: 'text', text: body.instructions }], messages: Message[] = [];
  const echoes = new Set<Message>();
  const push = (role: Message['role'], blocks: Block[]) => {
    const last = messages.at(-1);
    // Consecutive turns of one role are merged; an echoed tool-round turn is replayed exactly as returned and never merged into.
    if (last && last.role === role && !echoes.has(last)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  let echoed: Set<string> | null = null;
  for (const item of body.input as unknown[]) {
    if (!record(item)) return fail('COPILOT_REQUEST_INVALID');
    if (item.role === 'developer' && typeof item.content === 'string') { system.push({ type: 'text', text: item.content }); continue; }
    if ((item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string') { echoed = null; push(item.role, [{ type: 'text', text: item.content }]); continue; }
    if (item.type === 'reasoning') {
      const encoded = typeof item.encrypted_content === 'string' && item.encrypted_content.startsWith(ANTHROPIC_ECHO) ? item.encrypted_content.slice(ANTHROPIC_ECHO.length) : null;
      let content: unknown;
      try { content = encoded === null ? null : JSON.parse(encoded); } catch { content = null; }
      if (!Array.isArray(content) || !content.every(block => record(block) && typeof block.type === 'string')) return fail('COPILOT_REQUEST_INVALID');
      // The assistant turn is replayed exactly as the API returned it: thinking, text and tool calls, in order.
      const echo: Message = { role: 'assistant', content: content as Block[] };
      messages.push(echo); echoes.add(echo);
      echoed = new Set((content as Block[]).filter(block => block.type === 'tool_use').map(block => String(block.id)));
      continue;
    }
    if (item.type === 'function_call') {
      // Already part of the echoed assistant turn; a call FloFi did not receive in that turn is refused.
      if (!echoed || typeof item.call_id !== 'string' || !echoed.has(item.call_id)) return fail('COPILOT_REQUEST_INVALID');
      continue;
    }
    if (item.type === 'function_call_output' && typeof item.call_id === 'string' && typeof item.output === 'string') {
      push('user', [{ type: 'tool_result', tool_use_id: item.call_id, content: item.output }]);
      continue;
    }
    return fail('COPILOT_REQUEST_INVALID');
  }
  const format = record(body.text) && record(body.text.format) ? body.text.format : null;
  if (!format || format.type !== 'json_schema' || !record(format.schema)) return fail('COPILOT_REQUEST_INVALID');
  const effort = record(body.reasoning) && typeof body.reasoning.effort === 'string' ? body.reasoning.effort : null;
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]).map(tool => {
    if (!record(tool) || tool.type !== 'function' || typeof tool.name !== 'string' || typeof tool.description !== 'string' || !record(tool.parameters)) return fail('COPILOT_REQUEST_INVALID');
    return { name: tool.name, description: tool.description, input_schema: anthropicSchema(tool.parameters), ...tool.strict === true ? { strict: true } : {} };
  }) : null;
  return { model: body.model, max_tokens: body.max_output_tokens, system, messages,
    ...tools ? { tools, tool_choice: { type: body.tool_choice === 'none' ? 'none' : 'auto' } } : {},
    output_config: { format: { type: 'json_schema', schema: anthropicSchema(format.schema) }, ...effort ? { effort } : {} } };
}

// ── Response translation ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/**
 * A native Messages API answer expressed in the response shape the Copilot parses. Refusals become refusals, a cut-off answer is
 * incomplete, tool calls become function calls (with the whole assistant turn kept for the echo), and any block FloFi did not ask for
 * (server tools, unknown types) stays an unknown item that the shared reader refuses.
 */
export function responsesBodyFromAnthropic(text: string): string {
  let message: Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(text); if (!record(parsed)) return fail('COPILOT_RESPONSE_INVALID'); message = parsed; } catch { return fail('COPILOT_RESPONSE_INVALID'); }
  if (message.type !== 'message' || message.role !== 'assistant' || !Array.isArray(message.content)) return fail('COPILOT_RESPONSE_INVALID');
  const content = message.content as unknown[], stop = message.stop_reason;
  const usage = record(message.usage) ? message.usage : {};
  const input = [count(usage.input_tokens), count(usage.cache_creation_input_tokens), count(usage.cache_read_input_tokens)];
  const shared = { model: typeof message.model === 'string' && MODEL.test(message.model) ? message.model : null,
    usage: { input_tokens: input[0] === null ? null : input.reduce<number>((total, value) => total + (value ?? 0), 0), output_tokens: count(usage.output_tokens) } };
  if (stop === 'refusal') return JSON.stringify({ ...shared, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: '' }] }] });
  if (stop === 'max_tokens' || stop === 'model_context_window_exceeded' || stop === 'pause_turn')
    return JSON.stringify({ ...shared, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
  if (stop !== 'end_turn' && stop !== 'tool_use' && stop !== 'stop_sequence') return JSON.stringify({ ...shared, status: 'failed', output: [] });
  const output: Record<string, unknown>[] = [], texts: string[] = [];
  const calls = content.filter((block): block is Block => record(block) && block.type === 'tool_use');
  if (calls.length) output.push({ type: 'reasoning', summary: [], encrypted_content: ANTHROPIC_ECHO + JSON.stringify(content) });
  for (const block of content) {
    if (!record(block)) return fail('COPILOT_RESPONSE_INVALID');
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
    if (block.type === 'text' && typeof block.text === 'string') { texts.push(block.text); continue; }
    if (block.type === 'tool_use') {
      output.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? null) });
      continue;
    }
    // Never the provider's own type name: a block named like a shared item ('reasoning', 'message') must not be skipped as one.
    output.push({ type: 'provider_block_unexpected' });
  }
  if (texts.length) output.splice(calls.length ? 1 : 0, 0, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: texts.join(''), annotations: [] }] });
  return JSON.stringify({ ...shared, status: 'completed', output });
}

/** Allow-listed Anthropic error types; every other value (and every error message) is dropped. */
export const ANTHROPIC_ERROR_TYPES = new Set(['invalid_request_error', 'authentication_error', 'billing_error', 'permission_error', 'not_found_error',
  'request_too_large', 'rate_limit_error', 'api_error', 'overloaded_error']);
/** Request parameters an invalid-request message may name; only these names are ever surfaced (never the message itself). */
const ANTHROPIC_PARAMS = ['output_config.format', 'output_config.effort', 'output_config', 'max_tokens', 'temperature', 'thinking', 'tool_choice', 'tools', 'model', 'system'];
export type AnthropicRejection = { readonly status: number; readonly type: string | null; readonly param: string | null };
/** An upstream refusal with its allow-listed diagnostics (for an authorized operator's live test). */
export class CopilotProviderError extends CopilotServiceError {
  constructor(code: string, readonly upstream: AnthropicRejection) { super(code); }
}
/** The closed code and allow-listed diagnostics of a non-2xx Messages API answer. */
export function anthropicRejection(status: number, body: string): { readonly code: string; readonly upstream: AnthropicRejection } {
  let type: string | null = null, message = '';
  try {
    const error = (JSON.parse(body) as { error?: { type?: unknown; message?: unknown } }).error;
    type = typeof error?.type === 'string' && ANTHROPIC_ERROR_TYPES.has(error.type) ? error.type : null;
    message = typeof error?.message === 'string' ? error.message.slice(0, 2_000) : '';
  } catch { /* an unreadable body keeps only its status */ }
  const param = status === 400 ? ANTHROPIC_PARAMS.find(name => new RegExp(`(?:^|[^a-z_.])${name.replace('.', '\\.')}(?:$|[^a-z_])`, 'i').test(message)) ?? null : null;
  // Insufficient credits arrive as 402 billing_error or a 400 about the credit balance; neither is retried or routed elsewhere.
  const billing = status === 402 || type === 'billing_error' || (status === 400 && /credit balance/i.test(message));
  const code = billing ? 'COPILOT_UPSTREAM_BILLING' : status === 401 || status === 403 ? 'COPILOT_UPSTREAM_UNAUTHORIZED'
    : status === 404 ? 'COPILOT_UPSTREAM_MODEL_UNAVAILABLE' : status === 429 ? 'COPILOT_UPSTREAM_RATE_LIMITED' : status === 408 ? 'COPILOT_TIMEOUT'
      : status === 413 ? 'COPILOT_UPSTREAM_REJECTED' : status >= 400 && status < 500 ? 'COPILOT_UPSTREAM_REJECTED' : 'COPILOT_UPSTREAM_UNAVAILABLE';
  return { code, upstream: { status, type: billing && !type ? 'billing_error' : type, param } };
}

/** The live Anthropic transport: one fixed HTTPS endpoint, no redirects, a hard timeout and a byte cap. Errors carry codes only. */
export function createAnthropicTransport(apiKey: string, fetchImpl: typeof fetch = fetch,
  limits: { readonly timeoutMs: number; readonly maxResponseBytes: number } = COPILOT_SERVER_LIMITS): CopilotTransport {
  return async ({ body }) => {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return fail('COPILOT_REQUEST_INVALID'); }
    if (!record(parsed)) return fail('COPILOT_REQUEST_INVALID');
    const request = JSON.stringify(anthropicRequest(parsed));
    let response: Response, text: string;
    try {
      response = await fetchImpl(ANTHROPIC_MESSAGES_URL, { method: 'POST', body: request, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(limits.timeoutMs),
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' } });
      text = await readCapped(response, limits.maxResponseBytes);
    } catch (cause) {
      if (cause instanceof CopilotServiceError) throw cause;
      const name = cause instanceof Error ? cause.name : '';
      return fail(name === 'TimeoutError' || name === 'AbortError' ? 'COPILOT_TIMEOUT' : 'COPILOT_UPSTREAM_UNAVAILABLE');
    }
    const retryAfter = response.headers.get('retry-after');
    if (response.status === 429) return { status: 429, body: '', retryAfter };
    if (response.status < 200 || response.status >= 300) {
      const rejected = anthropicRejection(response.status, text);
      throw new CopilotProviderError(rejected.code, rejected.upstream);
    }
    const translated = responsesBodyFromAnthropic(text);
    if (translated.length > limits.maxResponseBytes) return fail('COPILOT_RESPONSE_TOO_LARGE');
    return { status: response.status, body: translated, retryAfter } satisfies CopilotHttpResponse;
  };
}

// ── Model discovery ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type DiscoveredModel = { readonly id: string; readonly displayName: string; readonly createdAt: string | null; readonly maxInputTokens: number | null;
  readonly maxOutputTokens: number | null; readonly structuredOutputs: boolean | null; readonly efforts: readonly string[] | null };
export type ModelDiscovery = { readonly ok: true; readonly models: readonly DiscoveredModel[]; readonly fetchedAt: string }
  | { readonly ok: false; readonly code: string; readonly fetchedAt: string };
export const MODEL_DISCOVERY_TTL_MS = 10 * 60_000, MODEL_DISCOVERY_FAILURE_TTL_MS = 60_000;
const DISCOVERY = Symbol.for('flofi.copilot.anthropic-models');
const supported = (value: unknown): boolean | null => record(value) && typeof value.supported === 'boolean' ? value.supported : null;
function discovered(entry: unknown): DiscoveredModel | null {
  if (!record(entry) || typeof entry.id !== 'string' || !/^claude-[a-z0-9][a-z0-9.-]{0,90}$/.test(entry.id)) return null;
  const caps = record(entry.capabilities) ? entry.capabilities : {}, effort = record(caps.effort) ? caps.effort : null;
  const efforts = effort && supported(effort) ? ['low', 'medium', 'high', 'xhigh', 'max'].filter(level => supported(effort[level]) === true) : effort ? [] : null;
  const name = typeof entry.display_name === 'string' && /^[\p{L}\p{N} .()/-]{1,80}$/u.test(entry.display_name) ? entry.display_name : entry.id;
  return { id: entry.id, displayName: name, createdAt: typeof entry.created_at === 'string' && entry.created_at.length <= 40 ? entry.created_at : null,
    maxInputTokens: count(entry.max_input_tokens), maxOutputTokens: count(entry.max_tokens), structuredOutputs: supported(caps.structured_outputs), efforts };
}
/**
 * The models this Anthropic organization can use (`GET /v1/models`, at most 3 pages of 100), newest first. Cached per process and key
 * fingerprint for 10 minutes (failures for one minute), so the Admin never calls the API on every page view. Retired models are not
 * listed by the API, so they are never offered as available.
 */
export async function discoverAnthropicModels(apiKey: string, options: { readonly fetch?: typeof fetch; readonly now?: () => number; readonly fresh?: boolean } = {}): Promise<ModelDiscovery> {
  const now = options.now ?? Date.now, fetchImpl = options.fetch ?? fetch;
  const holder = globalThis as unknown as Record<symbol, Map<string, { at: number; value: ModelDiscovery }> | undefined>;
  const cache = holder[DISCOVERY] ??= new Map(), fingerprint = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  const cached = cache.get(fingerprint);
  if (cached && !options.fresh && now() - cached.at < (cached.value.ok ? MODEL_DISCOVERY_TTL_MS : MODEL_DISCOVERY_FAILURE_TTL_MS)) return cached.value;
  const models: DiscoveredModel[] = [];
  let value: ModelDiscovery;
  try {
    let after: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const url = new URL(ANTHROPIC_MODELS_URL);
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after_id', after);
      const response = await fetchImpl(url, { method: 'GET', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION } });
      const text = await readCapped(response, 1_048_576);
      if (response.status < 200 || response.status >= 300) { value = { ok: false, code: anthropicRejection(response.status, text).code, fetchedAt: new Date(now()).toISOString() }; break; }
      const parsed = JSON.parse(text) as { data?: unknown; has_more?: unknown; last_id?: unknown };
      if (!Array.isArray(parsed.data)) throw new Error('COPILOT_RESPONSE_INVALID');
      for (const entry of parsed.data) { const model = discovered(entry); if (model) models.push(model); }
      if (parsed.has_more !== true || typeof parsed.last_id !== 'string') break;
      after = parsed.last_id;
    }
    value ??= { ok: true, models: Object.freeze(models), fetchedAt: new Date(now()).toISOString() };
  } catch (cause) {
    const code = cause instanceof CopilotServiceError ? cause.message : cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError') ? 'COPILOT_TIMEOUT'
      : 'COPILOT_UPSTREAM_UNAVAILABLE';
    value = { ok: false, code, fetchedAt: new Date(now()).toISOString() };
  }
  cache.set(fingerprint, { at: now(), value });
  return value;
}

// ── Estimated cost ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Anthropic first-party API list prices in USD per million tokens (standard tier, no batch, no cache), as published on the pricing page
 * (checked 2026-11-03). Claude Haiku 5.5's price applies to prompts up to 100K tokens, far above any Copilot request. Keep this table in
 * step with the pricing page; a model that is not listed has no estimate. No OpenAI price is listed: none was validated for this build.
 */
export const MODEL_PRICES_CHECKED = '2026-11-03';
export const MODEL_PRICES: readonly { readonly provider: CopilotProvider; readonly match: RegExp; readonly label: string; readonly inputPerMTok: number; readonly outputPerMTok: number }[] =
  Object.freeze([
    { provider: 'ANTHROPIC', match: /^claude-fable-5-2(?:-\d{8})?$/, label: 'Claude Fable 5.2', inputPerMTok: 8, outputPerMTok: 40 },
    { provider: 'ANTHROPIC', match: /^claude-fable-5(?:-1)?(?:-\d{8})?$/, label: 'Claude Fable 5 / 5.1', inputPerMTok: 10, outputPerMTok: 50 },
    { provider: 'ANTHROPIC', match: /^claude-opus-5-5(?:-\d{8})?$/, label: 'Claude Opus 5.5', inputPerMTok: 4, outputPerMTok: 20 },
    { provider: 'ANTHROPIC', match: /^claude-opus-(?:5|4-8)(?:-\d{8})?$/, label: 'Claude Opus 5 / 4.8', inputPerMTok: 5, outputPerMTok: 25 },
    { provider: 'ANTHROPIC', match: /^claude-sonnet-5(?:-5)?(?:-\d{8})?$/, label: 'Claude Sonnet 5 / 5.5', inputPerMTok: 2, outputPerMTok: 10 },
    { provider: 'ANTHROPIC', match: /^claude-haiku-5-5(?:-\d{8})?$/, label: 'Claude Haiku 5.5', inputPerMTok: 0.1, outputPerMTok: 0.5 },
    { provider: 'ANTHROPIC', match: /^claude-haiku-4-5(?:-\d{8})?$/, label: 'Claude Haiku 4.5', inputPerMTok: 1, outputPerMTok: 5 },
  ] as const);
export const modelPrice = (model: string) => MODEL_PRICES.find(price => price.match.test(model)) ?? null;
/** Estimated USD for measured tokens, or null when the model has no listed price. An estimate, never an invoice or a credit balance. */
export function estimatedCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = modelPrice(model);
  return price ? (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000 : null;
}
