// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-001: the HTTP boundary of the FloFi Remote MCP Gateway (`POST /api/mcp`).
 *
 * Order of checks, each failing closed before any MCP processing: enablement → Origin allowlist (DNS-rebinding protection for
 * browser clients; server-to-server clients send no Origin) → bearer credential → the official SDK's stateless handler
 * (one fresh server per request, JSON responses, 64 KiB body bound). Nothing is kept between requests, so any serverless
 * instance can serve any request. Logs carry the principal id, tool, outcome code and duration — never the token, arguments,
 * addresses or results.
 *
 * BUILD-MCP-002: with `FLOFI_MCP_OAUTH=enabled` the gateway is also an OAuth protected resource. A `flofi_at_` access token is
 * looked up in PostgreSQL on every request (revocation is immediate) and must be bound to this exact resource (audience). The
 * gateway reads the bounded JSON-RPC body before the SDK so a tool call outside the token's scopes is refused at the HTTP level
 * (403 `insufficient_scope`, which lets the client step up), and an unauthenticated request gets the 401 challenge that points
 * clients to the protected resource metadata.
 *
 * Deadlines (`deadline.ts`): every request has one budget well below the function limit. Each store read before the exchange, every
 * runtime read and each tool is bounded by it; the forwarded request carries an abort signal (client close, hard deadline), and if the
 * exchange is still running at the hard deadline the gateway answers itself with a classified JSON-RPC error carrying the request id.
 * Every response names its request id (`x-flofi-request-id`) and every request ends with one `mcp.request` log line.
 */
import { networkScope } from '../server/network-scope.ts';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticate, principalScopes, readMcpConfig, type McpOAuthPrincipal, type McpPrincipal } from './config.ts';
import { PANEL_URI } from './app/panel.ts';
import { readHandoffPolicy } from './execution.ts';
import { DEFAULT_SCOPES, readOAuthConfig, type McpScope, type OAuthConfig } from './oauth/config.ts';
import { credentialDigest, credentialOf } from './oauth/crypto.ts';
import { mcpState, type McpState } from './oauth/state.ts';
import { boundedRuntime, deploymentRuntime, type McpRuntime } from './runtime.ts';
import { APPROVAL_TOOL_NAMES, createFlofiMcpServer, timeoutResult, TOOL_SCOPES, type ToolName } from './tools.ts';
import { createRequestBudget, isDeadlineError, MCP_UPSTREAM_TIMEOUTS, withinBudget, type RequestBudget } from './deadline.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type GatewayLogger = { readonly info: (event: string, fields?: Readonly<Record<string, string | number | boolean | null>>) => void;
  readonly warn: (event: string, fields?: Readonly<Record<string, string | number | boolean | null>>) => void };
export type GatewayOptions = { readonly env?: Env; readonly runtime?: McpRuntime; readonly logger?: GatewayLogger; readonly state?: McpState; readonly now?: () => Date;
  /** Tests: the request budget (default `MCP_REQUEST_BUDGET_MS`) and the tool margin before it. */
  readonly budgetMs?: number; readonly marginMs?: number };
export const MCP_MAX_BODY_BYTES = 65_536;
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const reject = (status: number, code: string, extra: Record<string, string> = {}) =>
  Response.json({ ok: false, code }, { status, headers: { ...HEADERS, ...extra } });

/** RFC 6750 §3 challenge with the RFC 9728 `resource_metadata` pointer and the scopes to ask for. */
function challenge(oauth: OAuthConfig, scopes: readonly McpScope[], error?: 'invalid_token' | 'insufficient_scope'): string {
  return `Bearer ${error ? `error="${error}", ` : ''}resource_metadata="${oauth.resourceMetadataUrl}", scope="${scopes.join(' ')}"`;
}
/**
 * The scopes a JSON-RPC message (or batch) needs: only `tools/call` of a tool that exists for this principal needs one; everything
 * else needs a token. A tool the principal does not have at all (e.g. an approval tool for a static credential) is left to the SDK,
 * which reports it as unknown: a 403 would wrongly suggest that a step-up could grant it.
 */
function requiredScopes(body: string, principal: McpPrincipal): readonly McpScope[] {
  let message: unknown;
  try { message = JSON.parse(body); } catch { return []; }
  const needed = new Set<McpScope>();
  for (const entry of Array.isArray(message) ? message : [message]) {
    if (!entry || typeof entry !== 'object') continue;
    const { method, params } = entry as { method?: unknown; params?: { name?: unknown } };
    const name = method === 'tools/call' && params && typeof params === 'object' && typeof params.name === 'string' ? params.name : null;
    if (!name || !Object.hasOwn(TOOL_SCOPES, name)) continue;
    if (principal.kind !== 'mcp-oauth' && (APPROVAL_TOOL_NAMES as readonly string[]).includes(name)) continue;
    needed.add(TOOL_SCOPES[name as keyof typeof TOOL_SCOPES]);
  }
  return [...needed];
}

/**
 * BUILD-MCP-002: the in-chat panel (`FLOFI_MCP_APP`, default enabled) and the hosts on which it offers the in-frame environment
 * probe (`FLOFI_MCP_INFRAME_WALLET_HOSTS`, host names as MCP Apps `hostInfo.name`; empty by default). The probe never executes.
 */
export function panelConfig(env: Env): { readonly resourceUri: string; readonly inFrameProbeHosts: readonly string[] } | null {
  if ((env.FLOFI_MCP_APP ?? 'enabled') === 'disabled') return null;
  const hosts = (env.FLOFI_MCP_INFRAME_WALLET_HOSTS ?? '').split(',').map(s => s.trim()).filter(h => /^[A-Za-z0-9._-]{1,64}$/.test(h)).slice(0, 16);
  return { resourceUri: PANEL_URI, inFrameProbeHosts: hosts };
}

type Pending = { readonly id: string | number; readonly tool: ToolName | null };
/** The JSON-RPC methods of a body (bounded), the tool of a single `tools/call`, and each request id (with its tool) a gateway answer must echo. */
function messagesOf(body: string | null): { readonly methods: string; readonly tool: string | null; readonly requests: readonly Pending[]; readonly batch: boolean } {
  let parsed: unknown;
  try { parsed = body === null ? null : JSON.parse(body); } catch { parsed = null; }
  const list = (Array.isArray(parsed) ? parsed : [parsed]).filter((m): m is Record<string, unknown> => !!m && typeof m === 'object').slice(0, 100);
  const methods = [...new Set(list.map(m => typeof m.method === 'string' && /^[A-Za-z0-9/_.-]{1,64}$/.test(m.method) ? m.method : null).filter(Boolean))].slice(0, 8).join(',');
  const toolOf = (m: Record<string, unknown>): ToolName | null => {
    const name = m.method === 'tools/call' ? (m.params as { name?: unknown } | undefined)?.name : null;
    return typeof name === 'string' && Object.hasOwn(TOOL_SCOPES, name) ? name as ToolName : null;
  };
  const calls = list.filter(m => m.method === 'tools/call'), tool = calls.length === 1 ? toolOf(calls[0]!) : null;
  const requests = list.filter(m => typeof m.id === 'string' && m.id.length <= 128 || typeof m.id === 'number' && Number.isFinite(m.id))
    .map(m => ({ id: m.id as string | number, tool: toolOf(m) }));
  return { methods, tool, batch: Array.isArray(parsed), requests };
}
/**
 * The gateway's own answer when the exchange is still running at the hard deadline: one JSON-RPC error per request id, carrying the
 * request id and what the call may have done (`timeoutResult`: never "nothing was submitted"; an approval request is UNKNOWN).
 */
function deadlineResponse(body: string | null, budget: RequestBudget): Response {
  const { requests, batch } = messagesOf(body);
  if (!requests.length) return new Response(null, { status: 202, headers: HEADERS });
  // Each request is classified by its own tool (a non-tool method is a read: it has no effect at all).
  const answers = requests.map(({ id, tool }) => ({ jsonrpc: '2.0', id, error: { code: -32001, message: 'FloFi MCP request timed out',
    data: timeoutResult(tool ?? 'get_supported_networks', 'MCP_REQUEST_TIMEOUT', budget.requestId) } }));
  return Response.json(batch ? answers : answers[0], { status: 200, headers: HEADERS });
}

export async function handleMcpRequest(request: Request, options: GatewayOptions = {}): Promise<Response> {
  const started = Date.now(), logger = options.logger;
  const budget = createRequestBudget({ ...options.budgetMs === undefined ? {} : { totalMs: options.budgetMs },
    ...options.marginMs === undefined ? {} : { marginMs: options.marginMs }, parent: request.signal });
  const seen: Seen = { principal: null, body: null, outcome: null };
  let response: Response;
  try { response = await serve(request, options, budget, seen); }
  catch (error) {
    // Never an unanswered request: an unexpected failure is a classified 500 with the request id.
    seen.outcome = isDeadlineError(error) ? error.code : 'MCP_INTERNAL_ERROR';
    response = reject(isDeadlineError(error) ? 503 : 500, seen.outcome);
  } finally { budget.dispose(); }
  const headers = new Headers(response.headers);
  headers.set('x-flofi-request-id', budget.requestId);
  const { methods, tool } = messagesOf(seen.body), platform = request.headers.get('x-vercel-id');
  logger?.info('mcp.request', { request_id: budget.requestId, ...platform && /^[A-Za-z0-9:_-]{1,128}$/.test(platform) ? { platform_request_id: platform } : {},
    principal: seen.principal, http_method: request.method, rpc: methods || null, tool, status: response.status,
    outcome: seen.outcome ?? (response.status < 400 ? 'OK' : 'REFUSED'), duration_ms: Date.now() - started });
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
type Seen = { principal: string | null; body: string | null; outcome: string | null };

async function serve(request: Request, options: GatewayOptions, budget: RequestBudget, seen: Seen): Promise<Response> {
  const env = options.env ?? process.env, logger = options.logger, now = options.now?.() ?? new Date();
  /** The gateway's own PostgreSQL work, bounded: a store that does not answer in time is unavailable (fail closed). */
  const store = <T>(work: () => Promise<T>): Promise<T> => withinBudget(budget, MCP_UPSTREAM_TIMEOUTS.store, () => work());
  const config = readMcpConfig(env), oauthConfig = readOAuthConfig(env);
  if (!config.enabled) {
    if (config.code === 'MCP_CONFIGURATION_INVALID') logger?.warn('mcp.configuration_invalid');
    return reject(config.code === 'MCP_NOT_ENABLED' ? 404 : 503, config.code);
  }
  if (!oauthConfig.enabled && oauthConfig.code === 'MCP_OAUTH_CONFIGURATION_INVALID') {
    logger?.warn('mcp.oauth.configuration_invalid', { reason: oauthConfig.reason ?? null });
    return reject(503, 'MCP_CONFIGURATION_INVALID');
  }
  const oauth = oauthConfig.enabled ? oauthConfig : null;
  const origin = request.headers.get('origin');
  if (origin !== null && !config.allowedOrigins.includes(origin)) return reject(403, 'MCP_ORIGIN_FORBIDDEN');
  const header = request.headers.get('authorization'), bearer = /^Bearer ([^\s]+)$/.exec(header ?? '')?.[1] ?? null;
  let principal: McpPrincipal | null = null, state: McpState | null = null;
  const accessToken = oauth ? credentialOf('access', bearer) : null;
  if (oauth && accessToken) {
    try { state = options.state ?? await store(() => mcpState(env)); }
    catch { logger?.warn('mcp.oauth.store_unavailable', { request_id: budget.requestId }); return reject(503, 'MCP_OAUTH_STORE_UNAVAILABLE'); }
    const oauthState = state;
    const found = await store(() => oauthState.oauth.authenticate(credentialDigest(oauth.keys.token, accessToken), now)).catch(() => 'UNAVAILABLE' as const);
    if (found === 'UNAVAILABLE') { logger?.warn('mcp.oauth.store_unavailable', { request_id: budget.requestId }); return reject(503, 'MCP_OAUTH_STORE_UNAVAILABLE'); }
    // Audience binding: a token minted for another resource (another origin of a shared database) is not valid here.
    if (found && found.resource === oauth.resource) principal = Object.freeze({ kind: 'mcp-oauth', id: found.grantId, tenantId: oauth.tenantId, accountId: found.accountId,
      clientId: found.clientId, clientName: found.clientName, scopes: found.scopes, wallets: Object.freeze([]) }) satisfies McpOAuthPrincipal;
  } else if (!accessToken) principal = authenticate(config, header);
  if (!principal) {
    logger?.warn('mcp.unauthorized');
    return reject(401, 'MCP_UNAUTHORIZED', { 'www-authenticate': oauth ? challenge(oauth, DEFAULT_SCOPES, bearer ? 'invalid_token' : undefined) : 'Bearer realm="flofi-mcp"' });
  }
  seen.principal = principal.id;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MCP_MAX_BODY_BYTES) return reject(413, 'MCP_REQUEST_TOO_LARGE');
  let body: string | null;
  // A client that does not finish sending its (≤ 64 KiB) body in time is not waited for.
  try { body = request.method === 'POST' ? await withinBudget(budget, MCP_UPSTREAM_TIMEOUTS.read, () => request.text()) : null; }
  catch (error) { if (isDeadlineError(error)) return reject(408, 'MCP_REQUEST_BODY_TIMEOUT'); throw error; }
  seen.body = body;
  if (body !== null && Buffer.byteLength(body, 'utf8') > MCP_MAX_BODY_BYTES) return reject(413, 'MCP_REQUEST_TOO_LARGE');
  const held = principalScopes(principal), missing = body === null ? [] : requiredScopes(body, principal).filter(s => !held.includes(s));
  if (missing.length) {
    logger?.warn('mcp.insufficient_scope', { principal: principal.id, scope: missing.join(' ') });
    return reject(403, 'MCP_INSUFFICIENT_SCOPE', oauth && principal.kind === 'mcp-oauth'
      ? { 'www-authenticate': challenge(oauth, [...new Set([...held, ...missing])], 'insufficient_scope') } : {});
  }
  // A `flofi.runs` read by an OAuth account sees only wallets that account linked on FloFi (never an address from the request).
  if (principal.kind === 'mcp-oauth' && state && body !== null && requiredScopes(body, principal).includes('flofi.runs')) {
    const linkState = state, account = principal.accountId;
    const links = await store(() => linkState.links.active(account, now)).catch(() => null);
    if (!links) { logger?.warn('mcp.oauth.store_unavailable', { request_id: budget.requestId }); return reject(503, 'MCP_OAUTH_STORE_UNAVAILABLE'); }
    principal = Object.freeze({ ...principal, wallets: Object.freeze(links.map(l => l.address)) });
  }
  // Every runtime call of this request is bounded by its budget (an injected runtime too).
  const runtime = options.runtime ? boundedRuntime(options.runtime, budget) : deploymentRuntime(env, budget), active = principal;
  const policy = readHandoffPolicy(env), ui = panelConfig(env);
  // BUILD-FLOFI-MAINNET-PRODUCT-001: the deployment's network scope (the route passes `process.env`; a hosted deployment is always Mainnet-only).
  const scope = networkScope({ ...process.env, ...env });
  const handler = createMcpHandler(() => createFlofiMcpServer({ principal: active, runtime, policy, ui, scope, budget, ...state ? { state } : {}, ...oauth ? { oauth } : {},
    onTool: event => { seen.outcome = event.outcome;
      logger?.info('mcp.tool', { request_id: budget.requestId, principal: active.id, tenant: active.tenantId, tool: event.tool, outcome: event.outcome, duration_ms: event.durationMs }); } }),
  // `auto` answers with one JSON body: no tool emits a notification before its result.
  { legacy: 'stateless', maxRequestBodySize: MCP_MAX_BODY_BYTES, onerror: () => logger?.warn('mcp.protocol_error', { principal: active.id }) });
  // The forwarded request is aborted when the client goes away or at the hard deadline, so the SDK tears its exchange down (and any
  // stream it opened ends) instead of outliving the answer.
  const forwardedAbort = new AbortController(), closeForwarded = () => forwardedAbort.abort();
  if (request.signal.aborted) closeForwarded(); else request.signal.addEventListener('abort', closeForwarded, { once: true });
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const hardDeadline = new Promise<'DEADLINE'>(resolve => { hardTimer = setTimeout(() => { resolve('DEADLINE'); closeForwarded(); }, Math.max(0, budget.hardDeadline - Date.now())); });
  try {
    // The body was read for the scope check; the SDK gets an identical request.
    const forwarded = new Request(request.url, { method: request.method, headers: request.headers, signal: forwardedAbort.signal, ...body === null ? {} : { body } });
    // The exchange is complete once the body is read, so the per-request handler can close.
    const exchange = (async () => {
      const response = await handler.fetch(forwarded), text = response.status === 204 || response.status === 202 ? null : await response.text();
      return { response, text };
    })();
    const done = await Promise.race([exchange, hardDeadline]);
    if (done === 'DEADLINE') {
      exchange.catch(() => undefined);
      seen.outcome = 'MCP_REQUEST_TIMEOUT';
      logger?.warn('mcp.request_deadline', { request_id: budget.requestId, principal: active.id });
      return deadlineResponse(body, budget);
    }
    const { response, text } = done;
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(HEADERS)) headers.set(key, value);
    if (request.signal.aborted) seen.outcome ??= 'CLIENT_CLOSED';
    return new Response(text, { status: response.status, statusText: response.statusText, headers });
  } finally {
    clearTimeout(hardTimer);
    request.signal.removeEventListener('abort', closeForwarded);
    await handler.close().catch(() => undefined);
  }
}
