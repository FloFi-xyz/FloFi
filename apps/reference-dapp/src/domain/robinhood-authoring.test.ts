// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: Canvas authoring of Robinhood Chain swaps and the Stocks card through the shared action setup, crypto picker,
 * editor reducer and composer presentation. The catalog is the official capture validated by the same parser the server uses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRobinhoodStockTokenRegistry, robinhoodNetworkCatalog } from '@defi-workflow-engine/action-registry';
import { hashArtifactBytes, readCatalogSwapNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createBaseSepoliaReviewContext, validateAuthoringWorkflow } from '@defi-workflow-engine/reference-linter';
import { featuredStockSymbols, registerNetworkCatalog, resetNetworkCatalogs, searchNetworkAssets, ROBINHOOD_CHAIN, ROBINHOOD_NETWORK } from './asset-catalogs';
import { canvasAmountCommand, canvasAmountMessage, setupSummary } from './canvas-action-setup';
import { cryptoInputOf, cryptoNetworks, cryptoSelectionOf, createCryptoActionNode, selectCryptoToken, validCryptoSelection } from './crypto-action-picker';
import { editorHistoryReducer, initialEditorHistory } from './editor-history';
import { editorReducer } from './editor';
import { composerSummary } from './composer-presentation';
import { catalogSwapDetails } from './catalog-swap-authoring';

const OFFICIAL = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/robinhood-rhj-assets-2026-10-11.json', import.meta.url), 'utf8');
const catalog = robinhoodNetworkCatalog(parseRobinhoodStockTokenRegistry(OFFICIAL, '2026-10-11T02:00:00.000Z'));
const context = createBaseSepoliaReviewContext();
beforeEach(() => resetNetworkCatalogs());
afterEach(() => resetNetworkCatalogs());

function stocksSetup() {
  const started = editorHistoryReducer(initialEditorHistory(), { type: 'START_STOCKS_SETUP', position: { x: 10, y: 20 } });
  return started;
}
function apply(history: ReturnType<typeof stocksSetup>, amount: string) {
  const id = history.actionSetup!.id;
  const edited = editorHistoryReducer(history, { type: 'EDIT_CANVAS_AMOUNT', id, amount, context });
  const command = canvasAmountCommand(edited.editor, edited.actionSetup, edited.amountInputs, id, context, {}, edited.cryptoSelections);
  const next = editorReducer(edited.editor, command, context);
  expect(next.error).toBeNull();
  return next.workflow as unknown as SemanticWorkflow;
}

describe('Robinhood Chain in the shared crypto picker', () => {
  it('is a mainnet swap network next to Base and Solana, never a testnet one', () => {
    expect(cryptoNetworks('swap', 'mainnet').map(profile => profile.network)).toContain(ROBINHOOD_NETWORK);
    expect(cryptoNetworks('swap', 'testnet').map(profile => profile.network)).not.toContain(ROBINHOOD_NETWORK);
  });
  it('offers USDG, WETH and the featured five as shortcuts; non-featured tokens only through the validated catalog', () => {
    const selection = { action: 'swap' as const, network: ROBINHOOD_NETWORK, from: 'USDG', to: 'TSLA' };
    expect(validCryptoSelection(selection)).toBe(true);
    expect(validCryptoSelection({ ...selection, to: 'PLTR' })).toBe(false);
    expect(() => selectCryptoToken(selection, 'destination', 'PLTR')).toThrow('ACTION_TOKEN_UNSUPPORTED');
    registerNetworkCatalog(catalog);
    expect(validCryptoSelection({ ...selection, to: 'PLTR' })).toBe(true);
    expect(selectCryptoToken(selection, 'destination', 'PLTR')).toEqual({ ...selection, to: 'PLTR' });
    expect(validCryptoSelection({ ...selection, to: 'ETH' })).toBe(false);
    expect(validCryptoSelection({ ...selection, to: 'NOPE' })).toBe(false);
  });
  it('fails closed while the official catalog is not loaded: no Stock Token identity is invented', () => {
    expect(() => createCryptoActionNode('node-002', { selection: { action: 'swap', network: ROBINHOOD_NETWORK, from: 'USDG', to: 'TSLA' }, amount: '5', slippage: '50' }))
      .toThrow('ASSET_CATALOG_UNAVAILABLE');
    expect(canvasAmountMessage(new Error('ASSET_CATALOG_UNAVAILABLE'))).toMatch(/unavailable/);
  });
});

describe('the Stocks card is a canonical Robinhood Chain swap', () => {
  it('starts as USDG → the first featured Stock Token, Robinhood only', () => {
    const history = stocksSetup();
    expect(history.actionSetup).toMatchObject({ action: 'swap', stocks: true, amount: '0',
      cryptoSelection: { action: 'swap', network: ROBINHOOD_NETWORK, from: 'USDG', to: 'AAPL' } });
    expect(featuredStockSymbols()).toEqual(['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN']);
    expect(setupSummary(history.actionSetup!, context)).toMatchObject({ action: 'Stocks', provider: 'Uniswap', chain: ROBINHOOD_NETWORK, amount: '0 USDG', detail: 'USDG → AAPL' });
  });
  it('applies a featured Stock Token into the canonical catalog-swap IR with its official identity', () => {
    registerNetworkCatalog(catalog);
    const workflow = apply(stocksSetup(), '25');
    const node = workflow.nodes.find(item => item.actionType === 'asset.swap.exact-input')!;
    expect(node.chainId).toBe('eip155:4663');
    const fields = readCatalogSwapNode(node);
    expect(fields).toMatchObject({ amount: '25000000', slippageBps: 50,
      input: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, officialId: null },
      output: { address: '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9', decimals: 18, officialId: '0x00000000000000000000000000000000c2425be3658540dd8e2424cbf3c5c649' } });
    expect(validateAuthoringWorkflow(workflow, context)).toBe(workflow);
    expect(composerSummary(workflow, node, context)).toMatchObject({ action: 'Stocks', amount: '25 USDG', detail: 'USDG → AAPL' });
    expect(cryptoSelectionOf(node)).toEqual({ action: 'swap', network: ROBINHOOD_NETWORK, from: 'USDG', to: 'AAPL' });
    expect(cryptoInputOf(node)).toMatchObject({ amount: '25', slippage: '50' });
  });
  it('a non-featured search result (PLTR) configures the same card and flows into the same IR shape', () => {
    registerNetworkCatalog(catalog);
    const pltr = searchNetworkAssets(ROBINHOOD_CHAIN, 'palantir', { assetClass: 'STOCK_TOKEN' })[0]!;
    expect(pltr.symbol).toBe('PLTR');
    let history = stocksSetup();
    history = editorHistoryReducer(history, { type: 'EDIT_CRYPTO_SELECTION', id: history.actionSetup!.id,
      selection: selectCryptoToken(history.actionSetup!.cryptoSelection!, 'destination', 'PLTR'), context });
    expect(history.actionSetup).toMatchObject({ stocks: true, cryptoSelection: { to: 'PLTR' } });
    const workflow = apply(history, '10');
    const node = workflow.nodes.find(item => item.actionType === 'asset.swap.exact-input')!;
    expect(readCatalogSwapNode(node).output).toEqual({ chain: 'eip155:4663', address: pltr.address, decimals: 18, officialId: pltr.stock!.officialId });
    expect(catalogSwapDetails(node)).toMatchObject({ from: 'USDG', to: 'PLTR', stockPurchase: true });
  });
  it('keeps the workflow hash stable for the same intent, and changes it when the asset changes', () => {
    registerNetworkCatalog(catalog);
    const hash = (workflow: SemanticWorkflow) => hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow)));
    const a = apply(stocksSetup(), '25'), b = apply(stocksSetup(), '25');
    expect(hash(a)).toBe(hash(b));
    let history = stocksSetup();
    history = editorHistoryReducer(history, { type: 'EDIT_CRYPTO_SELECTION', id: history.actionSetup!.id,
      selection: selectCryptoToken(history.actionSetup!.cryptoSelection!, 'destination', 'TSLA'), context });
    expect(hash(apply(history, '25'))).not.toBe(hash(a));
  });
  it('shows a canonical stock purchase without the catalog as a neutral label, never a guessed symbol', () => {
    registerNetworkCatalog(catalog);
    const workflow = apply(stocksSetup(), '1');
    resetNetworkCatalogs();
    const node = workflow.nodes.find(item => item.actionType === 'asset.swap.exact-input')!;
    expect(catalogSwapDetails(node)).toMatchObject({ from: 'USDG', to: 'Stock Token', stockPurchase: true });
    expect(cryptoSelectionOf(node)).toBeNull();
  });
});
