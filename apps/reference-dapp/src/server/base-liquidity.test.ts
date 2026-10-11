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
import { catalogLiquidityCopy, liquidityRunNetwork, parseBaseLiquidityChat } from '../domain/robinhood-liquidity-authoring';
import { parseLocalCommand } from '../domain/commands';
import { canvasAmountCommand } from '../domain/canvas-action-setup';
import { defaultPoolRange, selectCryptoNetwork } from '../domain/crypto-action-picker';
import { editorHistoryReducer, initialEditorHistory } from '../domain/editor-history';
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
  // A Base pool used to start at Base Sepolia's 0.05% ticks (±887270), which the default 0.3% tier (spacing 60) cannot use: Review failed and
  // the toolbox card never applied (canvas-ux browser profile). Every catalog network now starts at its default tier's full range.
  it('starts a new Pool card on Base at the default tier\'s full range, so the toolbox flow reviews and applies', () => {
    for (const [network, tick] of [['Base', '887220'], ['Robinhood Chain', '887220'], ['Base Sepolia', '887270'], ['Ethereum Sepolia', '887220'], ['Solana Devnet', '443584']] as const)
      expect(defaultPoolRange(network), network).toEqual({ rangeUnit: 'TICK', lower: `-${tick}`, upper: tick });
    let history = editorHistoryReducer(initialEditorHistory(), { type: 'START_ACTION_SETUP', action: 'pool', position: { x: 10, y: 20 } });
    const id = history.actionSetup!.id;
    history = editorHistoryReducer(history, { type: 'EDIT_CRYPTO_SELECTION', id, selection: selectCryptoNetwork('pool', 'Base'), context });
    expect(history.actionSetup).toMatchObject({ cryptoSelection: { network: 'Base' }, input: { rangeUnit: 'TICK', lower: '-887220', upper: '887220' } });
    const setup = history.actionSetup as Extract<NonNullable<typeof history.actionSetup>, { action: 'pool' }>;
    history = editorHistoryReducer(history, { type: 'EDIT_POOL_SETUP', id, input: { ...setup.input, maxUsdc: '0.0001', maxWeth: '1' } });
    const command = canvasAmountCommand(history.editor, history.actionSetup, history.amountInputs, id, context, {}, history.cryptoSelections);
    const next = editorReducer(history.editor, command, context);
    expect(next.error).toBeNull();
    const node = next.workflow.nodes.at(-1)!;
    expect(node).toMatchObject({ actionType: 'asset.liquidity.concentrated', chainId: 'eip155:8453' });
    // The default 0.3% tier at its full range (tick spacing 60).
    const fields = readConcentratedLiquidity(node as Parameters<typeof readConcentratedLiquidity>[0]);
    expect([fields.feeTier, fields.tickLower, fields.tickUpper]).toEqual([3000, -887_220, 887_220]);
  });
  it('presents a Base position as real funds on Base, never as a testnet profile', () => {
    expect(liquidityRunNetwork('eip155:8453')).toMatchObject({ network: 'Base', realFunds: true, robinhood: false, evidenceSlug: 'base-mainnet',
      profile: { chainHex: '0x2105', explorer: 'https://basescan.org/' } });
    expect(liquidityRunNetwork(8453)).toMatchObject({ network: 'Base', realFunds: true });
    // Robinhood Chain and the testnet profiles keep their presentation; nothing authored is still Base Sepolia, as before.
    expect(liquidityRunNetwork('eip155:4663')).toMatchObject({ network: 'Robinhood Chain', realFunds: true, robinhood: true, evidenceSlug: 'robinhood-chain' });
    expect(liquidityRunNetwork('eip155:84532')).toMatchObject({ network: 'Base Sepolia', realFunds: false, evidenceSlug: 'base-sepolia' });
    expect(liquidityRunNetwork('eip155:11155111')).toMatchObject({ network: 'Ethereum Sepolia', realFunds: false });
    expect(liquidityRunNetwork(undefined)).toMatchObject({ network: 'Base Sepolia', realFunds: false });
    // The catalog copy names the position's own network; Robinhood Chain's and the testnets' text is unchanged.
    const text = 'This pair has no live Uniswap v3 pool at this fee tier on Robinhood Chain. Choose another fee tier; nothing was signed.';
    expect(catalogLiquidityCopy(text, 'Base')).toBe('This pair has no live Uniswap v3 pool at this fee tier on Base. Choose another fee tier; nothing was signed.');
    expect(catalogLiquidityCopy('Robinhood Chain liquidity is not enabled on this server.', 'Base')).toBe('Base liquidity is not enabled on this server.');
    for (const network of ['Robinhood Chain', 'Base Sepolia']) expect(catalogLiquidityCopy(text, network)).toBe(text);
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
