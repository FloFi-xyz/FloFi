// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (A01/A07): the two reported stale-downstream cases, through the real editor reducer, editor history and
 * sequence model. Pure and offline: no quote, wallet or network (the live estimate is the test's own value).
 */
import { describe, expect, it } from 'vitest';
import { lintWorkflow } from '@defi-workflow-engine/reference-linter';
import { composeWorkflow, dappReviewContext, operationSteps, reviewContextOf } from '../engine/strategy-engine';
import type { Command } from './commands';
import { dependencyStates, firstDependencyIssue, producerBasis, type ProducerEstimate } from './dependency-consistency';
import { editorReducer, initialEditor, type EditorState } from './editor';
import { editorHistoryReducer, initialEditorHistory } from './editor-history';
import { workflowSequence } from './workflow-sequence';

const OWNER = '0x1111111111111111111111111111111111111111';
const context = dappReviewContext();
const sequenceOf = (state: EditorState) => workflowSequence(state.workflow, step => lintWorkflow(step, reviewContextOf(step)));
const statesOf = (state: EditorState, estimate: Readonly<Record<string, string>> = {}) =>
  dependencyStates(state.workflow, sequenceOf(state), state.dependencyBases, id => estimate[id] ? { expected: estimate[id]! } satisfies ProducerEstimate : null);
/** The Canvas a person builds card by card, linked in order (each command at the Canvas's current revision), from a strategy's own commands. */
function canvasOf(steps: readonly Record<string, unknown>[]): EditorState {
  const composed = composeWorkflow({ version: 2, steps });
  if (!composed.ok) throw new Error(composed.code);
  let state = initialEditor();
  for (const op of operationSteps(composed)) {
    state = editorReducer(state, { ...op.command, baseRevision: state.workflow.revision } as Command, context);
    if (state.error) throw new Error(state.error);
  }
  return state;
}
/** The same step re-authored with another amount, as the card's own edit command (SET_* of the existing node). */
function edited(state: EditorState, index: number, strategy: Record<string, unknown>): Command {
  const composed = composeWorkflow(strategy);
  if (!composed.ok) throw new Error(composed.code);
  const add = operationSteps(composed)[0]!.command as Command & { type: string; amount?: string };
  const node = state.workflow.nodes.filter(n => !n.actionType.startsWith('mock-'))[index]!;
  // A Base swap card's amount edit is SET_SWAP_AMOUNT; every other card is re-authored by its own SET_* command.
  if (add.type === 'ADD_SWAP') return { type: 'SET_SWAP_AMOUNT', nodeId: node.nodeId, amount: add.amount!, source: 'CANVAS', baseRevision: state.workflow.revision } as Command;
  return { ...add, type: add.type.replace(/^ADD_/, 'SET_'), nodeId: node.nodeId, baseRevision: state.workflow.revision } as Command;
}

const SWAP = (amount: string) => ({ action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount, slippageBps: 100 });
const SUPPLY = (amount: string) => ({ action: 'supply', network: 'base', asset: 'WETH', amount, beneficiary: OWNER });

describe('A01/A07: a dependent amount never stays silently stale', () => {
  it('upstream 0.1 → 0.2 USDC with the dependent amount left as it was: stale until the dependent step is set again', () => {
    const built = canvasOf([SWAP('0.1'), SUPPLY('0.00004')]);
    const [swap, supply] = built.workflow.nodes.filter(n => !n.actionType.startsWith('mock-'));
    expect(sequenceOf(built)!.steps[1]).toMatchObject({ fundedBy: 0 });
    // Set against the swap as it is: consistent.
    expect(built.dependencyBases).toEqual({ [supply!.nodeId]: producerBasis(swap!) });
    expect(firstDependencyIssue(statesOf(built))).toBeNull();
    // The swap becomes 0.2 USDC; the Supply keeps 0.00004 WETH (what 0.1 USDC was estimated to deliver).
    const changed = editorReducer(built, edited(built, 0, SWAP('0.2')), context);
    expect(changed.error).toBeNull();
    expect(firstDependencyIssue(statesOf(changed))).toEqual({ kind: 'stale', step: 2, from: 1, reason: 'UPSTREAM_CHANGED' });
    // An unrelated or refused command never clears it.
    const refused = editorReducer(changed, { ...edited(changed, 0, SWAP('0.3')), baseRevision: 0 } as Command, context);
    expect(refused.error).toMatch(/BASE_REVISION_CONFLICT/);
    expect(firstDependencyIssue(statesOf(refused))).toMatchObject({ reason: 'UPSTREAM_CHANGED' });
    // Setting the dependent amount again (its own edit) records the swap as it is now.
    const reset = editorReducer(changed, edited(changed, 1, SUPPLY('0.00008')), context);
    expect(reset.error).toBeNull();
    expect(firstDependencyIssue(statesOf(reset))).toBeNull();
    // Changing the swap back to what the Supply was set against makes it consistent again too (the record names the swap's declaration).
    expect(firstDependencyIssue(statesOf(editorReducer(changed, edited(changed, 0, SWAP('0.1')), context)))).toBeNull();
  });

  it('bridge output 0.097076 → 0.097075 while the next deposit keeps 0.097076: stale (it would claim more than arrives)', () => {
    const built = canvasOf([SWAP('0.1'), SUPPLY('0.097076')]);
    const producer = built.workflow.nodes.filter(n => !n.actionType.startsWith('mock-'))[0]!.nodeId;
    expect(firstDependencyIssue(statesOf(built, { [producer]: '0.097076' }))).toBeNull();
    expect(firstDependencyIssue(statesOf(built, { [producer]: '0.097075' }))).toEqual({ kind: 'stale', step: 2, from: 1, reason: 'ABOVE_UPSTREAM' });
    // A dependent amount below the estimate is the person's own cap ("up to"): never stale on its own.
    const below = editorReducer(built, edited(built, 1, SUPPLY('0.05')), context);
    expect(firstDependencyIssue(statesOf(below, { [producer]: '0.097075' }))).toBeNull();
    // No estimate known: only the record is judged (never a guess).
    expect(firstDependencyIssue(statesOf(built))).toBeNull();
  });

  // flofi-workflow review: a reloaded or reopened Canvas has no record; the next edit of the earlier step must still be stale at once.
  it('after a reload (no record), an upstream edit is stale at once', () => {
    const built = canvasOf([SWAP('0.1'), SUPPLY('0.00004')]);
    const reloaded: EditorState = { workflow: built.workflow, error: null };
    const changed = editorReducer(reloaded, edited(reloaded, 0, SWAP('0.2')), context);
    expect(changed.error).toBeNull();
    expect(firstDependencyIssue(statesOf(changed))).toEqual({ kind: 'stale', step: 2, from: 1, reason: 'UPSTREAM_CHANGED' });
  });
  it('the current expected output decides; an expired estimate gives no verdict', () => {
    const built = canvasOf([SWAP('0.1'), SUPPLY('0.00004')]);
    const [swap] = built.workflow.nodes.filter(n => !n.actionType.startsWith('mock-'));
    const judge = (estimate: ProducerEstimate | null, completed: Parameters<typeof dependencyStates>[4] = []) =>
      firstDependencyIssue(dependencyStates(built.workflow, sequenceOf(built), built.dependencyBases, id => id === swap!.nodeId ? estimate : null, completed));
    expect(judge({ expected: '0.0000399' })).toMatchObject({ reason: 'ABOVE_UPSTREAM' });
    expect(judge({ expected: '0.0000401' })).toBeNull();
    expect(judge({ expected: '0.00003', expiresAt: '2020-01-01T00:00:00.000Z' })).toBeNull();
  });
  it('a step that spends another asset, and an independent step, are never judged', () => {
    const built = canvasOf([SWAP('0.1'), { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '5', slippageBps: 100 }]);
    expect(built.dependencyBases).toBeUndefined();
    expect([...statesOf(built, {}).values()]).toEqual([]);
  });

  it('the editor history keeps the record through undo and redo, so a stale dependent amount is not cleared by them', () => {
    const built = canvasOf([SWAP('0.1'), SUPPLY('0.00004')]);
    let history = { ...initialEditorHistory(), editor: built };
    history = editorHistoryReducer(history, { type: 'COMMAND', command: edited(built, 0, SWAP('0.2')), context });
    expect(firstDependencyIssue(statesOf(history.editor))).toMatchObject({ reason: 'UPSTREAM_CHANGED' });
    history = editorHistoryReducer(history, { type: 'UNDO' });
    expect(firstDependencyIssue(statesOf(history.editor))).toBeNull();
    history = editorHistoryReducer(history, { type: 'REDO' });
    expect(firstDependencyIssue(statesOf(history.editor))).toMatchObject({ reason: 'UPSTREAM_CHANGED' });
  });
});
