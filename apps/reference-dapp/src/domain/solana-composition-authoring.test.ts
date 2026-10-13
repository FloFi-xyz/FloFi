// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext, validateAuthoringWorkflow } from '@defi-workflow-engine/reference-linter';
import { isBoundComposition, resolveWorkflowCapability } from '@defi-workflow-engine/action-registry';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, initialEditor, type EditorState } from './editor';
import type { Command } from './commands';
import { checkConnection } from './canvas-connect';
import { canDeleteCanvasEdge, canDeleteCanvasNode } from './canvas-keyboard';
import { savedWorkflowHash, validateSavedWorkflow } from './saved-workflow';
import type { SolanaLiquidityInput } from './solana-liquidity-authoring';

const context = createBaseSepoliaReviewContext();
const position: SolanaLiquidityInput = { network: 'Solana Devnet', maxSol: '0.05', maxDevUsdc: '1000', rangeUnit: 'TICK', lower: '-39104', upper: '-36992', slippage: '100' };
const swap = { network: 'Solana Devnet' as const, from: 'SOL' as const, to: 'devUSDC' as const, amount: '0.1', slippage: '50' };
function apply(state: EditorState, command: Record<string, unknown>): EditorState {
  const result = editorReducer(state, { ...command, source: 'CANVAS', baseRevision: state.workflow.revision } as Command, context);
  expect(result.error).toBeNull();
  return result;
}
const attempt = (state: EditorState, command: Record<string, unknown>) => editorReducer(state, { ...command, source: 'CANVAS', baseRevision: state.workflow.revision } as Command, context);
function built() {
  let state = apply(initialEditor(), { type: 'ADD_SOLANA_SWAP', input: swap });
  const swapId = state.workflow.nodes.at(-1)!.nodeId;
  state = apply(state, { type: 'ADD_SOLANA_LIQUIDITY', input: position });
  return { state, swapId, poolId: state.workflow.nodes.at(-1)!.nodeId };
}
const capability = (workflow: EditorState['workflow']) => resolveWorkflowCapability(workflow, { environment: 'PUBLIC_TESTNET' });

describe('Canvas authoring of Solana Devnet Swap → Orca liquidity', () => {
  it('links the swap output to the position as a typed binding the engine accepts', () => {
    const { state, swapId, poolId } = built();
    expect(capability(state.workflow).executionSupported).toBe(false);
    const check = checkConnection(state, context, swapId, poolId);
    expect(check.ok).toBe(true);
    const linked = apply(state, { type: 'CONNECT', from: swapId, to: poolId });
    const pool = linked.workflow.nodes.find(n => n.nodeId === poolId)!;
    expect(pool.dependencies).toEqual([swapId]);
    expect(pool.inputs.at(-1)).toEqual({ name: 'amount1-source', kind: 'OUTPUT_REFERENCE', value: { nodeId: swapId, outputId: 'amount-out' } });
    expect(linked.workflow.resourceEdges).toEqual([{ fromNodeId: swapId, outputId: 'amount-out', toNodeId: poolId, inputName: 'amount1-source' }]);
    expect(isBoundComposition(linked.workflow)).toBe(true);
    expect(() => validateAuthoringWorkflow(linked.workflow, context)).not.toThrow();
    expect(capability(linked.workflow)).toMatchObject({ executionSupported: true });
    expect(capability(linked.workflow).blockers.map(b => b.code)).not.toContain('COMPOSITION_UNSUPPORTED');
  });
  it('keeps a reverse link an ordering dependency, reported as not executable', () => {
    const { state, swapId, poolId } = built();
    const reverse = apply(state, { type: 'CONNECT', from: poolId, to: swapId });
    expect(reverse.workflow.resourceEdges).toEqual([]);
    expect(capability(reverse.workflow).blockers.map(b => b.code)).toContain('COMPOSITION_UNSUPPORTED');
    expect(() => validateAuthoringWorkflow(reverse.workflow, context)).toThrow();
  });
  it('unlinks back to the byte-identical isolated position', () => {
    const { state, swapId, poolId } = built();
    const before = state.workflow.nodes.find(n => n.nodeId === poolId);
    const linked = apply(state, { type: 'CONNECT', from: swapId, to: poolId });
    expect(canDeleteCanvasEdge(linked.workflow, swapId, poolId)).toBe(true);
    expect(canDeleteCanvasNode(linked.workflow, swapId)).toBe(false);
    const unlinked = apply(linked, { type: 'DISCONNECT', from: swapId, to: poolId });
    expect(unlinked.workflow.nodes.find(n => n.nodeId === poolId)).toEqual(before);
    expect(unlinked.workflow.resourceEdges).toEqual([]);
  });
  it('keeps the binding through position edits and follows the swap direction on swap edits', () => {
    const { state, swapId, poolId } = built();
    const linked = apply(state, { type: 'CONNECT', from: swapId, to: poolId });
    const edited = apply(linked, { type: 'SET_SOLANA_LIQUIDITY', nodeId: poolId, input: { ...position, maxSol: '0.04', maxDevUsdc: '2' } });
    expect(isBoundComposition(edited.workflow)).toBe(true);
    expect(edited.workflow.nodes.find(n => n.nodeId === poolId)!.inputs.find(i => i.name === 'amount1-max')).toMatchObject({ value: { amount: '2000000' } });
    const reversed = apply(edited, { type: 'SET_SOLANA_SWAP', nodeId: swapId, input: { ...swap, from: 'devUSDC', to: 'SOL', amount: '1' } });
    expect(reversed.workflow.resourceEdges).toEqual([{ fromNodeId: swapId, outputId: 'amount-out', toNodeId: poolId, inputName: 'amount0-source' }]);
    expect(isBoundComposition(reversed.workflow)).toBe(true);
    const zero = attempt(edited, { type: 'SET_SOLANA_LIQUIDITY', nodeId: poolId, input: { ...position, maxDevUsdc: '0' } });
    expect(zero.error).toBe('SOLANA_COMPOSITION_CAP_REQUIRED');
  });
  it('lets authoring add other steps beside the linked pair without presenting them as executable', () => {
    const { state, swapId, poolId } = built();
    const linked = apply(state, { type: 'CONNECT', from: swapId, to: poolId });
    const extra = apply(linked, { type: 'ADD_SOLANA_SWAP', input: { ...swap, amount: '0.2' } });
    expect(capability(extra.workflow).blockers.map(b => b.code)).toContain('COMPOSITION_UNSUPPORTED');
    expect(() => validateAuthoringWorkflow(extra.workflow, context)).toThrow(/ISOLATED_ONLY/);
    const removed = apply(extra, { type: 'REMOVE', nodeId: extra.workflow.nodes.at(-1)!.nodeId });
    expect(isBoundComposition(removed.workflow)).toBe(true);
  });
  it('saves and restores the linked workflow with a stable hash', () => {
    const { state, swapId, poolId } = built();
    const linked = apply(state, { type: 'CONNECT', from: swapId, to: poolId }).workflow as SemanticWorkflow;
    const restored = validateSavedWorkflow(JSON.parse(JSON.stringify(linked)));
    expect(savedWorkflowHash(restored)).toBe(savedWorkflowHash(linked));
    const removedPool = apply({ workflow: linked, error: null }, { type: 'REMOVE', nodeId: poolId });
    expect(removedPool.workflow.resourceEdges).toEqual([]);
  });
});
