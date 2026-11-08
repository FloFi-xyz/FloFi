// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createLogger, HttpError, type Database } from '@defi-workflow-engine/cloud-runtime';
import { createMockedSolanaJupiter, createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaSwapNode } from '../src/domain/jupiter-authoring.ts';
import { createBackend, previewTransport } from './app.ts';
import { PREVIEW_METHODS, previewStorage } from './preview.ts';

const quiet = createLogger({ service: 'test', sink: () => undefined });
const untouchable = { query: async () => { throw new Error('DB_TOUCHED'); }, close: async () => undefined } as unknown as Database;
const enc = (text: string) => new TextEncoder().encode(text);

describe('BUILD-MCP-001 read-only flow previews', () => {
  it('supports the old Jupiter simulation payload during a backend-first rollout and keeps QUOTE read-only', async () => {
    const harness = createMockedSolanaJupiter(), owner = createMockedSolanaWallet().owner, methods: string[] = [];
    harness.fund(owner, 3_000_000_000n, { USDC: 100_000_000n });
    const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'workflow-preview-compatibility', revision: 1, resourceEdges: [],
      nodes: [createSolanaSwapNode('node-002', { network: 'Solana', from: 'USDC', to: 'SOL', amount: '1', slippage: '100' })] };
    const backend = createBackend({ db: untouchable, env: { GRYLOO_JUPITER_HARNESS: 'MOCKED_LOOPBACK_ONLY' }, logger: quiet,
      tenantId: 'default', holderId: 'test', evidenceStore: null, http: harness.http,
      rpc: { 'jupiter-swap': async (method, params) => { methods.push(method); return harness.rpc(method, params); } } });
    const route = backend.routes.find(r => r.name === 'preview')!, path = '/v1/previews/jupiter-swap';
    const call = async (body: unknown) => (await route.handler({ method: 'POST', path, query: new URLSearchParams(), headers: {}, body, requestId: 'r' }, route.pattern.exec(path)!)).body;
    const args = [workflow, owner];
    for (const body of [{ args }, { args, purpose: 'SIMULATION' }]) {
      expect(await call(body)).toMatchObject({ ok: true, value: { authorization: null, attempt: null, review: { commitment: expect.any(String) } } });
    }
    expect(methods).toContain('simulateTransaction');
    methods.length = 0;
    const quote = await call({ args, purpose: 'QUOTE' });
    expect(quote).toMatchObject({ ok: true, value: { format: 'flofi.jupiter-quote-preview.v1', amount: '1000000', slippageBps: 100 } });
    expect(methods).toEqual([]);
    expect(harness.state.sent).toEqual([]);
    const value = (quote as { value: Record<string, unknown> }).value;
    for (const key of ['id', 'review', 'authorization', 'attempt', 'unsignedTransaction']) expect(value).not.toHaveProperty(key);
  });

  it('the per-call run log keeps the durable store contract and is never shared', async () => {
    const storage = previewStorage(), other = previewStorage();
    expect(await storage.log.read('run.jsonl')).toBeNull();
    await storage.log.extend('run.jsonl', enc('a\n'), () => undefined);
    await expect(storage.log.extend('run.jsonl', enc('b\n'), () => undefined)).rejects.toThrow('JOURNAL_CORRUPT');
    await expect(storage.log.extend('run.jsonl', enc('a\nb\n'), () => { throw new Error('ROUTER_STORE_CORRUPT'); })).rejects.toThrow('ROUTER_STORE_CORRUPT');
    await storage.log.extend('run.jsonl', enc('a\nb\n'), () => undefined);
    expect(await storage.log.create('run.jsonl', enc('x'))).toBe(false);
    expect(new TextDecoder().decode((await storage.log.read('run.jsonl'))!)).toBe('a\nb\n');
    expect(await other.log.read('run.jsonl')).toBeNull();
    await expect(storage.log.read('../escape')).rejects.toThrow('STORAGE_NAME_INVALID');
    expect(await storage.leases.hold('key', async () => storage.leases.hold('key', async () => 'nested'))).toBe('nested');
  });

  it('serves POST /v1/previews/:flow with strict validation; flows without a preview and disabled flows fail closed', async () => {
    const backend = createBackend({ db: untouchable, env: {}, logger: quiet, tenantId: 'default', holderId: 'test', evidenceStore: null });
    const route = backend.routes.find(r => r.name === 'preview')!;
    const call = async (flow: string, body: unknown) => {
      const path = `/v1/previews/${flow}`, match = route.pattern.exec(path);
      if (!match) return 'NO_ROUTE';
      try { return (await route.handler({ method: 'POST', path, query: new URLSearchParams(), headers: {}, body, requestId: 'r' }, match)).body; }
      catch (error) { if (error instanceof HttpError) return `HTTP_${error.status}_${error.message}`; throw error; }
    };
    expect(await call('crosschain-router-testnet', { args: [{ workflowId: 'w', nodes: [] }, '0x' + '1'.repeat(40)] })).toEqual({ ok: false, code: 'ROUTER_TESTNET_NOT_ENABLED' });
    expect(await call('crosschain-router-testnet', { args: [{ workflowId: 'w', nodes: [] }] })).toBe('HTTP_400_ARGUMENTS_INVALID');
    expect(await call('crosschain-router-testnet', { args: [], extra: 1 })).toBe('HTTP_400_ARGUMENTS_INVALID');
    expect(await call('jupiter-swap', { args: [], purpose: 'EXECUTE' })).toBe('HTTP_400_ARGUMENTS_INVALID');
    expect(await call('base-swap', { args: [], purpose: 'QUOTE' })).toEqual({ ok: false, code: 'PREVIEW_QUOTE_NOT_AVAILABLE' });
    expect(await call('jupiter-swap', { args: [{}, 'invalid-owner'], purpose: 'QUOTE' })).toBe('HTTP_400_ARGUMENTS_INVALID');
    expect(await call('crosschain-router-testnet', null)).toBe('HTTP_400_ARGUMENTS_INVALID');
    expect(await call('robinhood-transfer', { args: [] })).toEqual({ ok: false, code: 'PREVIEW_NOT_AVAILABLE' });
    expect(await call('orca-liquidity', { args: [] })).toEqual({ ok: false, code: 'PREVIEW_NOT_AVAILABLE' });
    expect(await call('no-such-flow', { args: [] })).toBe('HTTP_404_FLOW_NOT_FOUND');
    // Previews never use a mutating/authorizing method: only the flows' own simulate (or the swap's prepare).
    expect(new Set(Object.values(PREVIEW_METHODS))).toEqual(new Set(['simulate', 'prepare']));
  });
});

describe('BUILD-FLOFI-E2E-RELIABILITY-001 abandoned preview cutoff', () => {
  it('after the deadline no client of the preview transport starts a read — per-chain clients included', async () => {
    const calls: string[] = [], rpc = (name: string) => async (method: string) => { calls.push(`${name}:${method}`); return '0x1'; };
    const abandoned = new AbortController();
    const deps = previewTransport({ rpc: rpc('main'), chains: { rpcs: { 'eip155:8453': rpc('base'), 'eip155:42161': rpc('arbitrum') } } } as never, abandoned.signal);
    await deps.rpc('eth_blockNumber', []);
    await deps.chains!.rpcs['eip155:8453']!('eth_chainId', []);
    abandoned.abort();
    for (const read of [deps.rpc, ...Object.values(deps.chains!.rpcs)]) await expect(read('eth_call', [])).rejects.toThrow('CLOUD_PREVIEW_TIMEOUT');
    expect(calls).toEqual(['main:eth_blockNumber', 'base:eth_chainId']);
  });
});

describe('P0 catalog reliability: previews nobody waits for never hold the shared transport', () => {
  const setup = () => {
    const harness = createMockedSolanaJupiter(), owner = createMockedSolanaWallet().owner, reads: string[] = [];
    harness.fund(owner, 3_000_000_000n, { USDC: 100_000_000n });
    let gate: Promise<void> = Promise.resolve(), open: () => void = () => undefined;
    const hold = () => { gate = new Promise<void>(resolve => { open = resolve; }); };
    const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'workflow-preview-coalescing', revision: 1, resourceEdges: [],
      nodes: [createSolanaSwapNode('node-002', { network: 'Solana', from: 'USDC', to: 'SOL', amount: '1', slippage: '100' })] };
    const backend = createBackend({ db: untouchable, env: { GRYLOO_JUPITER_HARNESS: 'MOCKED_LOOPBACK_ONLY' }, logger: quiet,
      tenantId: 'default', holderId: 'test', evidenceStore: null, http: harness.http,
      rpc: { 'jupiter-swap': async (method, params) => { await gate; reads.push(method); return harness.rpc(method, params); } } });
    const route = backend.routes.find(r => r.name === 'preview')!, path = '/v1/previews/jupiter-swap';
    const call = (signal?: AbortSignal, headers: Record<string, string> = {}) => route.handler({ method: 'POST', path, query: new URLSearchParams(), headers,
      body: { args: [workflow, owner] }, requestId: 'r', ...signal ? { signal } : {} }, route.pattern.exec(path)!).then(r => r.body as { ok: boolean; code?: string; value?: unknown });
    return { reads, hold, release: () => open(), call };
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 20));

  it('identical concurrent previews share one computation and each caller gets the same answer', async () => {
    const solo = setup();
    expect(await solo.call()).toMatchObject({ ok: true });
    const single = solo.reads.length;
    const shared = setup();
    shared.hold();
    const answers = Promise.all([shared.call(), shared.call(), shared.call()]);
    await tick(); shared.release();
    const [a, b, c] = await answers;
    expect(a).toMatchObject({ ok: true }); expect(b).toEqual(a); expect(c).toEqual(a);
    expect(b).not.toBe(a);
    expect(shared.reads.length).toBe(single);
  });

  it('previews that differ in amount, subject or purpose are never shared', async () => {
    const harness = createMockedSolanaJupiter(), owner = createMockedSolanaWallet().owner, other = createMockedSolanaWallet().owner;
    harness.fund(owner, 3_000_000_000n, { USDC: 100_000_000n }); harness.fund(other, 3_000_000_000n, { USDC: 100_000_000n });
    let open: () => void = () => undefined, previews = 0;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const backend = createBackend({ db: untouchable, env: { GRYLOO_JUPITER_HARNESS: 'MOCKED_LOOPBACK_ONLY' }, logger: quiet, tenantId: 'default', holderId: 'test',
      evidenceStore: null, http: async query => { previews++; await gate; return harness.http(query); },
      rpc: { 'jupiter-swap': async (method, params) => { await gate; return harness.rpc(method, params); } } });
    const workflowOf = (amount: string): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'workflow-preview-keys', revision: 1, resourceEdges: [],
      nodes: [createSolanaSwapNode('node-002', { network: 'Solana', from: 'USDC', to: 'SOL', amount, slippage: '100' })] });
    const answers = Promise.all([backend.previewFlow('jupiter-swap', [workflowOf('1'), owner], 'QUOTE'), backend.previewFlow('jupiter-swap', [workflowOf('2'), owner], 'QUOTE'),
      backend.previewFlow('jupiter-swap', [workflowOf('1'), other], 'QUOTE'), backend.previewFlow('jupiter-swap', [workflowOf('1'), owner], 'SIMULATION')]);
    await tick(); open();
    const [one, two, otherSubject] = await answers;
    // Four different requests (amount, subject, purpose): four computations. Sharing any of them would leave fewer.
    expect(previews).toBeGreaterThanOrEqual(4);
    expect((one as { value: { amount: string } }).value.amount).toBe('1000000');
    expect((two as { value: { amount: string } }).value.amount).toBe('2000000');
    expect(otherSubject).toMatchObject({ ok: true });
  });

  it('a preview every caller has left is abandoned: its queued reads are dropped, and a later identical preview starts afresh', async () => {
    const s = setup();
    s.hold();
    const first = new AbortController(), second = new AbortController();
    const one = s.call(first.signal), two = s.call(second.signal);
    await tick();
    first.abort();
    await tick();
    // One caller still waits: the computation continues.
    second.abort();
    expect(await one).toEqual({ ok: false, code: 'CLOUD_PREVIEW_ABANDONED' });
    expect(await two).toEqual({ ok: false, code: 'CLOUD_PREVIEW_ABANDONED' });
    s.release(); await tick();
    expect(s.reads.length).toBeLessThanOrEqual(1);
    expect(await s.call()).toMatchObject({ ok: true });
  });

  it("stops at the caller's own deadline (x-flofi-deadline-ms) with a classified timeout", async () => {
    const s = setup();
    s.hold();
    const started = Date.now();
    expect(await s.call(undefined, { 'x-flofi-deadline-ms': '150' })).toEqual({ ok: false, code: 'CLOUD_PREVIEW_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2_000);
    s.release();
  });
});

describe('P0 catalog reliability (review): shared previews stay safe and keep each caller\'s own deadline', () => {
  it('a transport that cannot be built is a classified refusal for every caller, never an unhandled rejection', async () => {
    const { composeStrategy } = await import('../src/engine/strategy-engine');
    const composed = composeStrategy({ action: 'swap', network: 'arbitrum-one', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.0012' });
    if (!composed.ok) throw new Error(composed.code);
    const backend = createBackend({ db: untouchable, env: { GRYLOO_ARBITRUM_MAINNET: 'live', GRYLOO_ARBITRUM_RPC_URL: 'http://plain.example' }, logger: quiet,
      tenantId: 'default', holderId: 'test', evidenceStore: null });
    const answers = await Promise.all([backend.previewFlow('arbitrum-swap', [composed.workflow]), backend.previewFlow('arbitrum-swap', [composed.workflow])]);
    expect(answers).toEqual([{ ok: false, code: 'ARBITRUM_RPC_CONFIGURATION_INVALID' }, { ok: false, code: 'ARBITRUM_RPC_CONFIGURATION_INVALID' }]);
  });
  it('a caller that joins with a longer deadline still gets the answer after the first caller\'s deadline passed', async () => {
    const harness = createMockedSolanaJupiter(), owner = createMockedSolanaWallet().owner;
    harness.fund(owner, 3_000_000_000n, { USDC: 100_000_000n });
    let open: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'workflow-preview-deadlines', revision: 1, resourceEdges: [],
      nodes: [createSolanaSwapNode('node-002', { network: 'Solana', from: 'USDC', to: 'SOL', amount: '1', slippage: '100' })] };
    const backend = createBackend({ db: untouchable, env: { GRYLOO_JUPITER_HARNESS: 'MOCKED_LOOPBACK_ONLY' }, logger: quiet, tenantId: 'default', holderId: 'test',
      evidenceStore: null, http: harness.http, rpc: { 'jupiter-swap': async (method, params) => { await gate; return harness.rpc(method, params); } } });
    const short = backend.previewFlow('jupiter-swap', [workflow, owner], 'SIMULATION', { deadlineMs: 100 });
    const long = backend.previewFlow('jupiter-swap', [workflow, owner], 'SIMULATION', { deadlineMs: 5_000 });
    expect(await short).toEqual({ ok: false, code: 'CLOUD_PREVIEW_TIMEOUT' });
    open();
    expect(await long).toMatchObject({ ok: true });
  });
});
