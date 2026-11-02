// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `/api/mcp` deadlines (production: requests ran ~300 s until the function limit). A slow or silent upstream (cloud API, provider,
 * runtime) must end within the request budget with a classified, correlated answer; a client that goes away must stop the upstream
 * work; a deadline never triggers a retry or a second write; and a timed-out request never says "nothing was submitted".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callCloudFlow, CLOUD_API_DEADLINE_EXCEEDED, previewCloudFlow } from '../server/cloud-api-client';
import { composeStrategy } from '../engine/strategy-engine';
import { createRequestBudget, DeadlineError, MCP_PLATFORM_LIMIT_MS, MCP_REQUEST_BUDGET_MS, MCP_RESPONSE_MARGIN_MS, withinBudget } from './deadline';
import { credential, gatewayEnv, memoryLogger, session } from './gateway.test-harness';
import { boundedRuntime, deploymentRuntime, type McpRuntime } from './runtime';
import { timeoutResult } from './tools';

const OWNER = '0x1111111111111111111111111111111111111111', RUN = 'xroute-' + 'a'.repeat(32);
const BRIDGE = { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '5', routing: 'auto' };
const alice = { principal: 'dev-alice', token: credential(), wallets: [OWNER] };
const env = gatewayEnv([alice]);
const REMOTE = { API_BASE_URL: 'https://api.flofi.test', API_AUTH_TOKEN: credential() };
const hashOf = (strategy: unknown) => { const c = composeStrategy(strategy); if (!c.ok) throw new Error(c.code); return c.workflowHash; };
const never = <T>() => new Promise<T>(() => undefined);
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** A runtime whose every call hangs unless overridden: a provider or cloud API that accepted the connection and never answers. */
function silentRuntime(patch: Partial<McpRuntime> = {}): McpRuntime {
  return { kind: 'embedded', mode: async () => 'live', info: async () => ({ executionEnabled: true }), preview: never, run: never, journal: never, evidence: never,
    runs: never, record: never, ...patch };
}
/** A fetch that, like the real one, hangs until its signal aborts and then rejects with the signal's reason. */
function hangingFetch(seen: { url: string; signal: AbortSignal | null }[], answer?: (url: string) => Response | null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input), signal = init?.signal ?? null;
    seen.push({ url, signal });
    const ready = answer?.(url);
    if (ready) return ready;
    return new Promise<Response>((_, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
    });
  });
}
async function post(client: ReturnType<typeof session>, name: string, args: unknown) {
  const response = await client.post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, { 'mcp-protocol-version': '2025-11-25' });
  const result = (response.message?.result ?? {}) as { structuredContent?: Record<string, unknown>; isError?: boolean };
  return { response, output: result.structuredContent ?? {}, isError: result.isError === true };
}

describe('the request budget stays well below the platform limit', () => {
  it('leaves the tools a margin before the hard deadline, both far below maxDuration', () => {
    expect(MCP_REQUEST_BUDGET_MS + 60_000).toBeLessThanOrEqual(MCP_PLATFORM_LIMIT_MS);
    expect(MCP_RESPONSE_MARGIN_MS).toBeGreaterThan(0);
    const budget = createRequestBudget();
    expect(budget.hardDeadline - budget.toolDeadline).toBe(MCP_RESPONSE_MARGIN_MS);
    expect(budget.requestId).toMatch(/^[0-9a-f-]{36}$/);
    budget.dispose();
  });

  it('bounds one operation by its own cap (upstream) and by what remains of the request (request)', async () => {
    const budget = createRequestBudget({ totalMs: 10_000, marginMs: 0 });
    await expect(withinBudget(budget, 30, () => never())).rejects.toMatchObject({ code: 'MCP_UPSTREAM_TIMEOUT' });
    const short = createRequestBudget({ totalMs: 40, marginMs: 0 });
    await expect(withinBudget(short, 60_000, () => never())).rejects.toMatchObject({ code: 'MCP_REQUEST_TIMEOUT' });
    expect(await withinBudget(budget, 1_000, async () => 'answer')).toBe('answer');
    budget.dispose(); short.dispose();
  });

  it('aborts the operation it bounds, so a cancellable read actually stops', async () => {
    const budget = createRequestBudget({ totalMs: 10_000, marginMs: 0 });
    let seen: AbortSignal | null = null;
    await expect(withinBudget(budget, 20, signal => { seen = signal; return never(); })).rejects.toBeInstanceOf(DeadlineError);
    expect(seen!.aborted).toBe(true);
    budget.dispose();
  });
});

describe('a silent upstream ends within the budget with a classified, correlated answer', () => {
  it('simulate_strategy: a preview that never answers is NOT_COMPLETED within the budget, with the request id of the response', async () => {
    const logger = memoryLogger(), started = Date.now();
    const client = session({ env, token: alice.token, runtime: silentRuntime(), logger, budgetMs: 2_000, marginMs: 1_000 });
    const { response, output, isError } = await post(client, 'simulate_strategy', { strategy: BRIDGE, workflowHash: hashOf(BRIDGE), simulationSubject: OWNER });
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(response.status).toBe(200);
    expect(isError).toBe(true);
    expect(output).toMatchObject({ ok: false, code: 'MCP_REQUEST_TIMEOUT', outcome: 'NOT_COMPLETED', retryable: true, requestId: response.headers.get('x-flofi-request-id') });
    expect(logger.lines.map(l => l.event)).toEqual(['mcp.tool', 'mcp.request']);
    expect(logger.lines[1]!.fields).toMatchObject({ outcome: 'MCP_REQUEST_TIMEOUT', tool: 'simulate_strategy', request_id: output.requestId });
  });

  it('get_execution_status: a status read that never answers is STATUS_UNKNOWN — never "not found", never "nothing submitted"', async () => {
    const client = session({ env, token: alice.token, runtime: silentRuntime(), budgetMs: 2_000, marginMs: 1_000 });
    const { output, response } = await post(client, 'get_execution_status', { executionId: RUN });
    expect(output).toMatchObject({ ok: false, code: 'MCP_REQUEST_TIMEOUT', outcome: 'STATUS_UNKNOWN', next: ['get_execution_status'] });
    expect(response.text).not.toMatch(/RUN_NOT_FOUND|NOT_STARTED/);
    expect(String(output.message)).toMatch(/not evidence that nothing was submitted/);
  });

  it('get_capabilities: a deployment fact that never answers is a timeout, never read as "off" or "not enabled"', async () => {
    const client = session({ env, token: alice.token, runtime: silentRuntime({ mode: never }), budgetMs: 2_000, marginMs: 1_000 });
    const { output, response } = await post(client, 'get_capabilities', { network: 'base-sepolia', action: 'bridge' });
    expect(output).toMatchObject({ ok: false, code: 'MCP_REQUEST_TIMEOUT' });
    expect(response.text).not.toMatch(/FLOW_NOT_ENABLED|"enabled":false/);
  });

  it('the gateway answers by itself at the hard deadline when the exchange is still running (JSON-RPC error with the request id)', async () => {
    // A tool deadline later than the hard deadline cannot happen with real settings; the margin of 0 forces the backstop.
    const client = session({ env, token: alice.token, runtime: silentRuntime({ preview: never }), budgetMs: 1_500, marginMs: 0 });
    const response = await client.post({ jsonrpc: '2.0', id: 'r1', method: 'tools/call', params: { name: 'simulate_strategy',
      arguments: { strategy: BRIDGE, workflowHash: hashOf(BRIDGE), simulationSubject: OWNER } } }, { 'mcp-protocol-version': '2025-11-25' });
    const message = response.message as { id?: unknown; error?: { data?: Record<string, unknown> }; result?: { structuredContent?: Record<string, unknown> } };
    // Either the tool's own classified answer or the gateway's backstop: never a hang, always the request id.
    const data = message.error?.data ?? message.result?.structuredContent;
    expect(message.id).toBe('r1');
    expect(data).toMatchObject({ ok: false, code: 'MCP_REQUEST_TIMEOUT', requestId: response.headers.get('x-flofi-request-id') });
  });

  it('a 2026-07-28 subscriptions/listen is acknowledged and completed at once instead of holding the function open', async () => {
    const client = session({ env, token: alice.token, budgetMs: 20_000 });
    const init = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect((init.result as { capabilities: { tools: { listChanged?: boolean } } }).capabilities.tools.listChanged).toBe(false);
    const started = Date.now();
    const response = await client.post({ jsonrpc: '2.0', id: 9, method: 'subscriptions/listen', params: { notifications: { toolsListChanged: true },
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {} } } }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'subscriptions/listen' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(response.status).toBe(200);
    expect(response.text).toContain('"resultType":"complete"');
  });
});

describe('a client that goes away stops the upstream work, and a deadline never retries or repeats anything', () => {
  it('remote runtime: aborting the client aborts the preview fetch in flight, with one attempt and no retry', async () => {
    const seen: { url: string; signal: AbortSignal | null }[] = [];
    hangingFetch(seen);
    const client = new AbortController(), budget = createRequestBudget({ totalMs: 60_000, parent: client.signal });
    const pending = deploymentRuntime(REMOTE, budget).preview('crosschain-router-testnet', [{ workflowId: 'w', nodes: [] }, OWNER]);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    client.abort();
    expect(await pending).toEqual({ ok: false, code: 'MCP_REQUEST_CANCELLED' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.flofi.test/v1/previews/crosschain-router-testnet');
    expect(seen[0]!.signal!.aborted).toBe(true);
    budget.dispose();
  });

  it('gateway: a client abort reaches the runtime fetch and the request ends promptly', async () => {
    const seen: { url: string; signal: AbortSignal | null }[] = [];
    hangingFetch(seen, url => url.includes('/v1/flows/') ? Response.json({ ok: true, value: 'live' }) : null);
    const controller = new AbortController();
    const client = session({ env: gatewayEnv([alice], REMOTE), token: alice.token, signal: controller.signal, budgetMs: 60_000 });
    const started = Date.now();
    const pending = post(client, 'simulate_strategy', { strategy: BRIDGE, workflowHash: hashOf(BRIDGE), simulationSubject: OWNER });
    await vi.waitFor(() => expect(seen.some(s => s.url.endsWith('/v1/previews/crosschain-router-testnet'))).toBe(true));
    controller.abort();
    await pending.catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(5_000);
    const previews = seen.filter(s => s.url.endsWith('/v1/previews/crosschain-router-testnet'));
    expect(previews).toHaveLength(1);
    expect(previews[0]!.signal!.aborted).toBe(true);
  });

  it('cloud client: a mutation cut short by the caller\'s deadline is reported as such and is never retried', async () => {
    const calls: unknown[] = [], controller = new AbortController();
    const transport = (async (_url: URL, init: RequestInit) => {
      calls.push(init);
      return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    }) as unknown as typeof fetch;
    const pending = callCloudFlow('robinhood-transfer', 'begin', ['rhx-1', OWNER, {}], { env: REMOTE, transport, signal: controller.signal, sleep: async () => undefined });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    // Not CLOUD_API_UNAVAILABLE and not retried: whether the API applied it is unknown to this caller, so it must not try again.
    expect(await pending).toEqual({ ok: false, code: CLOUD_API_DEADLINE_EXCEEDED });
    expect(calls).toHaveLength(1);
    expect(await callCloudFlow('robinhood-transfer', 'status', ['rhx-1'], { env: REMOTE, transport, signal: controller.signal })).toEqual({ ok: false, code: CLOUD_API_DEADLINE_EXCEEDED });
    expect(calls).toHaveLength(1);
  });

  it('cloud client: the per-attempt timeout still retries a read-only preview, but never past the caller\'s deadline', async () => {
    const calls: number[] = [], controller = new AbortController();
    const transport = (async () => { calls.push(Date.now()); return new Response('busy', { status: 503 }); }) as unknown as typeof fetch;
    const pending = previewCloudFlow('aave-supply', [], { env: REMOTE, transport, signal: controller.signal, maxAttempts: 3, sleep: async () => { controller.abort(); } });
    expect(await pending).toEqual({ ok: false, code: CLOUD_API_DEADLINE_EXCEEDED });
    expect(calls).toHaveLength(1);
  });

  it('a bounded runtime never turns a timeout into a domain answer', async () => {
    const budget = createRequestBudget({ totalMs: 200, marginMs: 0 }), runtime = boundedRuntime(silentRuntime(), budget);
    expect(await runtime.run(RUN, OWNER)).toEqual({ ok: false, code: 'MCP_REQUEST_TIMEOUT' });
    // The read's own cap and the budget's timer end at the same instant; under load either fires first. Assert once the budget has ended.
    if (!budget.signal.aborted) await new Promise(resolve => budget.signal.addEventListener('abort', resolve, { once: true }));
    await expect(runtime.mode('crosschain-router-testnet')).rejects.toMatchObject({ code: 'MCP_REQUEST_TIMEOUT' });
    budget.dispose();
  });
});

describe('what a timed-out tool may say about its effects', () => {
  it('an approval request that timed out is UNKNOWN, is never retried automatically and never claims that nothing was created', () => {
    const body = timeoutResult('request_user_approval', 'MCP_REQUEST_TIMEOUT', 'req-1');
    // BUILD-FLOFI-E2E-RELIABILITY-001: no approvalId was delivered, so the next step is asking the user (not a status read it cannot make).
    expect(body).toMatchObject({ ok: false, outcome: 'UNKNOWN', retryable: false, automaticRetry: false, next: [], requestId: 'req-1' });
    expect(String(body.message)).toMatch(/UNKNOWN/);
    expect(String(body.message)).toMatch(/do not request approval again automatically/);
    expect(String(body.message)).toMatch(/Do not tell the user that nothing was created/);
    expect(String(body.message)).not.toMatch(/\bno approval (request )?was created\b|\bnothing was (submitted|sent)\b/i);
    expect(timeoutResult('open_approval_session', 'MCP_REQUEST_TIMEOUT', null)).toMatchObject({ outcome: 'UNKNOWN', retryable: false });
    for (const tool of ['get_execution_status', 'get_evidence', 'get_approval_status', 'get_execution_progress'] as const)
      expect(timeoutResult(tool, 'MCP_REQUEST_TIMEOUT', null)).toMatchObject({ outcome: 'STATUS_UNKNOWN', next: [tool] });
    for (const tool of ['compose_strategy', 'simulate_strategy', 'get_capabilities'] as const)
      expect(timeoutResult(tool, 'MCP_REQUEST_TIMEOUT', null)).toMatchObject({ outcome: 'NOT_COMPLETED', retryable: true });
  });
});
