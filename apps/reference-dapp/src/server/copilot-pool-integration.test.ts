// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-P1 pool conversational reliability, end to end offline: a position requested by conversation, its percentage range answered in a separate
 * message and computed from the pool price FloFi read through the real Uniswap v3 liquidity service, becomes the canonical IR, is simulated and
 * reviewed by that same service, and reaches the existing owner-wallet handoff — on the MOCKED in-process Arbitrum One chain (no network, no key).
 * Nothing is signed or sent: the prepared request is inspected and the chain's send counter stays at zero.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARBITRUM_ONE, catalogAsset, catalogPoolOn, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as ORCA_MAINNET, parseArbitrumTokenList, UNISWAP_V3_ARBITRUM as UNI,
  type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { createMockedSolanaDevnetOrca, createMockedSolanaWallet, decodeUniswapApprove, uniswapBandAroundSqrtPriceIn } from '@defi-workflow-engine/reference-compiler';
import { readConcentratedLiquidity, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER } from '../../e2e/uniswap-liquidity-harness';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import { CopilotSession, act, intent } from '../domain/copilot-session.test-harness';
import { setActiveNetworkScope } from '../domain/network-scope';
import { ORCA_MAINNET_POOL, type PoolPriceRead, type PoolRef } from '../domain/pool-range';
import { priceBoundsAround } from '../domain/pool-price-bounds';
import { solanaLiquidityTicks } from '../domain/solana-liquidity-authoring';
import { createPositionMintSigner } from '../wallet/position-mint-signer';
import { createOrcaLiquidityService } from './orca-liquidity-service';
import { poolReader } from '../state/copilot-pool-reads';
import { createUniswapLiquidityService } from './uniswap-liquidity-service';
import type { Rpc } from './public-testnet-service';

const catalog = parseArbitrumTokenList(readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8'),
  '2026-10-12T00:00:00Z');
const chainId = ARBITRUM_ONE.chain, asset = (symbol: string) => catalogAsset(catalog, { symbol })! as CanonicalAsset & { address: string };
const dirs: string[] = [];
beforeEach(() => { registerNetworkCatalog(catalog); setActiveNetworkScope('PUBLIC_MAINNET'); });
afterEach(() => { resetNetworkCatalogs(); setActiveNetworkScope(null); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function arbitrumPool() {
  const profile = catalogPoolOn(chainId, asset('USDC') as never, asset('WETH') as never, 500);
  const chain = createUniswapLiquidityChain({ profile, tick: -225_600, usdc: 10n ** 22n, weth: 10n ** 10n });
  const calls: string[] = [];
  const rpc: Rpc = async (method, params) => { calls.push(method); return chain.rpc(method, params); };
  const path = mkdtempSync(join(tmpdir(), 'flofi-copilot-pool-')); dirs.push(path);
  const service = createUniswapLiquidityService({ storage: createFileExecutionStorage(path, 'UNISWAP_LIQUIDITY_BUSY'), rpc: async () => { throw Error('NO_OTHER_CHAIN_CLIENT'); },
    rpcs: { [chainId]: rpc }, provenance: 'MOCKED', now: chain.clock, mockedCodePins: UNI_MOCK_CODE_PINS, executionEnabled: true,
    catalog: { chain: chainId, catalogFor: async () => catalog, codePins: chain.catalogPins } });
  return { profile, chain, service, calls };
}

describe('conversation → IR → Simulate → Review → owner-wallet handoff (MOCKED Arbitrum One)', () => {
  it('"±10%" answered in its own message: the range comes from the service\'s pool read, Review binds it, approvals are exact, nothing is sent', async () => {
    const { profile, chain, service, calls } = await arbitrumPool();
    // The web chat's read, through the same service method the server action calls (`catalogLiquidityPrice`).
    const read = await service.price(chainId, { tokenA: asset('USDC').address, tokenB: asset('WETH').address, fee: 500 });
    expect(read.pool).toBe(profile.pool);
    const reads: PoolRef[] = [];
    const s = Object.assign(new CopilotSession([], UNI_OWNER), { walletChainId: chainId, now: Date.now(), poolReader: (ref: PoolRef): PoolPriceRead => {
      reads.push(ref); return { ref, readAt: Date.now(), ok: true, sqrtPrice: read.sqrtPriceX96, tick: read.tick, at: read.blockNumber };
    } });
    const deposits = [{ asset: 'USDC', maxAmount: '10' }, { asset: 'WETH', maxAmount: '0.005' }];
    const asked = s.say('Add liquidity on Arbitrum with 10 USDC and 0.005 WETH at the 0.05% fee in a percentage range',
      intent.action(act.catalogLiquidity({ network: 'ARBITRUM', deposits, feeTier: '0.05', rangeUnit: 'PERCENT' })));
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_PERCENT_REQUIRED' });
    const proposed = s.say('±10%');
    expect(proposed?.kind).toBe('PROPOSAL');
    expect(reads).toEqual([expect.objectContaining({ kind: 'UNISWAP_V3', chain: chainId, pool: profile.pool, fee: 500 })]);
    const ticks = uniswapBandAroundSqrtPriceIn(BigInt(read.sqrtPriceX96), 1_000, profile.tickSpacing, 'TOKEN1_PER_TOKEN0');
    expect(proposed?.sentence).toBe(`add liquidity 10 USDC and 0.005 WETH on Arbitrum One fee 0.05% ticks ${ticks.tickLower} to ${ticks.tickUpper} slippage 100 bps`);
    s.apply();
    const workflow = structuredClone(s.workflow) as unknown as SemanticWorkflow;
    expect(readConcentratedLiquidity(workflow.nodes.at(-1)!)).toMatchObject({ ...ticks, feeTier: 500, amount0Max: '5000000000000000', amount1Max: '10000000' });
    // Simulate and Review: the existing service, unchanged, reads the pool again and binds the conversational range.
    const run = await service.simulate(workflow, UNI_OWNER);
    expect(run.review).toMatchObject({ chainId: 42161, owner: UNI_OWNER, contracts: { pool: profile.pool }, range: { tickLower: ticks.tickLower, tickUpper: ticks.tickUpper } });
    const reviewed = await service.review(run.id, run.review.commitment, workflow);
    expect(reviewed.authorization).toBe(run.review.commitment);
    // Approvals are exactly the reviewed maxima (never unlimited), to the reviewed position manager.
    expect(run.review.approvals.map(a => [a.token, a.spender, a.amount])).toEqual([[UNI.weth, UNI.positionManager, '5000000000000000'], [UNI.usdc, UNI.positionManager, '10000000']]);
    expect(decodeUniswapApprove(run.review.calls[0]!.data).amount).toBe(5_000_000_000_000_000n);
    // The existing owner-wallet handoff prepares the first request for the owner's own wallet; the chat never signs or sends.
    const begun = await service.begin(run.id, UNI_OWNER, workflow);
    expect(begun.transaction).toMatchObject({ chainId: '0xa4b1', from: UNI_OWNER, value: '0x0' });
    // The web chat's reader binds the service's read to the pool FloFi asked for.
    const viaReader = await poolReader({ orca: async () => ({ ok: false, code: 'UNUSED' }), catalog: async (c, p) => ({ ok: true, value: await service.price(c, p) }) })(reads[0]!);
    expect(viaReader).toMatchObject({ ok: true, sqrtPrice: read.sqrtPriceX96, tick: read.tick });
    expect(calls.every(method => !/send|sign/i.test(method))).toBe(true);
    expect(chain.counters.sends).toBe(0);
  });
  it('the pool price moves after the chat\'s proposal: Review reads the pool again and keeps the chat\'s ticks; a move after Review requires a new Review', async () => {
    const { chain, service } = await arbitrumPool();
    const read = await service.price(chainId, { tokenA: asset('USDC').address, tokenB: asset('WETH').address, fee: 500 });
    const s = Object.assign(new CopilotSession([], UNI_OWNER), { walletChainId: chainId, now: Date.now(), poolReader: (ref: PoolRef): PoolPriceRead =>
      ({ ref, readAt: Date.now(), ok: true, sqrtPrice: read.sqrtPriceX96, tick: read.tick, at: read.blockNumber }) });
    const proposed = s.say('Add liquidity on Arbitrum with 10 USDC and 0.005 WETH at the 0.05% fee, ±10%', intent.action(act.catalogLiquidity({ network: 'ARBITRUM',
      deposits: [{ asset: 'USDC', maxAmount: '10' }, { asset: 'WETH', maxAmount: '0.005' }], feeTier: '0.05', rangeUnit: 'PERCENT', upper: '10' })));
    expect(proposed?.kind).toBe('PROPOSAL');
    s.apply();
    const workflow = structuredClone(s.workflow) as unknown as SemanticWorkflow;
    const chat = readConcentratedLiquidity(workflow.nodes.at(-1)!);
    chain.movePrice(200);
    // Simulate reads the pool at its own block: Review shows the moved price and binds exactly the chat's ticks (no price is carried from the chat).
    const run = await service.simulate(workflow, UNI_OWNER);
    expect(run.review.pool.tick).toBe(read.tick + 200);
    expect(run.review.range).toMatchObject({ tickLower: chat.tickLower, tickUpper: chat.tickUpper, state: 'IN_RANGE' });
    await service.review(run.id, run.review.commitment, workflow);
    chain.movePrice(1000);
    await expect(service.begin(run.id, UNI_OWNER, workflow)).rejects.toThrow('UNISWAP_STATE_CHANGED_REVIEW_REQUIRED');
    expect((await service.load(run.id)).authorization).toBeNull();
    expect(chain.counters.sends).toBe(0);
  });
  it('a pool that does not exist at the requested fee tier is refused by name, before any proposal', async () => {
    const { service } = await arbitrumPool();
    const s = Object.assign(new CopilotSession([], UNI_OWNER), { now: Date.now(), poolReader: (ref: PoolRef): PoolPriceRead => ({ ref, readAt: Date.now(), ok: false, code: 'POOL_READ_FAILED' }) });
    let code = 'POOL_READ_FAILED';
    await service.price(chainId, { tokenA: asset('USDC').address, tokenB: asset('WETH').address, fee: 3000 }).catch((cause: Error) => { code = cause.message; });
    expect(code).toBe('UNISWAP_CONTRACT_CODE_MISSING');
    s.poolReader = (ref: PoolRef): PoolPriceRead => ({ ref, readAt: Date.now(), ok: false, code });
    const reply = s.say('Add liquidity on Arbitrum with 10 USDC and 0.005 WETH at the 0.3% fee, ±10%',
      intent.action(act.catalogLiquidity({ network: 'ARBITRUM', deposits: [{ asset: 'USDC', maxAmount: '10' }, { asset: 'WETH', maxAmount: '0.005' }], feeTier: '0.3',
        rangeUnit: 'PERCENT', upper: '10' })));
    expect(reply).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POOL_NOT_FOUND' });
    expect(reply?.command).toBeUndefined();
  });
});

describe('conversation → IR → Simulate → Review → owner-wallet handoff (MOCKED Orca SOL/USDC on Solana mainnet-beta)', () => {
  async function orcaPool() {
    const env = createMockedSolanaDevnetOrca({ liquidityProfile: ORCA_MAINNET }), wallet = createMockedSolanaWallet();
    env.fund(wallet.owner, 3_000_000_000n, 50_000_000n);
    const path = mkdtempSync(join(tmpdir(), 'flofi-copilot-orca-')); dirs.push(path);
    const clock = Date.now();
    const service = createOrcaLiquidityService({ rpc: env.rpc, journalDir: path, profile: ORCA_MAINNET, provenance: 'MOCKED', executionEnabled: true, now: () => clock });
    return { env, wallet, service };
  }
  const deposits = [{ asset: 'SOL', maxAmount: '0.01' }, { asset: 'USDC', maxAmount: '0.3' }];
  it.each(['separate messages ("<lower>usdc" → "lower" → "<upper>")', '"±10%" from the verified mainnet price'])('%s: the chat\'s range is the reviewed range, nothing is sent', async mode => {
    const { env, wallet, service } = await orcaPool();
    // The web chat's read, through the same service method the server action calls (`solanaMainnetLiquidityPrice`), bound by the web chat's reader.
    const price = await service.price();
    const read = await poolReader({ orca: async () => ({ ok: true, value: price }), catalog: async () => ({ ok: false, code: 'UNUSED' }) })(ORCA_MAINNET_POOL);
    expect(read).toMatchObject({ ok: true, price: price.price, tick: price.tickCurrentIndex, at: price.slot });
    const s = Object.assign(new CopilotSession(), { now: Date.now(), poolReader: (ref: PoolRef): PoolPriceRead => ({ ...read, ref, readAt: Date.now() }) });
    s.say('Add liquidity on Orca on Solana with 0.01 SOL and 0.3 USDC', intent.action(act.liquidity({ protocol: 'ORCA', network: 'SOLANA', deposits })));
    let bounds: { lower: string; upper: string };
    if (mode.startsWith('separate')) {
      const around = priceBoundsAround(price.price, -10, 10);
      bounds = { lower: String(Math.floor(Number(around.lower))), upper: String(Math.ceil(Number(around.upper))) };
      expect(s.say(`${bounds.lower}usdc`)).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_SIDE_REQUIRED' });
      expect(s.say('lower')).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_BOUND_REQUIRED' });
      expect(s.say(bounds.upper)?.kind).toBe('PROPOSAL');
    } else {
      bounds = priceBoundsAround(price.price, -10, 10);
      expect(s.say('±10%')?.sentence).toContain(`from ${bounds.lower} to ${bounds.upper} USDC per SOL`);
    }
    s.apply();
    const workflow = structuredClone(s.workflow) as unknown as SemanticWorkflow;
    const ticks = solanaLiquidityTicks({ rangeUnit: 'PRICE', lower: bounds.lower, upper: bounds.upper, network: 'Solana' });
    const key = await createPositionMintSigner();
    const run = await service.simulate(workflow, wallet.owner, { operation: 'OPEN', positionMint: key.address });
    expect(run.review).toMatchObject({ cluster: 'mainnet-beta', pool: { address: ORCA_MAINNET.pool.address }, range: { tickLower: ticks.tickLower, tickUpper: ticks.tickUpper } });
    const record = await service.review(run.id, run.review.commitment, workflow);
    // The existing owner-wallet handoff prepares the unsigned request for the owner's own wallet; the chat never signs or submits.
    const begun = await service.begin(record.id, wallet.owner, workflow);
    expect(begun.walletChain).toBe('solana:mainnet');
    expect(env.state.sent).toHaveLength(0);
  });
});
