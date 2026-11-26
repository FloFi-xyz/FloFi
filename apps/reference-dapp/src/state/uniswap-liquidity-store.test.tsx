// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (EXEC-01): the browser store's Execute against the real Uniswap liquidity service on the MOCKED
 * in-process chain (server actions delegate to it), with a scripted EIP-1193 owner wallet. The production incident: the first approval
 * confirms, the Review then expires, and the next Execute must neither prepare nor send anything under it — the store refreshes the SAME run in
 * place (keeping the confirmed approval), says why (`requoted`, as the bridges do; the chat and the Review present it), and waits for the
 * owner's explicit authorization before the remaining requests and the mint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { sqrtRatioAtTick } from '@defi-workflow-engine/reference-compiler';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { HookHarness } from '../test-utils/hook-harness';
import { editorReducer, initialEditor } from '../domain/editor';
import { uniswapBandInput } from '../domain/uniswap-liquidity-authoring';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER, type UniswapLiquidityChain } from '../../e2e/uniswap-liquidity-harness';
import { createUniswapLiquidityService, type UniswapLiquidityService } from '../server/uniswap-liquidity-service';
import { OBSERVATION_DELAYS_MS } from '../domain/observation-schedule';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const f = vi.hoisted(() => ({
  workflow: null as unknown, canonical: null as unknown, service: null as unknown, provider: null as unknown, restore: vi.fn(),
  simulated: [] as SemanticWorkflow[],
  // Stable, as the real store's callbacks are (useCallback with no dependencies).
  track: (read: Promise<unknown>) => read,
  refreshes: 0, failures: [] as string[], invalidations: 0,
  // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: observations made, observations that still find no receipt (scripted), and the follow's delays.
  observes: 0, pendingObservations: 0, sleeps: [] as number[],
}));
// The real observation loop runs; only its waiting is skipped (the delays it asked for are recorded).
vi.mock('../domain/observation-schedule', async original => {
  const real = await original<typeof import('../domain/observation-schedule')>();
  return { ...real, observeUntilSettled: <T,>(observe: () => Promise<T>, settled: (value: T) => boolean, options: { readonly active?: () => boolean } = {}) =>
    real.observeUntilSettled(observe, settled, { ...options, sleep: async ms => { f.sleeps.push(ms); await new Promise(resolve => setTimeout(resolve, 0)); } }) };
});
// The store runs the RUNTIME workflow (a sequence's current step, else the canonical workflow): `f.canonical` stands for a whole multi-step Canvas.
vi.mock('./workflow-store', () => ({ useWorkflow: () => ({ state: { workflow: f.canonical ?? f.workflow }, runtimeWorkflow: f.workflow, restoreLiquidityCanvas: f.restore,
  trackCanvasRestoration: f.track }) }));
vi.mock('./build009-wallet-store', () => ({
  useBuild009Wallet: () => ({ account: '0x5555555555555555555555555555555555555555', chainId: '0x14a34', session: async () => ({ account: '0x5555555555555555555555555555555555555555', chainId: '0x14a34' }),
    connect: async () => null, switchTo: async () => undefined }),
  injected: () => f.provider,
}));
vi.mock('../app/uniswap-liquidity-action', () => {
  const svc = () => f.service as UniswapLiquidityService;
  const wrap = async <T,>(work: () => Promise<T>) => { try { return { ok: true as const, value: await work() }; } catch (cause) { return { ok: false as const, code: (cause as Error).message }; } };
  return {
    uniswapLiquidityMode: async () => 'harness', uniswapLiquidityInfo: async () => ({ ok: true, value: { executionEnabled: true } }),
    catalogLiquidityMode: async () => 'off', catalogLiquidityInfo: async () => ({ ok: false, code: 'OFF' }), uniswapLiquidityPrice: async () => ({ ok: false, code: 'UNUSED' }),
    uniswapLiquiditySimulate: (workflow: SemanticWorkflow, owner: string) => { f.simulated.push(workflow); return wrap(() => svc().simulate(workflow, owner)); },
    uniswapLiquidityRefresh: (id: string) => { f.refreshes++; return wrap(() => svc().refresh(id)); },
    uniswapLiquidityReview: (id: string, commitment: string, workflow: SemanticWorkflow) => wrap(() => svc().review(id, commitment, workflow)),
    uniswapLiquidityInvalidate: (id: string) => { f.invalidations++; return wrap(() => svc().invalidate(id)); },
    uniswapLiquidityBegin: (id: string, owner: string, workflow: SemanticWorkflow) => wrap(() => svc().begin(id, owner, workflow)),
    uniswapLiquidityHandoff: (id: string) => wrap(() => svc().handoff(id)),
    uniswapLiquidityReport: (id: string, result: Parameters<UniswapLiquidityService['report']>[1]) => wrap(() => svc().report(id, result)),
    uniswapLiquidityWalletFailure: (id: string, diagnostic: Parameters<UniswapLiquidityService['walletFailure']>[1]) => { f.failures.push(diagnostic.code); return wrap(() => svc().walletFailure(id, diagnostic)); },
    uniswapLiquidityObserve: (id: string) => {
      f.observes++;
      // A scripted observation that finds no receipt yet: the durable record as it stands (its submitted attempt still PENDING), read-only.
      if (f.pendingObservations > 0) { f.pendingObservations--; return wrap(() => svc().load(id)); }
      return wrap(() => svc().observe(id));
    },
    uniswapLiquidityStatus: (id: string) => wrap(() => svc().load(id)),
  };
});
// Imported after the mocks.
const { UniswapLiquidityProvider, useUniswapLiquidity } = await import('./uniswap-liquidity-store');

function workflow(): SemanticWorkflow {
  const band = uniswapBandInput((sqrtRatioAtTick(225_600) + 123_456_789n).toString(), 1_000);
  const result = editorReducer(initialEditor(), { type: 'ADD_UNISWAP_LIQUIDITY', input: { network: 'Base Sepolia', maxUsdc: '10', maxWeth: '0.005',
    rangeUnit: band.rangeUnit, lower: band.lower, upper: band.upper, slippage: '100' }, source: 'CANVAS', baseRevision: 0 }, createBaseSepoliaReviewContext());
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
}
/** The same pool with a different USDC maximum: a semantic edit of the Canvas. */
function workflow2(): SemanticWorkflow {
  const band = uniswapBandInput((sqrtRatioAtTick(225_600) + 123_456_789n).toString(), 1_000);
  const result = editorReducer(initialEditor(), { type: 'ADD_UNISWAP_LIQUIDITY', input: { network: 'Base Sepolia', maxUsdc: '9', maxWeth: '0.005',
    rangeUnit: band.rangeUnit, lower: band.lower, upper: band.upper, slippage: '100' }, source: 'CANVAS', baseRevision: 0 }, createBaseSepoliaReviewContext());
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
}
let host: HookHarness, store: ReturnType<typeof useUniswapLiquidity>, chain: UniswapLiquidityChain;
const sent: { to: string; data: string }[] = [];
/** `slowSessionRead`: seconds the owner's wallet takes to answer its nonce read between the prepare and the hand-off (once). */
const wallet = { slowSessionRead: 0 };
/** Every record the store presented, in order (to prove no interim record is shown while a run is refreshed in place). */
const shown: { commitment: string; states: string[] }[] = [];
function Probe() {
  store = useUniswapLiquidity();
  const r = store.record;
  if (r && JSON.stringify(shown.at(-1)) !== JSON.stringify({ commitment: r.review.commitment, states: r.attempts.map(a => a.state) }))
    shown.push({ commitment: r.review.commitment, states: r.attempts.map(a => a.state) });
  return null;
}
const read = () => host.render(() => renderToStaticMarkup(<UniswapLiquidityProvider><Probe/></UniswapLiquidityProvider>));
async function settle() { for (let i = 0; i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 0)); read(); } }
async function act(action: () => Promise<void>) { const done = action(); await settle(); await done; await settle(); }

beforeEach(async () => {
  host = new HookHarness(); sent.length = 0; shown.length = 0; f.refreshes = 0; f.failures = []; wallet.slowSessionRead = 0; f.canonical = null; f.simulated = [];
  f.observes = 0; f.pendingObservations = 0; f.sleeps = []; f.invalidations = 0;
  chain = createUniswapLiquidityChain();
  const dir = await mkdtemp(join(tmpdir(), 'flofi-unilp-store-'));
  f.service = createUniswapLiquidityService({ storage: createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY'), rpc: chain.rpc, provenance: 'MOCKED',
    mockedCodePins: UNI_MOCK_CODE_PINS, now: chain.clock });
  f.workflow = workflow();
  f.provider = { request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_accounts') return [UNI_OWNER];
    if (method === 'eth_chainId') return '0x14a34';
    if (method === 'eth_getTransactionCount') {
      if (wallet.slowSessionRead) { chain.advance(wallet.slowSessionRead); wallet.slowSessionRead = 0; }
      return chain.rpc('eth_getTransactionCount', params);
    }
    if (method === 'eth_sendTransaction') { const tx = params[0] as { to: string; data: string }; sent.push(tx); return chain.wallet.send(params[0] as Parameters<typeof chain.wallet.send>[0]); }
    throw new Error('MOCK_WALLET_METHOD_DENIED');
  } };
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  read(); await settle();
});
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); });

/** Simulate → Review → the USDC approval (the first wallet request), confirmed and reconciled. */
async function approveUsdc() {
  await act(() => store.simulate());
  expect(store.record?.review.calls.map(c => c.step)).toEqual(['APPROVE_TOKEN0', 'APPROVE_TOKEN1', 'MINT']);
  await act(() => store.review());
  await act(() => store.execute());
  expect(store.record?.attempts.map(a => [a.step, a.state])).toEqual([['APPROVE_TOKEN0', 'CONFIRMED']]);
  expect(sent).toHaveLength(1);
  return store.record!;
}

describe('PR #254 follow-up: a pool step of a step-by-step sequence is simulated alone (production Swap → Bridge → Pool)', () => {
  it('simulates the runtime step, never the whole multi-step Canvas, and its Review stays current while the Canvas is unchanged', async () => {
    // The Canvas holds a Router bridge before the pool; the sequence's current step (the runtime workflow) is the pool alone.
    const bridge = editorReducer(initialEditor(), { type: 'ADD_ROUTER_BRIDGE', source: 'CANVAS', baseRevision: 0,
      input: { source: 'Base', destination: 'Arbitrum', token: 'USDC', amount: '1', recipient: '', slippage: '100', routing: 'AUTO' } }, createBaseSepoliaReviewContext());
    const step = f.workflow as SemanticWorkflow;
    f.canonical = { ...step, nodes: [...bridge.workflow.nodes, ...step.nodes] };
    read(); await settle();
    await act(() => store.simulate());
    expect(f.simulated).toEqual([step]);
    expect(store.error).toBeNull();
    expect(store.record?.workflow).toEqual(step);
    expect(store.retired).toBe(false);
    // The whole Canvas, as this store used to send it, is refused by the server for the Router bridge it carries (production: ROUTER_ISOLATED_ONLY).
    await expect((f.service as UniswapLiquidityService).simulate(f.canonical as SemanticWorkflow, UNI_OWNER)).rejects.toThrow('ROUTER_ISOLATED_ONLY');
  });
});

describe('post-#254 hotfix: an edit while a transaction is in flight leaves its authorization to the execution', () => {
  it('asks once, keeps the pending run as it is (no repeated invalidation), and invalidates the unused authorization once the attempt concluded', async () => {
    await act(() => store.simulate());
    await act(() => store.review());
    const id = store.record!.id, service = f.service as UniswapLiquidityService, w = f.workflow as SemanticWorkflow;
    // The owner's approval is handed to the wallet and broadcast; it is still pending when the Canvas is edited.
    const begun = await service.begin(id, UNI_OWNER, w); await service.handoff(id);
    await service.report(id, { kind: 'HASH', hash: chain.wallet.send(begun.transaction, { hold: true }) });
    f.pendingObservations = 1;
    await act(() => store.observe());
    expect(store.record?.attempts.map(a => [a.step, a.state])).toEqual([['APPROVE_TOKEN0', 'PENDING']]);
    f.workflow = workflow2();
    read(); await settle(); await settle();
    expect(store.retired).toBe(true);
    expect(f.invalidations).toBe(1);
    expect(store.record?.authorization).toBe(store.record?.review.commitment);
    expect(store.error).toBeNull();
    // The approval lands and is reconciled; the edit still stands, so the authorization the next step would use is now invalidated.
    chain.wallet.release();
    await act(() => store.observe());
    expect(store.record?.attempts.map(a => [a.step, a.state])).toEqual([['APPROVE_TOKEN0', 'CONFIRMED']]);
    await settle();
    expect(f.invalidations).toBe(2);
    expect(store.record?.authorization).toBeNull();
    expect(store.record?.error).toBe('UNISWAP_SEMANTIC_EDIT_REQUIRES_REVIEW');
  });
});

describe('EXEC-01: the store continues the same run after its Review expired between two wallet requests', () => {
  it('refuses before preparing, refreshes the run in place, says why, and continues only after a new authorization', async () => {
    const first = await approveUsdc();
    // The owner comes back after the Review expired (120 s on this profile) and clicks Execute for the next request.
    chain.advance(130);
    await act(() => store.execute());
    // Nothing was prepared or sent; the same run now carries an updated Review of only what remains, not yet authorized.
    expect(sent).toHaveLength(1);
    expect(f.refreshes).toBe(1);
    expect(store.error).toBeNull();
    expect(store.requoted).toEqual({ code: 'UNISWAP_REVIEW_EXPIRED', runId: first.id });
    expect(store.record?.id).toBe(first.id);
    expect(store.record?.attempts.map(a => [a.step, a.state])).toEqual([['APPROVE_TOKEN0', 'CONFIRMED']]);
    expect(store.record?.review.calls.map(c => c.step)).toEqual(['APPROVE_TOKEN1', 'MINT']);
    expect(store.record?.authorization).toBeNull();
    // Execute without the new authorization requests nothing.
    await act(() => store.execute());
    expect(store.error).toBe('UNISWAP_REVIEW_REQUIRED');
    expect(sent).toHaveLength(1);
    // The owner authorizes the updated Review: the WETH approval, then the mint — the USDC approval is never asked again.
    await act(() => store.review());
    expect(store.requoted).toBeNull();
    await act(() => store.execute());
    await act(() => store.execute());
    expect(store.record?.verdict).toBe('RECONCILED');
    expect(store.record?.attempts.map(a => a.step)).toEqual(['APPROVE_TOKEN0', 'APPROVE_TOKEN1', 'MINT']);
    expect(sent.map(t => t.to)).toEqual([first.review.token0.address, first.review.token1.address, first.review.contracts.positionManager]);
  });

  it('a Review that expires during the wallet-session checks is refused at the hand-off, concluded as unsent, and refreshed in place', async () => {
    const first = await approveUsdc();
    // The prepare happens with time left; the owner's wallet then takes long enough to answer its nonce read that the Review expires.
    chain.advance(Math.floor((Date.parse(first.review.expiresAt) - chain.clock().getTime()) / 1000) - 15);
    wallet.slowSessionRead = 20;
    await act(() => store.execute());
    expect(sent).toHaveLength(1);
    expect(f.refreshes).toBe(1);
    expect(store.requoted).toEqual({ code: 'UNISWAP_REVIEW_EXPIRED', runId: first.id });
    // The prepared WETH request is recorded as never sent, because its Review expired (not as a refusal or a cancellation by the owner).
    expect(store.record?.attempts.map(a => [a.step, a.state, a.note])).toEqual([['APPROVE_TOKEN0', 'CONFIRMED', null], ['APPROVE_TOKEN1', 'CANCELLED', 'UNISWAP_REVIEW_EXPIRED']]);
    expect(f.failures).toEqual(['UNISWAP_REVIEW_EXPIRED']);
    // The cancelled attempt was never presented under the expired Review (the chat would have read the run as finished): the store went from
    // the authorized run straight to the refreshed one.
    expect(shown.some(r => r.commitment === first.review.commitment && r.states.includes('CANCELLED'))).toBe(false);
    await act(() => store.review());
    await act(() => store.execute());
    await act(() => store.execute());
    expect(store.record?.verdict).toBe('RECONCILED');
    expect(sent).toHaveLength(3);
  });

  it('other refusals keep their own meaning and never refresh', async () => {
    await approveUsdc();
    const service = f.service as UniswapLiquidityService;
    // Another wallet request holds the next nonce: the run is not refreshed, the owner is told why.
    const blocked = vi.spyOn(service, 'begin').mockRejectedValueOnce(new Error('UNISWAP_OWNER_NONCE_IN_USE'));
    await act(() => store.execute());
    expect(store.error).toBe('UNISWAP_OWNER_NONCE_IN_USE');
    expect(f.refreshes).toBe(0);
    expect(store.requoted).toBeNull();
    blocked.mockRestore();
    expect(sent).toHaveLength(1);
  });

  it('an authorization in the Review\'s last seconds is refused by the server and the same run is refreshed for a new authorization', async () => {
    await act(() => store.simulate());
    const first = store.record!;
    chain.advance(Math.floor((Date.parse(first.review.expiresAt) - chain.clock().getTime()) / 1000) - 5);
    await act(() => store.review());
    expect(store.error).toBeNull();
    expect(store.requoted).toEqual({ code: 'UNISWAP_REVIEW_EXPIRED', runId: first.id });
    expect(store.record?.id).toBe(first.id);
    expect(store.record?.review.commitment).not.toBe(first.review.commitment);
    expect(store.record?.authorization).toBeNull();
    await act(() => store.review());
    expect(store.record?.authorization).toBe(store.record?.review.commitment);
    expect(sent).toHaveLength(0);
  });
});

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the follow after the wallet uses the shared observation schedule', () => {
  it('keeps observing read-only past the former 20 × 2 s cap until the request is confirmed, with one wallet request and no owner action', async () => {
    await act(() => store.simulate());
    await act(() => store.review());
    // 24 observations find no receipt yet (the former loop gave up after 20); the 25th reconciles the approval.
    f.pendingObservations = 24;
    await act(() => store.execute());
    expect(f.observes).toBe(25);
    expect(f.sleeps).toEqual(OBSERVATION_DELAYS_MS.slice(0, 24));
    expect(store.record?.attempts.map(a => [a.step, a.state])).toEqual([['APPROVE_TOKEN0', 'CONFIRMED']]);
    expect(store.error).toBeNull();
    expect(sent).toHaveLength(1);
  });
});
