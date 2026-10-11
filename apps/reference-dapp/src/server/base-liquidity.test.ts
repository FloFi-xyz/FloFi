// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: Base mainnet concentrated liquidity on catalog pairs through the shared Uniswap v3 liquidity service (`balp-` runs), on a
 * MOCKED in-process chain with FloFi's Base token-list fixture: no network, no key, no send path but the scripted owner wallet. The OP Stack
 * L1 data fee is bounded at Review and read from each receipt. Evidence is MOCKED, never MAINNET_EXECUTED.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { decodeUniswapMint } from '@defi-workflow-engine/reference-compiler';
import { readConcentratedLiquidity, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { catalogPoolOn, UNISWAP_V3_BASE, type AssetCatalog, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { editorReducer, initialEditor } from '../domain/editor';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import { parseBaseLiquidityChat } from '../domain/robinhood-liquidity-authoring';
import { parseLocalCommand } from '../domain/commands';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER, type UniswapLiquidityChain } from '../../e2e/uniswap-liquidity-harness';
import { baseAsset, baseCatalog } from './base-mainnet.test-harness';
import { createUniswapLiquidityService, type UniswapBegin } from './uniswap-liquidity-service';
import type { Rpc } from './public-testnet-service';

const context = createBaseSepoliaReviewContext();
const catalog = baseCatalog();
const USDC = baseAsset(catalog, 'USDC'), CBBTC = baseAsset(catalog, 'cbBTC');
const token = (asset: CanonicalAsset) => asset as { symbol: string; address: string; decimals: number };
const workflow = (fee = 500): SemanticWorkflow => {
  const result = editorReducer(initialEditor(), { type: 'ADD_CRYPTO_ACTION', source: 'CANVAS', baseRevision: 0, input: { selection: { action: 'pool', network: 'Base',
    from: 'USDC', to: 'cbBTC' }, amount: '100', secondAmount: '0.001', slippage: '100', fee } }, context);
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
};
type Setup = { chain: UniswapLiquidityChain; service: ReturnType<typeof createUniswapLiquidityService> };
async function setup(options: { catalogFor?: (chain: string) => Promise<AssetCatalog>; executionEnabled?: boolean } = {}): Promise<Setup> {
  const profile = catalogPoolOn('eip155:8453', token(USDC), token(CBBTC), 500);
  const usdcIs0 = profile.token0.address === USDC.address;
  // cbBTC ≈ 100,000 USDC: the raw token1/token0 price decides the tick.
  const chain = createUniswapLiquidityChain({ profile, tick: usdcIs0 ? -69_082 : 69_082, usdc: usdcIs0 ? 1_000_000_000n : 10_000_000n, weth: usdcIs0 ? 10_000_000n : 1_000_000_000n });
  const dir = await mkdtemp(join(tmpdir(), 'flofi-base-lp-'));
  const sepolia: Rpc = async () => { throw new Error('BASE_SEPOLIA_CLIENT_MUST_NOT_BE_USED'); };
  const service = createUniswapLiquidityService({ storage: createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY'), rpc: sepolia, rpcs: { 'eip155:8453': chain.rpc },
    provenance: 'MOCKED', now: chain.clock, mockedCodePins: UNI_MOCK_CODE_PINS, executionEnabled: options.executionEnabled ?? true,
    catalog: { chain: 'eip155:8453', catalogFor: options.catalogFor ?? (async () => catalog), codePins: chain.catalogPins } });
  return { chain, service };
}
beforeAll(() => registerNetworkCatalog(catalog));
afterAll(() => resetNetworkCatalogs());

describe('BUILD-BASE-001 Base liquidity authoring', () => {
  it('authors any two Base catalog tokens at a standard tier in pool order, and Chat = Canvas', () => {
    const node = workflow().nodes.find(n => n.actionType === 'asset.liquidity.concentrated')!, f = readConcentratedLiquidity(node);
    const P = catalogPoolOn('eip155:8453', token(USDC), token(CBBTC), 500);
    expect(node.chainId).toBe('eip155:8453');
    expect([f.token0.address, f.token1.address]).toEqual([P.token0.address, P.token1.address]);
    expect([f.feeTier, f.tickLower, f.tickUpper]).toEqual([500, -887_270, 887_270]);
    expect(parseBaseLiquidityChat('Add liquidity 100 USDC and 0.001 cbbtc on Base fee 0.05%')).toMatchObject({ network: 'Base', tokenB: 'cbBTC', fee: 500, rangeUnit: 'FULL' });
    const chat = parseLocalCommand('add liquidity 100 USDC and 0.001 cbBTC on Base fee 0.05% slippage 100 bps', initialEditor().workflow, context, null);
    const viaChat = editorReducer(initialEditor(), chat, context).workflow.nodes.at(-1);
    expect(JSON.stringify(viaChat)).toBe(JSON.stringify(node));
  });
});

describe('BUILD-BASE-001 Base liquidity service (MOCKED)', () => {
  it('binds chain 8453, the CREATE2 pool and both catalog identities into Review, with an L1 data fee bound', async () => {
    const { service } = await setup();
    const run = await service.simulate(workflow(), UNI_OWNER), r = run.review;
    expect(run.id).toMatch(/^balp-[a-f0-9]{32}$/);
    expect(r).toMatchObject({ chainId: 8453, network: 'Base', contracts: { positionManager: UNISWAP_V3_BASE.positionManager }, pool: { fee: 500, tickSpacing: 10 } });
    expect(r.stocks ?? []).toEqual([]);
    expect(r.calls.map(c => c.step)).toEqual(['APPROVE_TOKEN0', 'APPROVE_TOKEN1', 'MINT']);
    expect(decodeUniswapMint(r.calls[2]!.data)).toMatchObject({ fee: 500, recipient: UNI_OWNER });
    expect(BigInt(r.fees.l1FeeUpperBoundWei ?? '0')).toBeGreaterThan(0n);
  });
  it("approves, mints and reconciles on 0x2105 with each receipt's l1Fee; evidence is MOCKED", async () => {
    const { service, chain } = await setup(), w = workflow();
    const simulated = await service.simulate(w, UNI_OWNER), run = await service.review(simulated.id, simulated.review.commitment, w);
    for (let index = 0; index < 3; index++) {
      const begun: UniswapBegin = await service.begin(run.id, UNI_OWNER, w);
      expect(begun.transaction.chainId).toBe('0x2105');
      await service.handoff(run.id);
      await service.report(run.id, { kind: 'HASH', hash: chain.wallet.send(begun.transaction) });
      await service.observe(run.id);
    }
    const record = await service.load(run.id);
    expect(record.verdict).toBe('RECONCILED');
    expect(record.attempts.every(a => BigInt(a.receipt?.l1FeeWei ?? '0') > 0n)).toBe(true);
    expect(record.evidence).toMatchObject({ evidenceClass: 'MOCKED', chainId: 8453, bundle: { environment: 'MOCKED', outcome: 'RECONCILED' } });
    expect(record.evidence!.transactions.every(t => t.explorer.startsWith('https://basescan.org/'))).toBe(true);
  });
  it('fails closed: token list unavailable, a token no longer listed, no pool at the tier, owner execution not enabled', async () => {
    const w = workflow();
    await expect((await setup({ catalogFor: async () => { throw new Error('BASE_TOKEN_LIST_UNAVAILABLE'); } })).service.simulate(w, UNI_OWNER)).rejects.toThrow('BASE_TOKEN_LIST_UNAVAILABLE');
    const without: AssetCatalog = { ...catalog, assets: catalog.assets.filter(a => a.address !== CBBTC.address) };
    await expect((await setup({ catalogFor: async () => without })).service.simulate(w, UNI_OWNER)).rejects.toThrow('CATALOG_ASSET_IDENTITY_CHANGED');
    await expect((await setup()).service.simulate(workflow(3000), UNI_OWNER)).rejects.toThrow('UNISWAP_CONTRACT_CODE_MISSING');
    const off = await setup({ executionEnabled: false }), simulated = await off.service.simulate(w, UNI_OWNER);
    await off.service.review(simulated.id, simulated.review.commitment, w);
    await expect(off.service.begin(simulated.id, UNI_OWNER, w)).rejects.toThrow('UNISWAP_EXECUTION_NOT_ENABLED');
  });
  it('a Robinhood Chain service never serves a Base position', async () => {
    const { chain } = await setup(), dir = await mkdtemp(join(tmpdir(), 'flofi-base-lp-'));
    const robinhood = createUniswapLiquidityService({ storage: createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY'), rpc: chain.rpc, provenance: 'MOCKED',
      mockedCodePins: UNI_MOCK_CODE_PINS, now: chain.clock, catalog: { catalogFor: async () => catalog } });
    await expect(robinhood.simulate(workflow(), UNI_OWNER)).rejects.toThrow('UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED');
    expect(chain.counters.sends).toBe(0);
  });
});
