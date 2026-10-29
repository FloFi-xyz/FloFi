// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-CHAT-E2E-FIX-002: how a sequence of independent owner-wallet steps (`workflow-sequence.ts`) is presented — every canonical action, in
 * order, with what already executed, what runs now and how a funded step is funded. Presentation only: labels come from the Canvas card projection
 * (`composerSummary`), delivered amounts from the steps' reconciled records; nothing is estimated here.
 */
import { formatAssetAmount } from '@defi-workflow-engine/action-registry';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import type { Workflow } from './initial-workflow';
import { composerSummary } from './composer-presentation';
import type { SequenceStep } from './workflow-sequence';
import type { SequenceView } from '../state/workflow-store';
import { translate } from '../i18n/locale';

type Language = 'EN' | 'PT';
export type SequenceStepPresentation = {
  readonly number: number; readonly action: string; readonly amount: string | null; readonly detail: string | null; readonly network: string;
  /** COMPLETED: executed and reconciled; CURRENT: the step simulated, reviewed and signed now; NEXT: simulated after the steps before it. */
  readonly state: 'COMPLETED' | 'CURRENT' | 'NEXT';
  /** A funded step: the producing step's number, the authored cap, and (once known) the amount it spends. */
  readonly funding: { readonly from: number; readonly cap: string; readonly bound: string | null } | null;
  /** What a completed step's reconciled record proves it delivered, when FloFi can read it. */ readonly delivered: string | null;
};
export type SequencePresentation = { readonly total: number; readonly current: number; readonly finished: boolean; readonly steps: readonly SequenceStepPresentation[] };

function card(workflow: Workflow, context: ReviewContext, nodeId: string) {
  const node = workflow.nodes.find(item => item.nodeId === nodeId);
  if (!node) return null;
  const summary = composerSummary(workflow, node, context);
  return { action: summary.action, amount: summary.amount === 'Amount not available' ? null : summary.amount, detail: summary.bridgePair ?? summary.detail ?? null, network: summary.chain };
}
/** The symbol a card amount is written in ("0.001 WETH" → "WETH"). */
const symbolOf = (amount: string | null) => amount?.split(' ').slice(1).join(' ') || '';
const formatted = (units: string, step: SequenceStep, amount: string | null) => {
  const symbol = symbolOf(amount);
  return step.input ? `${formatAssetAmount(units, step.input.decimals)}${symbol ? ` ${symbol}` : ''}` : units;
};
/** One step's short label, e.g. "Swap · 10 USDC · USDC → WETH · Base". */
export function sequenceStepLabel(workflow: Workflow, context: ReviewContext, step: SequenceStep): string {
  const summary = card(workflow, context, step.nodeId);
  return summary ? [summary.action, summary.amount, summary.detail && !summary.amount?.includes(summary.detail) ? summary.detail : null, summary.network].filter(Boolean).join(' · ') : step.nodeId;
}
export function presentSequence(workflow: Workflow, context: ReviewContext, sequence: SequenceView): SequencePresentation {
  const steps = sequence.steps.map((step, index): SequenceStepPresentation => {
    const summary = card(workflow, context, step.nodeId), done = sequence.completed[index];
    const state = index < sequence.completed.length ? 'COMPLETED' : index === sequence.cursor ? 'CURRENT' : 'NEXT';
    const producer = step.fundedBy === null ? null : sequence.steps[step.fundedBy]!, producerDone = step.fundedBy === null ? undefined : sequence.completed[step.fundedBy];
    const bound = producerDone?.received && step.input ? BigInt(producerDone.received) < BigInt(step.input.amount) ? producerDone.received : step.input.amount : null;
    // The delivered asset's symbol is the card's own output label (the text after its arrow, e.g. "USDC → WETH"), never guessed.
    const outputSymbol = /→\s*([^\s·]+)\s*$/.exec(summary?.detail ?? '')?.[1] ?? '';
    const output = done?.received && step.output ? `${formatAssetAmount(done.received, step.output.decimals)}${outputSymbol ? ` ${outputSymbol}` : ''}` : null;
    return { number: index + 1, action: summary?.action ?? 'Action', amount: summary?.amount ?? null, detail: summary?.detail ?? null, network: summary?.network ?? step.chainId,
      state, delivered: output, funding: producer && step.input ? { from: producer.index + 1, cap: summary?.amount ?? formatted(step.input.amount, step, null),
        bound: bound ? formatted(bound, step, summary?.amount ?? null) : null } : null };
  });
  return { total: steps.length, current: sequence.cursor + 1, finished: sequence.finished, steps };
}

/** The exact missing capability when one step of a sequence has no owner-wallet runtime FloFi can run on its own. */
export function sequenceUnsupportedMessage(workflow: Workflow, context: ReviewContext, step: SequenceStep, language: Language = 'EN'): string {
  const summary = card(workflow, context, step.nodeId);
  return translate(language, 'Step {0} ({1} on {2}) cannot run as part of a multi-action workflow yet: FloFi executes this action only as its own workflow. Nothing was simulated or sent.',
    step.index + 1, translate(language, summary?.action ?? 'Action'), summary?.network ?? step.chainId);
}
/** A step whose runtime exists but whose provider this deployment does not serve (switched off here). */
export function sequenceUnservedMessage(workflow: Workflow, context: ReviewContext, step: SequenceStep, language: Language = 'EN'): string {
  const summary = card(workflow, context, step.nodeId);
  return translate(language, 'Step {0} ({1} on {2}) cannot run on this deployment: its provider is not available here. Nothing was simulated or sent.',
    step.index + 1, translate(language, summary?.action ?? 'Action'), summary?.network ?? step.chainId);
}
/** Why the current funded step cannot use what its producer delivered (nothing delivered, or an amount its card refuses). */
export function sequenceFundingMessage(sequence: SequenceView, language: Language = 'EN'): string | null {
  const step = sequence.current;
  if (step.fundedBy === null) return null;
  if (sequence.fundingIssue === 'NOTHING_DELIVERED') return translate(language, 'Step {0} has nothing to spend: step {1} delivered none of its asset.', step.index + 1, step.fundedBy + 1);
  if (sequence.fundingIssue === 'BOUND_REFUSED') return translate(language, 'Step {0} cannot spend the amount step {1} delivered: the step refuses that amount.', step.index + 1, step.fundedBy + 1);
  return null;
}
