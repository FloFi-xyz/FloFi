// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the Editor's canonical Canvas workflow as the canonical strategy every FloFi surface hands to the
 * shared workflow-run flow (a v2 step list, with the typed bindings of its funded steps). Nothing is rebuilt or reinterpreted, and nothing a browser
 * says about amounts is trusted:
 *
 *   order      the Canvas sequence order (`domain/workflow-sequence.ts`): financial actions in dependency order, else the order they were authored in;
 *              a workflow one of FloFi's composition runtimes executes as a whole is not a sequence and is refused here
 *   steps      each Canvas node is read through the Canvas's own IR readers (`workflowSteps`) into the authoring command FloFi's chat produces for
 *              it, and that command becomes a StrategySpec by the engine's inverse mapping (`strategyOfCommand`, shared with the channels)
 *   bindings   a step the Canvas funds with what an earlier step delivers (`fundedBy`) carries the engine's typed binding: it spends what that step
 *              actually delivered after reconciliation, capped by its own authored amount (the rule the Canvas sequence already applies)
 *   parity     the strategy is composed by the deterministic engine and every composed step must reproduce its Canvas node EXACTLY (action, chain,
 *              inputs, constraints, protocols, failure policy, authorization class — the comparison automations use); any difference is refused
 *
 * The result's workflow hash is the engine's sequence hash, which the approval service re-derives from the strategy alone. Pure: no IO, no
 * authority; single-step workflows keep their own per-flow execution path and are refused here.
 */
import { lintWorkflow } from '@defi-workflow-engine/reference-linter';
import { parseArtifactBytes, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { nodeSemantics } from '../automations/binding.ts';
import { strategyOfCommand } from '../channels/core/strategy.ts';
import type { Command } from '../domain/commands';
import type { Workflow } from '../domain/initial-workflow';
import { compositionWorkflow, sequenceOrder, workflowSequence } from '../domain/workflow-sequence';
import { workflowSteps, type StepDetail } from '../domain/workflow-steps';
import { composeWorkflow, reviewContextOf, type WorkflowComposition } from '../engine/strategy-engine';
import type { StrategyInput, StrategySpec } from '../engine/strategy-spec';

/** The workflow-run limits (`workflow_runs.step_count BETWEEN 2 AND 8`). */
export const EDITOR_RUN_MIN_STEPS = 2;
export const EDITOR_RUN_MAX_STEPS = 8;
const MAX_WORKFLOW_BYTES = 262_144;

export type EditorWorkflowStrategy = { readonly ok: true; readonly strategy: StrategyInput; readonly workflowHash: string; readonly stepCount: number;
  readonly composition: WorkflowComposition };
/** A closed refusal; `step` (0-based) names the Canvas step that could not be represented or reproduced. */
export type EditorWorkflowRefusal = { readonly ok: false; readonly code: string; readonly step?: number };

const base = { source: 'CHAT', baseRevision: 0 } as const;
const EVM_SWAP_COMMAND = { 'Base': 'ADD_SWAP', 'Base Sepolia': 'ADD_TESTNET_SWAP', 'Ethereum Sepolia': 'ADD_ETHEREUM_SEPOLIA_SWAP' } as const;
/** The authoring command FloFi's chat produces for a step the Canvas IR readers describe, or null for a step no authoring command expresses. */
export function authoringCommandOf(detail: StepDetail): Command | null {
  switch (detail.type) {
    case 'EVM_SWAP': return { ...base, type: EVM_SWAP_COMMAND[detail.network], direction: `${detail.from}_TO_${detail.to}`, amount: detail.amount, slippage: detail.slippage } as Command;
    case 'SOLANA_SWAP': return { ...base, type: 'ADD_SOLANA_SWAP', input: detail.input } as Command;
    case 'ROUTER': return { ...base, type: 'ADD_ROUTER_BRIDGE', input: detail.input } as Command;
    case 'UNIVERSAL_BRIDGE': return { ...base, type: 'ADD_UNIVERSAL_BRIDGE', input: detail.input } as Command;
    case 'AAVE': return { ...base, type: ({ SUPPLY: 'ADD_SUPPLY', BORROW: 'ADD_BORROW', REPAY: 'ADD_REPAY' } as const)[detail.operation], input: detail.input } as Command;
    case 'AAVE_WITHDRAW': return { ...base, type: 'ADD_WITHDRAW', input: detail.input } as Command;
    case 'UNISWAP_LIQUIDITY': return { ...base, type: 'ADD_UNISWAP_LIQUIDITY', input: detail.input } as Command;
    case 'ORCA_LIQUIDITY': return { ...base, type: 'ADD_SOLANA_LIQUIDITY', input: detail.input } as Command;
    case 'CATALOG_SWAP': return { ...base, type: 'ADD_CRYPTO_ACTION', input: { selection: { action: 'swap', network: detail.network, from: detail.from, to: detail.to },
      amount: detail.amount, slippage: detail.slippage } } as Command;
    case 'CATALOG_LIQUIDITY': {
      const i = detail.input;
      return { ...base, type: 'ADD_CRYPTO_ACTION', input: { selection: { action: 'pool', network: i.network, from: i.tokenA, to: i.tokenB }, amount: i.amountA,
        secondAmount: i.amountB, slippage: i.slippage, fee: i.fee, ...i.rangeUnit === 'TICK' ? { rangeUnit: 'TICK', lower: i.lower, upper: i.upper } : {} } } as Command;
    }
    case 'TRANSFER': return { ...base, type: 'ADD_RH_TRANSFER', input: detail.input } as Command;
    default: return null;
  }
}

/** The Canvas workflow, validated against the canonical Semantic Workflow schema (size-bounded), or null. */
function canonicalWorkflow(input: unknown): Workflow | null {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(input));
    if (bytes.length > MAX_WORKFLOW_BYTES) return null;
    return parseArtifactBytes(bytes, 'semantic-workflow') as SemanticWorkflow as unknown as Workflow;
  } catch { return null; }
}
const financialNodes = (workflow: Pick<Workflow, 'nodes'>) => workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));

/** The Editor's Canvas workflow → its canonical multi-step strategy (see the module comment), or a closed refusal. */
export function editorWorkflowStrategy(input: unknown): EditorWorkflowStrategy | EditorWorkflowRefusal {
  const workflow = canonicalWorkflow(input);
  if (!workflow) return { ok: false, code: 'EDITOR_WORKFLOW_INVALID' };
  const ordered = sequenceOrder(workflow);
  if (!ordered.length) return { ok: false, code: 'EDITOR_WORKFLOW_EMPTY' };
  // A workflow one of FloFi's composition runtimes executes as a whole keeps that path; it is not a sequence of independent steps.
  if (compositionWorkflow(workflow)) return { ok: false, code: 'EDITOR_WORKFLOW_COMPOSITION' };
  if (ordered.length < EDITOR_RUN_MIN_STEPS) return { ok: false, code: 'EDITOR_WORKFLOW_SINGLE_STEP' };
  if (ordered.length > EDITOR_RUN_MAX_STEPS) return { ok: false, code: 'EDITOR_WORKFLOW_TOO_LONG' };
  // Exactly the Canvas's own sequence: every step must lint alone with its own network's trusted context, as its runtime receives it.
  const sequence = workflowSequence(workflow, step => lintWorkflow(step, reviewContextOf(step)));
  if (!sequence || sequence.steps.length !== ordered.length) return { ok: false, code: 'EDITOR_WORKFLOW_NOT_SEQUENCE' };
  const context = reviewContextOf(workflow), described = new Map(workflowSteps(workflow, context).map(step => [step.nodeId, step.detail]));
  const specs: StrategySpec[] = [];
  for (const [index, step] of sequence.steps.entries()) {
    const detail = described.get(step.nodeId), command = detail ? authoringCommandOf(detail) : null;
    const spec = command ? strategyOfCommand(command) : null;
    if (!spec) return { ok: false, code: 'EDITOR_WORKFLOW_STEP_NOT_REPRESENTABLE', step: index };
    specs.push(spec);
  }
  // The Canvas's own funding (what an earlier step delivers to the owner, spent by a later one) as the engine's typed bindings.
  const bindings = sequence.steps.flatMap(step => step.funding.map(funding => ({ step: step.index, amountFrom: funding.fundedBy })));
  const unique = [...new Map(bindings.map(binding => [`${binding.step}:${binding.amountFrom}`, binding])).values()];
  const strategy = { version: 2, steps: specs, ...unique.length ? { bindings: unique } : {} } as StrategyInput;
  const composed = composeWorkflow(strategy);
  if (!composed.ok) return { ok: false, code: composed.code };
  if (composed.steps.length !== sequence.steps.length) return { ok: false, code: 'EDITOR_WORKFLOW_PARITY_FAILED' };
  // Every composed step must be exactly its Canvas node: the run executes the engine's composition, so anything else is not this workflow.
  for (const [index, step] of sequence.steps.entries()) {
    const reproduced = financialNodes(composed.steps[index]!.workflow), node = ordered.find(candidate => candidate.nodeId === step.nodeId);
    if (!node || reproduced.length !== 1 || nodeSemantics(reproduced[0]!) !== nodeSemantics(node)) return { ok: false, code: 'EDITOR_WORKFLOW_PARITY_FAILED', step: index };
  }
  return { ok: true, strategy: composed.strategy, workflowHash: composed.workflowHash, stepCount: composed.steps.length, composition: composed };
}
