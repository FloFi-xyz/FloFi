// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext } from '@defi-workflow-engine/reference-linter';
import { amountOf, type Command } from './commands';
import { deletableCanvasNodes } from './canvas-keyboard';
import { editorHistoryReducer, initialEditorHistory, templateEditorHistory, planCanvasDuplicate, type EditorHistory } from './editor-history';
import { composerActions } from './composer-presentation';
import { CANVAS_COLUMN, defaultCanvasPosition, shownCanvasPositions } from './canvas-layout';
import { createAuthoredLending } from './lending-authoring';

const context = createReviewContext({ registryId: referenceRegistry.registryId,
  capabilityId: referenceRegistry.capabilities[0]?.id, actionId: referenceRegistry.actions[0]?.id, assets: baseAssetRegistry });
type EditInput = Command extends infer T ? T extends Command ? Omit<T, 'baseRevision'> : never : never;
const edit = (state: EditorHistory, command: EditInput) =>
  editorHistoryReducer(state, { type: 'COMMAND', command: { ...command, baseRevision: state.editor.workflow.revision } as Command, context });
const add = (state: EditorHistory, kind: 'read' | 'transform' | 'condition' = 'transform') =>
  edit(state, { type: 'ADD', kind, source: 'CANVAS' });

describe('canvas edit history', () => {
  it('restores the exact durable lending IR only into an untouched Canvas; edited Canvas cannot be overwritten',()=>{
    const workflow=createAuthoredLending('workflow-local',3,{supply:'0.1',borrow:'0.01',slippage:'50',owner:'0x1111111111111111111111111111111111111111'});
    const initial=templateEditorHistory(),restored=editorHistoryReducer(initial,{type:'RESTORE_LENDING_CANVAS',workflow});
    expect(restored.editor.workflow).toEqual(workflow);expect(restored.past).toHaveLength(0);
    const edited=add(initial);expect(editorHistoryReducer(edited,{type:'RESTORE_LENDING_CANVAS',workflow})).toBe(edited);
    const invalid=structuredClone(workflow);invalid.nodes[2]!.inputs=[];
    expect(editorHistoryReducer(initial,{type:'RESTORE_LENDING_CANVAS',workflow:invalid})).toBe(initial);
  });
  it('gives only an untouched draft the identity an external proposal was composed on', () => {
    const fresh = editorHistoryReducer(templateEditorHistory(), { type: 'ADOPT_DRAFT_IDENTITY', workflowId: 'workflow-request-1' });
    const adopted = editorHistoryReducer(fresh, { type: 'ADOPT_DRAFT_IDENTITY', workflowId: 'workflow-local' });
    expect(adopted.editor.workflow).toEqual({ ...templateEditorHistory().editor.workflow, workflowId: 'workflow-local' });
    expect(Object.isFrozen(adopted.editor.workflow)).toBe(true);
    const edited = add(fresh);
    expect(editorHistoryReducer(edited, { type: 'ADOPT_DRAFT_IDENTITY', workflowId: 'workflow-local' })).toBe(edited);
    expect(editorHistoryReducer(fresh, { type: 'ADOPT_DRAFT_IDENTITY', workflowId: '../other' })).toBe(fresh);
  });
  it('duplicates one selected node with a new ID and one undoable offset', () => {
    let state = templateEditorHistory();
    const before = state.past.length;
    const plan = planCanvasDuplicate(state.editor.workflow, state.layout, ['node-001'], context)!;
    state = editorHistoryReducer(state, { type: 'DUPLICATE', nodeIds: ['node-001'], context });
    expect(state.past).toHaveLength(before + 1);
    expect(state.editor.workflow.nodes).toHaveLength(2);
    expect(plan.ids[0]).not.toBe('node-001');
    expect(state.layout[plan.ids[0]!]).toMatchObject({ x: 121, y: 126 });
    state = editorHistoryReducer(state, { type: 'UNDO' });
    expect(state.editor.workflow.nodes).toHaveLength(1);
    state = editorHistoryReducer(state, { type: 'REDO' });
    expect(state.editor.workflow.nodes.map(node => node.nodeId)).toContain(plan.ids[0]);
    expect(state.layout[plan.ids[0]!]).toMatchObject({ x: 121, y: 126 });
  });

  it('duplicates a connected group and keeps only edges inside the selection', () => {
    let state = add(add(templateEditorHistory()), 'condition');
    state = edit(state, { type: 'CONNECT', from: 'node-001', to: 'node-002', source: 'CANVAS' });
    state = edit(state, { type: 'CONNECT', from: 'node-002', to: 'node-003', source: 'CANVAS' });
    state = editorHistoryReducer(state, { type: 'MOVE', positions: { 'node-002': { x: 330, y: 210 }, 'node-003': { x: 600, y: 250 } } });
    const plan = planCanvasDuplicate(state.editor.workflow, state.layout, ['node-002', 'node-003'], context)!;
    const before = state.past.length;
    state = editorHistoryReducer(state, { type: 'DUPLICATE', nodeIds: ['node-002', 'node-003'], context });
    expect(state.past).toHaveLength(before + 1);
    expect(new Set(state.editor.workflow.nodes.map(node => node.nodeId)).size).toBe(5);
    expect(state.layout[plan.ids[1]!]!.x - state.layout[plan.ids[0]!]!.x).toBe(270);
    expect(state.layout[plan.ids[1]!]!.y - state.layout[plan.ids[0]!]!.y).toBe(40);
    expect(state.editor.workflow.resourceEdges.filter(edge => plan.ids.includes(edge.toNodeId)))
      .toEqual([{ fromNodeId: plan.ids[0], outputId: 'result', toNodeId: plan.ids[1], inputName: 'source' }]);
    expect(state.editor.workflow.nodes.find(node => node.nodeId === plan.ids[0])?.dependencies).toEqual([]);
    state = editorHistoryReducer(state, { type: 'UNDO' });
    expect(state.editor.workflow.nodes).toHaveLength(3);
    expect(state.editor.workflow.resourceEdges).toHaveLength(2);
    state = editorHistoryReducer(state, { type: 'REDO' });
    expect(state.editor.workflow.nodes).toHaveLength(5);
    expect(state.editor.workflow.resourceEdges).toHaveLength(3);
  });
  it('records a group move once, preserving relative positions through undo and redo', () => {
    let state = add(add(templateEditorHistory()), 'condition');
    state = editorHistoryReducer(state, { type: 'MOVE', positions: { 'node-002': { x: 330, y: 210 }, 'node-003': { x: 600, y: 210 } } });
    const before = state.past.length;
    state = editorHistoryReducer(state, { type: 'MOVE', positions: { 'node-002': { x: 400, y: 245 }, 'node-003': { x: 670, y: 245 } } });
    expect(state.past).toHaveLength(before + 1);
    expect(state.layout['node-003']!.x - state.layout['node-002']!.x).toBe(270);
    state = editorHistoryReducer(state, { type: 'UNDO' });
    expect(state.layout['node-002']).toMatchObject({ x: 330, y: 210 });
    expect(state.layout['node-003']).toMatchObject({ x: 600, y: 210 });
    state = editorHistoryReducer(state, { type: 'REDO' });
    expect(state.layout['node-002']).toMatchObject({ x: 400, y: 245 });
    expect(state.layout['node-003']).toMatchObject({ x: 670, y: 245 });
  });

  it('deletes connected selected nodes in one edit and restores edges on undo', () => {
    let state = add(add(templateEditorHistory()), 'condition');
    state = edit(state, { type: 'CONNECT', from: 'node-002', to: 'node-003', source: 'CANVAS' });
    state = editorHistoryReducer(state, { type: 'MOVE', positions: { 'node-002': { x: 400, y: 240 }, 'node-003': { x: 670, y: 240 } } });
    expect(deletableCanvasNodes(state.editor.workflow, ['node-002', 'node-003'])).toEqual(['node-002', 'node-003']);
    state = edit(state, { type: 'REMOVE_MANY', nodeIds: ['node-002', 'node-003'], source: 'CANVAS' });
    expect(state.editor.workflow.nodes.map(node => node.nodeId)).toEqual(['node-001']);
    expect(state.editor.workflow.resourceEdges).toHaveLength(0);
    state = editorHistoryReducer(state, { type: 'UNDO' });
    const revisionAfterUndo = state.editor.workflow.revision;
    expect(state.editor.workflow.nodes).toHaveLength(3);
    expect(state.editor.workflow.resourceEdges).toHaveLength(1);
    state = editorHistoryReducer(state, { type: 'UNDO' });
    expect(state.editor.workflow.revision).toBe(revisionAfterUndo);
    expect(state.layout['node-002']).toBeUndefined();
    state = editorHistoryReducer(state, { type: 'REDO' });
    expect(state.editor.workflow.revision).toBe(revisionAfterUndo);
    state = editorHistoryReducer(state, { type: 'REDO' });
    expect(state.editor.workflow.nodes).toHaveLength(1);
    expect(state.editor.workflow.resourceEdges).toHaveLength(0);
  });

  it('restores edits, disconnects, and clears redo after a fresh edit', () => {
    let state = add(templateEditorHistory());
    state = edit(state, { type: 'SET_AMOUNT', nodeId: 'node-002', amount: '42', source: 'CANVAS' });
    state = edit(state, { type: 'CONNECT', from: 'node-001', to: 'node-002', source: 'CANVAS' });
    state = edit(state, { type: 'DISCONNECT', from: 'node-001', to: 'node-002', source: 'CANVAS' });
    state = editorHistoryReducer(state, { type: 'UNDO' });
    expect(state.editor.workflow.resourceEdges).toHaveLength(1);
    state = editorHistoryReducer(state, { type: 'UNDO' });
    expect(state.editor.workflow.resourceEdges).toHaveLength(0);
    state = editorHistoryReducer(state, { type: 'UNDO' });
    expect(amountOf(state.editor.workflow.nodes[1]!)).not.toBe('42');
    state = editorHistoryReducer(state, { type: 'REDO' });
    expect(amountOf(state.editor.workflow.nodes[1]!)).toBe('42');
    state = edit(state, { type: 'SET_AMOUNT', nodeId: 'node-002', amount: '99', source: 'CANVAS' });
    expect(state.future).toHaveLength(0);
    expect(editorHistoryReducer(state, { type: 'REDO' })).toBe(state);
  });

  // BUILD-SOLANA-MAINNET-001 (intentional change, requirement D): a locked amount protects the amount from edits, not the step from deletion.
  it('deletes selected connected steps even when one has a locked amount', () => {
    let state = add(add(templateEditorHistory()), 'condition');
    state = edit(state, { type: 'CONNECT', from: 'node-002', to: 'node-003', source: 'CANVAS' });
    state = edit(state, { type: 'LOCK', nodeId: 'node-003', locked: true, source: 'CANVAS' });
    expect(deletableCanvasNodes(state.editor.workflow, ['node-002', 'node-003'])).toEqual(['node-002', 'node-003']);
  });

  // BUILD-FLOFI-BUILDER-UX-002: a card is pinned where it is drawn whenever the layout changes, so no untouched card ever moves.
  const swap = (state: EditorHistory) => edit(state, { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '1', slippage: '50', source: 'CHAT' } as EditInput);
  const drawn = (state: EditorHistory) => shownCanvasPositions(composerActions(state.editor.workflow), state.layout);
  it('pins a step the chat added (no position) where it is first drawn, and a linked step beside the step it consumes', () => {
    let state = swap(initialEditorHistory());
    const [first] = composerActions(state.editor.workflow);
    expect(state.layout[first!.nodeId]).toMatchObject(defaultCanvasPosition(0));
    state = swap(state);
    const [, second] = composerActions(state.editor.workflow);
    state = edit(state, { type: 'CONNECT', from: first!.nodeId, to: second!.nodeId, source: 'CANVAS' });
    expect(state.layout[second!.nodeId]).toMatchObject(defaultCanvasPosition(1));
    expect(state.layout[second!.nodeId]!.x - state.layout[first!.nodeId]!.x).toBe(CANVAS_COLUMN);
  });
  it('never moves an untouched card when another card is moved, duplicated or set up', () => {
    // A restored workflow has no stored places: every card is drawn from the flow placement.
    let state = editorHistoryReducer(swap(swap(initialEditorHistory())), { type: 'LOAD_LAYOUT', layout: {} });
    const [first, second] = composerActions(state.editor.workflow), before = drawn(state);
    state = editorHistoryReducer(state, { type: 'MOVE', positions: { [first!.nodeId]: { x: before[second!.nodeId]!.x + 20, y: before[second!.nodeId]!.y + 10 } } });
    expect(drawn(state)[second!.nodeId]).toEqual(before[second!.nodeId]);
    state = editorHistoryReducer(state, { type: 'LOAD_LAYOUT', layout: {} });
    state = editorHistoryReducer(state, { type: 'DUPLICATE', nodeIds: [first!.nodeId], context });
    expect(drawn(state)[first!.nodeId]).toEqual(before[first!.nodeId]);
    expect(drawn(state)[second!.nodeId]).toEqual(before[second!.nodeId]);
    state = editorHistoryReducer(state, { type: 'UNDO' });
    state = editorHistoryReducer(state, { type: 'START_ACTION_SETUP', action: 'swap', position: defaultCanvasPosition(0) });
    expect(drawn(state)[first!.nodeId]).toEqual(before[first!.nodeId]);
    state = editorHistoryReducer(state, { type: 'REMOVE_ACTION_SETUP' });
    expect(drawn(state)).toEqual(before);
  });
});
