// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the Editor's Canvas workflow → the canonical multi-step strategy the shared workflow run executes.
 * Workflows are authored exactly as the Canvas and its chat author them (the editor reducer over the deterministic grammar); the result must be
 * the engine's own composition, step for step, with the Canvas's funding as typed bindings — and anything else is refused.
 */
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext } from '@defi-workflow-engine/reference-linter';
import { parseLocalCommand } from '../domain/commands';
import { editorReducer, initialEditor, type EditorState } from '../domain/editor';
import type { Workflow } from '../domain/initial-workflow';
import { composeWorkflowBound, semanticWorkflowHash } from '../engine/strategy-engine';
import { editorWorkflowStrategy, EDITOR_RUN_MAX_STEPS } from './workflow-strategy';

const context = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry });
const OWNER = '0x1111111111111111111111111111111111111111';
function author(...sentences: string[]): Workflow {
  let state: EditorState = initialEditor();
  for (const sentence of sentences) {
    state = editorReducer(state, parseLocalCommand(sentence, state.workflow, context, OWNER), context);
    expect(state.error, sentence).toBeNull();
  }
  return state.workflow;
}
const ok = (workflow: unknown) => {
  const result = editorWorkflowStrategy(workflow);
  if (!result.ok) throw new Error(`${result.code}${result.step === undefined ? '' : `@${result.step}`}`);
  return result;
};
const SWAP_BASE = 'swap 10 USDC to WETH on Base slippage 100 bps', SWAP_BACK = 'swap 0.004 WETH to USDC on Base slippage 100 bps';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** The Canvas node's single MAXIMUM_INPUT quantity (what the step may spend). */
const limitOf = (node: Workflow['nodes'][number]) => (node.userConstraints.find(c => c.kind === 'MAXIMUM_INPUT') as unknown as { quantity: { amount: string } }).quantity;

describe('BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001 Editor workflow → canonical workflow-run strategy', () => {
  it('reproduces a funded Swap → Swap as the engine composes it, with the Canvas funding as the typed binding', () => {
    const workflow = author(SWAP_BASE, SWAP_BACK), result = ok(workflow);
    expect(result.strategy).toEqual({ version: 2, steps: [
      { version: 1, action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 100 },
      { version: 1, action: 'swap', network: 'base', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.004', slippageBps: 100 }], bindings: [{ step: 1, amountFrom: 0 }] });
    expect(result.stepCount).toBe(2);
    // The approval service re-derives exactly this hash from the strategy alone.
    const again = composeWorkflowBound(result.strategy, result.workflowHash);
    expect(again.ok && again.workflowHash).toBe(result.workflowHash);
    // Each composed step is the Canvas step's own canonical IR (same hash as the Canvas projection the Editor simulates).
    const projection = (index: number) => ({ ...workflow, nodes: [{ ...workflow.nodes.filter(n => !n.actionType.startsWith('mock-'))[index]!, dependencies: [] }],
      resourceEdges: [] }) as Workflow;
    expect(result.composition.steps.map(step => step.workflow.nodes.filter(n => !n.actionType.startsWith('mock-'))[0]!.inputs))
      .toEqual([0, 1].map(index => projection(index).nodes[0]!.inputs));
    expect(semanticWorkflowHash(projection(0))).not.toBe(result.workflowHash);
  });

  it('covers the actions a Canvas sequence runs: swaps, bridges, Aave lending, transfers, positions and Solana', () => {
    const cases: [readonly string[], readonly string[]][] = [
      [[SWAP_BASE, 'bridge 5 USDC from Base to Arbitrum'], ['swap', 'bridge']],
      [['bridge 0.01 ETH from Base to Arbitrum One receive USDC via best slippage 100 bps', 'swap 5 USDC to WETH on Base slippage 100 bps'], ['bridge', 'swap']],
      [[`supply 5 USDC to Aave on Arbitrum One beneficiary ${OWNER}`, `borrow 1 USDC from Aave on Arbitrum One beneficiary ${OWNER}`,
        `repay 1 USDC to Aave on Arbitrum One beneficiary ${OWNER}`, 'withdraw 2 USDC from Aave on Arbitrum One'], ['supply', 'borrow', 'repay', 'withdraw']],
      [[SWAP_BASE, 'send 1 USDC on Base to 0x2222222222222222222222222222222222222222'], ['swap', 'transfer']],
      [[SWAP_BASE, 'add liquidity 5 USDC and 0.01 WETH on Base full range slippage 100 bps'], ['swap', 'add_liquidity']],
      [['swap 5 USDC to SOL on Solana slippage 50 bps', 'swap 0.01 SOL to USDC on Solana slippage 50 bps'], ['swap', 'swap']],
    ];
    for (const [sentences, actions] of cases) {
      const result = ok(author(...sentences));
      expect((result.strategy as { steps: { action: string }[] }).steps.map(step => step.action), sentences.join(' → ')).toEqual(actions);
      expect(result.stepCount).toBe(actions.length);
    }
  });

  it('keeps one-step workflows on their own per-flow path and refuses workflows beyond the run limits', () => {
    expect(editorWorkflowStrategy(author(SWAP_BASE))).toEqual({ ok: false, code: 'EDITOR_WORKFLOW_SINGLE_STEP' });
    expect(editorWorkflowStrategy(initialEditor().workflow)).toMatchObject({ ok: false });
    const many = author(...Array.from({ length: EDITOR_RUN_MAX_STEPS + 1 }, (_, i) => `swap ${i + 1} USDC to WETH on Base slippage 100 bps`));
    expect(editorWorkflowStrategy(many)).toEqual({ ok: false, code: 'EDITOR_WORKFLOW_TOO_LONG' });
    const eight = author(...Array.from({ length: EDITOR_RUN_MAX_STEPS }, (_, i) => `swap ${i + 1} USDC to WETH on Base slippage 100 bps`));
    expect(ok(eight).stepCount).toBe(EDITOR_RUN_MAX_STEPS);
  });

  it('never trusts a browser-made workflow: anything the engine would not author for the Canvas step is refused, nothing is guessed', () => {
    const workflow = author(SWAP_BASE, SWAP_BACK);
    for (const value of [null, 'workflow', 42, [], { nodes: 'x' }, { ...workflow, nodes: undefined }]) expect(editorWorkflowStrategy(value)).toEqual({ ok: false, code: 'EDITOR_WORKFLOW_INVALID' });
    // A spend limit that differs from the swap's own amount (an altered amount) is not what the engine authors for that step.
    const altered = clone(workflow), node = altered.nodes.filter(n => !n.actionType.startsWith('mock-'))[0]!;
    limitOf(node).amount = '1000000000';
    expect(editorWorkflowStrategy(altered)).toMatchObject({ ok: false });
    // A different slippage constraint than the step's own, or another failure policy, likewise.
    const policy = clone(workflow);
    (policy.nodes.filter(n => !n.actionType.startsWith('mock-'))[1]! as { failurePolicy: string }).failurePolicy = 'CONTINUE';
    expect(editorWorkflowStrategy(policy)).toMatchObject({ ok: false });
    // An oversized document is refused before it is read.
    expect(editorWorkflowStrategy({ ...workflow, description: 'x'.repeat(300_000) })).toEqual({ ok: false, code: 'EDITOR_WORKFLOW_INVALID' });
  });

  it('refuses a workflow one of FloFi\'s composition runtimes executes as a whole (it is not a sequence of independent steps)', () => {
    const lending = author('compose supply 0.1 USDC to Aave then borrow 0.01 USDC then swap borrowed USDC to WETH on Base Sepolia slippage 100 bps');
    expect(lending.nodes.filter(n => !n.actionType.startsWith('mock-')).length).toBeGreaterThan(1);
    expect(editorWorkflowStrategy(lending)).toEqual({ ok: false, code: 'EDITOR_WORKFLOW_COMPOSITION' });
  });
});
