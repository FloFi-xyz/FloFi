// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: Robinhood Chain sentences in the local chat parser author the same canonical IR as the Canvas — catalog swaps, transfers,
 * positions and the USDC ⇄ USDG bridge routes — and an unknown symbol or an unloaded registry fails closed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { parseLocalCommand, summarize } from './commands';
import { editorReducer, templateEditor } from './editor';
import { registerNetworkCatalog, resetNetworkCatalogs, ROBINHOOD_NETWORK } from './asset-catalogs';
import { createCryptoActionNode } from './crypto-action-picker';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';

const context = createBaseSepoliaReviewContext(), editor = templateEditor();
const parse = (text: string) => parseLocalCommand(text, editor.workflow, context);
const apply = (text: string) => { const r = editorReducer(editor, parse(text), context); if (r.error) throw new Error(r.error); return r.workflow; };
afterEach(() => resetNetworkCatalogs());

describe('BUILD-RH-002 Robinhood Chain chat', () => {
  it('"Swap 50 USDG for TSLA on Robinhood" authors the Canvas catalog swap; a non-featured symbol works the same way', () => {
    registerNetworkCatalog(officialCatalog());
    expect(parse('Swap 50 USDG for TSLA on Robinhood')).toMatchObject({ type: 'ADD_CRYPTO_ACTION',
      input: { selection: { action: 'swap', network: ROBINHOOD_NETWORK, from: 'USDG', to: 'TSLA' }, amount: '50', slippage: '100' } });
    const node = apply('Swap 50 USDG for TSLA on Robinhood').nodes.find(n => n.chainId === 'eip155:4663')!;
    expect(node).toEqual(createCryptoActionNode(node.nodeId, { selection: { action: 'swap', network: ROBINHOOD_NETWORK, from: 'USDG', to: 'TSLA' }, amount: '50', slippage: '100' }));
    expect(parse('swap 10 usdg to pltr on robinhood chain slippage 80 bps')).toMatchObject({ input: { selection: { to: 'PLTR' }, slippage: '80' } });
    expect(summarize(apply('Swap 50 USDG for TSLA on Robinhood'))).toContain('Swap 50 USDG to TSLA on Robinhood Chain via Uniswap v3, 100 bps; real funds');
  });
  it('"Transfer 3 AAPL on Robinhood" is a token transfer to the connected owner; an explicit recipient is kept', () => {
    registerNetworkCatalog(officialCatalog());
    expect(parse('Transfer 3 AAPL on Robinhood')).toMatchObject({ type: 'ADD_RH_TRANSFER', input: { network: 'Robinhood Chain', asset: 'AAPL', amount: '3', recipient: 'CONNECTED_OWNER' } });
    const to = '0x' + 'ab'.repeat(20);
    expect(parse(`Send 1.5 USDG on Robinhood Chain to ${to.toUpperCase().replace('0X', '0x')}`)).toMatchObject({ input: { asset: 'USDG', recipient: to } });
    expect(summarize(apply('Transfer 3 AAPL on Robinhood'))).toContain('Transfer 3 AAPL on Robinhood Chain to the connected owner; real funds');
  });
  it('"Bridge 100 USDC from Base to Robinhood" and "Add liquidity 100 USDG and 0.4 TSLA on Robinhood" author their canonical nodes', () => {
    registerNetworkCatalog(officialCatalog());
    expect(parse('Bridge 100 USDC from Base to Robinhood')).toMatchObject({ type: 'ADD_ROUTER_BRIDGE', input: { source: 'Base', destination: 'Robinhood Chain', token: 'USDC', amount: '100' } });
    expect(summarize(apply('Bridge 100 USDC from Base to Robinhood'))).toContain('Cross-chain bridge 100 USDC from Base to Robinhood Chain (delivered as USDG)');
    expect(parse('Add liquidity 100 USDG and 0.4 TSLA on Robinhood fee 0.3%')).toMatchObject({ type: 'ADD_CRYPTO_ACTION',
      input: { selection: { action: 'pool', network: ROBINHOOD_NETWORK, from: 'USDG', to: 'TSLA' }, amount: '100', secondAmount: '0.4', fee: 3000 } });
    expect(summarize(apply('Add liquidity 100 USDG and 0.4 TSLA on Robinhood'))).toContain('up to 100 USDG and 0.4 TSLA, full range');
  });
  it('fails closed: an unknown symbol, a native asset where an ERC-20 is required, or Stock Tokens before the registry is loaded', () => {
    // Base assets are code-pinned; Stock Tokens resolve only from the validated official registry.
    expect(parse('Swap 5 USDG for WETH on Robinhood')).toMatchObject({ type: 'ADD_CRYPTO_ACTION' });
    expect(() => parse('Swap 5 USDG for TSLA on Robinhood')).toThrow();
    expect(() => parse('Transfer 3 AAPL on Robinhood')).toThrow('ASSET_CATALOG_UNAVAILABLE');
    registerNetworkCatalog(officialCatalog());
    expect(() => parse('Swap 5 USDG for NOTREAL on Robinhood')).toThrow();
    // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: native ETH is a swap side of its own on Robinhood Chain (its pool is checked at Simulate), never WETH.
    expect(parse('Swap 5 ETH for TSLA on Robinhood')).toMatchObject({ type: 'ADD_CRYPTO_ACTION', input: { selection: { from: 'ETH', to: 'TSLA' } } });
    expect(() => parse('Pool 5 ETH and 5 USDG on Robinhood')).toThrow();
    expect(() => parse('Bridge 5 USDG from Base to Robinhood')).toThrow();
  });
});
