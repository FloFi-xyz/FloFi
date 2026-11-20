// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-RELIABILITY-GLOBAL-PRECISION-001 (A): the Base liquidity removal of 2026-11-20 (run balp-3e4b2c94…, 13:45–13:48 UTC) was
 * refused again and again with UNISWAP_L1_FEES_CHANGED_REVIEW_REQUIRED. The Uniswap liquidity runtime froze the GasPriceOracle's instantaneous L1
 * bound at Review, with no headroom, and refused the request when the L1 part alone moved up by a single wei; each refresh froze a new
 * instantaneous bound, so the next L1 block refused again. The bridges had the same defect, fixed on 2026-11-13 by the shared network-fee rule
 * (`@defi-workflow-engine/workflow-contracts` network-fee.ts); this runtime now applies that rule too:
 *  - Review: the L1 part of "Network fee, at most X" carries the shared 2× headroom (`l1FeeReviewBound`);
 *  - begin / hand-off: the request stands while its network fee at the current price and L1 estimate is within X;
 *  - beyond X: the same run is refreshed in place (nothing was sent), never a silent increase;
 *  - reconciliation: the charged total (execution + L1) is checked against X.
 * MOCKED Base chain; no network, no key; only the scripted owner wallet sends. These tests prove the runtime's rule, not a mainnet execution.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catalogPoolOn, type UniswapPoolProfile } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { sqrtRatioAtTick, uniswapAmountsForLiquidity } from '@defi-workflow-engine/reference-compiler';
import { authorizedNetworkFee, L1_FEE_REVIEW_HEADROOM, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, initialEditor } from '../domain/editor';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import type { LiquidityPositionChoice } from '../domain/liquidity-positions';
import { UNISWAP_POSITION_REFRESH_IN_PLACE, UNISWAP_REFRESH_IN_PLACE } from '../domain/uniswap-liquidity-continuation';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER } from '../../e2e/uniswap-liquidity-harness';
import { baseAsset, baseCatalog } from './base-mainnet.test-harness';
import { createUniswapLiquidityService } from './uniswap-liquidity-service';

const catalog = baseCatalog();
const USDC = baseAsset(catalog, 'USDC'), WETH = baseAsset(catalog, 'WETH');
const token = (a: unknown) => a as { symbol: string; address: string; decimals: number };
const TICK = -195_000, LIQUIDITY = 4_000_000_000_000n;
/** The oracle's bound at Review in the harness (`getL1FeeUpperBound`). */
const ESTIMATE = 3_000_000_000n;
beforeEach(() => registerNetworkCatalog(catalog));
afterEach(() => resetNetworkCatalogs());

async function setup() {
  const profile = catalogPoolOn('eip155:8453', token(USDC), token(WETH), 500);
  const chain = createUniswapLiquidityChain({ profile, tick: TICK, usdc: 10n ** BigInt(profile.token0.decimals + 6), weth: 10n ** BigInt(profile.token1.decimals + 6) });
  const dir = await mkdtemp(join(tmpdir(), 'flofi-l1-fee-'));
  const service = createUniswapLiquidityService({ storage: createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY'), rpc: async () => { throw new Error('NO_OTHER_CHAIN_CLIENT'); },
    rpcs: { 'eip155:8453': chain.rpc }, provenance: 'MOCKED', now: chain.clock, mockedCodePins: UNI_MOCK_CODE_PINS,
    catalog: { chain: 'eip155:8453', catalogFor: async () => catalog, codePins: chain.catalogPins } });
  const s = profile.tickSpacing, lower = Math.floor((TICK - 40 * s) / s) * s, upper = Math.ceil((TICK + 40 * s) / s) * s;
  const tokenId = chain.seedPosition({ tickLower: lower, tickUpper: upper, liquidity: LIQUIDITY });
  return { profile, chain, service, lower, upper, tokenId };
}
/** The removal workflow Chat or Canvas authors (MANAGE_LIQUIDITY_POSITION). */
function removal(profile: UniswapPoolProfile, tokenId: string, lower: number, upper: number, operation: LiquidityPositionChoice['operation'], partBps: number | null,
  close: boolean): SemanticWorkflow {
  const principal = uniswapAmountsForLiquidity(sqrtRatioAtTick(TICK), lower, upper, LIQUIDITY);
  const choice: LiquidityPositionChoice = { position: { protocol: 'UNISWAP_V3', chain: profile.chain, network: 'Base', manager: profile.positionManager, pool: profile.pool,
    positionId: tokenId, owner: UNI_OWNER }, operation, partBps, close };
  const side = (t: UniswapPoolProfile['token0']) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals });
  const result = editorReducer(initialEditor(), { type: 'MANAGE_LIQUIDITY_POSITION', choice, pool: { token0: side(profile.token0), token1: side(profile.token1),
    feeTier: profile.feeTier, tickLower: lower, tickUpper: upper, amount0: principal.amount0.toString(), amount1: principal.amount1.toString(), slippageBps: 100 },
    source: 'CHAT', baseRevision: 0 }, createBaseSepoliaReviewContext());
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
}
async function reviewedRemoval(operation: LiquidityPositionChoice['operation'] = 'DECREASE', partBps: number | null = 5_000, close = false) {
  const s = await setup(), w = removal(s.profile, s.tokenId, s.lower, s.upper, operation, partBps, close);
  const run = await s.service.positionSimulate(w, UNI_OWNER, { operation, tokenId: s.tokenId, partBps, close });
  await s.service.positionReview(run.id, run.review.commitment, w);
  return { ...s, w, run };
}
const authorized = (review: { calls: readonly { gasLimit: string; l1FeeUpperBoundWei: string | null }[]; fees: { maxFeePerGas: string } }) =>
  authorizedNetworkFee({ gasLimit: BigInt(review.calls[0]!.gasLimit), maxFeePerGas: BigInt(review.fees.maxFeePerGas), l1FeeBound: BigInt(review.calls[0]!.l1FeeUpperBoundWei!) });

describe('A — L1 data fee changes on a Base liquidity removal (MOCKED)', () => {
  it('Review presents and binds the L1 part of the network fee maximum with the shared headroom', async () => {
    const { run } = await reviewedRemoval();
    expect(run.id).toMatch(/^balp-[a-f0-9]{32}$/);
    const call = run.review.calls[0]!, fees = run.review.fees;
    expect(BigInt(call.l1FeeUpperBoundWei!)).toBe(ESTIMATE * L1_FEE_REVIEW_HEADROOM);
    expect(fees.l1FeeUpperBoundWei).toBe(call.l1FeeUpperBoundWei);
    // The one figure the owner authorizes ("Network fee, at most X") is the execution cap plus that bound.
    expect(BigInt(fees.totalUpperBoundWei!)).toBe(BigInt(fees.executionFeeUpperBoundWei) + BigInt(fees.l1FeeUpperBoundWei!));
    expect(BigInt(fees.totalUpperBoundWei!)).toBe(authorized(run.review));
  });

  it('reproduces the incident: an L1 rise within the authorized maximum no longer refuses — prepare, hand-off, send once, reconcile', async () => {
    const { chain, service, run, w } = await reviewedRemoval();
    // Production: the L1 bound moved within seconds of every Review. Before this build, ×1.5 refused at begin with UNISWAP_L1_FEES_CHANGED_REVIEW_REQUIRED.
    chain.setL1Fee({ estimate: ESTIMATE * 3n / 2n });
    const begun = await service.positionBegin(run.id, UNI_OWNER, w);
    // The wallet-controlled fields are exactly the reviewed ones; nothing was raised to make the request pass.
    expect(begun.transaction).toMatchObject({ gas: '0x' + BigInt(run.review.calls[0]!.gasLimit).toString(16), maxFeePerGas: '0x' + BigInt(run.review.fees.maxFeePerGas).toString(16) });
    chain.setL1Fee({ estimate: ESTIMATE * 2n });
    await service.positionHandoff(run.id);
    await service.positionReport(run.id, { kind: 'HASH', hash: chain.wallet.send(begun.transaction) });
    const done = await service.positionObserve(run.id);
    expect(done).toMatchObject({ verdict: 'RECONCILED', error: null, result: { liquidityRemoved: (LIQUIDITY / 2n).toString(), liquidityAfter: (LIQUIDITY / 2n).toString(), burned: false } });
    expect(done.attempts.map(a => a.state)).toEqual(['CONFIRMED']);
    expect(chain.counters.sends).toBe(1);
  });

  it('beyond the authorized maximum: refused before any wallet request, refreshed on the SAME run, authorized again, then sent once', async () => {
    const { chain, service, run, w } = await reviewedRemoval();
    chain.setL1Fee({ estimate: authorized(run.review) + 1n });
    await expect(service.positionBegin(run.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_L1_FEES_CHANGED_REVIEW_REQUIRED');
    const refused = await service.positionStatus(run.id);
    // Nothing prepared, nothing reserved, nothing sent; the authorization is cleared and the run (with its workflow) stays.
    expect(refused).toMatchObject({ verdict: 'PENDING', authorization: null, error: 'UNISWAP_L1_FEES_CHANGED_REVIEW_REQUIRED', attempts: [] });
    expect(UNISWAP_POSITION_REFRESH_IN_PLACE.test(refused.error!)).toBe(true);
    expect(UNISWAP_REFRESH_IN_PLACE.test(refused.error!)).toBe(true);
    expect(chain.counters.sends).toBe(0);
    // The fresh Review shows the new maximum; it is never raised silently: the owner authorizes it explicitly.
    const refreshed = await service.positionRefresh(run.id);
    expect(refreshed.id).toBe(run.id);
    expect(refreshed.authorization).toBeNull();
    expect(BigInt(refreshed.review.fees.l1FeeUpperBoundWei!)).toBe((authorized(run.review) + 1n) * L1_FEE_REVIEW_HEADROOM);
    expect(refreshed.review.commitment).not.toBe(run.review.commitment);
    await expect(service.positionBegin(run.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_REVIEW_REQUIRED');
    await service.positionReview(run.id, refreshed.review.commitment, w);
    const begun = await service.positionBegin(run.id, UNI_OWNER, w);
    await service.positionHandoff(run.id);
    await service.positionReport(run.id, { kind: 'HASH', hash: chain.wallet.send(begun.transaction) });
    expect(await service.positionObserve(run.id)).toMatchObject({ verdict: 'RECONCILED' });
    expect(chain.counters.sends).toBe(1);
  });

  it('a refusal at hand-off concludes the provably unsent attempt; the same run continues on the same nonce, with no duplicate', async () => {
    const { chain, service, run, w } = await reviewedRemoval();
    const begun = await service.positionBegin(run.id, UNI_OWNER, w);
    chain.setL1Fee({ estimate: authorized(run.review) * 4n });
    await expect(service.positionHandoff(run.id)).rejects.toThrow('UNISWAP_L1_FEES_CHANGED_REVIEW_REQUIRED');
    // The wallet was never called (the attempt never became SUBMITTING): observation concludes it as not submitted.
    const observed = await service.positionObserve(run.id);
    expect(observed.attempts.at(-1)).toMatchObject({ state: 'CANCELLED', note: 'UNISWAP_WALLET_NOT_SUBMITTED', transactionHash: null });
    chain.setL1Fee({ estimate: ESTIMATE });
    const refreshed = await service.positionRefresh(run.id);
    await service.positionReview(run.id, refreshed.review.commitment, w);
    const again = await service.positionBegin(run.id, UNI_OWNER, w);
    expect(again.attempt.nonce).toBe(begun.attempt.nonce);
    await service.positionHandoff(run.id);
    await service.positionReport(run.id, { kind: 'HASH', hash: chain.wallet.send(again.transaction) });
    const done = await service.positionObserve(run.id);
    expect(done.verdict).toBe('RECONCILED');
    expect(done.attempts.map(a => a.state)).toEqual(['CANCELLED', 'CONFIRMED']);
    expect(chain.counters.sends).toBe(1);
  });

  it('after an unknown wallet outcome nothing is refreshed, re-authorized or prepared again: the run is only observed', async () => {
    const { chain, service, run, w } = await reviewedRemoval();
    const begun = await service.positionBegin(run.id, UNI_OWNER, w);
    await service.positionHandoff(run.id);
    // The wallet may have broadcast (held in the mempool), but the browser lost the answer.
    chain.wallet.send(begun.transaction, { hold: true });
    await service.positionReport(run.id, { kind: 'UNKNOWN' });
    chain.setL1Fee({ estimate: authorized(run.review) * 4n });
    await expect(service.positionRefresh(run.id)).rejects.toThrow('UNISWAP_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
    await expect(service.positionBegin(run.id, UNI_OWNER, w)).rejects.toThrow(/UNISWAP_(ATTEMPT_ACTIVE_OBSERVE_EXISTING|REVIEW_REQUIRED)/);
    chain.wallet.release();
    const done = await service.positionObserve(run.id);
    expect(done).toMatchObject({ verdict: 'RECONCILED' });
    expect(done.attempts).toHaveLength(1);
    expect(chain.counters.sends).toBe(1);
  });

  it('reconciliation: a charged L1 fee above the estimate but within the authorized maximum reconciles; beyond it the run is frozen for attention', async () => {
    const within = await reviewedRemoval();
    within.chain.setL1Fee({ charged: ESTIMATE * 2n });
    const a = await within.service.positionBegin(within.run.id, UNI_OWNER, within.w);
    await within.service.positionHandoff(within.run.id);
    await within.service.positionReport(within.run.id, { kind: 'HASH', hash: within.chain.wallet.send(a.transaction) });
    const ok = await within.service.positionObserve(within.run.id);
    expect(ok.verdict).toBe('RECONCILED');
    expect(ok.attempts[0]!.receipt!.l1FeeWei).toBe((ESTIMATE * 2n).toString());

    const beyond = await reviewedRemoval();
    beyond.chain.setL1Fee({ charged: authorized(beyond.run.review) + 1n });
    const b = await beyond.service.positionBegin(beyond.run.id, UNI_OWNER, beyond.w);
    await beyond.service.positionHandoff(beyond.run.id);
    await beyond.service.positionReport(beyond.run.id, { kind: 'HASH', hash: beyond.chain.wallet.send(b.transaction) });
    expect(await beyond.service.positionObserve(beyond.run.id)).toMatchObject({ verdict: 'DIVERGENT', error: 'UNISWAP_RECEIPT_BOUNDS_VIOLATED' });
    expect(beyond.chain.counters.sends).toBe(1);
  });

  it('a 100% removal keeps the NFT with zero liquidity; closing burns it — the result says which', async () => {
    const kept = await reviewedRemoval('EXIT', null, false);
    const k = await kept.service.positionBegin(kept.run.id, UNI_OWNER, kept.w);
    await kept.service.positionHandoff(kept.run.id);
    await kept.service.positionReport(kept.run.id, { kind: 'HASH', hash: kept.chain.wallet.send(k.transaction) });
    expect(await kept.service.positionObserve(kept.run.id)).toMatchObject({ verdict: 'RECONCILED', result: { liquidityAfter: '0', burned: false } });
    expect(kept.chain.snapshot.owners[kept.tokenId]).toBe(UNI_OWNER.toLowerCase());

    const closed = await reviewedRemoval('EXIT', null, true);
    const c = await closed.service.positionBegin(closed.run.id, UNI_OWNER, closed.w);
    await closed.service.positionHandoff(closed.run.id);
    await closed.service.positionReport(closed.run.id, { kind: 'HASH', hash: closed.chain.wallet.send(c.transaction) });
    expect(await closed.service.positionObserve(closed.run.id)).toMatchObject({ verdict: 'RECONCILED', result: { liquidityAfter: null, burned: true } });
    expect(closed.chain.snapshot.owners[closed.tokenId]).toBeUndefined();
  });
});

describe('A — the same rule on a Base liquidity deposit (mint path, MOCKED)', () => {
  it('an L1 rise within the authorized maximum between the approval and the mint does not stop the deposit', async () => {
    const { chain, service } = await setup();
    const result = editorReducer(initialEditor(), { type: 'ADD_CRYPTO_ACTION', source: 'CANVAS', baseRevision: 0, input: { selection: { action: 'pool', network: 'Base',
      from: 'USDC', to: 'WETH' }, amount: '1', secondAmount: '0.001', slippage: '100', fee: 500 } }, createBaseSepoliaReviewContext());
    if (result.error) throw new Error(result.error);
    const w = structuredClone(result.workflow) as unknown as SemanticWorkflow;
    const simulated = await service.simulate(w, UNI_OWNER);
    expect(simulated.review.calls.every(c => BigInt(c.l1FeeUpperBoundWei!) === ESTIMATE * L1_FEE_REVIEW_HEADROOM)).toBe(true);
    await service.review(simulated.id, simulated.review.commitment, w);
    for (const factor of [3n, 4n, 5n]) {
      chain.setL1Fee({ estimate: ESTIMATE * factor / 3n });
      const begun = await service.begin(simulated.id, UNI_OWNER, w);
      await service.handoff(simulated.id);
      await service.report(simulated.id, { kind: 'HASH', hash: chain.wallet.send(begun.transaction) });
      await service.observe(simulated.id);
    }
    const done = await service.load(simulated.id);
    expect(done.verdict).toBe('RECONCILED');
    expect(chain.counters.sends).toBe(done.attempts.length);
  });
});
