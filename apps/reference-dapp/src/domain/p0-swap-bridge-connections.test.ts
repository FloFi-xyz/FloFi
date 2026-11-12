// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 (owner request §18.1, mandatory): automatic card connections for the reported workflow — Arbitrum One Swap 0.001 WETH → USDC, then Bridge
 * 2 USDC Arbitrum One → Base. The connection is a real typed dependency (exact token, chain, decimals), the bridge spends
 * min(authored cap, reconciled delivery), a deletion never leaves an orphaned reference, Undo restores it, and moving cards never changes the
 * execution order.
 */
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext, lintWorkflow } from '@defi-workflow-engine/reference-linter';
import { parseLocalCommand, type Command } from './commands';
import { composerConnections } from './composer-presentation';
import { editorHistoryReducer, initialEditorHistory, type EditorHistory } from './editor-history';
import type { Workflow } from './initial-workflow';
import { boundAmount, workflowSequence, type CompletedStep } from './workflow-sequence';

const context = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry });
const OWNER = '0x1111111111111111111111111111111111111111';
const ARBITRUM_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const SWAP = 'swap 0.001 WETH to USDC on Arbitrum One slippage 100 bps', BRIDGE = 'bridge 2 USDC from Arbitrum to Base';
const lint = (workflow: Workflow) => lintWorkflow(workflow, context);
const command = (state: EditorHistory, sentence: string): EditorHistory => {
  const next = editorHistoryReducer(state, { type: 'COMMAND', command: parseLocalCommand(sentence, state.editor.workflow, context, OWNER), context });
  expect(next.editor.error).toBeNull();
  return next;
};
const edit = (state: EditorHistory, value: Omit<Command, 'baseRevision'>): EditorHistory =>
  editorHistoryReducer(state, { type: 'COMMAND', command: { ...value, baseRevision: state.editor.workflow.revision } as Command, context });
const authored = () => command(command(initialEditorHistory(), SWAP), BRIDGE);
const financial = (workflow: Workflow) => workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));

describe('P0 §18.1 automatic connections: Arbitrum Swap → Bridge to Base', () => {
  it('connects the bridge to the swap as a typed dependency on the exact Arbitrum USDC the swap delivers', () => {
    const workflow = authored().editor.workflow;
    const [swap, bridge] = financial(workflow);
    expect(swap!.chainId).toBe('eip155:42161'); expect(bridge!.chainId).toBe('eip155:42161');
    const sequence = workflowSequence(workflow, lint)!;
    expect(sequence.steps.map(step => step.fundedBy)).toEqual([null, 0]);
    expect(sequence.steps[0]!.output).toMatchObject({ chainId: 'eip155:42161', address: ARBITRUM_USDC, decimals: 6 });
    expect(sequence.steps[1]!.input).toMatchObject({ chainId: 'eip155:42161', address: ARBITRUM_USDC, decimals: 6, amount: '2000000' });
    // The visible connection is that dependency (never a decorative arrow between independent cards).
    expect(composerConnections(workflow).map(edge => [edge.source, edge.target])).toContainEqual([swap!.nodeId, bridge!.nodeId]);
  });

  it('the bridge spends min(authored 2 USDC, what the swap actually delivered); nothing proven delivered spends nothing', () => {
    const sequence = workflowSequence(authored().editor.workflow, lint)!, bridge = sequence.steps[1]!;
    const done = (received: string | null): CompletedStep[] => [{ nodeId: sequence.steps[0]!.nodeId, node: '', received, runKey: 'arb-swap-1' }];
    expect(boundAmount(bridge, done('1500000'))).toBe('1500000');
    expect(boundAmount(bridge, done('2400000'))).toBe('2000000');
    expect(boundAmount(bridge, done(null))).toBeNull();
  });

  it('deleting the swap leaves no orphaned reference; Undo restores the connection; Redo removes it again', () => {
    const before = authored(), [swap, bridge] = financial(before.editor.workflow);
    const removed = edit(before, { type: 'REMOVE_MANY', nodeIds: [swap!.nodeId], source: 'CANVAS' } as Omit<Command, 'baseRevision'>);
    const ids = new Set(removed.editor.workflow.nodes.map(node => node.nodeId));
    for (const node of removed.editor.workflow.nodes) for (const dependency of node.dependencies) expect(ids.has(dependency)).toBe(true);
    for (const edge of removed.editor.workflow.resourceEdges) { expect(ids.has(edge.fromNodeId)).toBe(true); expect(ids.has(edge.toNodeId)).toBe(true); }
    const undone = editorHistoryReducer(removed, { type: 'UNDO' });
    // The same graph comes back under a NEWER revision: a Review made before the edit can never be reused for it.
    expect({ ...undone.editor.workflow, revision: 0 }).toEqual({ ...before.editor.workflow, revision: 0 });
    expect(undone.editor.workflow.revision).toBeGreaterThan(removed.editor.workflow.revision);
    expect(composerConnections(undone.editor.workflow).map(edge => [edge.source, edge.target])).toContainEqual([swap!.nodeId, bridge!.nodeId]);
    const redone = editorHistoryReducer(undone, { type: 'REDO' }).editor.workflow;
    expect({ ...redone, revision: 0 }).toEqual({ ...removed.editor.workflow, revision: 0 });
  });

  it('moving cards changes positions only, never the execution order or the funding', () => {
    const before = authored(), [swap, bridge] = financial(before.editor.workflow);
    // The bridge drawn to the left of the swap still runs after it and is still funded by it.
    const moved = editorHistoryReducer(before, { type: 'MOVE', positions: { [bridge!.nodeId]: { x: -400, y: 0 }, [swap!.nodeId]: { x: 600, y: 300 } } });
    expect(moved.editor.workflow).toEqual(before.editor.workflow);
    expect(workflowSequence(moved.editor.workflow, lint)!.steps.map(step => [step.nodeId, step.fundedBy])).toEqual([[swap!.nodeId, null], [bridge!.nodeId, 0]]);
  });
});
