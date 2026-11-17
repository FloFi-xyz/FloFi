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

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const f = vi.hoisted(() => ({
  workflow: null as unknown, service: null as unknown, provider: null as unknown, restore: vi.fn(),
  // Stable, as the real store's callbacks are (useCallback with no dependencies).
  track: (read: Promise<unknown>) => read,
  refreshes: 0, failures: [] as string[],
}));
vi.mock('./workflow-store', () => ({ useWorkflow: () => ({ state: { workflow: f.workflow }, restoreLiquidityCanvas: f.restore, trackCanvasRestoration: f.track }) }));
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
    uniswapLiquiditySimulate: (workflow: SemanticWorkflow, owner: string) => wrap(() => svc().simulate(workflow, owner)),
    uniswapLiquidityRefresh: (id: string) => { f.refreshes++; return wrap(() => svc().refresh(id)); },
    uniswapLiquidityReview: (id: string, commitment: string, workflow: SemanticWorkflow) => wrap(() => svc().review(id, commitment, workflow)),
    uniswapLiquidityInvalidate: (id: string) => wrap(() => svc().invalidate(id)),
    uniswapLiquidityBegin: (id: string, owner: string, workflow: SemanticWorkflow) => wrap(() => svc().begin(id, owner, workflow)),
    uniswapLiquidityHandoff: (id: string) => wrap(() => svc().handoff(id)),
    uniswapLiquidityReport: (id: string, result: Parameters<UniswapLiquidityService['report']>[1]) => wrap(() => svc().report(id, result)),
    uniswapLiquidityWalletFailure: (id: string, diagnostic: Parameters<UniswapLiquidityService['walletFailure']>[1]) => { f.failures.push(diagnostic.code); return wrap(() => svc().walletFailure(id, diagnostic)); },
    uniswapLiquidityObserve: (id: string) => wrap(() => svc().observe(id)),
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
  host = new HookHarness(); sent.length = 0; shown.length = 0; f.refreshes = 0; f.failures = []; wallet.slowSessionRead = 0;
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
