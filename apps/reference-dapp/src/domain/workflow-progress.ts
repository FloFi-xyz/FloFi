// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (execution continuity, production 2026-11-12): ONE progress for the WHOLE workflow, read by Execute, the FloFi Assistant and the
 * Dashboard alike. Before this, Execute counted the current runtime's steps ("0 of 1" for a sequence step), only after every operation of a step
 * read "confirmed" (an owner-bound approval stayed "Pending confirmation" beside its confirmed transaction), and the sequence count rose only once
 * the shell handed over to the next step — three numbers for one workflow.
 *
 * Per-step phases come from the shared vocabulary (`execution-phase.ts`) and from durable records only: a step the sequence completed (its run's
 * reconciled record) is RECONCILED; the current step's phase is its runtime's lifecycle (an approval whose receipt confirmed is confirmed; a bridge
 * deposit confirmed at the source with its fill pending is AWAITING_DESTINATION); a step counts as completed only when RECONCILED. N is the number
 * of workflow steps. Pure: presentation only, never authority — nothing here signs, submits, retries or decides that funds moved.
 */
import { EXECUTION_PHASE_LABEL, phaseCompletesStep, workflowProgress, type ExecutionPhase } from './execution-phase';
import { phaseNetwork, type ExecutionLifecycle, type LifecycleOperation, type LifecycleStep } from './execution-lifecycle';
import { isFinalExecutionResult } from './execution-result';
import type { SequencePresentation } from './sequence-presentation';

/** A catalog key and its `{0}` parameters (a network name), translated by the surface that shows it. */
export type PhaseText = { readonly key: string; readonly args: readonly string[] };
export type WorkflowStepProgress = {
  readonly number: number; readonly action: string; readonly network: string;
  /** Null: not started (nothing prepared or requested for it yet). */ readonly phase: ExecutionPhase | null; readonly text: PhaseText;
  /** The step the workflow is on now. */ readonly current: boolean;
  /** What its reconciled record proves it delivered (a completed sequence step), when FloFi can read it. */ readonly delivered: string | null;
};
export type WorkflowProgressView = {
  readonly steps: readonly WorkflowStepProgress[]; readonly completed: number; readonly total: number;
  /** 1-based number of the step the workflow is on (null once every step completed). */ readonly current: number | null;
  /** Every step reconciled: the workflow's COMPLETED (written once, never before the last reconciliation). */ readonly finished: boolean;
  /** Something needs the owner: a step failed or its outcome is unknown. */ readonly attention: boolean;
};

const FAILED = ['failed', 'cancelled', 'expired', 'not-submitted'];
const SENT = ['signed', 'submitting', 'submitted', 'posted', 'pending', 'settling', 'partial'];
/** One operation's phase from its durable lifecycle state (its runtime's own phase where it worded one). */
export function operationPhase(op: LifecycleOperation): ExecutionPhase | null {
  if (op.phase) return op.phase;
  if (op.state === 'confirmed') return op.wallet ? 'CONFIRMED_AT_SOURCE' : 'RECONCILED';
  if (op.state === 'wallet') return 'SENT_TO_WALLET';
  if (op.state === 'preparing') return 'PREPARED';
  if (SENT.includes(op.state)) return op.wallet ? 'SUBMITTED' : 'AWAITING_DESTINATION';
  if (op.state === 'uncertain') return 'OUTCOME_UNKNOWN';
  if (FAILED.includes(op.state)) return 'FAILED';
  return null;
}
/**
 * A lifecycle step's phase. `reconciled`: its run is final and complete (every request confirmed and reconciled by its runtime) — only then is
 * it RECONCILED; a step whose requests all confirmed before that is CONFIRMED_AT_SOURCE.
 */
export function lifecycleStepPhase(step: LifecycleStep, reconciled: boolean): ExecutionPhase | null {
  const ops = step.operations;
  if (!ops.length || ops.every(op => op.state === 'waiting')) return null;
  if (ops.some(op => op.state === 'uncertain')) return 'OUTCOME_UNKNOWN';
  if (ops.some(op => FAILED.includes(op.state))) return 'FAILED';
  if (ops.every(op => op.state === 'confirmed')) return reconciled ? 'RECONCILED' : 'CONFIRMED_AT_SOURCE';
  if (ops.some(op => op.state === 'wallet')) return 'SENT_TO_WALLET';
  const requests = ops.filter(op => op.wallet);
  if (requests.length && requests.every(op => op.state === 'confirmed') && ops.some(op => !op.wallet && operationPhase(op) === 'AWAITING_DESTINATION')) return 'AWAITING_DESTINATION';
  if (ops.some(op => op.phase === 'CONFIRMED_AT_SOURCE')) return 'CONFIRMED_AT_SOURCE';
  if (requests.some(op => SENT.includes(op.state))) return 'SUBMITTED';
  if (ops.some(op => op.state === 'preparing')) return 'PREPARED';
  // A request of this step confirmed and its next one not requested yet: the run waits for the owner (never sent by FloFi).
  if (ops.some(op => op.state === 'confirmed')) return 'AWAITING_AUTHORIZATION';
  return 'PREPARED';
}
/** The words for a phase: its catalog key and, where it names one, the network (the step's source, or its destination while delivery is awaited). */
export function phaseText(phase: ExecutionPhase | null, step?: LifecycleStep | null): PhaseText {
  if (!phase) return { key: 'Not started', args: [] };
  const key = EXECUTION_PHASE_LABEL[phase];
  if (!key.includes('{0}')) return { key, args: [] };
  const ops = step?.operations ?? [];
  const chain = phase === 'AWAITING_DESTINATION' ? ops.find(op => !op.wallet)?.chain : ops.filter(op => op.wallet && op.state !== 'waiting').at(-1)?.chain ?? ops[0]?.chain;
  return chain ? { key, args: [phaseNetwork(chain)] } : { key: phase === 'AWAITING_DESTINATION' ? 'Waiting for delivery' : 'Confirmed', args: [] };
}
const reconciledRun = (live: ExecutionLifecycle) => live.state === 'complete' && isFinalExecutionResult(live);

/**
 * The whole workflow's progress. `sequence`: the workflow's steps when it runs step by step (the shell's sequence presentation); `live`: the
 * current runtime's execution (its current step's run, or the whole workflow's when one runtime serves it); `prepared`: the current step's own
 * simulation is ready and nothing was requested for it yet. Null when nothing ran and no sequence has started.
 */
export function workflowProgressView(input: { readonly sequence: SequencePresentation | null | undefined; readonly live: ExecutionLifecycle | null | undefined; readonly prepared?: boolean }): WorkflowProgressView | null {
  const { sequence, prepared = false } = input, live = input.live?.started && input.live.matchesWorkflow !== false ? input.live : null;
  let steps: WorkflowStepProgress[];
  if (sequence && sequence.total > 0) {
    steps = sequence.steps.map((step, index): WorkflowStepProgress => {
      const current = !sequence.finished && step.state === 'CURRENT';
      const runStep = current && live ? live.steps[0] ?? null : null;
      const phase: ExecutionPhase | null = step.state === 'COMPLETED' ? 'RECONCILED' : !current ? null
        : runStep ? lifecycleStepPhase(runStep, reconciledRun(live!)) ?? (prepared ? 'PREPARED' : null) : prepared ? 'PREPARED' : null;
      return { number: index + 1, action: step.action, network: step.network, phase, text: phaseText(phase, runStep), current, delivered: step.delivered };
    });
  } else if (live) {
    const done = reconciledRun(live);
    steps = live.steps.map((step): WorkflowStepProgress => {
      const phase = lifecycleStepPhase(step, done);
      return { number: step.number, action: step.action, network: step.network, phase, text: phaseText(phase, step), current: live.active?.id === step.id, delivered: null };
    });
  } else return null;
  const { completed, total } = workflowProgress(steps.map(step => step.phase ?? 'PREPARED'));
  const finished = total > 0 && completed === total;
  const at = steps.findIndex(step => !step.phase || !phaseCompletesStep(step.phase));
  return { steps, completed, total, current: finished || at < 0 ? null : at + 1, finished,
    attention: steps.some(step => step.phase === 'FAILED' || step.phase === 'OUTCOME_UNKNOWN') };
}
/** "X of N steps completed" (EN catalog key; `{0}`/`{1}` as parameters). */
export const STEPS_COMPLETED = '{0} of {1} steps completed';
