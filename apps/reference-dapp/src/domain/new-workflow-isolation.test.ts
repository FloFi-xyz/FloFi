// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-P0-MAINNET-EXECUTION-RELIABILITY (Incident F): a workflow the owner explicitly creates with New workflow never shows a run of another
 * workflow identity — final or still unresolved — while that run's record and observation are untouched (presentation only). Deterministic
 * fixtures; no network, no wallet.
 */
import { describe, expect, it } from 'vitest';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from './execution-lifecycle';
import { currentExecution, projectExecutionResult } from './execution-result';
import { editorHistoryReducer, initialEditorHistory } from './editor-history';
import { persistEditor, readPersistedEditor } from './editor-persistence';
import type { Workflow } from './initial-workflow';
import { reviewFixture } from '../test-utils/review-fixture';

const fixture = reviewFixture();
/** The previous workflow's run (the fixture's), in a given attempt state. */
function runSource(state: string, txHash: string | null = null) {
  return { ...fixture.source, state: { ...fixture.source.state,
    run: { ...('run' in fixture.source.state ? fixture.source.state.run : {}), attempts: [{ step: 'swap', state, txHash }] } } } as unknown as ExecutionLifecycleSource;
}
/** "New workflow": the reducer's own empty draft under a fresh identity. */
const fresh = (id = 'workflow-new-1') => editorHistoryReducer(initialEditorHistory(), { type: 'NEW_WORKFLOW', workflowId: id }).editor.workflow as Workflow;
const HASH = '0x' + 'ab'.repeat(32);

describe('New workflow state isolation', () => {
  it.each([
    ['a successful reconciled execution', 'CONFIRMED', HASH],
    ['a cancelled pre-send attempt', 'CANCELLED', null],
    ['another transaction still pending', 'PENDING', HASH],
    ['an unknown submission result', 'SUBMISSION_RESULT_UNKNOWN', null],
    ['a submitted request awaiting settlement', 'HASH', HASH],
  ])('after %s, the new Canvas has no execution attached (the previous run itself is unchanged)', (_label, state, hash) => {
    const canvas = fresh(), source = runSource(state, hash);
    const previous = projectExecutionLifecycle(fixture.workflow, fixture.context, source);
    expect(previous.started).toBe(true);
    const onNew = projectExecutionLifecycle(canvas, fixture.context, source, { freshWorkflow: true });
    expect(onNew).toMatchObject({ detached: true, matchesWorkflow: false });
    expect(currentExecution(onNew)).toBeNull();
    // Nothing about the run is rewritten: its own projection (Dashboard, History) keeps every operation and hash.
    expect(onNew.steps.flatMap(s => s.operations).map(o => [o.state, o.hash])).toEqual(previous.steps.flatMap(s => s.operations).map(o => [o.state, o.hash]));
  });
  it('keeps every existing attachment when the Canvas was not explicitly created as new (a reload mid-run still shows its run)', () => {
    const source = runSource('PENDING', HASH);
    const onDraft = projectExecutionLifecycle(fresh(), fixture.context, source);
    expect(onDraft.detached).toBeUndefined();
    const ownWorkflow = projectExecutionLifecycle(fixture.workflow, fixture.context, source, { freshWorkflow: true });
    expect(ownWorkflow.detached).toBeUndefined(); expect(currentExecution(ownWorkflow)).not.toBeNull();
  });
  it('a run of the SAME new identity (the owner built and ran the new workflow) stays attached', () => {
    const canvas = { ...fixture.workflow, workflowId: 'workflow-new-2' } as Workflow;
    const source = { ...fixture.source, state: { ...fixture.source.state, run: { ...('run' in fixture.source.state ? fixture.source.state.run : {}),
      workflow: canvas, attempts: [{ step: 'swap', state: 'PENDING', txHash: HASH }] } } } as unknown as ExecutionLifecycleSource;
    const progress = projectExecutionLifecycle(canvas, fixture.context, source, { freshWorkflow: true });
    expect(progress.detached).toBeUndefined();
  });
  it('rapid New workflow clicks each produce a distinct, valid, empty identity (no shared state between them)', () => {
    const a = fresh('workflow-a'), b = fresh('workflow-b');
    expect(a.workflowId).not.toBe(b.workflowId);
    for (const w of [a, b]) { expect(w.revision).toBe(0); expect(w.nodes).toEqual([]); }
    expect(projectExecutionResult(projectExecutionLifecycle(b, fixture.context, runSource('CONFIRMED', HASH), { freshWorkflow: true }))).not.toBeNull();
  });

  it('refresh after New workflow keeps the new identity marked fresh, empty or authored; the visit’s own draft is never marked', () => {
    const data = new Map<string, string>(), storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    persistEditor(storage, fresh('workflow-new-9'), true);
    expect(readPersistedEditor(storage)).toEqual({ workflowId: 'workflow-new-9', workflow: null, fresh: true });
    // The visit's own untouched draft (no explicit New workflow) is remembered exactly as before: no marker.
    persistEditor(storage, fresh('workflow-initial'), false);
    expect(readPersistedEditor(storage)).toEqual({ workflowId: 'workflow-initial', workflow: null });
    // Review F1: once the new workflow has actions, a reload still knows it was explicitly created (no other workflow's run re-attaches).
    persistEditor(storage, fixture.workflow, true);
    expect(readPersistedEditor(storage)).toMatchObject({ workflowId: fixture.workflow.workflowId, fresh: true });
    expect(readPersistedEditor(storage)?.workflow).not.toBeNull();
    // A workflow not created that way is remembered without the marker, exactly as before.
    persistEditor(storage, fixture.workflow, false);
    expect(readPersistedEditor(storage)?.fresh).toBeUndefined();
    // Only `true` is a marker; anything else is ignored.
    data.set('flofi:editor-workflow:v1', JSON.stringify({ ...JSON.parse(data.get('flofi:editor-workflow:v1')!), fresh: 'yes' }));
    expect(readPersistedEditor(storage)?.fresh).toBeUndefined();
  });
  it('review F1: after New workflow, authoring and a reload, another identity’s unresolved run stays detached', () => {
    const authored = { ...fixture.workflow, workflowId: 'workflow-new-authored' } as Workflow;
    const onReload = projectExecutionLifecycle(authored, fixture.context, runSource('PENDING', HASH), { freshWorkflow: true });
    expect(onReload.detached).toBe(true); expect(currentExecution(onReload)).toBeNull();
  });
});
