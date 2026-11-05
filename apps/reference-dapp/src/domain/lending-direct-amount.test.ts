// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001 (workstream 3): an ordinary Supply, Borrow, Repay or Withdraw amount edit on an existing Canvas card
 * applies directly on Enter (`commitCanvasAmount`), exactly like Swap and Bridge: one COMMAND through the history guard, the card keeps its
 * asset, network and links, the workflow revision moves (so every Simulation, Review and authorization of the previous revision is stale),
 * and no proposal is created. Nothing here signs, submits or authorizes anything.
 */
import { describe, expect, it } from 'vitest';
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import { actionReviewValue, canvasAmountCommand, canvasAmountMessage } from './canvas-action-setup';
import { cryptoReviewContext, selectCryptoNetwork, type CryptoAction } from './crypto-action-picker';
import { editorHistoryReducer, initialEditorHistory, type EditorHistory } from './editor-history';
import { borrowDetails, supplyDetails } from './supply-authoring';
import { workflowSequence } from './workflow-sequence';

const NETWORK = 'Arbitrum One';
/** A disposable, well-formed owner address (no key exists for it here). */
const OWNER = '0x1111111111111111111111111111111111111111';
const context = cryptoReviewContext(NETWORK);
const hashOf = (state: EditorHistory) => hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(state.editor.workflow)));
/** What the Canvas card does on Enter (`commitCanvasAmount`): the card's own command through the history guard, never a proposal. */
function commit(state: EditorHistory, id: string): EditorHistory {
  const command = canvasAmountCommand(state.editor, state.actionSetup, state.amountInputs, id, context, state.bridgeNetworkInputs, state.cryptoSelections, state.recipientInputs);
  const authoringAmount = actionReviewValue(state.actionSetup, id, state.amountInputs[id], state.bridgeNetworkInputs[id], state.cryptoSelections[id], state.recipientInputs[id])!;
  return editorHistoryReducer(state, { type: 'COMMAND', command, context, authoringId: id, authoringAmount });
}
function add(state: EditorHistory, action: CryptoAction, amount: string, asset?: string): EditorHistory {
  state = editorHistoryReducer(state, { type: 'START_ACTION_SETUP', action, position: { x: state.editor.workflow.nodes.length * 300, y: 0 },
    ...['supply', 'borrow', 'repay'].includes(action) ? { beneficiary: OWNER } : {} });
  const id = state.actionSetup!.id;
  const selection = asset ? { ...selectCryptoNetwork(action, NETWORK), from: asset } : selectCryptoNetwork(action, NETWORK);
  state = editorHistoryReducer(state, { type: 'EDIT_CRYPTO_SELECTION', id, selection, context });
  state = editorHistoryReducer(state, { type: 'EDIT_CANVAS_AMOUNT', id, amount, context });
  const next = commit(state, id);
  expect(next.actionSetup, `${action} setup applied`).toBeNull();
  return next;
}
const nodeOf = (state: EditorHistory, actionType: string) => state.editor.workflow.nodes.find(node => node.actionType === actionType)!;
function swapSupplyBorrow(): EditorHistory {
  let state = add(initialEditorHistory(), 'swap', '3');
  state = add(state, 'supply', '0.0013', 'WETH');
  state = add(state, 'borrow', '1', 'USDC');
  return state;
}

describe('workstream 3: Enter applies an ordinary lending amount edit directly', () => {
  it('authors Swap 3 USDC → WETH, Supply WETH and Borrow USDC on Arbitrum One as one ordered sequence', () => {
    const state = swapSupplyBorrow();
    expect(state.editor.workflow.nodes.map(node => node.actionType)).toEqual(['asset.swap.exact-input', 'supply', 'borrow']);
    const supply = supplyDetails(nodeOf(state, 'supply') as never)!, borrow = borrowDetails(nodeOf(state, 'borrow') as never)!;
    expect(supply).toMatchObject({ network: NETWORK, asset: 'WETH', amount: '0.0013' });
    expect(borrow).toMatchObject({ network: NETWORK, asset: 'USDC', amount: '1' });
    const sequence = workflowSequence(state.editor.workflow, () => ({ findings: [] }) as never);
    expect(sequence?.steps.map(step => step.nodeId)).toEqual(state.editor.workflow.nodes.map(node => node.nodeId));
    // Supply spends the WETH the Swap delivers (exact token identity); Borrow draws USDC on its own.
    expect(sequence?.steps.map(step => step.fundedBy)).toEqual([null, 0, null]);
  });

  it('Supply 0.0013 → 0.0010 WETH + Enter: the card shows 0.0010 WETH at once, keeps its links, and the revision moves', () => {
    let state = swapSupplyBorrow();
    const supply = nodeOf(state, 'supply'), dependencies = [...supply.dependencies];
    const before = { revision: state.editor.workflow.revision, hash: hashOf(state) };
    state = editorHistoryReducer(state, { type: 'EDIT_CANVAS_AMOUNT', id: supply.nodeId, amount: '0.0010', context });
    // The draft is not the workflow until Enter.
    expect(supplyDetails(nodeOf(state, 'supply') as never)?.amount).toBe('0.0013');
    state = commit(state, supply.nodeId);
    const after = nodeOf(state, 'supply');
    // The canonical amount is normalized: 0.0010 WETH and 0.001 WETH are the same 1_000_000_000_000_000 wei.
    expect(supplyDetails(after as never)).toMatchObject({ network: NETWORK, asset: 'WETH', amount: '0.001' });
    expect(after.nodeId).toBe(supply.nodeId); expect(after.dependencies).toEqual(dependencies);
    expect(state.editor.workflow.revision).toBe(before.revision + 1); expect(hashOf(state)).not.toBe(before.hash);
    expect(state.amountInputs).toEqual({});
    // The Swap still funds the Supply (exact WETH identity), so Supply spends what the Swap actually delivers, capped by 0.0010 WETH.
    const sequence = workflowSequence(state.editor.workflow, () => ({ findings: [] }) as never)!;
    expect(sequence.steps[1]!.fundedBy).toBe(0);
  });

  it('Borrow 1 → 0.5 USDC + Enter: the card shows 0.5 USDC at once', () => {
    let state = swapSupplyBorrow();
    const borrow = nodeOf(state, 'borrow'), revision = state.editor.workflow.revision;
    state = editorHistoryReducer(state, { type: 'EDIT_CANVAS_AMOUNT', id: borrow.nodeId, amount: '0.5', context });
    state = commit(state, borrow.nodeId);
    expect(borrowDetails(nodeOf(state, 'borrow') as never)).toMatchObject({ network: NETWORK, asset: 'USDC', amount: '0.5' });
    expect(state.editor.workflow.revision).toBe(revision + 1);
    expect(nodeOf(state, 'borrow').dependencies).toEqual(borrow.dependencies);
  });

  it.each(['0', '', 'abc', '-1', '0.0000000000000000001'])('an invalid Supply amount (%j) is refused with a message and never changes the workflow', amount => {
    const start = swapSupplyBorrow(), supply = nodeOf(start, 'supply');
    const state = editorHistoryReducer(start, { type: 'EDIT_CANVAS_AMOUNT', id: supply.nodeId, amount, context });
    let message: string | null = null;
    try { commit(state, supply.nodeId); } catch (cause) { message = canvasAmountMessage(cause, NETWORK); }
    expect(message).toBeTruthy();
    expect(state.editor.workflow).toBe(start.editor.workflow);
  });

  it('a repeated commit of the same draft (Enter, then leaving the card) is a no-op', () => {
    let state = swapSupplyBorrow();
    const supply = nodeOf(state, 'supply');
    state = editorHistoryReducer(state, { type: 'EDIT_CANVAS_AMOUNT', id: supply.nodeId, amount: '0.0011', context });
    const draft = state;
    state = commit(state, supply.nodeId);
    const command = canvasAmountCommand(draft.editor, null, draft.amountInputs, supply.nodeId, context, draft.bridgeNetworkInputs, draft.cryptoSelections, draft.recipientInputs);
    const again = editorHistoryReducer(state, { type: 'COMMAND', command, context, authoringId: supply.nodeId, authoringAmount: actionReviewValue(null, supply.nodeId, '0.0011')! });
    expect(again).toBe(state);
  });
});
