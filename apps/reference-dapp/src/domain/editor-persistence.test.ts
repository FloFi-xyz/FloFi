// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext } from '@defi-workflow-engine/reference-linter';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { parseLocalCommand } from './commands';
import { editorReducer, initialEditor, type EditorState } from './editor';
import { editorHistoryReducer, initialEditorHistory } from './editor-history';
import type { Workflow } from './initial-workflow';
import { EDITOR_WORKFLOW_STORAGE_KEY, editorPersistencePath, persistEditor, readPersistedEditor } from './editor-persistence';

const context = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry });
const OWNER = '0x1111111111111111111111111111111111111111';
function author(...sentences: string[]): Workflow {
  let state: EditorState = initialEditor();
  for (const sentence of sentences) { state = editorReducer(state, parseLocalCommand(sentence, state.workflow, context, OWNER), context); expect(state.error).toBeNull(); }
  return { ...state.workflow, workflowId: 'workflow-7f1c2a' } as Workflow;
}
function memory() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

describe('P0 hotfix (execution continuity): the Editor Canvas survives reloads, /approve and the end of a run', () => {
  it('round-trips the exact canonical workflow (byte-identical JSON, so a recovered run still matches it) with its identity and revision', () => {
    const storage = memory(), workflow = author('swap 0.001 ETH to USDC on Base slippage 100 bps', 'bridge 2 USDC from Base to Arbitrum');
    persistEditor(storage, workflow);
    const read = readPersistedEditor(storage)!;
    expect(read.workflowId).toBe('workflow-7f1c2a');
    expect(JSON.stringify(read.workflow)).toBe(JSON.stringify(workflow));
    expect(read.workflow!.revision).toBe(workflow.revision);
  });
  it('remembers the empty draft as nothing to restore (only its identity), never as a workflow', () => {
    const storage = memory();
    persistEditor(storage, { schemaVersion: '1.0.0', workflowId: 'workflow-empty-1', revision: 0, nodes: [], resourceEdges: [] } as unknown as Workflow);
    expect(readPersistedEditor(storage)).toEqual({ workflowId: 'workflow-empty-1', workflow: null });
  });
  it('fails closed: blocked storage, corrupt JSON, another format, a bad identity or an invalid workflow restore nothing', () => {
    const throwing = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(readPersistedEditor(throwing)).toBeNull();
    expect(() => persistEditor(throwing, author('swap 0.001 ETH to USDC on Base slippage 100 bps'))).not.toThrow();
    expect(readPersistedEditor(null)).toBeNull();
    const storage = memory(), workflow = author('swap 0.001 ETH to USDC on Base slippage 100 bps');
    for (const raw of ['{', '[]', JSON.stringify({ format: 'other', workflowId: 'workflow-1', workflow }),
      JSON.stringify({ format: 'flofi.editor-workflow.v1', workflowId: '../x', workflow }),
      JSON.stringify({ format: 'flofi.editor-workflow.v1', workflowId: 'workflow-other', workflow }),
      JSON.stringify({ format: 'flofi.editor-workflow.v1', workflowId: 'workflow-7f1c2a', workflow: { ...workflow, nodes: [] } }),
      JSON.stringify({ format: 'flofi.editor-workflow.v1', workflowId: 'workflow-7f1c2a', workflow: { ...workflow, schemaVersion: 'x' } })]) {
      storage.data.set(EDITOR_WORKFLOW_STORAGE_KEY, raw);
      expect(readPersistedEditor(storage)).toBeNull();
    }
  });
  it('only the product Editor reads or writes it (never /approve, embedded signing or the engineering page)', () => {
    expect(['/app', '/app/dashboard', '/app/workflows'].map(editorPersistencePath)).toEqual([true, true, true]);
    expect(['/approve', '/mcp/approve', '/__engineering', '/connections', '/application', null, undefined].map(editorPersistencePath)).toEqual([false, false, false, false, false, false, false]);
  });
  it('is put back only on the untouched initial Canvas, with its own identity; an authored Canvas is never replaced', () => {
    const workflow = author('swap 0.001 ETH to USDC on Base slippage 100 bps', 'bridge 2 USDC from Base to Arbitrum') as unknown as SemanticWorkflow;
    const restored = editorHistoryReducer(initialEditorHistory(), { type: 'RESTORE_PERSISTED_CANVAS', workflowId: workflow.workflowId, workflow, layout: { 'node-002': { x: 10, y: 20, actionType: 'asset.bridge' } } });
    expect(JSON.stringify(restored.editor.workflow)).toBe(JSON.stringify(workflow));
    expect(restored.layout).toEqual({ 'node-002': { x: 10, y: 20, actionType: 'asset.bridge' } });
    expect(restored.past).toEqual([]);
    // The owner already started authoring in this visit: nothing is replaced.
    const authored = editorHistoryReducer(initialEditorHistory(), { type: 'COMMAND', command: parseLocalCommand('swap 0.002 ETH to USDC on Base slippage 100 bps', initialEditor().workflow, context, OWNER), context });
    expect(authored.editor.workflow.nodes).toHaveLength(1);
    expect(editorHistoryReducer(authored, { type: 'RESTORE_PERSISTED_CANVAS', workflowId: workflow.workflowId, workflow, layout: {} })).toBe(authored);
    // An identity that disagrees with the workflow, or an invalid workflow, restores nothing.
    expect(editorHistoryReducer(initialEditorHistory(), { type: 'RESTORE_PERSISTED_CANVAS', workflowId: 'workflow-else', workflow, layout: {} }).editor.workflow.nodes).toHaveLength(0);
    expect(editorHistoryReducer(initialEditorHistory(), { type: 'RESTORE_PERSISTED_CANVAS', workflowId: workflow.workflowId, workflow: { ...workflow, nodes: [] }, layout: {} }).editor.workflow.nodes).toHaveLength(0);
  });
  it('"Create new workflow" replaces it with a fresh, empty workflow of a new identity (the only way it is cleared)', () => {
    const storage = memory(), workflow = author('swap 0.001 ETH to USDC on Base slippage 100 bps');
    persistEditor(storage, workflow);
    const fresh = editorHistoryReducer(initialEditorHistory(), { type: 'NEW_WORKFLOW', workflowId: 'workflow-new-2' });
    persistEditor(storage, fresh.editor.workflow);
    expect(readPersistedEditor(storage)).toEqual({ workflowId: 'workflow-new-2', workflow: null });
  });
});
