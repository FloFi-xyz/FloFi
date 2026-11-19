// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the browser store of a Uniswap v3 position operation against the REAL Uniswap liquidity service on the
 * MOCKED in-process Base chain (the server actions delegate to it), with a scripted EIP-1193 owner wallet. No network, no key: the only send
 * path is the scripted wallet, and every run is MOCKED evidence.
 *
 * Proven here: a staged operation reaches the runtime as exactly that operation (never a deposit), one exact wallet request after the envelope
 * check, an expired Review refreshed in place (`requoted`) without anything sent, a server-widened envelope refused before the wallet, and an
 * unknown wallet outcome only observed (never resent).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { catalogPoolOn, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { HookHarness } from '../test-utils/hook-harness';
import { editorReducer, initialEditor } from '../domain/editor';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import { uniswapPositionRequestOf, type LiquidityPositionChoice } from '../domain/liquidity-positions';
import type { LiquidityPositionPoolInput } from '../domain/commands';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER, type UniswapLiquidityChain } from '../../e2e/uniswap-liquidity-harness';
import { baseAsset, baseCatalog } from '../server/base-mainnet.test-harness';
import { createUniswapLiquidityService, type UniswapLiquidityService } from '../server/uniswap-liquidity-service';
import type { Rpc } from '../server/public-testnet-service';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const f = vi.hoisted(() => ({ workflow: null as unknown, staged: null as unknown, service: null as unknown, provider: null as unknown, restore: vi.fn(),
  track: (read: Promise<unknown>) => read, refreshes: 0, failures: [] as string[], begin: null as null | ((value: unknown) => unknown) }));
vi.mock('./workflow-store', () => ({ useWorkflow: () => ({ state: { workflow: f.workflow }, runtimeWorkflow: f.workflow, newWorkflow: false, context: null,
  stagedPosition: f.staged, restoreLiquidityCanvas: f.restore, trackCanvasRestoration: f.track }) }));
vi.mock('./build009-wallet-store', () => ({
  useBuild009Wallet: () => ({ account: '0x5555555555555555555555555555555555555555', chainId: '0x2105', session: async () => ({ account: '0x5555555555555555555555555555555555555555', chainId: '0x2105' }),
    connect: async () => null, switchTo: async () => undefined }),
  injected: () => f.provider,
}));
vi.mock('../app/uniswap-liquidity-action', () => {
  const svc = () => f.service as UniswapLiquidityService;
  const wrap = async <T,>(work: () => Promise<T>) => { try { return { ok: true as const, value: await work() }; } catch (cause) { return { ok: false as const, code: (cause as Error).message }; } };
  return {
    catalogLiquidityMode: async () => 'harness', catalogLiquidityInfo: async () => ({ ok: true, value: { executionEnabled: true } }),
    uniswapPositionSimulate: (workflow: SemanticWorkflow, owner: string, request: unknown) => wrap(() => svc().positionSimulate(workflow, owner, request)),
    uniswapPositionRefresh: (id: string) => { f.refreshes++; return wrap(() => svc().positionRefresh(id)); },
    uniswapPositionReview: (id: string, commitment: string, workflow: SemanticWorkflow) => wrap(() => svc().positionReview(id, commitment, workflow)),
    uniswapPositionInvalidate: (id: string) => wrap(() => svc().positionInvalidate(id)),
    uniswapPositionBegin: (id: string, owner: string, workflow: SemanticWorkflow) => wrap(async () => {
      const begun = await svc().positionBegin(id, owner, workflow);
      return f.begin ? f.begin(begun) as typeof begun : begun;
    }),
    uniswapPositionHandoff: (id: string) => wrap(() => svc().positionHandoff(id)),
    uniswapPositionReport: (id: string, result: Parameters<UniswapLiquidityService['positionReport']>[1]) => wrap(() => svc().positionReport(id, result)),
    uniswapPositionWalletFailure: (id: string, diagnostic: Parameters<UniswapLiquidityService['positionWalletFailure']>[1]) => { f.failures.push(diagnostic.code); return wrap(() => svc().positionWalletFailure(id, diagnostic)); },
    uniswapPositionObserve: (id: string) => wrap(() => svc().positionObserve(id)),
    uniswapPositionStatus: (id: string) => wrap(() => svc().positionStatus(id)),
  };
});
// Imported after the mocks.
const { UniswapPositionProvider, useUniswapPosition } = await import('./uniswap-position-store');

const context = createBaseSepoliaReviewContext();
const catalog = baseCatalog();
const USDC = baseAsset(catalog, 'USDC'), CBBTC = baseAsset(catalog, 'cbBTC');
const token = (asset: CanonicalAsset) => asset as { symbol: string; address: string; decimals: number };
const PROFILE = catalogPoolOn('eip155:8453', token(USDC), token(CBBTC), 500);
const USDC_IS_0 = PROFILE.token0.address === USDC.address;
const TICK = USDC_IS_0 ? -69_082 : 69_082;
const LOWER = Math.floor((TICK - 2_000) / 10) * 10, UPPER = Math.ceil((TICK + 2_000) / 10) * 10;
const view = (t: { symbol: string; address: string; decimals: number }) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals });
const POOL: LiquidityPositionPoolInput = { token0: view(PROFILE.token0), token1: view(PROFILE.token1), feeTier: 500, tickLower: LOWER, tickUpper: UPPER,
  amount0: '0', amount1: '0', slippageBps: 100 };
const choiceOf = (tokenId: string, patch: Partial<Pick<LiquidityPositionChoice, 'operation' | 'partBps' | 'close'>> = {}): LiquidityPositionChoice => ({
  position: { protocol: 'UNISWAP_V3', chain: 'eip155:8453', network: 'Base', manager: PROFILE.positionManager, pool: PROFILE.pool, positionId: tokenId, owner: UNI_OWNER },
  operation: 'COLLECT', partBps: null, close: false, ...patch });
/** The workflow MANAGE_LIQUIDITY_POSITION produces (the real editor path), and the staged choice the workflow store would hold for it. */
function stage(choice: LiquidityPositionChoice) {
  const result = editorReducer(initialEditor(), { type: 'MANAGE_LIQUIDITY_POSITION', choice, pool: POOL, source: 'CHAT', baseRevision: 0 }, context);
  if (result.error) throw new Error(result.error);
  f.workflow = structuredClone(result.workflow) as unknown as SemanticWorkflow;
  f.staged = { positionId: choice.position.positionId, operation: choice.operation === 'DECREASE' ? 'DECREASE_PARTIAL' : choice.operation, partBps: choice.partBps, choice, serial: 1,
    workflowId: result.workflow.workflowId, revision: result.workflow.revision, node: '' };
}

let host: HookHarness, store: ReturnType<typeof useUniswapPosition>, chain: UniswapLiquidityChain;
const sent: { to: string; data: string; gas: string }[] = [];
const wallet = { mode: 'SEND' as 'SEND' | 'SEND_THEN_UNKNOWN' | 'REJECT' };
function Probe() { store = useUniswapPosition(); return null; }
const read = () => host.render(() => renderToStaticMarkup(<UniswapPositionProvider><Probe/></UniswapPositionProvider>));
async function settle() { for (let i = 0; i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 0)); read(); } }
async function act(action: () => Promise<void>) { const done = action(); await settle(); await done; await settle(); }

beforeAll(() => registerNetworkCatalog(catalog));
afterAll(() => resetNetworkCatalogs());
beforeEach(async () => {
  host = new HookHarness(); sent.length = 0; f.refreshes = 0; f.failures = []; f.begin = null; wallet.mode = 'SEND';
  chain = createUniswapLiquidityChain({ profile: PROFILE, tick: TICK, usdc: USDC_IS_0 ? 1_000_000_000n : 10_000_000n, weth: USDC_IS_0 ? 10_000_000n : 1_000_000_000n });
  const dir = await mkdtemp(join(tmpdir(), 'flofi-unipm-store-'));
  const sepolia: Rpc = async () => { throw new Error('BASE_SEPOLIA_CLIENT_MUST_NOT_BE_USED'); };
  f.service = createUniswapLiquidityService({ storage: createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY'), rpc: sepolia, rpcs: { 'eip155:8453': chain.rpc },
    provenance: 'MOCKED', now: chain.clock, mockedCodePins: UNI_MOCK_CODE_PINS, executionEnabled: true,
    catalog: { chain: 'eip155:8453', catalogFor: async () => catalog, codePins: chain.catalogPins } });
  f.provider = { request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_accounts') return [UNI_OWNER];
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getTransactionCount') return chain.rpc('eth_getTransactionCount', params);
    if (method === 'eth_sendTransaction') {
      if (wallet.mode === 'REJECT') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      const tx = params[0] as { to: string; data: string; gas: string }; sent.push(tx);
      const hash = chain.wallet.send(params[0] as Parameters<typeof chain.wallet.send>[0]);
      // The wallet broadcast it, then lost the answer: FloFi cannot tell whether anything was sent.
      if (wallet.mode === 'SEND_THEN_UNKNOWN') throw Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 });
      return hash;
    }
    throw new Error('MOCK_WALLET_METHOD_DENIED');
  } };
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
});
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); });

describe('BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the Uniswap position store (MOCKED Base, real service)', () => {
  it('a staged COLLECT is simulated as exactly that operation, one exact wallet request, reconciled', async () => {
    const tokenId = chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 5_000_000_000n });
    chain.accrueFees(tokenId, 1_234n, 5_678n);
    stage(choiceOf(tokenId)); read(); await settle();
    expect(store.engaged).toBe(true);
    expect(store.request).toEqual(uniswapPositionRequestOf(choiceOf(tokenId)));
    await act(() => store.simulate());
    expect(store.error).toBeNull();
    const run = store.record!;
    expect(run.format).toBe('flofi.uniswap-position-run.v1');
    expect(run.request).toEqual({ operation: 'COLLECT', tokenId, partBps: null, close: false });
    expect(run.review).toMatchObject({ operation: 'COLLECT', innerCalls: ['COLLECT'], liquidityToRemove: '0', calls: [{ step: 'COLLECT', to: PROFILE.positionManager }] });
    // Nothing is requested before the owner's explicit Review authorization.
    await act(() => store.execute());
    expect(store.error).toBe('UNISWAP_REVIEW_REQUIRED');
    expect(sent).toHaveLength(0);
    await act(() => store.review());
    expect(store.record?.authorization).toBe(run.review.commitment);
    await act(() => store.execute());
    expect(store.error).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: PROFILE.positionManager, data: run.review.calls[0].data });
    expect(store.record).toMatchObject({ verdict: 'RECONCILED', result: { operation: 'COLLECT', collected0: '1234', collected1: '5678', liquidityRemoved: '0', burned: false } });
  });

  it('a staged DECREASE withdraws exactly the staged share (never a deposit, no approval) and keeps the rest', async () => {
    const tokenId = chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 9_000_000_001n });
    stage(choiceOf(tokenId, { operation: 'DECREASE', partBps: 5_000 })); read(); await settle();
    await act(() => store.simulate());
    expect(store.record?.review).toMatchObject({ operation: 'DECREASE', partBps: 5_000, liquidityToRemove: '4500000000', liquidityAfter: '4500000001',
      innerCalls: ['DECREASE_LIQUIDITY', 'COLLECT'] });
    expect(store.record?.review.calls).toHaveLength(1);
    await act(() => store.review());
    await act(() => store.execute());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(PROFILE.positionManager);
    expect(store.record).toMatchObject({ verdict: 'RECONCILED', result: { liquidityRemoved: '4500000000', liquidityAfter: '4500000001', burned: false } });
  });

  it('a Review that expired before the wallet request is refreshed in place: nothing sent, `requoted`, a new authorization is required', async () => {
    const tokenId = chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 5_000_000_000n });
    stage(choiceOf(tokenId, { operation: 'EXIT' })); read(); await settle();
    await act(() => store.simulate());
    const first = store.record!;
    await act(() => store.review());
    chain.advance(130);
    await act(() => store.execute());
    expect(sent).toHaveLength(0);
    expect(f.refreshes).toBe(1);
    expect(store.error).toBeNull();
    expect(store.requoted).toEqual({ code: 'UNISWAP_REVIEW_EXPIRED', runId: first.id });
    expect(store.record?.id).toBe(first.id);
    expect(store.record?.review.commitment).not.toBe(first.review.commitment);
    expect(store.record?.authorization).toBeNull();
    // The refreshed Review is never authorized by itself.
    await act(() => store.execute());
    expect(store.error).toBe('UNISWAP_REVIEW_REQUIRED');
    expect(sent).toHaveLength(0);
    await act(() => store.review());
    expect(store.requoted).toBeNull();
    await act(() => store.execute());
    expect(sent).toHaveLength(1);
    expect(store.record).toMatchObject({ verdict: 'RECONCILED', result: { liquidityAfter: '0', burned: false } });
  });

  it('a transaction the server widened beyond the reviewed envelope is refused before the wallet is asked', async () => {
    const tokenId = chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 5_000_000_000n });
    chain.accrueFees(tokenId, 10n, 20n);
    stage(choiceOf(tokenId)); read(); await settle();
    await act(() => store.simulate());
    await act(() => store.review());
    f.begin = value => { const begun = value as { transaction: { gas: string } }; return { ...begun, transaction: { ...begun.transaction, gas: '0x' + (BigInt(begun.transaction.gas) + 1n).toString(16) } }; };
    await act(() => store.execute());
    expect(store.error).toBe('UNISWAP_TRANSACTION_ARTIFACT_CHANGED');
    expect(sent).toHaveLength(0);
    expect(f.failures).toEqual(['UNISWAP_TRANSACTION_ARTIFACT_CHANGED']);
    expect(store.record?.attempts.map(a => [a.state, a.note])).toEqual([['CANCELLED', 'UNISWAP_TRANSACTION_ARTIFACT_CHANGED']]);
  });

  it('an unknown wallet outcome is observed, never resent', async () => {
    const tokenId = chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 5_000_000_000n });
    stage(choiceOf(tokenId, { operation: 'DECREASE', partBps: 2_500 })); read(); await settle();
    await act(() => store.simulate());
    await act(() => store.review());
    wallet.mode = 'SEND_THEN_UNKNOWN';
    await act(() => store.execute());
    expect(store.error).toBe('UNISWAP_SUBMISSION_UNKNOWN_OBSERVE_EXISTING');
    expect(sent).toHaveLength(1);
    expect(f.failures).toEqual([]);
    // The observation found the broadcast request by its nonce and reconciled it; another Execute can never send it again.
    await act(() => store.observe());
    expect(store.record?.verdict).toBe('RECONCILED');
    wallet.mode = 'SEND';
    await act(() => store.execute());
    expect(sent).toHaveLength(1);
  });

  it('a declined wallet request is recorded as declined; nothing was sent', async () => {
    const tokenId = chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 5_000_000_000n });
    stage(choiceOf(tokenId, { operation: 'EXIT', close: true })); read(); await settle();
    await act(() => store.simulate());
    expect(store.record?.review).toMatchObject({ operation: 'EXIT', close: true, innerCalls: ['DECREASE_LIQUIDITY', 'COLLECT', 'BURN'] });
    await act(() => store.review());
    wallet.mode = 'REJECT';
    await act(() => store.execute());
    expect(store.error).toBe('UNISWAP_REJECTED');
    expect(sent).toHaveLength(0);
    expect(store.record?.attempts.map(a => [a.state, a.note])).toEqual([['CANCELLED', 'UNISWAP_REJECTED']]);
    expect(store.record?.authorization).toBeNull();
  });

  it('a run of another staged operation never stands for the current choice (retired), and without a staged choice or own run the store is not engaged', async () => {
    const tokenId = chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 5_000_000_000n });
    chain.accrueFees(tokenId, 10n, 20n);
    stage(choiceOf(tokenId)); read(); await settle();
    await act(() => store.simulate());
    expect(store.retired).toBe(false);
    // The owner stages EXIT for the same position (re-dispatched MANAGE_LIQUIDITY_POSITION): the COLLECT run is not this choice's Review.
    const workflow = f.workflow;
    stage(choiceOf(tokenId, { operation: 'EXIT' }));
    read(); await settle();
    expect(store.retired).toBe(true);
    expect(store.request).toMatchObject({ operation: 'EXIT' });
    await act(() => store.review());
    expect(store.error).toBe('UNISWAP_SIMULATION_REQUIRED');
    // A deposit workflow (no management marker) without a staged choice: the mint store keeps serving it.
    void workflow;
    f.staged = null; f.workflow = structuredClone(initialEditor().workflow) as unknown as SemanticWorkflow; read(); await settle();
    expect(store.engaged).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('after a reload (no staged choice) the canonical node alone engages the position path with its own request; it is never a deposit (F1)', async () => {
    const tokenId = chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 9_000_000_001n });
    stage(choiceOf(tokenId, { operation: 'DECREASE', partBps: 2_500 })); f.staged = null; read(); await settle();
    expect(store.engaged).toBe(true);
    expect(store.request).toEqual({ operation: 'DECREASE', tokenId, partBps: 2_500, close: false });
    await act(() => store.simulate());
    expect(store.error).toBeNull();
    expect(store.record?.review).toMatchObject({ operation: 'DECREASE', partBps: 2_500, liquidityToRemove: '2250000000' });
    // The deposit runtime refuses the same workflow outright.
    await expect((f.service as UniswapLiquidityService).simulate(f.workflow as SemanticWorkflow, UNI_OWNER)).rejects.toThrow(/UNISWAP_LIQUIDITY_WORKFLOW_MANAGES_POSITION|UNISWAP_LIQUIDITY_DECLARATION_INVALID/);
    expect(sent).toHaveLength(0);
  });
});
