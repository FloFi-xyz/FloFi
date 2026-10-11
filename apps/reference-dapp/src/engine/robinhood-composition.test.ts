// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: Robinhood Chain in the MCP strategy contract. A multichain step list (bridge USDC from Base into Robinhood as USDG, buy a
 * Stock Token, transfer another) composes to the same canonical IR per step as the FloFi chat, with stable hashes, honest real-funds
 * facts and the shared visual; Stock Token symbols resolve only in the validated official registry. Nothing quotes, signs or sends.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseLocalCommand } from '../domain/commands';
import { editorReducer, initialEditor } from '../domain/editor';
import { networkCatalog, registerNetworkCatalog, resetNetworkCatalogs, ROBINHOOD_CHAIN } from '../domain/asset-catalogs';
import { previewPlan } from '../mcp/simulation';
import { workflowPlan } from '../mcp/execution';
import { prepareStrategyCatalogs, strategyNamesRobinhood } from '../platform/catalogs';
import { workflowVisualModel } from '../platform/workflow-visual';
import { baseCatalog } from '../server/base-mainnet.test-harness';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';
import { composeStrategy, composeWorkflow, dappReviewContext, reviewComposition, semanticWorkflowHash } from './strategy-engine';

const BRIDGE_IN = { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'robinhood', asset: 'USDC', amount: '100' } as const;
const BUY_TSLA = { action: 'swap', network: 'robinhood', inputAsset: 'USDG', outputAsset: 'TSLA', amount: '50' } as const;
const SEND_AAPL = { action: 'transfer', network: 'robinhood', asset: 'AAPL', amount: '3' } as const;
const chat = (sentence: string) => {
  const state = initialEditor(), context = dappReviewContext();
  const after = editorReducer(state, parseLocalCommand(sentence, state.workflow, context, null), context);
  if (after.error) throw new Error(after.error);
  return after.workflow;
};
const ok = <T extends { ok: boolean }>(value: T) => { if (!value.ok) throw new Error((value as unknown as { code: string }).code); return value as Extract<T, { ok: true }>; };
afterEach(() => resetNetworkCatalogs());

describe('BUILD-RH-002 Robinhood Chain strategies', () => {
  it('composes bridge in → buy TSLA → transfer AAPL as three isolated steps, each byte-identical to the chat IR, with stable hashes', () => {
    registerNetworkCatalog(officialCatalog());
    const w = ok(composeWorkflow({ version: 2, steps: [BRIDGE_IN, BUY_TSLA, SEND_AAPL] }));
    expect(w.steps.map(s => s.strategy.action)).toEqual(['bridge', 'swap', 'transfer']);
    expect(w.fundsClass).toBe('REAL_FUNDS');
    expect(JSON.stringify(w.steps[0]!.workflow)).toBe(JSON.stringify(chat('bridge 100 USDC from Base to Robinhood via auto slippage 50 bps')));
    expect(JSON.stringify(w.steps[1]!.workflow)).toBe(JSON.stringify(chat('swap 50 USDG for TSLA on Robinhood slippage 50 bps')));
    expect(JSON.stringify(w.steps[2]!.workflow)).toBe(JSON.stringify(chat('transfer 3 AAPL on Robinhood')));
    expect(w.steps.map(s => s.workflowHash)).toEqual(w.steps.map(s => semanticWorkflowHash(s.workflow)));
    // Hash continuity: the same intent (and its normalized form) always yields the same hashes; one step is exactly v1.
    const again = ok(composeWorkflow({ version: 2, steps: w.steps.map(s => s.strategy) }));
    expect(again.workflowHash).toBe(w.workflowHash);
    expect(ok(composeWorkflow({ version: 2, steps: [BUY_TSLA] })).workflowHash).toBe(ok(composeStrategy(BUY_TSLA)).workflowHash);
    expect(workflowPlan(w)).toMatchObject({ kind: 'NOT_EXECUTABLE', reason: 'MULTI_STEP_SEQUENCE_NOT_IMPLEMENTED', networks: ['base', 'robinhood'] });
    // Each step's review is a mainnet (real-funds) review; nothing is approved by it.
    for (const step of w.steps) expect(reviewComposition(step)).toMatchObject({ environment: 'MAINNET' });
    expect(reviewComposition(w.steps[1]!).findings.map(f => f.code)).toEqual(expect.arrayContaining(['REAL_FUNDS', 'OWNER_APPROVAL_REQUIRED']));
  });
  it('the shared visual names every network and asset: USDC → USDG into Robinhood Chain, USDG → TSLA, AAPL transfer, real funds', () => {
    registerNetworkCatalog(officialCatalog());
    const visual = workflowVisualModel(ok(composeWorkflow({ version: 2, steps: [BRIDGE_IN, BUY_TSLA, SEND_AAPL] })));
    expect(visual).toMatchObject({ fundsClass: 'REAL_FUNDS', networks: ['Base', 'Robinhood Chain'], warnings: ['REAL_FUNDS', 'SEQUENCE_NOT_EXECUTABLE'] });
    expect(visual.steps.map(s => [s.action, s.network, s.toNetwork, s.amounts.map(a => `${a.amount} ${a.asset}`).join(), s.toAsset])).toEqual([
      ['BRIDGE', 'Base', 'Robinhood Chain', '100 USDC', 'USDG'], ['SWAP', 'Robinhood Chain', null, '50 USDG', 'TSLA'], ['TRANSFER', 'Robinhood Chain', null, '3 AAPL', null]]);
    expect(visual.connections).toEqual([{ from: 's1', to: 's2' }, { from: 's2', to: 's3' }]);
  });
  it('pools, bridges out and previews map to their own Robinhood flows', () => {
    registerNetworkCatalog(officialCatalog());
    const pool = ok(composeStrategy({ action: 'add_liquidity', network: 'robinhood', maxAmounts: { USDG: '100', TSLA: '0.4' }, range: { unit: 'full' } }));
    expect(pool.strategy).toMatchObject({ feeTier: 3000, slippageBps: 100 });
    expect(pool.notes).toContain('Default fee tier 0.3% applied.');
    expect(JSON.stringify(pool.workflow)).toBe(JSON.stringify(chat('add liquidity 100 USDG and 0.4 TSLA on Robinhood fee 0.3% full range slippage 100 bps')));
    expect(previewPlan(pool.strategy)).toEqual({ flow: 'robinhood-liquidity', subject: 'EVM' });
    expect(previewPlan(BUY_TSLA)).toEqual({ flow: 'robinhood-swap', subject: 'NONE' });
    expect(previewPlan({ ...SEND_AAPL })).toEqual({ code: 'SIMULATION_REQUIRES_OWNER_BROWSER' });
    for (const [source, destination, asset, flow] of [['base', 'robinhood', 'USDC', 'crosschain-router-base-to-robinhood'], ['robinhood', 'base', 'USDG', 'crosschain-router-robinhood-to-base'],
      ['arbitrum-one', 'robinhood', 'USDC', 'crosschain-router-arbitrum-to-robinhood'], ['robinhood', 'arbitrum-one', 'USDG', 'crosschain-router-robinhood-to-arbitrum']] as const) {
      const bridge = ok(composeStrategy({ action: 'bridge', sourceNetwork: source, destinationNetwork: destination, asset, amount: '10' }));
      expect(previewPlan(bridge.strategy)).toEqual({ flow, subject: 'EVM' });
    }
  });
  it('fails closed: Stock Tokens before the registry loads, unknown symbols, unsupported pairs, ranges and tiers', () => {
    expect(composeStrategy(BUY_TSLA)).toMatchObject({ ok: false, code: 'ASSET_CATALOG_UNAVAILABLE' });
    expect(composeStrategy({ ...BUY_TSLA, outputAsset: 'WETH' })).toMatchObject({ ok: true });
    registerNetworkCatalog(officialCatalog());
    expect(composeStrategy({ ...BUY_TSLA, outputAsset: 'NOTREAL' })).toMatchObject({ ok: false });
    // BUILD-BASE-001: Base is a catalog network too; a Robinhood symbol is not in its catalog and fails closed (never mapped to something nearby).
    expect(composeStrategy({ ...BUY_TSLA, network: 'base' })).toMatchObject({ ok: false, code: 'ACTION_ASSETS_UNSUPPORTED' });
    expect(composeStrategy({ ...BRIDGE_IN, asset: 'USDG' })).toMatchObject({ ok: false, code: 'ROUTER_PAIR_UNSUPPORTED' });
    expect(composeStrategy({ ...BRIDGE_IN, sourceNetwork: 'robinhood' })).toMatchObject({ ok: false, code: 'ROUTER_PAIR_UNSUPPORTED' });
    // BUILD-BASE-001 (intentional change): Arbitrum One → Base is now a Router route.
    expect(composeStrategy({ ...BRIDGE_IN, sourceNetwork: 'arbitrum-one', destinationNetwork: 'base' })).toMatchObject({ ok: true });
    expect(composeStrategy({ ...BRIDGE_IN, sourceNetwork: 'arbitrum-one', destinationNetwork: 'arbitrum-one' })).toMatchObject({ ok: false, code: 'ROUTER_PAIR_UNSUPPORTED' });
    const pool = { action: 'add_liquidity', network: 'robinhood', maxAmounts: { USDG: '100', TSLA: '0.4' } } as const;
    expect(composeStrategy({ ...pool, range: { unit: 'price', lower: '1', upper: '2' } })).toMatchObject({ ok: false, code: 'LIQUIDITY_RANGE_UNIT_UNSUPPORTED' });
    expect(composeStrategy({ ...pool, range: { unit: 'full' }, feeTier: 2500 })).toMatchObject({ ok: false, code: 'STRATEGY_SCHEMA_INVALID' });
    const testnet = { action: 'add_liquidity', network: 'base-sepolia', maxAmounts: { USDC: '10', WETH: '0.005' } } as const;
    expect(composeStrategy({ ...testnet, range: { unit: 'full' } })).toMatchObject({ ok: false, code: 'LIQUIDITY_RANGE_UNIT_UNSUPPORTED' });
    expect(composeStrategy({ ...testnet, range: { unit: 'tick', lower: '189960', upper: '200040' }, feeTier: 3000 })).toMatchObject({ ok: false, code: 'LIQUIDITY_FEE_TIER_UNSUPPORTED' });
    // BUILD-BASE-001: Base is a transfer network too. A symbol outside its pinned assets resolves only in Base's validated list; a Robinhood
    // Stock Token is in neither, before or after the list is loaded (transfer authoring reports any unresolved symbol as the catalog's).
    expect(composeStrategy({ ...SEND_AAPL, network: 'base' })).toMatchObject({ ok: false, code: 'ASSET_CATALOG_UNAVAILABLE' });
    registerNetworkCatalog(baseCatalog());
    expect(composeStrategy({ ...SEND_AAPL, network: 'base' })).toMatchObject({ ok: false, code: 'ASSET_CATALOG_UNAVAILABLE' });
    expect(composeStrategy({ ...SEND_AAPL, network: 'base', asset: 'cbBTC' })).toMatchObject({ ok: true });
    expect(composeStrategy({ ...SEND_AAPL, asset: '0x' + '1'.repeat(40) })).toMatchObject({ ok: false, code: 'STRATEGY_SCHEMA_INVALID' });
  });
  it('MCP loads the official catalog only for strategies naming Robinhood Chain, and a registry failure only leaves Stock Tokens unresolvable', async () => {
    expect([strategyNamesRobinhood(BUY_TSLA), strategyNamesRobinhood({ version: 2, steps: [{ action: 'swap', network: 'base' }, BRIDGE_IN] }),
      strategyNamesRobinhood({ action: 'swap', network: 'base' })]).toEqual([true, true, false]);
    let loads = 0;
    await prepareStrategyCatalogs({ action: 'swap', network: 'base' }, async () => { loads += 1; return officialCatalog(); });
    expect(loads).toBe(0);
    await prepareStrategyCatalogs(BUY_TSLA, async () => { throw new Error('STOCK_REGISTRY_UNAVAILABLE'); });
    expect(composeStrategy(BUY_TSLA)).toMatchObject({ ok: false, code: 'ASSET_CATALOG_UNAVAILABLE' });
    await prepareStrategyCatalogs(BUY_TSLA, async () => { loads += 1; return officialCatalog(); });
    expect(loads).toBe(1);
    expect(networkCatalog(ROBINHOOD_CHAIN)?.assets.filter(a => a.stock).length).toBe(194);
    expect(composeStrategy(BUY_TSLA)).toMatchObject({ ok: true });
  });
});
