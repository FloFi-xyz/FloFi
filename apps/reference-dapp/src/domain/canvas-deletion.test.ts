// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, readBoundComposition } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext, createReviewContext, validateWorkflowDraft, type ReviewContext } from '@defi-workflow-engine/reference-linter';
import { parseLocalCommand, type Command } from './commands';
import { editorReducer, templateEditor, resolveCanvasRemoval, type EditorState } from './editor';
import { editorHistoryReducer, initialEditorHistory, type EditorHistory } from './editor-history';
import { canDeleteCanvasNode, planCanvasRemoval } from './canvas-keyboard';
import { composerActions } from './composer-presentation';
import { solanaLiquidityDetails } from './solana-liquidity-authoring';

/**
 * BUILD-SOLANA-MAINNET-001 requirement D: any action card can be deleted. Removal keeps the graph consistent (links, typed bindings, dependent
 * steps), leaves the workflow editable, is one undo/redo step, and deleting the last action leaves an empty Canvas with nothing put in its place.
 */
const base = createReviewContext({ registryId: 'reference.registry', capabilityId: 'swap.direct-transaction', actionId: 'asset.swap.exact-input', assets: baseAssetRegistry });
const sepolia = createBaseSepoliaReviewContext();
const OWNER = '0x1111111111111111111111111111111111111111';
function chat(text: string, context: ReviewContext, from: EditorState = templateEditor()): EditorState {
  const next = editorReducer(from, parseLocalCommand(text, from.workflow, context, OWNER), context);
  expect(next.error).toBeNull();
  return next;
}
const remove = (state: EditorState, nodeIds: string[], context: ReviewContext) =>
  editorReducer(state, nodeIds.length === 1 ? { type: 'REMOVE', nodeId: nodeIds[0]!, source: 'CANVAS', baseRevision: state.workflow.revision }
    : { type: 'REMOVE_MANY', nodeIds, source: 'CANVAS', baseRevision: state.workflow.revision }, context);
const cards = (state: EditorState) => composerActions(state.workflow).map(node => node.nodeId);

describe('every action card can be deleted', () => {
  it('deletes the only Swap, leaving an empty Canvas (the hidden template draft) with nothing put in its place', () => {
    const swap = chat('swap 10 USDC to WETH on Base slippage 50 bps', base);
    expect(cards(swap)).toEqual(['node-002']);
    expect(canDeleteCanvasNode(swap.workflow, 'node-002')).toBe(true);
    const empty = remove(swap, ['node-002'], base);
    expect(empty.error).toBeNull();
    expect(cards(empty)).toEqual([]);
    expect(empty.workflow.nodes.every(node => node.actionType.startsWith('mock-'))).toBe(true);
    expect(empty.workflow.revision).toBe(swap.workflow.revision + 1);
    // Still editable: a new action is added after the deletion.
    expect(cards(chat('swap 5 USDC to WETH on Base slippage 50 bps', base, empty))).toHaveLength(1);
  });
  it('deletes a step whose amount is locked and a step whose id is not node-NNN', () => {
    const swap = chat('swap 10 USDC to WETH on Base slippage 50 bps', base);
    const locked = editorReducer(swap, { type: 'LOCK', nodeId: 'node-002', locked: true, source: 'CANVAS', baseRevision: swap.workflow.revision }, base);
    expect(locked.workflow.nodes.find(node => node.nodeId === 'node-002')!.lockedParameters).toHaveLength(1);
    expect(cards(remove(locked, ['node-002'], base))).toEqual([]);
    const bridgeSwap = chat('compose bridge 1.25 USDC from Base to Arbitrum slippage 50 bps then swap to WETH slippage 75 bps', base);
    expect(cards(bridgeSwap)[0]).toBe('build009-bridge');
    expect(canDeleteCanvasNode(bridgeSwap.workflow, 'build009-bridge')).toBe(true);
  });
  it('removes the middle of a connected template chain and keeps the rest consistent', () => {
    let state = templateEditor();
    for (const kind of ['transform', 'condition'] as const) state = editorReducer(state, { type: 'ADD', kind, source: 'CANVAS', baseRevision: state.workflow.revision }, base);
    state = editorReducer(state, { type: 'CONNECT', from: 'node-001', to: 'node-002', source: 'CANVAS', baseRevision: state.workflow.revision }, base);
    state = editorReducer(state, { type: 'CONNECT', from: 'node-002', to: 'node-003', source: 'CANVAS', baseRevision: state.workflow.revision }, base);
    expect(state.error).toBeNull();
    const after = remove(state, ['node-002'], base);
    expect(after.error).toBeNull();
    expect(after.workflow.nodes.map(node => node.nodeId)).toEqual(['node-001', 'node-003']);
    expect(after.workflow.nodes.find(node => node.nodeId === 'node-003')).toMatchObject({ dependencies: [] });
    expect(after.workflow.resourceEdges).toEqual([]);
    expect(() => validateWorkflowDraft(after.workflow, base)).not.toThrow();
  });
});

describe('dependants of a deleted step', () => {
  it('Solana Devnet Swap → Orca position: deleting the swap returns the position to its isolated form (it keeps its own maxima)', () => {
    const context = sepolia;
    let state = editorReducer(templateEditor(), parseLocalCommand('swap 0.1 SOL to devUSDC on Solana Devnet slippage 50 bps then add liquidity 5 swapped devUSDC and 0.05 SOL ticks -1024 to 1024 slippage 100 bps',
      templateEditor().workflow, context), context);
    expect(state.error).toBeNull();
    expect(() => readBoundComposition(state.workflow)).not.toThrow();
    const plan = planCanvasRemoval(state.workflow, ['node-002'])!;
    expect(plan).toEqual({ removed: ['node-002'], cascaded: [], unbound: ['node-003'] });
    state = remove(state, ['node-002'], context);
    expect(state.error).toBeNull();
    const position = state.workflow.nodes.find(node => node.nodeId === 'node-003')!;
    expect(solanaLiquidityDetails(position)).toMatchObject({ source: null, maxDevUsdc: '5', maxSol: '0.05' });
    expect(position.dependencies).toEqual([]);
    expect(state.workflow.resourceEdges).toEqual([]);
  });
  it('Base → Arbitrum bridge then swap (a fixed composition): deleting either step removes the composition, and the extra step is reported', () => {
    const state = chat('compose bridge 1.25 USDC from Base to Arbitrum slippage 50 bps then swap to WETH slippage 75 bps', base);
    const [bridge, swap] = cards(state);
    expect(planCanvasRemoval(state.workflow, [bridge!])).toEqual({ removed: [bridge, swap], cascaded: [swap], unbound: [] });
    for (const target of [bridge!, swap!]) {
      expect(resolveCanvasRemoval(state.workflow, [target], base)).toEqual({ removed: [bridge, swap], cascaded: [target === bridge ? swap : bridge], unbound: [] });
      const after = remove(state, [target], base);
      expect(after.error).toBeNull(); expect(cards(after)).toEqual([]);
    }
  });
  it('Supply → Borrow → Swap: deleting any step never refuses; what cannot stand alone goes with it and is reported, the rest stays valid', () => {
    const state = chat(`compose supply 0.1 USDC to Aave then borrow 0.01 USDC then swap borrowed USDC to WETH on Base Sepolia slippage 50 bps owner ${OWNER}`, sepolia);
    const [supply, borrow, swap] = cards(state);
    // Borrow: the swap spends its output and goes too; the Supply is a valid step on its own and stays.
    expect(resolveCanvasRemoval(state.workflow, [borrow!], sepolia)).toEqual({ removed: [borrow, swap], cascaded: [swap], unbound: [] });
    for (const target of [supply!, borrow!, swap!]) {
      const plan = resolveCanvasRemoval(state.workflow, [target], sepolia)!;
      const after = remove(state, [target], sepolia);
      expect(after.error, `${target}: ${after.error}`).toBeNull();
      expect(cards(after)).toEqual([supply, borrow, swap].filter(id => !plan.removed.includes(id!)));
      expect(plan.cascaded).toEqual(plan.removed.filter(id => id !== target));
      // BUILD-FLOFI-PRODUCT-UX-001: cascading away every financial step leaves the empty draft (never linted); otherwise the rest stays valid.
      if (after.workflow.nodes.length) expect(() => validateWorkflowDraft(after.workflow, sepolia)).not.toThrow();
      else expect(cards(after)).toEqual([]);
    }
  });
  it('Base → Arbitrum bridge and Uniswap liquidity: deleting any step removes the composition and keeps a valid, editable draft', () => {
    const state = chat(`bridge 100 USDC from Base to Arbitrum via LI.FI and create Uniswap liquidity ticks -200100 to -199900 recipient ${OWNER}`, base);
    for (const target of cards(state)) {
      const after = remove(state, [target], base);
      expect(after.error, `${target}: ${after.error}`).toBeNull();
      expect(cards(after)).toEqual([]);
      expect(cards(chat('swap 5 USDC to WETH on Base slippage 50 bps', base, after))).toHaveLength(1);
    }
  });
});

describe('undo and redo after deletion', () => {
  function history(...commands: ((state: EditorHistory) => Command)[]) {
    let state = initialEditorHistory();
    for (const make of commands) state = editorHistoryReducer(state, { type: 'COMMAND', command: make(state), context: base });
    return state;
  }
  it('undo restores the deleted step as a new revision; redo deletes it again; drafts of the deleted step are discarded', () => {
    let state = history(s => parseLocalCommand('swap 10 USDC to WETH on Base slippage 50 bps', s.editor.workflow, base, OWNER));
    state = editorHistoryReducer(state, { type: 'EDIT_CANVAS_AMOUNT', id: 'node-002', amount: '12', context: base });
    expect(state.amountInputs['node-002']).toBe('12');
    const before = state.editor.workflow;
    state = editorHistoryReducer(state, { type: 'COMMAND', command: { type: 'REMOVE', nodeId: 'node-002', source: 'CANVAS', baseRevision: before.revision }, context: base });
    expect(state.editor.error).toBeNull();
    expect(cards(state.editor)).toEqual([]);
    // No orphaned draft of the deleted step remains.
    expect(state.amountInputs).toEqual({});
    const undone = editorHistoryReducer(state, { type: 'UNDO' });
    expect(cards(undone.editor)).toEqual(['node-002']);
    expect(undone.editor.workflow.revision).toBeGreaterThan(state.editor.workflow.revision);
    const redone = editorHistoryReducer(undone, { type: 'REDO' });
    expect(cards(redone.editor)).toEqual([]);
    expect(redone.editor.workflow.revision).toBeGreaterThan(undone.editor.workflow.revision);
  });
});
