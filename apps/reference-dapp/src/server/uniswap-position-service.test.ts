// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: Uniswap v3 position management (collect, partial withdrawal, exit, explicit close) through the shared
 * Uniswap liquidity service on a MOCKED in-process Base chain. No network, no key, no send path but the scripted owner wallet; evidence is
 * MOCKED, never MAINNET_EXECUTED.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { decodeUniswapCollect, decodeUniswapDecreaseLiquidity, decodeUniswapPositionRequest, UNISWAP_MAX_UINT128 } from '@defi-workflow-engine/reference-compiler';
import { readConcentratedLiquidity, readConcentratedLiquidityManagement, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { catalogPoolOn, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { editorReducer, initialEditor } from '../domain/editor';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import { createUniswapLiquidityChain, managedPositionWorkflow, UNI_MOCK_CODE_PINS, UNI_OWNER, type UniswapLiquidityChain } from '../../e2e/uniswap-liquidity-harness';
import { baseAsset, baseCatalog } from './base-mainnet.test-harness';
import { createUniswapLiquidityService, uniswapRunNeedsObservation, type UniswapLiquidityService } from './uniswap-liquidity-service';
import { isUniswapPositionLog, parseUniswapPositionRequest, uniswapPositionReviewCommitment, validateUniswapPositionLog, type UniswapPositionRecord,
  type UniswapPositionRequest, type UniswapPositionReview } from './uniswap-position-service';
import { setLiquidityOutcomeSink } from './liquidity-lifecycle-telemetry';
import type { Rpc } from './public-testnet-service';

const context = createBaseSepoliaReviewContext();
const catalog = baseCatalog();
const USDC = baseAsset(catalog, 'USDC'), CBBTC = baseAsset(catalog, 'cbBTC');
const token = (asset: CanonicalAsset) => asset as { symbol: string; address: string; decimals: number };
const PROFILE = catalogPoolOn('eip155:8453', token(USDC), token(CBBTC), 500);
const USDC_IS_0 = PROFILE.token0.address === USDC.address;
const TICK = USDC_IS_0 ? -69_082 : 69_082;
const LOWER = Math.floor((TICK - 2_000) / 10) * 10, UPPER = Math.ceil((TICK + 2_000) / 10) * 10;
const OTHER = '0x7777777777777777777777777777777777777777';

/** The canonical pool node of the position (its pair, tier and exact range): what Chat and Canvas author for a position operation. */
function positionWorkflow(lower = LOWER, upper = UPPER): SemanticWorkflow {
  const result = editorReducer(initialEditor(), { type: 'ADD_CRYPTO_ACTION', source: 'CANVAS', baseRevision: 0, input: { selection: { action: 'pool', network: 'Base',
    from: 'USDC', to: 'cbBTC' }, amount: '100', secondAmount: '0.001', slippage: '100', fee: 500, rangeUnit: 'TICK', lower: String(lower), upper: String(upper) } }, context);
  if (result.error) throw new Error(result.error);
  const workflow = structuredClone(result.workflow) as unknown as SemanticWorkflow;
  const fields = readConcentratedLiquidity(workflow.nodes.find(n => n.actionType === 'asset.liquidity.concentrated') as never);
  if (fields.tickLower !== lower || fields.tickUpper !== upper) throw new Error('TEST_RANGE_NOT_AUTHORED');
  return workflow;
}
const managed = (w: SemanticWorkflow, r: UniswapPositionRequest) => managedPositionWorkflow(w, r);
/**
 * The suites below drive one run per position; this wrapper hands each position method the workflow marked with that run's own request (as the
 * editor does), so a test passes the position's pool workflow once. The binding itself is proven against the raw service.
 */
function marking(service: UniswapLiquidityService): UniswapLiquidityService {
  const workflows = new Map<string, SemanticWorkflow>();
  const of = (id: string, w: SemanticWorkflow) => readConcentratedLiquidityManagement(w.nodes.find(n => n.actionType === 'asset.liquidity.concentrated')!).management ? w : workflows.get(id) ?? w;
  return { ...service,
    positionSimulate: async (w, owner, r) => { const run = await service.positionSimulate(managed(w as SemanticWorkflow, r as UniswapPositionRequest), owner, r); workflows.set(run.id, run.workflow); return run; },
    positionReview: (id, commitment, w) => service.positionReview(id, commitment, of(id, w)),
    positionBegin: (id, owner, w) => service.positionBegin(id, owner, of(id, w)),
  } as UniswapLiquidityService;
}
type Faults = { ownerOf: boolean; endOfBlock: { block: string; liquidityDelta: bigint; laterLog: boolean; priorToo?: boolean } | null };
type Setup = { chain: UniswapLiquidityChain; service: UniswapLiquidityService; raw: UniswapLiquidityService; dir: string; faults: Faults };
async function setup(options: { confirmations?: number; executionEnabled?: boolean } = {}): Promise<Setup> {
  const chain = createUniswapLiquidityChain({ profile: PROFILE, tick: TICK, usdc: USDC_IS_0 ? 1_000_000_000n : 10_000_000n, weth: USDC_IS_0 ? 10_000_000n : 1_000_000_000n });
  const dir = await mkdtemp(join(tmpdir(), 'flofi-base-pm-'));
  const sepolia: Rpc = async () => { throw new Error('BASE_SEPOLIA_CLIENT_MUST_NOT_BE_USED'); };
  // A transport failure the node never answered (as the paced read client reports it), injectable for ownerOf reads only.
  const faults: Faults = { ownerOf: false, endOfBlock: null };
  const rpc: Rpc = async (method, params) => {
    const data = String((params[0] as { data?: string })?.data ?? '');
    if (faults.ownerOf && method === 'eth_call' && data.startsWith('0x6352211e')) throw new Error('PUBLIC_RPC_UNAVAILABLE');
    const end = faults.endOfBlock;
    // A later transaction of the same block (a third party's increaseLiquidity) changed the position: the end-of-block read shows it.
    const priorBlock = end ? '0x' + (BigInt(end.block) - 1n).toString(16) : null;
    if (end && method === 'eth_call' && data.startsWith('0x99fbab88') && (params[1] === end.block || end.priorToo && params[1] === priorBlock)) {
      const answer = String(await chain.rpc(method, params)), words = answer.slice(2).match(/.{64}/g)!;
      words[7] = (BigInt('0x' + words[7]) + end.liquidityDelta).toString(16).padStart(64, '0');
      return '0x' + words.join('');
    }
    if (end && method === 'eth_getLogs') {
      const filter = params[0] as { fromBlock: string; address: string };
      if (filter.fromBlock !== end.block || !end.laterLog) return [];
      const tokenWord = '0x' + String(faults.endOfBlock && (end as { tokenId?: string }).tokenId ? BigInt((end as { tokenId?: string }).tokenId!).toString(16) : '0').padStart(64, '0');
      return [{ address: filter.address, transactionIndex: '0x63', logIndex: '0x0', data: '0x',
        topics: ['0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f', tokenWord] }];
    }
    return chain.rpc(method, params);
  };
  const service = createUniswapLiquidityService({ storage: createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY'), rpc: sepolia, rpcs: { 'eip155:8453': rpc },
    provenance: 'MOCKED', now: chain.clock, mockedCodePins: UNI_MOCK_CODE_PINS, executionEnabled: options.executionEnabled ?? true,
    ...options.confirmations !== undefined ? { confirmations: options.confirmations } : {},
    catalog: { chain: 'eip155:8453', catalogFor: async () => catalog, codePins: chain.catalogPins } });
  return { chain, service: marking(service), raw: service, dir, faults };
}
const request = (patch: Partial<UniswapPositionRequest> & { tokenId: string }): UniswapPositionRequest =>
  ({ operation: 'COLLECT', partBps: null, close: false, ...patch });
/** Review → authorize → prepare → durable handoff → the owner's wallet sends → report → observe. */
async function execute({ service, chain }: Setup, id: string, w: SemanticWorkflow) {
  const run = await service.positionStatus(id);
  await service.positionReview(id, run.review.commitment, w);
  const begun = await service.positionBegin(id, UNI_OWNER, w);
  await service.positionHandoff(id);
  await service.positionReport(id, { kind: 'HASH', hash: chain.wallet.send(begun.transaction) });
  return service.positionObserve(id);
}
const balance = (chain: UniswapLiquidityChain, address: string) => chain.snapshot.balances[address]![UNI_OWNER] ?? 0n;

beforeAll(() => registerNetworkCatalog(catalog));
afterAll(() => resetNetworkCatalogs());

describe('BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 Uniswap v3 position management (MOCKED Base)', () => {
  it('validates position requests strictly: a percentage only for a partial withdrawal, closing only with a full exit', () => {
    expect(parseUniswapPositionRequest({ operation: 'DECREASE', tokenId: '42', partBps: 5_000, close: false })).toEqual({ operation: 'DECREASE', tokenId: '42', partBps: 5_000, close: false });
    for (const bad of [{ operation: 'DECREASE', tokenId: '42', partBps: 10_000, close: false }, { operation: 'DECREASE', tokenId: '42', partBps: null, close: false },
      { operation: 'COLLECT', tokenId: '42', partBps: null, close: true }, { operation: 'DECREASE', tokenId: '42', partBps: 5_000, close: true },
      { operation: 'EXIT', tokenId: '042', partBps: null, close: false }, { operation: 'BURN', tokenId: '42', partBps: null, close: true },
      { operation: 'EXIT', tokenId: '42', partBps: null, close: false, recipient: OTHER }, { operation: 'COLLECT', tokenId: '42', partBps: 1, close: false }])
      expect(() => parseUniswapPositionRequest(bad), JSON.stringify(bad)).toThrow('UNISWAP_POSITION_REQUEST_INVALID');
  });

  it('collects fees accrued since the last checkpoint (never trusting a stale tokensOwed read) and keeps the position and its liquidity', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 5_000_000_000n });
    // Swaps accrued fees the manager has not checkpointed: positions() still reports zero tokensOwed.
    s.chain.accrueFees(tokenId, 1_234n, 5_678n);
    const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId }));
    expect(run.id).toMatch(/^balp-[a-f0-9]{32}$/);
    expect(run.review).toMatchObject({ operation: 'COLLECT', liquidityToRemove: '0', liquidityAfter: '5000000000', innerCalls: ['COLLECT'], deadline: null,
      position: { tokenId, owner: UNI_OWNER, tokensOwed0: '0', tokensOwed1: '0', liquidity: '5000000000' },
      expected: { principal0: '0', principal1: '0', collect0: '1234', collect1: '5678', owedAndFees0: '1234', owedAndFees1: '5678' }, minimums: { amount0Min: '0', amount1Min: '0' } });
    // One wallet request to the Position Manager; the recipient is the owner and the bound is uint128 max (fees accrued later are included).
    expect(decodeUniswapCollect(run.review.calls[0].data)).toEqual({ tokenId: BigInt(tokenId), recipient: UNI_OWNER, amount0Max: UNISWAP_MAX_UINT128, amount1Max: UNISWAP_MAX_UINT128 });
    // More fees accrue between the Review and the execution: they are collected too, and reconciliation accepts the larger amount.
    s.chain.accrueFees(tokenId, 100n, 200n);
    const before0 = balance(s.chain, PROFILE.token0.address), before1 = balance(s.chain, PROFILE.token1.address);
    const done = await execute(s, run.id, w);
    expect(done.verdict).toBe('RECONCILED');
    expect(done.result).toMatchObject({ operation: 'COLLECT', collected0: '1334', collected1: '5878', principal0: '0', liquidityRemoved: '0', liquidityAfter: '5000000000', burned: false });
    expect(balance(s.chain, PROFILE.token0.address) - before0).toBe(1_334n);
    expect(balance(s.chain, PROFILE.token1.address) - before1).toBe(5_878n);
    expect(s.chain.snapshot.owners[tokenId]).toBe(UNI_OWNER);
    expect(done.evidence).toMatchObject({ evidenceClass: 'MOCKED', chainId: 8453, bundle: { environment: 'MOCKED', outcome: 'RECONCILED' },
      result: { burned: false } });
    expect(done.evidence!.bundle.reconciliation.positions).toHaveLength(1);
    expect(uniswapRunNeedsObservation(done)).toBe(false);
  });

  it('emits content-free lifecycle outcomes (prepared, rejected, reconciled) without any address, token id or amount', async () => {
    const lines: Record<string, unknown>[] = [];
    setLiquidityOutcomeSink(fields => lines.push(fields as Record<string, unknown>));
    try {
      const s = await setup(), w = positionWorkflow();
      const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 5_000_000_000n });
      await expect(s.service.positionSimulate(w, UNI_OWNER, request({ tokenId }))).rejects.toThrow('UNISWAP_POSITION_NOTHING_TO_COLLECT');
      s.chain.accrueFees(tokenId, 10n, 10n);
      const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId }));
      await execute(s, run.id, w);
      expect(lines.map(line => [line.outcome, line.operation, line.code])).toEqual([['SIMULATION_REJECTED', 'COLLECT', 'UNISWAP_POSITION_NOTHING_TO_COLLECT'],
        ['COLLECTION_PREPARED', 'COLLECT', null], ['RECONCILED', 'COLLECT', null]]);
      const text = JSON.stringify(lines);
      for (const secret of [UNI_OWNER, run.id, PROFILE.positionManager, PROFILE.pool]) expect(text).not.toContain(secret.slice(2));
      expect(text).not.toMatch(new RegExp(`"${tokenId}"`));
    } finally { setLiquidityOutcomeSink(null); }
  });

  it('refuses to ask the owner to pay for a collection of nothing', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 5_000_000_000n });
    await expect(s.service.positionSimulate(w, UNI_OWNER, request({ tokenId }))).rejects.toThrow('UNISWAP_POSITION_NOTHING_TO_COLLECT');
  });

  it('withdraws 50% of the position liquidity (integer, rounded down) with fresh minimums, collects principal and fees, and keeps the rest', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 9_000_000_001n, owed0: 7n, owed1: 0n });
    s.chain.accrueFees(tokenId, 50n, 60n);
    const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'DECREASE', partBps: 5_000 }));
    const r = run.review;
    expect(r).toMatchObject({ operation: 'DECREASE', partBps: 5_000, close: false, liquidityToRemove: '4500000000', liquidityAfter: '4500000001',
      innerCalls: ['DECREASE_LIQUIDITY', 'COLLECT'], slippageBps: 100, position: { tokensOwed0: '7', tokensOwed1: '0' } });
    const [decrease, collect] = decodeUniswapPositionRequest(r.calls[0].data);
    const d = decodeUniswapDecreaseLiquidity(decrease!.data);
    expect(d).toMatchObject({ tokenId: BigInt(tokenId), liquidity: 4_500_000_000n, deadline: BigInt(r.deadline!) });
    // Minimums derive from the simulated principal at the reviewed slippage (1%), never from any mint minimum.
    expect(d.amount0Min).toBe(BigInt(r.expected.principal0) * 9_900n / 10_000n);
    expect(d.amount1Min).toBe(BigInt(r.expected.principal1) * 9_900n / 10_000n);
    expect(decodeUniswapCollect(collect!.data).recipient).toBe(UNI_OWNER);
    // Owed tokens the position already carried and fresh fees are reported apart from principal (never as yield of this withdrawal alone).
    expect(BigInt(r.expected.owedAndFees0)).toBe(57n);
    expect(BigInt(r.expected.owedAndFees1)).toBe(60n);
    const done = await execute(s, run.id, w);
    expect(done.verdict).toBe('RECONCILED');
    expect(done.result).toMatchObject({ liquidityRemoved: '4500000000', liquidityAfter: '4500000001', principal0: r.expected.principal0, burned: false });
    expect(s.chain.snapshot.positions[tokenId]).toMatchObject({ liquidity: 4_500_000_001n, owed0: 0n, owed1: 0n });
  });

  it('removes 100% without burning, and closes (burns) the NFT only when the owner explicitly asked', async () => {
    const s = await setup(), w = positionWorkflow();
    const kept = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
    const exit = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId: kept, operation: 'EXIT' }));
    expect(exit.review).toMatchObject({ liquidityToRemove: '2000000000', liquidityAfter: '0', close: false, innerCalls: ['DECREASE_LIQUIDITY', 'COLLECT'] });
    const exited = await execute(s, exit.id, w);
    expect(exited.result).toMatchObject({ liquidityAfter: '0', burned: false });
    expect(s.chain.snapshot.owners[kept]).toBe(UNI_OWNER);
    // The emptied position can then be closed on its own: collect (nothing left) and burn in one request.
    const closeEmpty = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId: kept, operation: 'EXIT', close: true }));
    expect(closeEmpty.review.innerCalls).toEqual(['COLLECT', 'BURN']);
    const closedEmpty = await execute(s, closeEmpty.id, w);
    expect(closedEmpty.result).toMatchObject({ burned: true, liquidityAfter: null });
    expect(s.chain.snapshot.owners[kept]).toBeUndefined();
    expect(closedEmpty.evidence!.bundle.reconciliation.positions).toEqual([]);

    const closing = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 3_000_000_000n });
    s.chain.accrueFees(closing, 9n, 9n);
    const close = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId: closing, operation: 'EXIT', close: true }));
    expect(close.review.innerCalls).toEqual(['DECREASE_LIQUIDITY', 'COLLECT', 'BURN']);
    const closed = await execute(s, close.id, w);
    expect(closed.result).toMatchObject({ burned: true, liquidityRemoved: '3000000000' });
    expect(s.chain.snapshot.positions[closing]).toBeUndefined();
  });

  it('never burns a position whose liquidity changed after the Review: the run needs a new Review instead', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 3_000_000_000n });
    const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'EXIT', close: true }));
    await s.service.positionReview(run.id, run.review.commitment, w);
    // Someone adds liquidity to the position (the manager lets anyone increase a position) before execution.
    s.chain.snapshot.positions[tokenId]!.liquidity += 1_000n;
    s.chain.advance(2);
    await expect(s.service.positionBegin(run.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_POSITION_STATE_CHANGED_REVIEW_REQUIRED');
    const after = await s.service.positionStatus(run.id);
    expect(after).toMatchObject({ authorization: null, error: 'UNISWAP_POSITION_STATE_CHANGED_REVIEW_REQUIRED', attempts: [] });
    expect(s.chain.counters.sends).toBe(0);
    // The refreshed Review removes the new liquidity too.
    const refreshed = await s.service.positionRefresh(run.id);
    expect(refreshed.review.liquidityToRemove).toBe('3000001000');
  });

  it('binds the connected wallet as the NFT owner: another owner, a transfer after Review, or a wrong range are refused', async () => {
    const s = await setup(), w = positionWorkflow();
    const foreign = s.chain.seedPosition({ owner: OTHER, tickLower: LOWER, tickUpper: UPPER, liquidity: 1_000_000n });
    await expect(s.service.positionSimulate(w, UNI_OWNER, request({ tokenId: foreign, operation: 'EXIT' }))).rejects.toThrow('UNISWAP_POSITION_OWNER_MISMATCH');
    await expect(s.service.positionSimulate(w, UNI_OWNER, request({ tokenId: '999999', operation: 'EXIT' }))).rejects.toThrow('UNISWAP_POSITION_NOT_FOUND');
    const mine = s.chain.seedPosition({ tickLower: LOWER - 10, tickUpper: UPPER, liquidity: 1_000_000n });
    await expect(s.service.positionSimulate(w, UNI_OWNER, request({ tokenId: mine, operation: 'EXIT' }))).rejects.toThrow('UNISWAP_POSITION_RANGE_MISMATCH');
    const moved = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 1_000_000_000n });
    const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId: moved, operation: 'DECREASE', partBps: 2_500 }));
    await s.service.positionReview(run.id, run.review.commitment, w);
    s.chain.transferPosition(moved, OTHER);
    await expect(s.service.positionBegin(run.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_POSITION_OWNER_MISMATCH');
    expect((await s.service.positionStatus(run.id)).authorization).toBeNull();
    await expect(s.service.positionBegin(run.id, OTHER, w)).rejects.toThrow('UNISWAP_WRONG_OWNER');
  });

  it('never prepares a request under an expired Review, and continues the same run after a fresh Review', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 1_000_000_000n });
    const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'DECREASE', partBps: 7_500 }));
    await s.service.positionReview(run.id, run.review.commitment, w);
    s.chain.advance(55);
    await expect(s.service.positionBegin(run.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_REVIEW_EXPIRED');
    expect(await s.service.positionStatus(run.id)).toMatchObject({ authorization: null, error: 'UNISWAP_REVIEW_EXPIRED', attempts: [] });
    await s.service.positionRefresh(run.id);
    const done = await execute(s, run.id, w);
    expect(done.result).toMatchObject({ liquidityRemoved: '750000000' });
  });

  it('records a wallet refusal as not sent, and a handoff after expiry as not submitted, without repeating anything', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 1_000_000_000n });
    const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'EXIT' }));
    await s.service.positionReview(run.id, run.review.commitment, w);
    await s.service.positionBegin(run.id, UNI_OWNER, w);
    await s.service.positionHandoff(run.id);
    const refused = await s.service.positionWalletFailure(run.id, { invoked: true, code: 'UNISWAP_WALLET_REJECTED', rejectionCode: 4001,
      calls: [{ method: 'eth_sendTransaction', submission: true, error: { code: 4001 } }] });
    expect(refused.attempts.at(-1)).toMatchObject({ state: 'CANCELLED', note: 'UNISWAP_REJECTED' });
    await s.service.positionRefresh(run.id);
    const again = await s.service.positionStatus(run.id);
    await s.service.positionReview(run.id, again.review.commitment, w);
    await s.service.positionBegin(run.id, UNI_OWNER, w);
    s.chain.advance(65);
    await expect(s.service.positionHandoff(run.id)).rejects.toThrow('UNISWAP_REVIEW_EXPIRED');
    expect((await s.service.positionStatus(run.id)).attempts.at(-1)).toMatchObject({ state: 'CANCELLED', note: 'UNISWAP_REVIEW_EXPIRED' });
    expect(s.chain.counters.sends).toBe(0);
  });

  it('observes an uncertain submission instead of resending, and never repeats a confirmed withdrawal (same run or another run)', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
    const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'DECREASE', partBps: 5_000 }));
    await s.service.positionReview(run.id, run.review.commitment, w);
    const begun = await s.service.positionBegin(run.id, UNI_OWNER, w);
    await s.service.positionHandoff(run.id);
    // The wallet sent the transaction but the browser lost the answer.
    s.chain.wallet.send(begun.transaction, { hold: true });
    await s.service.positionReport(run.id, { kind: 'UNKNOWN' });
    await expect(s.service.positionBegin(run.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
    await expect(s.service.positionRefresh(run.id)).rejects.toThrow('UNISWAP_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
    // A second run of the same position cannot prepare while the first may still execute.
    const second = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'DECREASE', partBps: 5_000 }));
    await s.service.positionReview(second.id, second.review.commitment, w);
    await expect(s.service.positionBegin(second.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_POSITION_OPERATION_IN_PROGRESS');
    s.chain.wallet.release();
    const done = await s.service.positionObserve(run.id);
    expect(done).toMatchObject({ verdict: 'RECONCILED', result: { liquidityRemoved: '1000000000', liquidityAfter: '1000000000' } });
    expect(done.attempts).toHaveLength(1);
    await expect(s.service.positionBegin(run.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_POSITION_OPERATION_ALREADY_CONFIRMED');
    await expect(s.service.positionRefresh(run.id)).rejects.toThrow('UNISWAP_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
    // The second run's Review was bound to the old liquidity: it can never re-apply the same 50% to the new state.
    await expect(s.service.positionBegin(second.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_POSITION_STATE_CHANGED_REVIEW_REQUIRED');
    expect(s.chain.counters.sends).toBe(1);
  });

  it('an uncertain attempt whose nonce another transaction consumed stops blocking the position only once it can no longer change liquidity', async () => {
    const s = await setup(), w = positionWorkflow();
    const lines = async (id: string) => (await readFile(join(s.dir, id + '.jsonl'), 'utf8')).trimEnd().split('\n').length;
    // Another transaction from the owner's account (another dapp) consumes the nonce FloFi reserved; FloFi's own request was never seen.
    const consumeNonce = (tx: { from: string; to: string; data: string; chainId: string }) => s.chain.wallet.send({ ...tx, to: OTHER, data: '0x' }, { revert: true });
    // 1. A collect-only request: even if the wallet sent it at another nonce, it can only pay owed tokens to the owner.
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
    s.chain.accrueFees(tokenId, 1_000n, 2_000n);
    const collect = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId }));
    await s.service.positionReview(collect.id, collect.review.commitment, w);
    const begun = await s.service.positionBegin(collect.id, UNI_OWNER, w);
    await s.service.positionHandoff(collect.id);
    await s.service.positionReport(collect.id, { kind: 'UNKNOWN' });
    consumeNonce(begun.transaction);
    const uncertain = await s.service.positionObserve(collect.id);
    expect(uncertain.attempts.at(-1)).toMatchObject({ state: 'SUBMISSION_RESULT_UNKNOWN', note: 'UNISWAP_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION' });
    expect(uncertain.verdict).toBe('PENDING');
    // Observing it again changes nothing and appends nothing (the run is never concluded as "not executed").
    const before = await lines(collect.id);
    expect((await s.service.positionObserve(collect.id)).attempts.at(-1)!.state).toBe('SUBMISSION_RESULT_UNKNOWN');
    expect(await lines(collect.id)).toBe(before);
    // A later exit of the same position is not locked out; it re-verifies the exact liquidity itself.
    const exit = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'EXIT', close: true }));
    expect(await execute(s, exit.id, w)).toMatchObject({ verdict: 'RECONCILED', result: { burned: true } });
    // 2. A decrease keeps blocking until its own on-chain deadline has passed (it could still execute at another nonce until then).
    const second = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 4_000_000_000n });
    const half = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId: second, operation: 'DECREASE', partBps: 5_000 }));
    await s.service.positionReview(half.id, half.review.commitment, w);
    const halfBegun = await s.service.positionBegin(half.id, UNI_OWNER, w);
    await s.service.positionHandoff(half.id);
    await s.service.positionReport(half.id, { kind: 'UNKNOWN' });
    consumeNonce(halfBegun.transaction);
    expect((await s.service.positionObserve(half.id)).attempts.at(-1)!.state).toBe('SUBMISSION_RESULT_UNKNOWN');
    const other = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId: second, operation: 'EXIT' }));
    await s.service.positionReview(other.id, other.review.commitment, w);
    await expect(s.service.positionBegin(other.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_POSITION_OPERATION_IN_PROGRESS');
    s.chain.advance(Number(half.review.deadline) - half.review.block.timestamp + 120);
    const fresh = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId: second, operation: 'EXIT' }));
    expect(await execute(s, fresh.id, w)).toMatchObject({ verdict: 'RECONCILED', result: { liquidityRemoved: '4000000000', liquidityAfter: '0', burned: false } });
    // The uncertain run itself stays uncertain and observable: nothing claims it did not execute.
    expect((await s.service.positionStatus(half.id)).attempts.at(-1)!.state).toBe('SUBMISSION_RESULT_UNKNOWN');
  });

  it('a later transaction in the same block that touches the position never turns a correct withdrawal into DIVERGENT; an unexplained difference does', async () => {
    for (const laterLog of [true, false]) {
      const s = await setup(), w = positionWorkflow();
      const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
      const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'DECREASE', partBps: 5_000 }));
      await s.service.positionReview(run.id, run.review.commitment, w);
      const begun = await s.service.positionBegin(run.id, UNI_OWNER, w);
      await s.service.positionHandoff(run.id);
      const hash = s.chain.wallet.send(begun.transaction);
      const receipt = await s.chain.rpc('eth_getTransactionReceipt', [hash]) as { blockNumber: string };
      s.faults.endOfBlock = { block: receipt.blockNumber, liquidityDelta: 777n, laterLog, ...{ tokenId } } as Faults['endOfBlock'];
      await s.service.positionReport(run.id, { kind: 'HASH', hash });
      const done = await s.service.positionObserve(run.id);
      if (laterLog) {
        // Proven by the transaction's own receipt (exact decrease, burn, collect and transfers); scoped to the transaction, honestly.
        expect(done).toMatchObject({ verdict: 'RECONCILED', result: { liquidityRemoved: '1000000000', liquidityAfter: '1000000000', reconciliationScope: 'TRANSACTION' } });
      } else {
        expect(done.verdict).toBe('DIVERGENT');
        expect(done.error).toBe('UNISWAP_POSITION_STATE_MISMATCH');
      }
    }
  });

  it('liquidity a third party added before inclusion (an earlier block) never turns a correct withdrawal into DIVERGENT (flofi-liquidity P3-1)', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
    const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'DECREASE', partBps: 5_000 }));
    await s.service.positionReview(run.id, run.review.commitment, w);
    const begun = await s.service.positionBegin(run.id, UNI_OWNER, w);
    await s.service.positionHandoff(run.id);
    const hash = s.chain.wallet.send(begun.transaction);
    const receipt = await s.chain.rpc('eth_getTransactionReceipt', [hash]) as { blockNumber: string };
    // The position held 777 more liquidity from the previous block on (someone's increaseLiquidity): the decrease still removed exactly the reviewed share.
    s.faults.endOfBlock = { block: receipt.blockNumber, liquidityDelta: 777n, laterLog: false, priorToo: true, ...{ tokenId } } as Faults['endOfBlock'];
    await s.service.positionReport(run.id, { kind: 'HASH', hash });
    const done = await s.service.positionObserve(run.id);
    expect(done).toMatchObject({ verdict: 'RECONCILED', result: { liquidityRemoved: '1000000000', liquidityAfter: '1000000777' } });
    expect(done.result).not.toHaveProperty('reconciliationScope');
  });

  it('a PREPARED attempt whose Review lapsed (an abandoned tab, or a run someone else prepared for this owner) never blocks the position or the nonce', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
    const abandoned = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'EXIT' }));
    await s.service.positionReview(abandoned.id, abandoned.review.commitment, w);
    await s.service.positionBegin(abandoned.id, UNI_OWNER, w);   // never handed off
    const next = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'DECREASE', partBps: 2_500 }));
    await s.service.positionReview(next.id, next.review.commitment, w);
    // While its Review is valid, the prepared request may still be handed to the wallet: the position stays claimed.
    await expect(s.service.positionBegin(next.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_POSITION_OPERATION_IN_PROGRESS');
    // Once it lapsed it can never be handed off: it is concluded not submitted and the position (and the owner's nonce) are free again.
    s.chain.advance(Math.ceil((Date.parse(abandoned.review.expiresAt) - s.chain.clock().getTime()) / 1000) + 5);
    const fresh = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'DECREASE', partBps: 2_500 }));
    expect(await execute(s, fresh.id, w)).toMatchObject({ verdict: 'RECONCILED', result: { liquidityRemoved: '500000000' } });
    expect((await s.service.positionStatus(abandoned.id)).attempts.at(-1)).toMatchObject({ state: 'CANCELLED', note: 'UNISWAP_WALLET_NOT_SUBMITTED' });
    await expect(s.service.positionHandoff(abandoned.id)).rejects.toThrow();
  });

  it('a read the node never answered is retried, never a Review change: the authorization stays and nothing is prepared', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
    const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'EXIT' }));
    await s.service.positionReview(run.id, run.review.commitment, w);
    s.faults.ownerOf = true;
    await expect(s.service.positionBegin(run.id, UNI_OWNER, w)).rejects.toThrow('PUBLIC_RPC_UNAVAILABLE');
    expect(await s.service.positionStatus(run.id)).toMatchObject({ authorization: run.review.commitment, attempts: [] });
    s.faults.ownerOf = false;
    expect(await execute(s, run.id, w)).toMatchObject({ verdict: 'RECONCILED' });
  });

  it('two runs of one position never both prepare a request, even when their begins race', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
    const runs = await Promise.all([request({ tokenId, operation: 'EXIT' }), request({ tokenId, operation: 'DECREASE', partBps: 2_500 })]
      .map(r => s.service.positionSimulate(w, UNI_OWNER, r)));
    for (const run of runs) await s.service.positionReview(run.id, run.review.commitment, w);
    const results = await Promise.allSettled(runs.map(run => s.service.positionBegin(run.id, UNI_OWNER, w)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const prepared = await Promise.all(runs.map(run => s.service.positionStatus(run.id)));
    expect(prepared.flatMap(run => run.attempts)).toHaveLength(1);
  });

  it('the run log validator binds the network, every attempt\'s chain and the collect recipient; only a position log is read as one', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
    const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'EXIT' }));
    await s.service.positionReview(run.id, run.review.commitment, w);
    await s.service.positionBegin(run.id, UNI_OWNER, w);
    const bytes = await readFile(join(s.dir, run.id + '.jsonl'));
    const pattern = /^balp-[a-f0-9]{32}$/, encode = (lines: unknown[]) => new TextEncoder().encode(lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    expect(() => validateUniswapPositionLog(bytes, pattern, 8453)).not.toThrow();
    expect(() => validateUniswapPositionLog(bytes, pattern, 42161)).toThrow('UNISWAP_LIQUIDITY_STORE_CORRUPT');
    const last = JSON.parse(new TextDecoder().decode(bytes).trimEnd().split('\n').at(-1)!) as UniswapPositionRecord;
    // An attempt for another chain, or a reviewed collect paying anyone but the owner (with a recomputed commitment), is corrupt.
    const otherChain = { ...last, attempts: last.attempts.map(a => ({ ...a, tx: { ...a.tx, chainId: '0xa4b1' } })) };
    expect(() => validateUniswapPositionLog(encode([otherChain]), pattern, 8453)).toThrow('UNISWAP_LIQUIDITY_STORE_CORRUPT');
    const ownerWord = UNI_OWNER.slice(2).padStart(64, '0'), otherWord = OTHER.slice(2).padStart(64, '0');
    const call = { ...last.review.calls[0]!, data: last.review.calls[0]!.data.split(ownerWord).join(otherWord) };
    const diverted = { ...last.review, calls: [call] } as UniswapPositionReview;
    const tampered = { ...last, authorization: null, attempts: [], review: { ...diverted, commitment: uniswapPositionReviewCommitment(diverted) } };
    expect(call.data).not.toBe(last.review.calls[0]!.data);
    expect(() => validateUniswapPositionLog(encode([tampered]), pattern, 8453)).toThrow('UNISWAP_LIQUIDITY_STORE_CORRUPT');
    // A mint log whose workflow happens to contain the position format string is never mistaken for a position log.
    const mint = await s.raw.simulate(w, UNI_OWNER);
    expect(isUniswapPositionLog(await readFile(join(s.dir, mint.id + '.jsonl')))).toBe(false);
    expect(isUniswapPositionLog(new TextEncoder().encode(JSON.stringify({ format: 'flofi.uniswap-liquidity-run.v1', note: '"format":"flofi.uniswap-position-run.v1"' }) + '\n'))).toBe(false);
    expect(isUniswapPositionLog(bytes)).toBe(true);
  });

  it('records a position change only at the network confirmation depth (PR #218), never at inclusion', async () => {
    const s = await setup({ confirmations: 3 }), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
    const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'EXIT', close: true }));
    const first = await execute(s, run.id, w);
    expect(first).toMatchObject({ verdict: 'PENDING', error: 'UNISWAP_AWAITING_CONFIRMATIONS', result: null, evidence: null });
    expect(first.attempts.at(-1)!.state).toBe('PENDING');
    expect(uniswapRunNeedsObservation(first)).toBe(true);
    s.chain.advance(4);
    const settled = await s.service.positionObserve(run.id);
    expect(settled).toMatchObject({ verdict: 'RECONCILED', result: { burned: true } });
  });

  it('binds the operation to the canonical workflow: the request must be the one its node names, and a managed position is never a deposit', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
    s.chain.accrueFees(tokenId, 1_000n, 2_000n);
    const half = request({ tokenId, operation: 'DECREASE', partBps: 5_000 });
    // An unmarked (deposit) workflow, or a node naming another position, operation, portion or close, is refused before any read is trusted.
    await expect(s.raw.positionSimulate(w, UNI_OWNER, half)).rejects.toThrow('UNISWAP_POSITION_REQUEST_MISMATCH');
    for (const other of [request({ tokenId, operation: 'DECREASE', partBps: 2_500 }), request({ tokenId, operation: 'EXIT' }), request({ tokenId, operation: 'EXIT', close: true }),
      request({ tokenId }), request({ tokenId: String(BigInt(tokenId) + 1n), operation: 'DECREASE', partBps: 5_000 })])
      await expect(s.raw.positionSimulate(managed(w, other), UNI_OWNER, half), JSON.stringify(other)).rejects.toThrow('UNISWAP_POSITION_REQUEST_MISMATCH');
    // The deposit path never reviews a workflow that manages a position (a lost staged choice can never become a mint).
    await expect(s.raw.simulate(managed(w, half), UNI_OWNER)).rejects.toThrow(/UNISWAP_LIQUIDITY_WORKFLOW_MANAGES_POSITION|UNISWAP_LIQUIDITY_DECLARATION_INVALID/);
    // A changed choice is a changed workflow: the earlier run's Review can no longer be authorized with it, and the new choice gets its own run.
    const first = await s.raw.positionSimulate(managed(w, half), UNI_OWNER, half);
    const quarter = request({ tokenId, operation: 'DECREASE', partBps: 2_500 });
    await expect(s.raw.positionReview(first.id, first.review.commitment, managed(w, quarter))).rejects.toThrow('UNISWAP_SEMANTIC_REVISION_CHANGED');
    await expect(s.raw.positionBegin(first.id, UNI_OWNER, managed(w, quarter))).rejects.toThrow();
    const second = await s.raw.positionSimulate(managed(w, quarter), UNI_OWNER, quarter);
    expect(second.review).toMatchObject({ operation: 'DECREASE', partBps: 2_500 });
    expect(second.review.workflowHash).not.toBe(first.review.workflowHash);
  });

  it('shares the owner nonce namespace with minting, and keeps the two run kinds apart', async () => {
    const s = await setup(), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
    const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'EXIT' }));
    await s.service.positionReview(run.id, run.review.commitment, w);
    await s.service.positionBegin(run.id, UNI_OWNER, w);
    // A mint prepared while the position request holds the owner's next nonce is refused (never two requests on one nonce).
    const mint = await s.service.simulate(w, UNI_OWNER);
    await s.service.review(mint.id, mint.review.commitment, w);
    await expect(s.service.begin(mint.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_OWNER_NONCE_IN_USE');
    await expect(s.service.load(run.id)).rejects.toThrow('UNISWAP_LIQUIDITY_RUN_KIND_MISMATCH');
    await expect(s.service.positionStatus(mint.id)).rejects.toThrow('UNISWAP_POSITION_RUN_NOT_FOUND');
    expect((await s.service.loadAny(run.id)).id).toBe(run.id);
    expect((await s.service.observeAny(run.id)).attempts.at(-1)!.state).toBe('CANCELLED');
  });

  it('keeps owner execution off unless enabled, while Simulate and Review stay read-only', async () => {
    const s = await setup({ executionEnabled: false }), w = positionWorkflow();
    const tokenId = s.chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
    const run = await s.service.positionSimulate(w, UNI_OWNER, request({ tokenId, operation: 'EXIT' }));
    await s.service.positionReview(run.id, run.review.commitment, w);
    await expect(s.service.positionBegin(run.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_EXECUTION_NOT_ENABLED');
  });

  it('is offered on catalog mainnets only, never on a testnet profile', async () => {
    const chain = createUniswapLiquidityChain();
    const dir = await mkdtemp(join(tmpdir(), 'flofi-sepolia-pm-'));
    const service = createUniswapLiquidityService({ storage: createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY'), rpc: chain.rpc, provenance: 'MOCKED',
      now: chain.clock, mockedCodePins: UNI_MOCK_CODE_PINS });
    await expect(service.positionSimulate(positionWorkflow(), UNI_OWNER, request({ tokenId: '1', operation: 'EXIT' }))).rejects.toThrow('UNISWAP_POSITION_NETWORK_UNSUPPORTED');
  });
});
