// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: Robinhood Chain concentrated liquidity on official catalog pairs (USDG / Stock Token) through the shared Uniswap v3
 * liquidity service, on a MOCKED in-process chain with the official registry capture: no network, no key, no send path but the
 * scripted owner wallet. Evidence is MOCKED, never MAINNET_EXECUTED.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext, validateUniswapLiquidityNode } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { decodeUniswapMint } from '@defi-workflow-engine/reference-compiler';
import { readConcentratedLiquidity, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { robinhoodLiquidityPool, UNISWAP_V3_ROBINHOOD, type AssetCatalog, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { editorReducer, initialEditor } from '../domain/editor';
import { registerNetworkCatalog, resetNetworkCatalogs, ROBINHOOD_NETWORK } from '../domain/asset-catalogs';
import { createRobinhoodLiquidityNode, parseRobinhoodLiquidityChat, robinhoodLiquidityDetails, type RobinhoodLiquidityInput } from '../domain/robinhood-liquidity-authoring';
import { cryptoInputOf, cryptoSelectionOf } from '../domain/crypto-action-picker';
import { workflowSteps } from '../domain/workflow-steps';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER, type UniswapLiquidityChain } from '../../e2e/uniswap-liquidity-harness';
import { asset, officialCatalog } from './robinhood-mainnet.test-harness';
import { createUniswapLiquidityService, validateUniswapLiquidityLog, type UniswapBegin } from './uniswap-liquidity-service';
import type { Rpc } from './public-testnet-service';

const context = createBaseSepoliaReviewContext();
const catalog = officialCatalog();
const USDG = asset(catalog, 'USDG'), TSLA = asset(catalog, 'TSLA'), PLTR = asset(catalog, 'PLTR');
/** TSLA ≈ 400 USDG: token0 is TSLA (lower address, 18 decimals), token1 USDG (6), so the raw token1/token0 price is ≈ 4e-10. */
const TICK = -216_420;
const pool = (a: CanonicalAsset, b: CanonicalAsset, fee = 3000) => robinhoodLiquidityPool(a as { symbol: string; address: string; decimals: number },
  b as { symbol: string; address: string; decimals: number }, fee);
const input = (patch: Partial<RobinhoodLiquidityInput> = {}): RobinhoodLiquidityInput => ({ network: ROBINHOOD_NETWORK, tokenA: 'USDG', tokenB: 'TSLA',
  amountA: '100', amountB: '0.4', fee: 3000, rangeUnit: 'FULL', slippage: '100', ...patch });
function workflow(patch: Partial<RobinhoodLiquidityInput> = {}): SemanticWorkflow {
  const i = input(patch);
  const result = editorReducer(initialEditor(), { type: 'ADD_CRYPTO_ACTION', source: 'CANVAS', baseRevision: 0, input: { selection: { action: 'pool', network: ROBINHOOD_NETWORK,
    from: i.tokenA, to: i.tokenB }, amount: i.amountA, secondAmount: i.amountB, slippage: i.slippage, fee: i.fee } }, context);
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
}
type Setup = { chain: UniswapLiquidityChain; dir: string; service: ReturnType<typeof createUniswapLiquidityService> };
async function setup(options: { stock?: CanonicalAsset; catalogFor?: (chain: string) => Promise<AssetCatalog>; fee?: number; pins?: boolean; dir?: string } = {}): Promise<Setup> {
  const stock = options.stock ?? TSLA, profile = pool(USDG, stock, options.fee ?? 3000);
  const stockIs0 = profile.token0.address === stock.address;
  const chain = createUniswapLiquidityChain({ profile, tick: TICK, usdc: stockIs0 ? 10n ** 18n : 1_000_000_000n, weth: stockIs0 ? 1_000_000_000n : 10n ** 18n,
    stocks: { [stock.address!]: { uid: stock.stock!.officialId, multiplierWad: BigInt(stock.stock!.multiplierWad) } } });
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'flofi-rh-lp-'));
  const base: Rpc = async () => { throw new Error('BASE_CLIENT_MUST_NOT_BE_USED'); };
  const service = createUniswapLiquidityService({ storage: createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY'), rpc: base, rpcs: { 'eip155:4663': chain.rpc },
    provenance: 'MOCKED', now: chain.clock, ...options.pins === false ? {} : { mockedCodePins: UNI_MOCK_CODE_PINS },
    catalog: { catalogFor: options.catalogFor ?? (async () => catalog), ...options.pins === false ? {} : { codePins: chain.catalogPins } } });
  return { chain, dir, service };
}
async function reviewed(s: Setup['service'], w: SemanticWorkflow) {
  const simulated = await s.simulate(w, UNI_OWNER);
  return s.review(simulated.id, simulated.review.commitment, w);
}
async function execute(s: Setup['service'], chain: UniswapLiquidityChain, id: string, w: SemanticWorkflow) {
  const begun: UniswapBegin = await s.begin(id, UNI_OWNER, w);
  await s.handoff(id);
  const hash = chain.wallet.send(begun.transaction);
  await s.report(id, { kind: 'HASH', hash });
  return { begun, hash };
}

beforeAll(() => registerNetworkCatalog(catalog));
afterAll(() => resetNetworkCatalogs());

describe('BUILD-RH-002 Robinhood Chain liquidity authoring', () => {
  it('authors any catalog pair at a standard fee tier: pool order, the CREATE2 pool, the tier full range, Chat = Canvas', () => {
    const node = workflow().nodes.find(n => n.actionType === 'asset.liquidity.concentrated')!, f = readConcentratedLiquidity(node), P = pool(USDG, TSLA);
    expect(node.chainId).toBe('eip155:4663');
    expect([f.token0.address, f.token1.address]).toEqual([TSLA.address, USDG.address]);
    expect([f.amount0Max, f.amount1Max, f.feeTier, f.tickLower, f.tickUpper]).toEqual(['400000000000000000', '100000000', 3000, -887_220, 887_220]);
    expect(f.positionAsset).toEqual({ chainId: 'eip155:4663', address: UNISWAP_V3_ROBINHOOD.positionManager, decimals: 0 });
    expect(robinhoodLiquidityDetails(node)).toMatchObject({ tokenA: 'USDG', tokenB: 'TSLA', amountA: '100', amountB: '0.4', fee: 3000, fullRange: true, pool: P.pool });
    expect(cryptoSelectionOf(node as never)).toEqual({ action: 'pool', network: ROBINHOOD_NETWORK, from: 'USDG', to: 'TSLA' });
    expect(cryptoInputOf(node as never)).toMatchObject({ amount: '100', secondAmount: '0.4', fee: 3000 });
    const chat = parseRobinhoodLiquidityChat('Add liquidity 100 USDG and 0.4 TSLA on Robinhood fee 0.3%');
    expect(chat).toEqual(input());
    expect(createRobinhoodLiquidityNode(node.nodeId, chat!)).toEqual(node);
    expect(workflowSteps(workflow() as never, context).find(s => s.kind === 'LIQUIDITY')).toMatchObject({ network: 'Robinhood Chain', testFunds: false,
      detail: { type: 'CATALOG_LIQUIDITY', fullRange: true } });
  });
  it('a non-featured Stock Token (PLTR) authors the same IR shape; tiers, ranges, identical or unknown tokens and pool order fail closed', () => {
    const pltr = createRobinhoodLiquidityNode('node-002', input({ tokenB: 'PLTR', amountB: '1' }));
    expect(robinhoodLiquidityDetails(pltr)).toMatchObject({ tokenA: 'USDG', tokenB: 'PLTR', pool: pool(USDG, PLTR).pool });
    expect(() => createRobinhoodLiquidityNode('n', input({ fee: 2500 }))).toThrow('UNISWAP_FEE_TIER_UNSUPPORTED');
    expect(() => createRobinhoodLiquidityNode('n', input({ tokenB: 'USDG' }))).toThrow('INVALID_ASSET_PAIR');
    expect(() => createRobinhoodLiquidityNode('n', input({ tokenB: 'NOTREAL' }))).toThrow('ASSET_CATALOG_UNAVAILABLE');
    expect(() => createRobinhoodLiquidityNode('n', input({ tokenA: 'ETH' }))).toThrow('UNISWAP_TOKEN_UNSUPPORTED');
    expect(() => createRobinhoodLiquidityNode('n', input({ rangeUnit: 'TICK', lower: '-600', upper: '610' }))).toThrow('UNISWAP_LIQUIDITY_RANGE_INVALID');
    expect(() => createRobinhoodLiquidityNode('n', input({ slippage: '301' }))).toThrow('UNISWAP_SLIPPAGE_OUT_OF_RANGE');
    expect(createRobinhoodLiquidityNode('n', input({ fee: 10000, rangeUnit: 'TICK', lower: '-2000', upper: '2000' })).chainId).toBe('eip155:4663');
    const node = createRobinhoodLiquidityNode('node-002', input());
    const swapped = JSON.parse(JSON.stringify(node).replaceAll(TSLA.address!, 'X').replaceAll(USDG.address!, TSLA.address!).replaceAll('X', USDG.address!)) as typeof node;
    expect(() => validateUniswapLiquidityNode(swapped)).toThrow();
    const tier = JSON.parse(JSON.stringify(node).replace('"value":3000', '"value":2500')) as typeof node;
    expect(() => validateUniswapLiquidityNode(tier)).toThrow('UNISWAP_FEE_TIER_UNSUPPORTED');
  });
});

describe('BUILD-RH-002 Robinhood Chain liquidity service (MOCKED)', () => {
  it('binds chain 4663, the CREATE2 pool, both official identities and the Stock Token multiplier into Review; no L1 data fee', async () => {
    const { service } = await setup(), P = pool(USDG, TSLA);
    const run = await service.simulate(workflow(), UNI_OWNER), r = run.review;
    expect(run.id).toMatch(/^rhlp-[a-f0-9]{32}$/);
    expect(r).toMatchObject({ chainId: 4663, network: 'Robinhood Chain', contracts: { pool: P.pool, positionManager: UNISWAP_V3_ROBINHOOD.positionManager },
      token0: { symbol: 'TSLA', address: TSLA.address, officialId: TSLA.stock!.officialId }, token1: { symbol: 'USDG', address: USDG.address, officialId: null },
      pool: { fee: 3000, tickSpacing: 60 }, range: { tickLower: -887_220, tickUpper: 887_220, state: 'IN_RANGE' } });
    expect(r.stocks).toEqual([expect.objectContaining({ side: 'token0', symbol: 'TSLA', officialId: TSLA.stock!.officialId, multiplierWad: TSLA.stock!.multiplierWad })]);
    expect(r.range.description).toContain('holds TSLA and USDG');
    expect(r.calls.map(c => c.step)).toEqual(['APPROVE_TOKEN0', 'APPROVE_TOKEN1', 'MINT']);
    expect(decodeUniswapMint(r.calls[2]!.data)).toMatchObject({ token0: TSLA.address, token1: USDG.address, fee: 3000, recipient: UNI_OWNER });
    expect([r.fees.l1FeeUpperBoundWei, r.fees.totalUpperBoundWei]).toEqual(['0', r.fees.executionFeeUpperBoundWei]);
  });
  it('approves, mints and reconciles on 0x1237 (Nitro receipts, no l1Fee); evidence is MOCKED and the Base client is never used', async () => {
    const { service, chain } = await setup(), w = workflow();
    const run = await reviewed(service, w);
    for (const [index, to] of [[0, TSLA.address], [1, USDG.address], [2, UNISWAP_V3_ROBINHOOD.positionManager]] as const) {
      const { begun } = await execute(service, chain, run.id, w);
      expect([index, begun.transaction.chainId, begun.transaction.to, begun.transaction.value]).toEqual([index, '0x1237', to, '0x0']);
      await service.observe(run.id);
    }
    const record = await service.load(run.id);
    expect(record.verdict).toBe('RECONCILED');
    expect(record.attempts.map(a => [a.step, a.state, a.receipt?.l1FeeWei])).toEqual([['APPROVE_TOKEN0', 'CONFIRMED', '0'], ['APPROVE_TOKEN1', 'CONFIRMED', '0'], ['MINT', 'CONFIRMED', '0']]);
    expect(record.evidence).toMatchObject({ evidenceClass: 'MOCKED', chainId: 4663, token0: { symbol: 'TSLA' }, token1: { symbol: 'USDG' },
      bundle: { environment: 'MOCKED', outcome: 'RECONCILED' } });
    expect(record.evidence!.transactions.every(t => t.explorer.startsWith('https://robinhoodchain.blockscout.com/tx/'))).toBe(true);
    expect(chain.counters.sends).toBe(3);
  });
  it('a non-featured Stock Token (PLTR) runs through the same service', async () => {
    const { service } = await setup({ stock: PLTR });
    const run = await service.simulate(workflow({ tokenB: 'PLTR', amountB: '1' }), UNI_OWNER);
    expect(run.review.stocks?.map(s => s.symbol)).toEqual(['PLTR']);
  });
  it('a multiplier change after Review clears the authorization before any wallet request; a scheduled change fails closed at Simulate', async () => {
    const w = workflow(), changed = BigInt(TSLA.stock!.multiplierWad) * 2n;
    const withMultiplier = (wad: bigint): AssetCatalog => ({ ...catalog, assets: catalog.assets.map(a => a.address === TSLA.address
      ? { ...a, stock: { ...a.stock!, multiplierWad: wad.toString() } } : a) });
    // The chain moves but the registry does not: they disagree, and the disagreement is never resolved by guessing.
    const a = await setup(), runA = await reviewed(a.service, w);
    a.chain.setStock(TSLA.address!, { multiplierWad: changed });
    await expect(a.service.begin(runA.id, UNI_OWNER, w)).rejects.toThrow('STOCK_MULTIPLIER_MISMATCH');
    expect(await a.service.load(runA.id)).toMatchObject({ authorization: null, error: 'STOCK_MULTIPLIER_MISMATCH' });
    // The issuer applies a corporate action and the registry follows: same identity, new economics — the Review no longer holds.
    let registry = catalog;
    const b = await setup({ catalogFor: async () => registry }), runB = await reviewed(b.service, w);
    b.chain.setStock(TSLA.address!, { multiplierWad: changed }); registry = withMultiplier(changed);
    await expect(b.service.begin(runB.id, UNI_OWNER, w)).rejects.toThrow('STOCK_MULTIPLIER_CHANGED_REVIEW_REQUIRED');
    expect(await b.service.load(runB.id)).toMatchObject({ authorization: null, error: 'STOCK_MULTIPLIER_CHANGED_REVIEW_REQUIRED' });
    // A fresh simulation and Review bind the new multiplier.
    const refreshed = await b.service.refresh(runB.id);
    expect(refreshed.review.stocks?.[0]?.multiplierWad).toBe(changed.toString());
    // A change scheduled to take effect inside the Review window fails closed before any Review exists.
    const c = await setup();
    c.chain.setStock(TSLA.address!, { scheduledWad: changed, effectiveAt: Math.floor(c.chain.clock().getTime() / 1000) + 30 });
    await expect(c.service.simulate(w, UNI_OWNER)).rejects.toThrow('STOCK_MULTIPLIER_CHANGE_PENDING');
    expect(a.chain.counters.sends + b.chain.counters.sends + c.chain.counters.sends).toBe(0);
  });
  it('fails closed: registry unavailable, an asset no longer in the registry, no pool at the fee tier, unverified deployments', async () => {
    const w = workflow();
    await expect((await setup({ catalogFor: async () => { throw new Error('STOCK_REGISTRY_UNAVAILABLE'); } })).service.simulate(w, UNI_OWNER)).rejects.toThrow('STOCK_REGISTRY_UNAVAILABLE');
    const without: AssetCatalog = { ...catalog, assets: catalog.assets.filter(a => a.address !== TSLA.address) };
    await expect((await setup({ catalogFor: async () => without })).service.simulate(w, UNI_OWNER)).rejects.toThrow('CATALOG_ASSET_IDENTITY_CHANGED');
    // The chain only has the 0.3% pool: the 0.05% pool of the same pair has no code.
    await expect((await setup()).service.simulate(workflow({ fee: 500 }), UNI_OWNER)).rejects.toThrow('UNISWAP_CONTRACT_CODE_MISSING');
    // Without the MOCKED pins the synthetic contracts are not the verified deployment.
    await expect((await setup({ pins: false })).service.simulate(w, UNI_OWNER)).rejects.toThrow('UNISWAP_UNEXPECTED_CONTRACT');
  });
  it('each service serves exactly its networks; provenance and logs never cross', async () => {
    const { service, dir, chain } = await setup();
    const baseWorkflow = editorReducer(initialEditor(), { type: 'ADD_UNISWAP_LIQUIDITY', source: 'CANVAS', baseRevision: 0, input: { network: 'Base Sepolia', maxUsdc: '10',
      maxWeth: '0.005', rangeUnit: 'TICK', lower: '-887270', upper: '887270', slippage: '100' } }, context).workflow as unknown as SemanticWorkflow;
    await expect(service.simulate(baseWorkflow, UNI_OWNER)).rejects.toThrow('UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED');
    const storage = createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY');
    const testnet = createUniswapLiquidityService({ storage, rpc: chain.rpc, provenance: 'MOCKED', mockedCodePins: UNI_MOCK_CODE_PINS, now: chain.clock });
    await expect(testnet.simulate(workflow(), UNI_OWNER)).rejects.toThrow('UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED');
    const run = await service.simulate(workflow(), UNI_OWNER);
    await expect(testnet.load(run.id)).rejects.toThrow('UNISWAP_LIQUIDITY_RUN_ID_INVALID');
    const bytes = await readFile(join(dir, run.id + '.jsonl'));
    expect(() => validateUniswapLiquidityLog(bytes)).not.toThrow();
    expect(() => validateUniswapLiquidityLog(Buffer.from(bytes.toString('utf8').replaceAll('"provenance":"MOCKED"', '"provenance":"PUBLIC_TESTNET"')))).toThrow('UNISWAP_LIQUIDITY_STORE_CORRUPT');
    expect(() => validateUniswapLiquidityLog(Buffer.from(bytes.toString('utf8').replaceAll(run.id, run.id.replace('rhlp-', 'unilp-'))))).toThrow('UNISWAP_LIQUIDITY_STORE_CORRUPT');
    const catalogRuntime = { catalogFor: async () => catalog };
    expect(() => createUniswapLiquidityService({ storage, rpc: chain.rpc, provenance: 'PUBLIC_TESTNET', catalog: catalogRuntime })).toThrow('UNISWAP_PROVENANCE_INVALID');
    expect(() => createUniswapLiquidityService({ storage, rpc: chain.rpc, provenance: 'PUBLIC_MAINNET' })).toThrow('UNISWAP_PROVENANCE_INVALID');
    expect(() => createUniswapLiquidityService({ storage, rpc: chain.rpc, provenance: 'PUBLIC_MAINNET', catalog: { ...catalogRuntime, codePins: chain.catalogPins } }))
      .toThrow('UNISWAP_CODE_PINS_MOCKED_ONLY');
    expect(chain.counters.sends).toBe(0);
  });
});
