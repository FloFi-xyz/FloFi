// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { editorReducer, initialEditor } from '../domain/editor';
import { savedWorkflowHash, validateSavedWorkflow } from '../domain/saved-workflow';
import type { BuildEstimate, BuildEstimateResult } from '../domain/build-estimate';
import { deferred, HookHarness } from '../test-utils/hook-harness';
import { clearLiveQuoteCache, useBuildEstimate, useLiveQuote } from './build-estimate';
import { LIVE_QUOTE_DEBOUNCE_MS } from '../domain/build-estimate';
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const now = new Date('2026-10-08T12:00:00Z');
const authored = (amount = '2') => validateSavedWorkflow(editorReducer(initialEditor(), { type: 'ADD_TESTNET_SWAP', direction: 'USDC_TO_WETH', amount, slippage: '50', source: 'CANVAS', baseRevision: 0 }, createBaseSepoliaReviewContext()).workflow);
const estimate = (workflow = authored(), extra: Partial<BuildEstimate> = {}): BuildEstimate => ({ workflowHash: savedWorkflowHash(workflow), nodeId: 'node-002', chain: 'eip155:84532', provider: 'Uniswap V3', expected: '0.001', minimum: '0.000995', symbol: 'WETH', slippageBps: 50, expiresAt: new Date(now.getTime() + 1000).toISOString(), ...extra });
let host: HookHarness, transport: ReturnType<typeof vi.fn>;
beforeEach(() => { clearLiveQuoteCache(); host = new HookHarness(); vi.useFakeTimers(); vi.setSystemTime(now); transport = vi.fn(); vi.stubGlobal('fetch', transport); });
afterEach(() => { host.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const response = (value: BuildEstimateResult) => ({ json: async () => value });
describe('Build estimate snapshot, freshness and provider binding', () => {
  it('publishes a matching success, sends an AbortSignal and clears at exact expiry', async () => {
    const workflow = authored(), value = estimate(workflow); transport.mockResolvedValue(response({ ok: true, estimate: value }));
    const read = () => host.render(() => useBuildEstimate(workflow, 'node-002', 'owner'));
    expect(read()).toBeNull(); await vi.advanceTimersByTimeAsync(350); expect(read()).toEqual(value);
    expect(transport.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(transport.mock.calls[0]![1].body)).toEqual({ workflow, nodeId: 'node-002', owner: 'owner' });
    await vi.advanceTimersByTimeAsync(650); expect(read()).toBeNull();
  });
  it.each([{ workflowHash: 'wrong' }, { nodeId: 'another' }, { chain: 'eip155:11155111' }, { provider: 'Jupiter' }, { expiresAt: now.toISOString() }])('rejects a mismatched or expired response %j', async extra => {
    const workflow = authored(); transport.mockResolvedValue(response({ ok: true, estimate: estimate(workflow, extra) }));
    const read = () => host.render(() => useBuildEstimate(workflow, 'node-002'));
    read(); await vi.advanceTimersByTimeAsync(350); expect(read()).toBeNull();
  });
  it('aborts an older snapshot and prevents its late completion overwriting the newer estimate', async () => {
    const old = deferred<ReturnType<typeof response>>(), first = authored(), second = authored('3'); let workflow = first;
    transport.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response({ ok: true, estimate: estimate(second) }));
    const read = () => host.render(() => useBuildEstimate(workflow, 'node-002'));
    read(); await vi.advanceTimersByTimeAsync(350); workflow = second; expect(read()).toBeNull();
    expect(transport.mock.calls[0]![1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(350); expect(read()?.workflowHash).toBe(savedWorkflowHash(second));
    old.resolve(response({ ok: true, estimate: estimate(first) })); await vi.advanceTimersByTimeAsync(0);
    expect(read()?.workflowHash).toBe(savedWorkflowHash(second));
  });
  it.each(['owner', 'node'] as const)('hides the prior estimate immediately when its %s binding changes', async change => {
    const workflow = authored(); let owner = 'owner-one', nodeId = 'node-002';
    transport.mockResolvedValue(response({ ok: true, estimate: estimate(workflow) }));
    const read = () => host.render(() => useBuildEstimate(workflow, nodeId, owner));
    read(); await vi.advanceTimersByTimeAsync(350); expect(read()).not.toBeNull();
    if (change === 'owner') owner = 'owner-two'; else nodeId = 'another-node';
    expect(read()).toBeNull();
  });
  it('returns no value after failure or timeout and aborts on unmount', async () => {
    const workflow = authored(); transport.mockRejectedValueOnce(Error('offline')).mockReturnValue(new Promise(() => {}));
    const read = () => host.render(() => useBuildEstimate(workflow, 'node-002'));
    read(); await vi.advanceTimersByTimeAsync(350); expect(read()).toBeNull();
    host.unmount(); host = new HookHarness(); read(); await vi.advanceTimersByTimeAsync(15_350);
    expect(read()).toBeNull(); expect(transport.mock.calls.at(-1)![1].signal.aborted).toBe(true);
    host.unmount();
  });
});

describe('UX-007 fast live quote feedback', () => {
  it('keeps an in-flight quote when catalog rerenders recreate the same workflow snapshot', async () => {
    let workflow = authored('100');
    const pending = deferred<ReturnType<typeof response>>();
    transport.mockReturnValue(pending.promise);
    const read = () => host.render(() => useLiveQuote(workflow, 'node-002', 'owner'));
    read(); await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS);
    expect(transport).toHaveBeenCalledOnce();
    workflow = JSON.parse(JSON.stringify(workflow));
    expect(read().status).toBe('calculating');
    expect(transport.mock.calls[0]![1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS);
    expect(transport).toHaveBeenCalledOnce();
    pending.resolve(response({ ok: true, estimate: estimate(workflow) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(read().status).toBe('ready');
  });
  it('shows calculating at once, asks once after the short debounce, then shows this exact amount', async () => {
    const workflow = authored('5'), value = estimate(workflow); let release!: (v: unknown) => void;
    transport.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const read = () => host.render(() => useLiveQuote(workflow, 'node-002', 'owner'));
    const timeline: [number, string][] = [[0, read().status]];
    await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS - 1); expect(transport).not.toHaveBeenCalled(); timeline.push([LIVE_QUOTE_DEBOUNCE_MS - 1, read().status]);
    await vi.advanceTimersByTimeAsync(1); expect(transport).toHaveBeenCalledOnce(); timeline.push([LIVE_QUOTE_DEBOUNCE_MS, read().status]);
    await vi.advanceTimersByTimeAsync(80); release(response({ ok: true, estimate: value })); await vi.advanceTimersByTimeAsync(0);
    timeline.push([LIVE_QUOTE_DEBOUNCE_MS + 80, read().status]);
    // Deterministic mocked timing only (input → calculating → request → resolution); no provider latency claim.
    expect(timeline).toEqual([[0, 'calculating'], [199, 'calculating'], [200, 'calculating'], [280, 'ready']]);
    expect(read()).toEqual({ status: 'ready', estimate: value });
    expect(transport.mock.calls.every(call => call[0] === '/api/build-estimate')).toBe(true);
  });
  it('coalesces rapid typing ("1", "10", "100") into one request for the latest amount', async () => {
    let workflow = authored('1'); transport.mockImplementation(async (_url: string, init: { body: string }) => response({ ok: true, estimate: estimate(JSON.parse(init.body).workflow) }));
    const read = () => host.render(() => useLiveQuote(workflow, 'node-002'));
    read(); await vi.advanceTimersByTimeAsync(60); workflow = authored('10'); expect(read().status).toBe('calculating');
    await vi.advanceTimersByTimeAsync(60); workflow = authored('100'); expect(read().status).toBe('calculating');
    await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS);
    expect(transport).toHaveBeenCalledOnce(); expect(JSON.parse(transport.mock.calls[0]![1].body).workflow).toEqual(authored('100'));
    expect(read()).toMatchObject({ status: 'ready', estimate: { workflowHash: savedWorkflowHash(authored('100')) } });
  });
  it('latest request wins: an older answer the transport could not abort never overwrites the newer amount', async () => {
    const late = deferred<ReturnType<typeof response>>(), fresh = deferred<ReturnType<typeof response>>(); let workflow = authored('10');
    transport.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => { init.signal.addEventListener('abort', () => undefined); return late.promise; })
      .mockReturnValueOnce(fresh.promise);
    const read = () => host.render(() => useLiveQuote(workflow, 'node-002'));
    read(); await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS);
    workflow = authored('100'); read(); await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS);
    expect(transport.mock.calls[0]![1].signal.aborted).toBe(true);
    fresh.resolve(response({ ok: true, estimate: estimate(authored('100')) })); await vi.advanceTimersByTimeAsync(0);
    late.resolve(response({ ok: true, estimate: estimate(authored('10')) })); await vi.advanceTimersByTimeAsync(0);
    expect(read()).toMatchObject({ status: 'ready', estimate: { workflowHash: savedWorkflowHash(authored('100')) } });
  });
  it('reports Quote unavailable truthfully and never keeps another amount\'s quote', async () => {
    let workflow = authored('2'); transport.mockResolvedValueOnce(response({ ok: true, estimate: estimate(workflow) })).mockResolvedValueOnce(response({ ok: false, code: 'ESTIMATE_UNAVAILABLE' }));
    const read = () => host.render(() => useLiveQuote(workflow, 'node-002'));
    read(); await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS); expect(read().status).toBe('ready');
    workflow = authored('3'); expect(read()).toEqual({ status: 'calculating' });
    await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS); expect(read()).toEqual({ status: 'unavailable' });
    expect(host.render(() => useBuildEstimate(workflow, 'node-002'))).toBeNull();
  });
  it('reuses an answered snapshot only for that exact snapshot and only until its own expiry', async () => {
    const two = authored('2'), three = authored('3'); let workflow = two;
    transport.mockImplementation(async (_url: string, init: { body: string }) => response({ ok: true, estimate: estimate(JSON.parse(init.body).workflow) }));
    const read = () => host.render(() => useLiveQuote(workflow, 'node-002'));
    read(); await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS); expect(read().status).toBe('ready');
    workflow = three; read(); await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS); expect(transport).toHaveBeenCalledTimes(2);
    workflow = two; read(); await vi.advanceTimersByTimeAsync(0);
    expect(read()).toMatchObject({ status: 'ready', estimate: { workflowHash: savedWorkflowHash(two) } }); expect(transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000); workflow = three; read(); workflow = two; read(); await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS);
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('is idle (no request) for a snapshot with nothing quotable', async () => {
    expect(host.render(() => useLiveQuote(undefined, 'node-002'))).toEqual({ status: 'idle' });
    await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS * 5); expect(transport).not.toHaveBeenCalled();
  });
});
