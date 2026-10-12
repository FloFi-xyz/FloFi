// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { workflowDependencyOrder, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { validateAuthoringWorkflow, createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { simulateLendingComposition, assertLendingReview } from '@defi-workflow-engine/reference-compiler';
import { createLendingHarness, OWNER } from '../../e2e/lending-harness.mjs';
import { editorReducer, initialEditor, type EditorState } from './editor';
import type { Command } from './commands';
import { selectCryptoNetwork, cryptoReviewContext, type CryptoAction } from './crypto-action-picker';
import { workflowSteps } from './workflow-steps';
import { composerActions, composerConnections } from './composer-presentation';
import { createAuthoredLending } from './lending-authoring';
import { savedWorkflowHash, validateSavedWorkflow } from './saved-workflow';
import { editorHistoryReducer, initialEditorHistory } from './editor-history';
import { freeze } from './initial-workflow';
import { generateMockedChain } from './mock-artifacts';
import { chainReducer, initialChainState, checkChainAccess, VALIDITY_MS } from './artifact-chain';
const context = createBaseSepoliaReviewContext();
const owner = '0x1111111111111111111111111111111111111111';
function apply(state: EditorState, command: Omit<Command, 'baseRevision' | 'source'>) {
  const result = editorReducer(state, { ...command, baseRevision: state.workflow.revision, source: 'CANVAS' } as Command, context);
  expect(result.error).toBeNull(); return result;
}
function action(state: EditorState, type: string) {
  return type === 'bridge' ? apply(state, { type: 'ADD_ROUTER_BRIDGE', input: { source: 'Base', destination: 'Arbitrum', token: 'USDC', amount: '5', recipient: owner, slippage: '50', routing: 'LIFI' } } as Command)
    : apply(state, { type: 'ADD_CRYPTO_ACTION', input: { selection: selectCryptoNetwork(type as CryptoAction, 'Arbitrum One'), amount: '1', slippage: '50', beneficiary: owner, recipient: owner } } as Command);
}
function connect(state: EditorState, from: string, to: string) { return apply(state, { type: 'CONNECT', from, to } as Command); }
function disconnect(state: EditorState, from: string, to: string) { return apply(state, { type: 'DISCONNECT', from, to } as Command); }
function build(types: string[]) { let state = initialEditor(); for (const type of types) state = action(state, type); return state; }
function ids(state: EditorState) { return composerActions(state.workflow).map(n => n.nodeId); }

describe('generic canonical workflow connections', () => {
  it.each([
    ['bridge', 'swap'], ['swap', 'swap', 'transfer'], ['bridge', 'bridge', 'bridge', 'swap'],
    ['supply', 'borrow', 'swap', 'bridge', 'transfer'], ['transfer', 'swap'], ['transfer', 'transfer'], ['swap', 'swap', 'swap'],
    ['repay', 'transfer'], ['withdraw', 'swap'], ['swap', 'pool', 'transfer'],
  ])('authors arbitrary instance sequence %j', (...types) => {
    let state = build(types); const nodes = ids(state);
    for (let i = 1; i < nodes.length; i++) state = connect(state, nodes[i - 1]!, nodes[i]!);
    expect(ids(state)).toEqual(nodes); expect(new Set(nodes).size).toBe(types.length);
    expect(workflowSteps(state.workflow, context).map(step => [step.index, step.nodeId])).toEqual(nodes.map((id, index) => [index + 1, id]));
    expect(composerConnections(state.workflow).map(e => [e.source, e.target])).toEqual(nodes.slice(1).map((id, i) => [nodes[i], id]));
    const restored = validateSavedWorkflow(JSON.parse(JSON.stringify(state.workflow)));
    expect(ids({ workflow: restored, error: null })).toEqual(nodes);
    expect(composerConnections(restored)).toEqual(composerConnections(state.workflow));
    expect(savedWorkflowHash(restored)).toBe(savedWorkflowHash(state.workflow as SemanticWorkflow));
    // Composition acceptance does not activate unsupported financial execution.
    expect(() => validateAuthoringWorkflow(state.workflow, context)).toThrow();
  });
  it('reverses creation order, removes and reconnects dependencies, and updates canonical numbering', () => {
    let state = build(['swap', 'bridge', 'transfer']); const [swap, bridge, send] = ids(state) as [string, string, string];
    state = connect(connect(state, bridge, swap), swap, send);
    expect(ids(state)).toEqual([bridge, swap, send]);
    const hash = savedWorkflowHash(state.workflow as SemanticWorkflow);
    state = disconnect(disconnect(state, bridge, swap), swap, send);
    expect(composerConnections(state.workflow)).toEqual([]);
    state = connect(connect(state, swap, bridge), bridge, send);
    expect(ids(state)).toEqual([swap, bridge, send]);
    expect(savedWorkflowHash(state.workflow as SemanticWorkflow)).not.toBe(hash);
  });
  it('rejects self/unknown/cyclic edges; duplicate relationships are idempotent', () => {
    const state = build(['swap', 'swap']); const [a, b] = ids(state) as [string, string];
    const linked = connect(state, a, b); expect(connect(linked, a, b).workflow).toBe(linked.workflow);
    for (const [from, to, error] of [[a, a, 'INVALID_CONNECTION'], [a, 'node-999', 'INVALID_CONNECTION'], [b, a, 'CYCLIC_CONNECTION']]) {
      const rejected = editorReducer(linked, { type: 'CONNECT', from: from!, to: to!, source: 'CANVAS', baseRevision: linked.workflow.revision }, context);
      expect(rejected.error).toBe(error); expect(rejected.workflow).toBe(linked.workflow);
    }
  });
  it('retains independent repeated-action parameters and connections through ordinary edits', () => {
    let state = build(['swap', 'swap', 'swap']); const [a, b, c] = ids(state) as [string, string, string];
    state = connect(connect(state, a, b), b, c);
    const others = state.workflow.nodes.filter(n => n.nodeId !== b);
    state = apply(state, { type: 'SET_CRYPTO_ACTION', nodeId: b, input: { selection: selectCryptoNetwork('swap', 'Arbitrum One'), amount: '2', slippage: '50' } } as Command);
    expect(state.workflow.nodes.filter(n => n.nodeId !== b)).toEqual(others);
    expect(state.workflow.nodes.find(n => n.nodeId === b)?.dependencies).toEqual([a]);
    expect(ids(state)).toEqual([a, b, c]);
  });
  it('uses existing DAG semantics for branching/joining without inferring asset flow', () => {
    let state = build(['swap', 'transfer', 'bridge']); const [a, b, c] = ids(state) as [string, string, string];
    state = connect(connect(connect(state, a, b), a, c), b, c);
    expect(state.workflow.nodes.find(n => n.nodeId === c)?.dependencies).toEqual([a, b]);
    expect(state.workflow.resourceEdges).toEqual([]);
  });
  it('layout changes preserve canonical hash/order; save and RESTORE_WORKFLOW reconstruct canonical edges', () => {
    let state = build(['swap', 'bridge']); const [a, b] = ids(state) as [string, string]; state = connect(state, b, a);
    const original = savedWorkflowHash(state.workflow as SemanticWorkflow);
    const restored = editorHistoryReducer(initialEditorHistory(), { type: 'RESTORE_WORKFLOW', workflow: JSON.parse(JSON.stringify(state.workflow)) });
    const moved = editorHistoryReducer(restored, { type: 'MOVE', positions: { [b]: { x: -400, y: 900 } } });
    expect(moved.editor.workflow).toBe(restored.editor.workflow);
    expect(savedWorkflowHash(moved.editor.workflow as SemanticWorkflow)).toBe(original);
    expect(ids(moved.editor)).toEqual([b, a]); expect(composerConnections(moved.editor.workflow)).toHaveLength(1);
  });
  it('matches an existing valid multi-step simulation plan, manifests and stable recovery node identities', async () => {
    const workflow = createAuthoredLending('canvas-sequence', 0, { supply: '0.1', borrow: '0.01', slippage: '50', owner: OWNER });
    const review = await simulateLendingComposition(workflow, OWNER, createLendingHarness().rpc);
    const order = composerActions(workflow).map(n => n.nodeId);
    const plan = review.plan.segments.flatMap(s => s.steps).map(s => s.nodeId).filter((id, i, all) => i === 0 || id !== all[i - 1]);
    expect(plan).toEqual(order); expect(review.calls.filter(c => ['SUPPLY', 'BORROW', 'SWAP'].includes(c.id)).map(c => c.nodeId)).toEqual(order);
    const changed = freeze({ ...workflow, revision: 1, nodes: workflow.nodes.map(n => n.nodeId === 'lending-borrow' ? { ...n, dependencies: [] } : n) });
    expect(() => assertLendingReview(review, changed as SemanticWorkflow, OWNER, Date.now())).toThrow();
  });
  it('an actual handle dependency mutation retires prior simulation/Review through the shared stale guard', async () => {
    let state = initialEditor();
    for (let i = 0; i < 2; i++) state = apply(state, { type: 'ADD_CRYPTO_ACTION', input: { selection: selectCryptoNetwork('swap', 'Base'), amount: '1', slippage: '50' } } as Command);
    const now = Date.now(), source = state.workflow;
    const { chain, review } = await generateMockedChain(source, cryptoReviewContext('Base'), { nowMs: now, generation: 1 });
    let artifacts = chainReducer(initialChainState(), { type: 'GENERATE_STARTED', workflow: source, generation: 1 });
    artifacts = chainReducer(artifacts, { type: 'GENERATE_SUCCEEDED', currentWorkflow: source,
      record: { chain, review, sourceWorkflow: source, generation: 1, observedAtMs: now, expiresAtMs: now + VALIDITY_MS, monotonicStartMs: 0 } });
    expect(checkChainAccess(artifacts, source, now, 0).ok).toBe(true);
    const [a, b] = ids(state) as [string, string]; state = connect(state, b, a);
    artifacts = chainReducer(artifacts, { type: 'REVISION_ACCEPTED', workflow: state.workflow });
    expect(checkChainAccess(artifacts, state.workflow, now, 0)).toEqual({ ok: false, code: 'ARTIFACTS_STALE' });
  });
  it('topological projection rejects corrupt graphs and does not treat array order as execution authority', () => {
    expect(workflowDependencyOrder([{ nodeId: 'b', dependencies: ['a'] }, { nodeId: 'a', dependencies: [] }]).map(n => n.nodeId)).toEqual(['a', 'b']);
    expect(() => workflowDependencyOrder([{ nodeId: 'a', dependencies: ['missing'] }])).toThrow();
    expect(() => workflowDependencyOrder([{ nodeId: 'a', dependencies: ['a'] }])).toThrow();
  });
});
