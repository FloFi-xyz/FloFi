// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { editorReducer, initialEditor } from '../domain/editor';
import { savedWorkflowHash, validateSavedWorkflow } from '../domain/saved-workflow';
import type { BuildEstimate, BuildEstimateResult } from '../domain/build-estimate';
import { deferred, HookHarness } from '../test-utils/hook-harness';
import { clearLiveQuoteCache, useBuildEstimate, useLiveQuote } from './build-estimate';
import { LIVE_QUOTE_DEBOUNCE_MS, BUILD_ESTIMATE_TIMEOUT_MS } from '../domain/build-estimate';
import { createUniversalBridgeNode, UNIVERSAL_NETWORKS, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { bridgeEstimateRequest } from '../domain/bridge-estimate';
import { parseDiscoveryRequest } from '../server/universal-router/requests';
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
    host.unmount(); host = new HookHarness(); read(); await vi.advanceTimersByTimeAsync(BUILD_ESTIMATE_TIMEOUT_MS + 350);
    expect(read()).toBeNull(); expect(transport.mock.calls.at(-1)![1].signal.aborted).toBe(true);
    host.unmount();
  });
});

describe('UX-007 fast live quote feedback', () => {
  it('preserves safe configuration diagnostics and the support reference without publishing an amount', async () => {
    const workflow = authored(), correlationId = '12345678-abcd-4321-9876-123456789abc';
    transport.mockResolvedValue(response({ ok: false, code: 'CLOUD_RUNTIME_NOT_CONFIGURED', correlationId }));
    const read = () => host.render(() => useLiveQuote(workflow, 'node-002'));
    read(); await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS);
    expect(read()).toEqual({ status: 'unavailable', code: 'CLOUD_RUNTIME_NOT_CONFIGURED', correlationId });
  });
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
    await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS); expect(read()).toMatchObject({ status: 'unavailable', code: 'ESTIMATE_UNAVAILABLE' });
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

describe('automatic Bridge estimates (MOCKED)', () => {
  const workflow = (amount = '10000000000000000', recipient = 'CONNECTED_OWNER', provider = 'relay'): SemanticWorkflow => ({
    schemaVersion: '1.0.0', workflowId: 'bridge-test', revision: 1, resourceEdges: [], nodes: [createUniversalBridgeNode('bridge', {
      sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.ethereum.chain,
      inputAsset: { kind: 'NATIVE', decimals: 18 }, outputAsset: { kind: 'NATIVE', decimals: 18 }, amount, slippageBps: 100,
      recipient: recipient as 'CONNECTED_OWNER', providers: [provider as 'relay'], selection: 'PREFERENCE_ORDER' })] });
  const quote = (w: SemanticWorkflow): BuildEstimate => {
    const r = parseDiscoveryRequest(bridgeEstimateRequest(w.nodes[0]!)!);
    return { workflowHash: savedWorkflowHash(w), nodeId: 'bridge', chain: r.source.chain, provider: r.providers[0]!,
      expected: '0.001', minimum: '0.00099', symbol: 'ETH', slippageBps: 100, expiresAt: new Date(now.getTime() + 1000).toISOString(),
      bridge: { selected: 0, execution: 'QUOTE_ONLY', discovery: { format: 'flofi.universal-discovery.v1', sourceChain: r.source.chain, destinationChain: r.destination.chain,
        amount: r.amount, inputToken: r.inputToken, outputToken: r.outputToken, observedAt: now.toISOString(), quoteSubjects: 'PUBLIC_QUOTE_SUBJECT', status: 'LIVE_QUOTE', recommended: null,
        candidates: [{ provider: r.providers[0]!, bridge: 'MOCKED', status: 'LIVE_QUOTE', executableBy: null, expectedOutput: '1000000000000000', minimumOutput: '990000000000000',
          estimatedDurationSeconds: null, fees: [], reason: 'BUILDER_NOT_VERIFIED', quoteId: null }] } } };
  };
  it.each(['amount', 'recipient', 'provider', 'wallet', 'destinationWallet'] as const)('invalidates on %s and discards an unabortable old answer', async change => {
    let w = workflow(), owner = 'owner-one', destination = 'destination-one';
    const old = deferred<ReturnType<typeof response>>();
    transport.mockReturnValueOnce(old.promise).mockImplementation(async (_url: string, init: { body: string }) => response({ ok: true, estimate: quote(JSON.parse(init.body).workflow) }));
    const read = () => host.render(() => useLiveQuote(w, 'bridge', owner, destination));
    expect(read().status).toBe('calculating'); await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS);
    const first = w;
    if (change === 'amount') w = workflow('1');
    if (change === 'recipient') w = workflow(undefined, '0x' + '12'.repeat(20));
    if (change === 'provider') w = workflow(undefined, undefined, 'lifi');
    if (change === 'wallet') owner = 'owner-two';
    if (change === 'destinationWallet') destination = 'destination-two';
    expect(read().status).toBe('calculating'); await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS);
    old.resolve(response({ ok: true, estimate: quote(first) })); await vi.advanceTimersByTimeAsync(0);
    expect(read()).toEqual({ status: 'ready', estimate: quote(w) }); expect(transport.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  it('refreshes an expired estimate automatically and never displays expired quantities', async () => {
    const w = workflow(); transport.mockImplementation(async () => response({ ok: true, estimate: quote(w) }));
    const read = () => host.render(() => useLiveQuote(w, 'bridge'));
    read(); await vi.advanceTimersByTimeAsync(200); expect(read().status).toBe('ready');
    await vi.advanceTimersByTimeAsync(800); expect(read().status).toBe('calculating');
    await vi.advanceTimersByTimeAsync(200); expect(read().status).toBe('unavailable'); expect(transport).toHaveBeenCalledTimes(2);
  });
  it('rejects economic tampering even when workflow hash, provider and HTTP status match', async () => {
    const w = workflow(), estimate = quote(w); transport.mockResolvedValue(response({ ok: true, estimate: { ...estimate, expected: '999999' } }));
    const read = () => host.render(() => useLiveQuote(w, 'bridge'));
    read(); await vi.advanceTimersByTimeAsync(200); expect(read()).toMatchObject({ status: 'unavailable', code: 'ESTIMATE_RESPONSE_MISMATCH' });
  });
});
