// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { JUPITER_SOLANA_MAINNET, SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { readExactInputSwap } from '@defi-workflow-engine/workflow-contracts';
import { cryptoInputOf, cryptoReviewContext, invertCryptoSelection, selectCryptoNetwork, type CryptoSelection } from './crypto-action-picker';
import { editorHistoryReducer, initialEditorHistory, type EditorHistory } from './editor-history';
import { actionReviewValue, canvasAmountCommand, canvasAuthoringIncomplete } from './canvas-action-setup';
import { editorReducer } from './editor';
import { savedWorkflowHash } from './saved-workflow';

/**
 * BUILD-SOLANA-MAINNET-001 requirement C: the Swap card's arrow exchanges From and To on the same network. The new From is the spending asset,
 * the owner's typed amount is re-validated in it, the old estimate's target is replaced, and nothing is applied until the owner applies the draft.
 */
const owner = '0x1111111111111111111111111111111111111111';
function authored(selection: CryptoSelection, amount: string): EditorHistory {
  const context = cryptoReviewContext(selection.network);
  const state = editorHistoryReducer(initialEditorHistory(), { type: 'COMMAND', context, command: { type: 'ADD_CRYPTO_ACTION',
    input: { selection, amount, slippage: '50', beneficiary: owner }, source: 'CANVAS', baseRevision: 0 } });
  expect(state.editor.error).toBeNull();
  return state;
}
const swapNode = (state: EditorHistory) => state.editor.workflow.nodes.find(node => node.actionType === 'asset.swap.exact-input')!;
function invert(state: EditorHistory, id: string, selection: CryptoSelection) {
  return editorHistoryReducer(state, { type: 'EDIT_CRYPTO_SELECTION', id, selection: invertCryptoSelection(selection)!, context: cryptoReviewContext(selection.network) });
}
function apply(state: EditorHistory, id: string, network: string) {
  const context = cryptoReviewContext(network);
  const command = canvasAmountCommand(state.editor, state.actionSetup, state.amountInputs, id, context, {}, state.cryptoSelections);
  const authoringAmount = actionReviewValue(state.actionSetup, id, state.amountInputs[id], undefined, state.cryptoSelections[id])!;
  return editorHistoryReducer(state, { type: 'COMMAND', command, context, authoringId: id, authoringAmount });
}

describe('the Swap arrow inverts From and To', () => {
  it('Solana SOL/USDC → USDC/SOL on the same mainnet cluster, with mainnet mints and the typed amount now spent in USDC', () => {
    const selection: CryptoSelection = { action: 'swap', network: 'Solana', from: 'SOL', to: 'USDC' };
    let state = authored(selection, '1');
    const id = swapNode(state).nodeId, before = state.editor.workflow;
    state = invert(state, id, selection);
    // A draft: the canonical workflow is unchanged and Simulate is blocked until the owner applies it.
    expect(state.editor.workflow).toBe(before);
    expect(state.cryptoSelections[id]).toEqual({ action: 'swap', network: 'Solana', from: 'USDC', to: 'SOL' });
    expect(canvasAuthoringIncomplete(state.actionSetup, state.amountInputs)).toBe(true);
    // The live estimate targets the draft preview: the inverted swap, never the old direction.
    const context = cryptoReviewContext('Solana');
    const preview = editorReducer(state.editor, canvasAmountCommand(state.editor, null, state.amountInputs, id, context, {}, state.cryptoSelections), context);
    expect(preview.error).toBeNull();
    expect(savedWorkflowHash(preview.workflow as never)).not.toBe(savedWorkflowHash(before as never));
    state = apply(state, id, 'Solana');
    expect(state.editor.error).toBeNull();
    const fields = readExactInputSwap(swapNode(state) as never);
    expect(fields.chain).toBe(JUPITER_SOLANA_MAINNET.chain);
    expect([fields.input.address, fields.output.address]).toEqual([SOLANA_MAINNET_TOKENS.USDC.mint, SOLANA_MAINNET_TOKENS.SOL.mint]);
    // 1 is now 1 USDC (6 decimals), never the previous estimated SOL output.
    expect(fields.amount).toBe('1000000');
    expect(cryptoInputOf(swapNode(state))?.selection).toEqual({ action: 'swap', network: 'Solana', from: 'USDC', to: 'SOL' });
  });
  it('Solana Devnet SOL/devUSDC → devUSDC/SOL keeps the Devnet cluster and test mint', () => {
    const selection: CryptoSelection = { action: 'swap', network: 'Solana Devnet', from: 'SOL', to: 'devUSDC' };
    let state = authored(selection, '0.5');
    const id = swapNode(state).nodeId;
    state = apply(invert(state, id, selection), id, 'Solana Devnet');
    expect(state.editor.error).toBeNull();
    expect(cryptoInputOf(swapNode(state))?.selection).toEqual({ action: 'swap', network: 'Solana Devnet', from: 'devUSDC', to: 'SOL' });
  });
  it('EVM: Base USDC → WETH becomes WETH → USDC on Base', () => {
    const selection = selectCryptoNetwork('swap', 'Base');
    let state = authored(selection, '0.25');
    const id = swapNode(state).nodeId;
    state = apply(invert(state, id, selection), id, 'Base');
    expect(state.editor.error).toBeNull();
    expect(cryptoInputOf(swapNode(state))?.selection).toMatchObject({ network: 'Base', from: selection.to, to: selection.from });
  });
  it('re-validates the typed amount in the new From token: too many decimals is refused and nothing is applied', () => {
    const selection: CryptoSelection = { action: 'swap', network: 'Solana', from: 'SOL', to: 'USDC' };
    let state = authored(selection, '0.123456789');
    const id = swapNode(state).nodeId, before = state.editor.workflow;
    state = invert(state, id, selection);
    expect(() => canvasAmountCommand(state.editor, null, state.amountInputs, id, cryptoReviewContext('Solana'), {}, state.cryptoSelections)).toThrow();
    expect(state.editor.workflow).toBe(before);
  });
  it('never produces a same-token pair, and offers nothing for non-swaps', () => {
    expect(invertCryptoSelection({ action: 'swap', network: 'Base', from: 'USDC', to: 'USDC' })).toBeNull();
    expect(invertCryptoSelection(selectCryptoNetwork('pool', 'Solana'))).toBeNull();
    expect(invertCryptoSelection(selectCryptoNetwork('supply', 'Base'))).toBeNull();
    const inverted = invertCryptoSelection({ action: 'swap', network: 'Solana', from: 'USDT', to: 'SOL' })!;
    expect(inverted.from).not.toBe(inverted.to);
  });
  it('undo restores the original direction; inverting twice returns to it', () => {
    const selection: CryptoSelection = { action: 'swap', network: 'Solana', from: 'SOL', to: 'USDC' };
    const state = authored(selection, '1'), id = swapNode(state).nodeId;
    const once = invert(state, id, selection);
    expect(editorHistoryReducer(once, { type: 'UNDO' }).cryptoSelections[id]).toBeUndefined();
    expect(invertCryptoSelection(invertCryptoSelection(selection)!)).toEqual(selection);
  });
  it('inverts a new, unapplied Swap draft (setup card) the same way', () => {
    let state = editorHistoryReducer(initialEditorHistory(), { type: 'START_ACTION_SETUP', action: 'swap', position: { x: 0, y: 0 } });
    const id = state.actionSetup!.id, selection: CryptoSelection = { action: 'swap', network: 'Solana', from: 'SOL', to: 'USDC' };
    state = editorHistoryReducer(state, { type: 'EDIT_CRYPTO_SELECTION', id, selection, context: cryptoReviewContext('Solana') });
    state = invert(state, id, selection);
    expect(state.actionSetup?.cryptoSelection).toEqual({ action: 'swap', network: 'Solana', from: 'USDC', to: 'SOL' });
  });
});
