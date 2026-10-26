// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FIX-UX-001: ordinary Canvas edits apply directly to the editable workflow (amount on Enter, slippage on Apply), new Canvas swaps
 * start at 100 bps, USD equivalents are never fabricated, and a Canvas connection is exactly a CONNECT the workflow accepts.
 */
import { describe, expect, it } from 'vitest';
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import { actionReviewValue, canvasAmountCommand, canvasAmountMessage, cryptoSetupInput } from './canvas-action-setup';
import { canvasAddCommand } from './canvas-authoring';
import { checkConnection, connectionEnd, handleHitScale } from './canvas-connect';
import { cryptoInputOf, cryptoReviewContext, selectCryptoNetwork } from './crypto-action-picker';
import { editorReducer } from './editor';
import { editorHistoryReducer, initialEditorHistory, type EditorHistory } from './editor-history';
import { parseSwapSlippageEdit, slippagePercent, swapDetails, SWAP_DEFAULT_SLIPPAGE_BPS } from './swap-authoring';
import { formatUsd, priceAssetOf, usdAmount, usdLine } from './usd-estimate';
import type { Command } from './commands';

const context = cryptoReviewContext('Base Sepolia');
const hashOf = (state: EditorHistory) => hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(state.editor.workflow)));
/** What the Canvas does on Enter: the card's own command, applied once through the history guard (`commitCanvasAmount`). */
function commit(state: EditorHistory, id: string): EditorHistory {
  const command = canvasAmountCommand(state.editor, state.actionSetup, state.amountInputs, id, context, state.bridgeNetworkInputs, state.cryptoSelections, state.recipientInputs);
  const authoringAmount = actionReviewValue(state.actionSetup, id, state.amountInputs[id], state.bridgeNetworkInputs[id], state.cryptoSelections[id], state.recipientInputs[id])!;
  return editorHistoryReducer(state, { type: 'COMMAND', command, context, authoringId: id, authoringAmount });
}
function baseSepoliaSwap(amount: string) {
  let state = editorHistoryReducer(initialEditorHistory(), { type: 'START_ACTION_SETUP', action: 'swap', position: { x: 0, y: 0 } });
  const id = state.actionSetup!.id;
  state = editorHistoryReducer(state, { type: 'EDIT_CRYPTO_SELECTION', id, selection: selectCryptoNetwork('swap', 'Base Sepolia'), context });
  state = editorHistoryReducer(state, { type: 'EDIT_CANVAS_AMOUNT', id, amount, context });
  state = commit(state, id);
  const node = state.editor.workflow.nodes.find(item => item.actionType === 'asset.swap.exact-input')!;
  return { state, node };
}

describe('BUILD-FIX-UX-001 direct Canvas amount entry', () => {
  it('Enter applies a new swap card exactly once, at the 100 bps swap default', () => {
    const { state, node } = baseSepoliaSwap('5');
    expect(state.actionSetup).toBeNull(); expect(state.amountInputs).toEqual({});
    expect(swapDetails(node, context)).toMatchObject({ from: 'USDC', to: 'WETH', amount: '5', slippage: SWAP_DEFAULT_SLIPPAGE_BPS });
    expect(state.editor.workflow.nodes.filter(item => item.actionType === 'asset.swap.exact-input')).toHaveLength(1);
  });
  it('edits 5 USDC to 10 USDC on Enter, once; a repeated commit of the same draft changes nothing', () => {
    const swap = baseSepoliaSwap('5'), node = swap.node;
    let state = swap.state;
    state = editorHistoryReducer(state, { type: 'EDIT_CANVAS_AMOUNT', id: node.nodeId, amount: '10', context });
    // A draft is not the workflow: the canonical amount is unchanged until the owner applies it.
    expect(swapDetails(state.editor.workflow.nodes.find(item => item.nodeId === node.nodeId)!, context)?.amount).toBe('5');
    const before = state.editor.workflow.revision, beforeHash = hashOf(state);
    const draft = state;
    state = commit(state, node.nodeId);
    expect(swapDetails(state.editor.workflow.nodes.find(item => item.nodeId === node.nodeId)!, context)).toMatchObject({ amount: '10', units: '10000000' });
    expect(state.editor.workflow.revision).toBe(before + 1); expect(hashOf(state)).not.toBe(beforeHash);
    expect(state.amountInputs).toEqual({});
    // A stale second commit of the same draft (Enter then leaving the card) is refused by the history guard.
    const command = canvasAmountCommand(draft.editor, draft.actionSetup, draft.amountInputs, node.nodeId, context, draft.bridgeNetworkInputs, draft.cryptoSelections, draft.recipientInputs);
    const again = editorHistoryReducer(state, { type: 'COMMAND', command, context, authoringId: node.nodeId, authoringAmount: actionReviewValue(null, node.nodeId, '10', undefined, draft.cryptoSelections[node.nodeId])! });
    expect(again).toBe(state);
  });
  it.each(['0', '', 'abc', '1.0000001', '-1'])('an invalid amount (%j) is refused with a message and never changes the workflow', amount => {
    const swap = baseSepoliaSwap('5'), node = swap.node;
    let state = swap.state;
    state = editorHistoryReducer(state, { type: 'EDIT_CANVAS_AMOUNT', id: node.nodeId, amount, context });
    const workflow = state.editor.workflow;
    let message: string | null = null;
    try { commit(state, node.nodeId); } catch (cause) { message = canvasAmountMessage(cause); }
    expect(message).toBe('Enter a valid amount greater than 0.');
    expect(state.editor.workflow).toBe(workflow);
  });
});

describe('BUILD-FIX-UX-001 swap slippage', () => {
  // BUILD-FLOFI-PRODUCT-UX-001 supersedes the earlier swap-only rule: every new artifact with a slippage starts at the shared 100 bps default.
  it('new Canvas swaps, bridges and lending compositions all start at the shared 100 bps default', () => {
    expect(SWAP_DEFAULT_SLIPPAGE_BPS).toBe(100); expect(slippagePercent(SWAP_DEFAULT_SLIPPAGE_BPS)).toBe('1.00%');
    expect(cryptoSetupInput({ id: 's', action: 'swap', amount: '1', cryptoSelection: selectCryptoNetwork('swap', 'Arbitrum One') }).slippage).toBe('100');
    expect(canvasAddCommand('swap', 0, null, '1')).toMatchObject({ type: 'ADD_SWAP', slippage: '100' });
    expect(canvasAddCommand('bridge', 0, null, '1')).toMatchObject({ input: { slippage: '100' } });
    expect(canvasAddCommand('lending', 0, '0x1111111111111111111111111111111111111111')).toMatchObject({ input: { slippage: '100' } });
  });
  it('accepts an exact integer from 1 to 300 bps and refuses anything else (never clamped)', () => {
    expect(parseSwapSlippageEdit('75')).toBe(75); expect(parseSwapSlippageEdit(' 100 ')).toBe(100); expect(parseSwapSlippageEdit('300')).toBe(300);
    for (const value of ['0', '301', '1000', '-1', '1.5', 'abc', '']) expect(() => parseSwapSlippageEdit(value)).toThrow();
  });
  it('a slippage edit applies to the canonical swap directly, changes its hash, and keeps an amount draft a draft', () => {
    const swap = baseSepoliaSwap('5'), node = swap.node;
    let state = swap.state;
    state = editorHistoryReducer(state, { type: 'EDIT_CANVAS_AMOUNT', id: node.nodeId, amount: '7', context });
    const beforeHash = hashOf(state), beforeRevision = state.editor.workflow.revision;
    for (const bps of ['75', '100']) {
      const input = cryptoInputOf(state.editor.workflow.nodes.find(item => item.nodeId === node.nodeId)!)!;
      const command = { type: 'SET_CRYPTO_ACTION', nodeId: node.nodeId, input: { ...input, slippage: String(parseSwapSlippageEdit(bps)) }, source: 'CANVAS', baseRevision: state.editor.workflow.revision } as Command;
      expect(editorReducer(state.editor, command, context).error).toBeNull();
      state = editorHistoryReducer(state, { type: 'COMMAND', command, context });
      const current = state.editor.workflow.nodes.find(item => item.nodeId === node.nodeId)!;
      expect(swapDetails(current, context)).toMatchObject({ slippage: Number(bps), amount: '5' });
      expect(current.userConstraints.filter(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS')).toEqual([{ kind: 'MAXIMUM_SLIPPAGE_BPS', maximumBps: Number(bps) }]);
    }
    expect(state.amountInputs[node.nodeId]).toBe('7');
    // 75 → back to 100 restores the constraint, yet each edit is a new revision: no earlier quote, simulation or Review binds to it.
    expect(state.editor.workflow.revision).toBe(beforeRevision + 2); expect(hashOf(state)).not.toBe(beforeHash);
  });
});

describe('BUILD-FIX-UX-001 USD equivalents', () => {
  it('follows only a verified feed: ETH/WETH and SOL/WSOL; stablecoins and other tokens have none', () => {
    expect(['ETH', 'weth', 'SOL', 'WSOL'].map(priceAssetOf)).toEqual(['ETH', 'ETH', 'SOL', 'SOL']);
    expect(['USDC', 'USDG', 'TSLA', 'cbBTC', '', null].map(priceAssetOf)).toEqual([null, null, null, null, null, null]);
  });
  it('multiplies exactly (no float) and rounds half-up to cents', () => {
    expect(usdAmount('1000000000000000000', 18, '2500.5')).toBe('2500.50');
    expect(usdAmount('412345678901234', 18, '2500.12345678')).toBe('1.03');
    expect(usdAmount('5000000', 6, '1')).toBe('5.00');
    expect(usdAmount('1', 18, '2500')).toBe('0.00');
    expect(usdAmount('12', 18, 'NaN')).toBeNull(); expect(usdAmount('1.5', 18, '1')).toBeNull();
    expect(formatUsd('1234567.89')).toBe('≈ $1,234,567.89'); expect(formatUsd('0.00')).toBe('< $0.01'); expect(formatUsd('5.00')).toBe('≈ $5.00');
  });
  it('test tokens say so; a mainnet value is labelled an estimate; otherwise the reason, never a number', () => {
    expect(usdLine('Base Sepolia', '5.00', { status: 'ready' })).toMatchObject({ kind: 'test-token', text: 'Test token · no USD value' });
    expect(usdLine('Base', '1.03', { status: 'ready', observedAt: '2026-10-12T10:00:00.000Z' })).toMatchObject({ kind: 'value', text: '≈ $1.03' });
    expect(usdLine('Arbitrum One', '1.03', { status: 'ready', mocked: true }).text).toBe('≈ $1.03 · test price');
    expect(usdLine('Base', null, { status: 'pending' })).toMatchObject({ kind: 'pending', text: 'Estimating USD…' });
    expect(usdLine('Base', null, { status: 'none' })).toMatchObject({ kind: 'unavailable', text: 'USD price unavailable' });
  });
});

describe('BUILD-FIX-UX-001 Canvas connections', () => {
  function twoSwaps() {
    let state = editorHistoryReducer(initialEditorHistory(), { type: 'COMMAND', command: canvasAddCommand('swap', 0, null, '1'), context });
    state = editorHistoryReducer(state, { type: 'COMMAND', command: canvasAddCommand('swap', state.editor.workflow.revision, null, '2'), context });
    const [a, b] = state.editor.workflow.nodes.filter(node => node.actionType === 'asset.swap.exact-input');
    return { editor: state.editor, a: a!.nodeId, b: b!.nodeId };
  }
  it('a gesture names two steps; only CONNECT decides, and its refusal is explained', () => {
    const { editor, a, b } = twoSwaps();
    const result = checkConnection(editor, context, a, b);
    expect(result.ok).toBe(editorReducer(editor, { type: 'CONNECT', from: a, to: b, source: 'CANVAS', baseRevision: editor.workflow.revision }, context).error === null);
    expect(result.ok).toBe(true);
    expect(checkConnection(editor, context, a, a)).toEqual({ ok: false, message: 'Choose two different steps to connect.' });
    if (result.ok) {
      const linked = editorReducer(editor, result.command, context);
      expect(linked.workflow.nodes.find(node => node.nodeId === b)!.dependencies).toContain(a);
      expect(checkConnection(linked, context, b, a)).toEqual({ ok: false, message: 'This connection would create a loop.' });
      // The same edge again is the existing idempotent no-op: never a second (duplicate) dependency.
      const again = checkConnection(linked, context, a, b);
      expect(again.ok && editorReducer(linked, again.command, context).workflow).toBe(linked.workflow);
      expect(linked.workflow.nodes.find(node => node.nodeId === b)!.dependencies.filter(id => id === a)).toHaveLength(1);
    } else expect(result.message).not.toBe('');
  });
  it('a drag released on a card connects output → input; on the pane or the starting card it names nothing', () => {
    expect(connectionEnd({ nodeId: 'a', type: 'source' }, 'b')).toEqual({ from: 'a', to: 'b' });
    expect(connectionEnd({ nodeId: 'b', type: 'target' }, 'a')).toEqual({ from: 'a', to: 'b' });
    expect(connectionEnd({ nodeId: 'a', type: 'source' }, null)).toBeNull(); expect(connectionEnd({ nodeId: 'a', type: 'source' }, 'a')).toBeNull();
  });
  it('the handle hit area compensates for zooming out, up to twice its size', () => {
    expect([1.4, 1, 0.75, 0.5, 0.35, 0, Number.NaN].map(handleHitScale)).toEqual([1, 1, 4 / 3, 2, 2, 1, 1]);
  });
});
