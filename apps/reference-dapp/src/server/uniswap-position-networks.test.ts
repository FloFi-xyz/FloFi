// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: Uniswap v3 position management on each catalog mainnet runtime (Arbitrum One's Nitro fee policy, Ethereum L1,
 * Robinhood Chain with a Stock Token side), with the workflow authored by the MANAGE_LIQUIDITY_POSITION command. MOCKED chains; no network, no key;
 * only the scripted owner wallet sends; evidence is MOCKED.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARBITRUM_ONE, catalogAsset, catalogPoolOn, parseArbitrumTokenList, parseEthereumTokenList, robinhoodLiquidityPool, type AssetCatalog,
  type CanonicalAsset, type UniswapPoolProfile } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { uniswapAmountsForLiquidity, sqrtRatioAtTick } from '@defi-workflow-engine/reference-compiler';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, initialEditor } from '../domain/editor';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import type { LiquidityPositionChoice } from '../domain/liquidity-positions';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER, type UniswapLiquidityChain } from '../../e2e/uniswap-liquidity-harness';
import { asset as robinhoodAsset, officialCatalog } from './robinhood-mainnet.test-harness';
import { createUniswapLiquidityService, type UniswapLiquidityService } from './uniswap-liquidity-service';

const fixture = (name: string) => readFileSync(new URL(`../../../../packages/action-registry/test/fixtures/${name}`, import.meta.url), 'utf8');
const ARBITRUM = parseArbitrumTokenList(fixture('arbitrum-token-list-fixture.json'), '2026-10-12T00:00:00Z');
const ETHEREUM = parseEthereumTokenList(fixture('ethereum-token-list-fixture.json'), '2026-10-17T00:00:00Z');
const ROBINHOOD = officialCatalog();
const token = (a: CanonicalAsset) => a as { symbol: string; address: string; decimals: number };
const of = (catalog: AssetCatalog, symbol: string) => catalogAsset(catalog, { symbol })!;
afterEach(() => resetNetworkCatalogs());

type Net = { readonly name: string; readonly catalog: AssetCatalog; readonly profile: UniswapPoolProfile; readonly tick: number;
  readonly stocks?: Readonly<Record<string, { uid: string; multiplierWad: bigint }>> };
async function setup(net: Net, options: { confirmations?: number } = {}) {
  registerNetworkCatalog(net.catalog);
  const { profile } = net;
  const chain = createUniswapLiquidityChain({ profile, tick: net.tick, usdc: 10n ** BigInt(profile.token0.decimals + 6), weth: 10n ** BigInt(profile.token1.decimals + 6),
    ...net.stocks ? { stocks: net.stocks } : {} });
  const dir = await mkdtemp(join(tmpdir(), 'flofi-pm-net-'));
  const service = createUniswapLiquidityService({ storage: createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY'), rpc: async () => { throw new Error('NO_OTHER_CHAIN_CLIENT'); },
    rpcs: { [profile.chain]: chain.rpc }, provenance: 'MOCKED', now: chain.clock, mockedCodePins: UNI_MOCK_CODE_PINS,
    ...options.confirmations ? { confirmations: options.confirmations } : {},
    catalog: { chain: profile.chain, catalogFor: async () => net.catalog, codePins: chain.catalogPins } });
  const spacing = profile.tickSpacing, lower = Math.floor((net.tick - 40 * spacing) / spacing) * spacing, upper = Math.ceil((net.tick + 40 * spacing) / spacing) * spacing;
  return { chain, service, lower, upper };
}
/** The workflow Chat or Canvas authors for a choice on a verified position: MANAGE_LIQUIDITY_POSITION through the editor and its validation. */
function authored(net: Net, tokenId: string, lower: number, upper: number, liquidity: bigint, operation: LiquidityPositionChoice['operation'],
  partBps: number | null, close: boolean): SemanticWorkflow {
  const { profile } = net;
  const principal = uniswapAmountsForLiquidity(sqrtRatioAtTick(net.tick), lower, upper, liquidity);
  const choice: LiquidityPositionChoice = { position: { protocol: 'UNISWAP_V3', chain: profile.chain, network: net.name, manager: profile.positionManager, pool: profile.pool,
    positionId: tokenId, owner: UNI_OWNER }, operation, partBps, close };
  const t = (side: UniswapPoolProfile['token0']) => ({ symbol: side.symbol, address: side.address, decimals: side.decimals });
  const result = editorReducer(initialEditor(), { type: 'MANAGE_LIQUIDITY_POSITION', choice, pool: { token0: t(profile.token0), token1: t(profile.token1),
    feeTier: profile.feeTier, tickLower: lower, tickUpper: upper, amount0: principal.amount0.toString(), amount1: principal.amount1.toString(), slippageBps: 100 },
    source: 'CHAT', baseRevision: 0 }, createBaseSepoliaReviewContext());
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
}
async function execute(service: UniswapLiquidityService, chain: UniswapLiquidityChain, id: string, w: SemanticWorkflow) {
  const run = await service.positionStatus(id);
  await service.positionReview(id, run.review.commitment, w);
  const begun = await service.positionBegin(id, UNI_OWNER, w);
  await service.positionHandoff(id);
  await service.positionReport(id, { kind: 'HASH', hash: chain.wallet.send(begun.transaction) });
  return service.positionObserve(id);
}

describe('BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 position management on every catalog mainnet runtime (MOCKED)', () => {
  it('Arbitrum One: a 25% withdrawal under the Nitro fee policy (posting gas inside the reviewed limit, no OP Stack L1 fee)', async () => {
    const net: Net = { name: 'Arbitrum One', catalog: ARBITRUM, tick: -225_600, profile: catalogPoolOn(ARBITRUM_ONE.chain, token(of(ARBITRUM, 'USDC')), token(of(ARBITRUM, 'WETH')), 500) };
    const { chain, service, lower, upper } = await setup(net);
    const tokenId = chain.seedPosition({ tickLower: lower, tickUpper: upper, liquidity: 4_000_000_000_000n });
    const w = authored(net, tokenId, lower, upper, 4_000_000_000_000n, 'DECREASE', 2_500, false);
    const run = await service.positionSimulate(w, UNI_OWNER, { operation: 'DECREASE', tokenId, partBps: 2_500, close: false });
    expect(run.id).toMatch(/^arlp-[a-f0-9]{32}$/);
    expect(run.review).toMatchObject({ chainId: 42161, network: 'Arbitrum One', liquidityToRemove: '1000000000000', fees: { l1FeeUpperBoundWei: '0' } });
    expect(BigInt(run.review.calls[0].gasLimit)).toBeGreaterThan(BigInt(run.review.calls[0].gasUsed));
    const done = await execute(service, chain, run.id, w);
    expect(done).toMatchObject({ verdict: 'RECONCILED', result: { liquidityRemoved: '1000000000000', liquidityAfter: '3000000000000', burned: false } });
    expect(done.evidence!.transaction.explorer.startsWith('https://arbiscan.io/')).toBe(true);
  });

  it('Ethereum: collects fees only at the L1 confirmation depth, never at inclusion', async () => {
    const net: Net = { name: 'Ethereum', catalog: ETHEREUM, tick: -195_000, profile: catalogPoolOn('eip155:1', token(of(ETHEREUM, 'USDC')), token(of(ETHEREUM, 'WETH')), 3000) };
    const { chain, service, lower, upper } = await setup(net, { confirmations: 3 });
    const tokenId = chain.seedPosition({ tickLower: lower, tickUpper: upper, liquidity: 9_000_000_000_000n });
    chain.accrueFees(tokenId, 4_321n, 8_765n);
    const w = authored(net, tokenId, lower, upper, 9_000_000_000_000n, 'COLLECT', null, false);
    const run = await service.positionSimulate(w, UNI_OWNER, { operation: 'COLLECT', tokenId, partBps: null, close: false });
    expect(run.id).toMatch(/^etlp-[a-f0-9]{32}$/);
    expect(run.review).toMatchObject({ chainId: 1, expected: { collect0: '4321', collect1: '8765' }, fees: { l1FeeUpperBoundWei: '0' } });
    const pending = await execute(service, chain, run.id, w);
    expect(pending).toMatchObject({ verdict: 'PENDING', error: 'UNISWAP_AWAITING_CONFIRMATIONS', result: null });
    chain.advance(6);
    expect(await service.positionObserve(run.id)).toMatchObject({ verdict: 'RECONCILED', result: { collected0: '4321', collected1: '8765', liquidityAfter: '9000000000000' } });
  });

  it('Robinhood Chain: exits and closes a Stock Token position, with the Stock Token identity bound into Review', async () => {
    const USDG = robinhoodAsset(ROBINHOOD, 'USDG'), TSLA = robinhoodAsset(ROBINHOOD, 'TSLA');
    const net: Net = { name: 'Robinhood Chain', catalog: ROBINHOOD, tick: -216_420, profile: robinhoodLiquidityPool(token(USDG), token(TSLA), 3000),
      stocks: { [TSLA.address!]: { uid: TSLA.stock!.officialId, multiplierWad: BigInt(TSLA.stock!.multiplierWad) } } };
    const { chain, service, lower, upper } = await setup(net);
    const tokenId = chain.seedPosition({ tickLower: lower, tickUpper: upper, liquidity: 50_000_000_000_000n });
    const w = authored(net, tokenId, lower, upper, 50_000_000_000_000n, 'EXIT', null, true);
    const run = await service.positionSimulate(w, UNI_OWNER, { operation: 'EXIT', tokenId, partBps: null, close: true });
    expect(run.id).toMatch(/^rhlp-[a-f0-9]{32}$/);
    expect(run.review.stocks?.map(stock => stock.officialId)).toEqual([TSLA.stock!.officialId]);
    expect(run.review.innerCalls).toEqual(['DECREASE_LIQUIDITY', 'COLLECT', 'BURN']);
    const done = await execute(service, chain, run.id, w);
    expect(done).toMatchObject({ verdict: 'RECONCILED', result: { burned: true, liquidityAfter: null } });
    expect(chain.snapshot.owners[tokenId]).toBeUndefined();
  });

  it('refuses a choice whose position is not on the verified pool of its own network', () => {
    const net: Net = { name: 'Arbitrum One', catalog: ARBITRUM, tick: -225_600, profile: catalogPoolOn(ARBITRUM_ONE.chain, token(of(ARBITRUM, 'USDC')), token(of(ARBITRUM, 'WETH')), 500) };
    registerNetworkCatalog(ARBITRUM);
    const ref = { protocol: 'UNISWAP_V3' as const, chain: ARBITRUM_ONE.chain, network: 'Arbitrum One', manager: net.profile.positionManager, pool: '0x' + '9'.repeat(40),
      positionId: '7', owner: UNI_OWNER };
    const t = (side: UniswapPoolProfile['token0']) => ({ symbol: side.symbol, address: side.address, decimals: side.decimals });
    const result = editorReducer(initialEditor(), { type: 'MANAGE_LIQUIDITY_POSITION', choice: { position: ref, operation: 'EXIT', partBps: null, close: false },
      pool: { token0: t(net.profile.token0), token1: t(net.profile.token1), feeTier: 500, tickLower: -226_000, tickUpper: -225_000, amount0: '1', amount1: '1', slippageBps: 100 },
      source: 'CHAT', baseRevision: 0 }, createBaseSepoliaReviewContext());
    expect(result.error).toBe('UNISWAP_POSITION_POOL_MISMATCH');
  });
});
