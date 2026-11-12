// SPDX-License-Identifier: AGPL-3.0-only
/** P0 hotfix (execution continuity): the Editor's sequence keeps its identity, its Canvas and its final result across reloads and completion. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext } from '@defi-workflow-engine/reference-linter';
import { HookHarness } from '../test-utils/hook-harness';
import { WorkflowProvider, useWorkflow } from './workflow-store';
import { parseLocalCommand } from '../domain/commands';
import { editorReducer, initialEditor, type EditorState } from '../domain/editor';
import type { Workflow } from '../domain/initial-workflow';
import { EDITOR_WORKFLOW_STORAGE_KEY, persistEditor } from '../domain/editor-persistence';
import { SEQUENCE_RUN_STORAGE_KEY } from '../domain/sequence-restore';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const initialContext = { registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry };
const context = createReviewContext(initialContext);
const OWNER = '0x1111111111111111111111111111111111111111';
function author(workflowId: string, ...sentences: string[]): Workflow {
  let state: EditorState = initialEditor();
  for (const sentence of sentences) { state = editorReducer(state, parseLocalCommand(sentence, state.workflow, context, OWNER), context); expect(state.error).toBeNull(); }
  return { ...state.workflow, workflowId } as Workflow;
}
const amountOf = (workflow: Workflow) => (workflow.nodes[0]!.userConstraints.find(c => c.kind === 'MAXIMUM_INPUT') as unknown as { quantity: { amount: string } }).quantity.amount;
let host: HookHarness, store: ReturnType<typeof useWorkflow>, storage: Map<string, string>;
function Probe() { store = useWorkflow(); return <span>{store.state.workflow.nodes.length}</span>; }
const render = (persistCanvas = true) => host.render(() => renderToStaticMarkup(<WorkflowProvider initialContext={initialContext} initialWorkflowId="workflow-server-random-1" persistCanvas={persistCanvas}><Probe/></WorkflowProvider>));
beforeEach(() => {
  host = new HookHarness(); storage = new Map();
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { documentElement: { lang: '' } }));
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage, setTimeout, clearTimeout, setInterval, clearInterval }));
});
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); });

describe('P0 hotfix (execution continuity): WorkflowProvider', () => {
  it('a reload of the Editor puts the remembered Swap → Bridge back with its identity; /approve (no persistence) never does', () => {
    const workflow = author('workflow-stable-1', 'swap 0.001 ETH to USDC on Base slippage 100 bps', 'bridge 2 USDC from Base to Arbitrum');
    persistEditor({ setItem: (key, value) => storage.set(key, value) }, workflow);
    render(false);
    expect(store.state.workflow.nodes).toHaveLength(0);
    expect(store.state.workflow.workflowId).toBe('workflow-server-random-1');
    host.unmount(); host = new HookHarness();
    render(true);
    expect(JSON.stringify(store.state.workflow)).toBe(JSON.stringify(workflow));
    expect(store.sequence?.steps).toHaveLength(2);
    expect(store.sequence?.cursor).toBe(0);
  });
  it('the Canvas is remembered as it changes, and "Create new workflow" replaces it with a fresh empty identity', () => {
    render(true);
    expect(JSON.parse(storage.get(EDITOR_WORKFLOW_STORAGE_KEY)!)).toMatchObject({ workflowId: 'workflow-server-random-1', workflow: null });
    const workflow = author('workflow-stable-2', 'swap 0.001 ETH to USDC on Base slippage 100 bps');
    store.restoreWorkflow(workflow as never); render(true);
    expect(JSON.parse(storage.get(EDITOR_WORKFLOW_STORAGE_KEY)!).workflowId).toBe('workflow-stable-2');
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
    store.createNewWorkflow(); render(true);
    expect(JSON.parse(storage.get(EDITOR_WORKFLOW_STORAGE_KEY)!)).toMatchObject({ workflowId: 'workflow-00000000-0000-4000-8000-000000000001', workflow: null });
  });
  it('production 2026-11-12: after the last step completes, the runtime workflow is still exactly the step that executed (no "Review required again")', () => {
    const workflow = author('workflow-stable-3', 'swap 0.001 ETH to USDC on Base slippage 100 bps', 'bridge 2 USDC from Base to Arbitrum');
    persistEditor({ setItem: (key, value) => storage.set(key, value) }, workflow);
    render(true);
    expect(store.runtimeWorkflow.nodes.map(node => node.nodeId)).toEqual([store.sequence!.steps[0]!.nodeId]);
    store.completeSequenceStep(0, { received: '2500000', runKey: 'arbsw-0123456789abcdef', kind: 'public', owner: OWNER }); render(true);
    expect(store.sequence).toMatchObject({ cursor: 1, finished: false, bound: '2000000' });
    const executed = JSON.stringify(store.runtimeWorkflow);
    expect(amountOf(store.runtimeWorkflow)).toBe('2000000');
    // The step pointers are kept under the stable identity, so a reload re-proves them from the runtimes' records.
    expect(JSON.parse(storage.get(SEQUENCE_RUN_STORAGE_KEY + 'workflow-stable-3')!).completed).toMatchObject([{ kind: 'public', runKey: 'arbsw-0123456789abcdef', received: '2500000' }]);
    store.completeSequenceStep(1, { received: '1990000', runKey: 'xroute-0123456789abcdef0123456789abcdef', kind: 'router', owner: OWNER }); render(true);
    expect(store.sequence).toMatchObject({ cursor: 1, finished: true, bound: '2000000', fundingIssue: null });
    expect(store.sequence!.completed).toHaveLength(2);
    expect(JSON.stringify(store.runtimeWorkflow)).toBe(executed);
    // Completing it again (a late re-render of the same record) changes nothing.
    store.completeSequenceStep(1, { received: '1990000', runKey: 'xroute-0123456789abcdef0123456789abcdef', kind: 'router', owner: OWNER }); render(true);
    expect(store.sequence!.completed).toHaveLength(2);
    expect(JSON.stringify(store.runtimeWorkflow)).toBe(executed);
  });
});
