// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baseAssetRegistry, parseArbitrumTokenList, parseEthereumTokenList, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext } from '@defi-workflow-engine/reference-linter';
import { readExactInputSwap } from '@defi-workflow-engine/workflow-contracts';
import { cryptoInputOf, cryptoReviewContext, type CryptoSelection } from './crypto-action-picker';
import { editorHistoryReducer, initialEditorHistory, type EditorHistory } from './editor-history';
import { actionReviewValue, canvasAmountCommand, canvasAmountMessage, canvasAuthoringIncomplete } from './canvas-action-setup';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';
import { baseCatalog } from '../server/base-mainnet.test-harness';

/**
 * P0 catalog reliability, incident 2026-11-07: an existing Arbitrum One WETH → USDC swap, amount edited to 0.0012 WETH and applied with Enter, was
 * refused with "This action cannot be combined with the current workflow" (the legacy SET_SWAP_AMOUNT only knows the Base reference pair and threw
 * INVALID_SWAP_NODE). The edit was lost and Simulate stayed unavailable. These tests drive the same reducer, command builder and context as the Canvas.
 */
const owner = '0x1111111111111111111111111111111111111111';
const tokenList = (name: string) => readFileSync(new URL(`../../../../packages/action-registry/test/fixtures/${name}-token-list-fixture.json`, import.meta.url), 'utf8');
// The Canvas's own context (product-workspace.tsx initialContext): the Base mainnet reference registry, whatever the card's network.
const canvasContext = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id,
  actionId: referenceRegistry.actions[0]!.id, assets: baseAssetRegistry });
beforeEach(() => {
  const at = new Date().toISOString();
  registerNetworkCatalog(parseArbitrumTokenList(tokenList('arbitrum'), at)); registerNetworkCatalog(parseEthereumTokenList(tokenList('ethereum'), at));
  registerNetworkCatalog(baseCatalog()); registerNetworkCatalog(officialCatalog());
});
afterEach(() => resetNetworkCatalogs());

function authored(selection: CryptoSelection, amount: string): EditorHistory {
  const state = editorHistoryReducer(initialEditorHistory(), { type: 'COMMAND', context: canvasContext, command: { type: 'ADD_CRYPTO_ACTION',
    input: { selection, amount, slippage: '50', beneficiary: owner }, source: 'CANVAS', baseRevision: 0 } });
  expect(state.editor.error).toBeNull();
  return state;
}
/** Type the amount on the card, then press Enter: exactly `editCanvasAmount` followed by `commitCanvasAmount`. */
function typeAndCommit(state: EditorHistory, id: string, amount: string): { state: EditorHistory; message: string | null } {
  const typed = editorHistoryReducer(state, { type: 'EDIT_CANVAS_AMOUNT', id, amount, context: canvasContext });
  try {
    const command = canvasAmountCommand(typed.editor, typed.actionSetup, typed.amountInputs, id, canvasContext, typed.bridgeNetworkInputs, typed.cryptoSelections, typed.recipientInputs);
    const value = actionReviewValue(typed.actionSetup, id, typed.amountInputs[id], typed.bridgeNetworkInputs[id], typed.cryptoSelections[id], typed.recipientInputs[id])!;
    return { state: editorHistoryReducer(typed, { type: 'COMMAND', command, context: canvasContext, authoringId: id, authoringAmount: value }), message: null };
  } catch (cause) { return { state: typed, message: canvasAmountMessage(cause, typed.cryptoSelections[id]?.network) }; }
}

describe('P0-C: an amount-only edit of an existing swap applies on Enter, on every swap network', () => {
  const cases: readonly [CryptoSelection, string, string, string][] = [
    [{ action: 'swap', network: 'Arbitrum One', from: 'WETH', to: 'USDC' }, '0.01', '0.0012', '1200000000000000'],
    [{ action: 'swap', network: 'Arbitrum One', from: 'USDC', to: 'WETH' }, '10', '12.5', '12500000'],
    [{ action: 'swap', network: 'Ethereum', from: 'WETH', to: 'USDC' }, '0.01', '0.0012', '1200000000000000'],
    [{ action: 'swap', network: 'Base', from: 'USDC', to: 'WETH' }, '10', '7', '7000000'],
    [{ action: 'swap', network: 'Solana', from: 'SOL', to: 'USDC' }, '0.5', '0.25', '250000000'],
    [{ action: 'swap', network: 'Robinhood Chain', from: 'USDG', to: 'WETH' }, '10', '3', '3000000'],
  ];
  for (const [selection, initial, edited, units] of cases) it(`${selection.network} ${selection.from} → ${selection.to}: ${initial} → ${edited}`, () => {
    const before = authored(selection, initial), node = before.editor.workflow.nodes.find(n => n.actionType === 'asset.swap.exact-input')!;
    const { state, message } = typeAndCommit(before, node.nodeId, edited);
    expect(message).toBeNull();
    expect(state.editor.error).toBeNull();
    // Applied in place: the same node, a new revision, the new amount in the same asset, and the draft cleared so Simulate is available.
    const after = state.editor.workflow.nodes.find(n => n.nodeId === node.nodeId)!;
    expect(state.editor.workflow.revision).toBe(before.editor.workflow.revision + 1);
    expect(state.editor.workflow.nodes).toHaveLength(before.editor.workflow.nodes.length);
    expect(readExactInputSwap(after as never).amount).toBe(units);
    expect(cryptoInputOf(after)?.selection).toEqual(selection);
    expect(state.amountInputs).toEqual({});
    expect(canvasAuthoringIncomplete(state.actionSetup, state.amountInputs)).toBe(false);
  });
  it('the network-specific review context gives the same result as the Canvas context', () => {
    const selection: CryptoSelection = { action: 'swap', network: 'Arbitrum One', from: 'WETH', to: 'USDC' };
    const before = authored(selection, '0.01'), id = before.editor.workflow.nodes[0]!.nodeId;
    const typed = editorHistoryReducer(before, { type: 'EDIT_CANVAS_AMOUNT', id, amount: '0.0012', context: canvasContext });
    expect(canvasAmountCommand(typed.editor, null, typed.amountInputs, id, cryptoReviewContext('Arbitrum One'), {}, {})).toMatchObject({ type: 'SET_CRYPTO_ACTION' });
  });
  it('an invalid amount still names the real problem, and the authored workflow is unchanged', () => {
    const before = authored({ action: 'swap', network: 'Arbitrum One', from: 'WETH', to: 'USDC' }, '0.01'), id = before.editor.workflow.nodes[0]!.nodeId;
    const { state, message } = typeAndCommit(before, id, '0.0000000000000000001');
    expect(message).toBe('Enter a valid amount greater than 0.');
    expect(state.editor.workflow).toBe(before.editor.workflow);
  });
});

describe('P0-C: canvasAmountMessage names the cause instead of "cannot be combined"', () => {
  it('keeps the composition message for real composition conflicts only', () => {
    for (const code of ['ACTION_REQUIRES_SEPARATE_WORKFLOW', 'COMPOSITION_UNSUPPORTED', 'ONE_LIQUIDITY_POSITION_ONLY'])
      expect(canvasAmountMessage(Error(code))).toContain('cannot be combined');
    for (const code of ['INVALID_SWAP_NODE', 'UNKNOWN_NODE', 'INVALID_COMMAND', 'REVIEW_CONTEXT_REQUIRED'])
      expect(canvasAmountMessage(Error(code))).toBe(`This change could not be applied (reference ${code}). Your workflow was not changed. Try again or edit the action from its menu.`);
    expect(canvasAmountMessage(Error('BASE_REVISION_CONFLICT: review a fresh proposal.'))).toBe('The workflow changed. Review this amount again.');
    expect(canvasAmountMessage(Error('ACTION_SELECTION_LOCKED'))).not.toBe('This amount is protected.');
    expect(canvasAmountMessage(Error('ACTION_NETWORK_UNSUPPORTED'))).toBe('This action is not available on this network. Choose another network.');
    expect(canvasAmountMessage('not an error')).not.toContain('cannot be combined');
  });
});
