// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ARB-001 Phase 7, UX-003 / UX-004: processing CTA projection and the clean "Create new workflow" draft. Presentation only. */
import { describe, expect, it } from 'vitest';
import { projectCanvasAction } from './canvas-lifecycle';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from './execution-lifecycle';
import { isFinalExecutionResult, projectExecutionResult } from './execution-result';
import { restoredLocalExecutionKind } from './execution-recovery';
import { editorHistoryReducer, initialEditorHistory } from './editor-history';
import { canvasAddCommand } from './canvas-authoring';
import { reviewFixture, reviewNow } from '../test-utils/review-fixture';
import type { ExecutionControlsState } from '../state/execution-controls';

const controls = { requesting: false, verifying: false, canContinue: false, canCheck: false };
describe('UX-003 processing states keep the CTA locked in place', () => {
  it('marks only Simulating and Waiting for wallet as processing; authority and labels are unchanged', () => {
    const f: ExecutionControlsState = { ...reviewFixture(), execution: { ready: false, started: false, start: null, prompt: null, expiresAt: null } };
    if (f.source.kind !== 'public') throw new Error('Expected the public swap review fixture');
    expect(projectCanvasAction({ ...f, source: { ...f.source, state: { ...f.source.state, busy: 'simulation-request' } } }, controls, reviewNow))
      .toEqual({ kind: 'status', label: 'Simulating workflow…', disabled: true, processing: true });
    expect(projectCanvasAction(f, { ...controls, requesting: true }, reviewNow)).toEqual({ kind: 'status', label: 'Waiting for wallet…', disabled: true, processing: true });
    expect(projectCanvasAction(f, { ...controls, verifying: true }, reviewNow)).toEqual({ kind: 'status', label: 'Reconciling…', disabled: true });
    expect(projectCanvasAction(f, controls, reviewNow).processing).toBeUndefined();
  });
});

describe('UX-004 final results and the clean new draft', () => {
  const f = reviewFixture(), hash = '0x' + 'a'.repeat(64);
  const progress = (state: string) => projectExecutionLifecycle(f.workflow, f.context, { ...f.source, state: { ...f.source.state,
    run: { ...('run' in f.source.state ? f.source.state.run : {}), attempts: [{ step: 'swap', state, txHash: ['HASH', 'PENDING', 'CONFIRMED', 'REVERTED'].includes(state) ? hash : null }] } } } as unknown as ExecutionLifecycleSource);
  it.each([['CONFIRMED', true], ['REVERTED', true], ['REJECTED', true], ['CANCELLED', true], ['UNKNOWN', false], ['PENDING', false], ['HASH', false], ['PREPARED', false]] as const)(
    '%s → final result %s', (state, final) => {
      expect(isFinalExecutionResult(progress(state))).toBe(final);
      if (final) expect(projectExecutionResult(progress(state))).not.toBeNull();
    });
  it('is never final without a started run', () => {
    expect(isFinalExecutionResult(null)).toBe(false); expect(isFinalExecutionResult(projectExecutionLifecycle(f.workflow, f.context, { kind: 'unavailable', state: { busy: false, error: null } }))).toBe(false);
  });
  it('starts an empty Build draft under a fresh identity: no actions, drafts, layout, setup or undo history', () => {
    let history = editorHistoryReducer(initialEditorHistory(), { type: 'COMMAND', command: canvasAddCommand('swap', 0, null, '5'), context: f.context, position: { x: 1, y: 2 } });
    history = editorHistoryReducer(history, { type: 'START_ACTION_SETUP', action: 'transfer', position: { x: 3, y: 4 } });
    expect(history.editor.workflow.nodes.some(node => !node.actionType.startsWith('mock-'))).toBe(true);
    const fresh = editorHistoryReducer(history, { type: 'NEW_WORKFLOW', workflowId: 'workflow-0f8fad5b-d9cb-469f-a165-70867728950e' });
    const initial = initialEditorHistory();
    expect(fresh).toMatchObject({ actionSetup: null, amountInputs: {}, recipientInputs: {}, bridgeNetworkInputs: {}, cryptoSelections: {}, layout: {}, past: [], future: [], setupSerial: 0 });
    expect(fresh.editor.workflow).toEqual({ ...initial.editor.workflow, workflowId: 'workflow-0f8fad5b-d9cb-469f-a165-70867728950e' });
    expect(fresh.editor.workflow.revision).toBe(0); expect(fresh.editor.error).toBeNull();
    expect(editorHistoryReducer(history, { type: 'NEW_WORKFLOW', workflowId: '../not an id' })).toBe(history);
  });
  it('restored local runs attach only when the shell passes them (it passes none to a created draft)', () => {
    const workflow = initialEditorHistory().editor.workflow;
    expect(restoredLocalExecutionKind(workflow, { composition: true, liquidity: false, cow: false })).toBe('composition');
    expect(restoredLocalExecutionKind(workflow, { composition: false, liquidity: false, cow: false })).toBeNull();
  });
});
