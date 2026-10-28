// SPDX-License-Identifier: AGPL-3.0-only
import { projectReview } from './review-presentation';
import { currentExecution, isFinalExecutionResult, nothingSubmitted } from './execution-result';
import type { ExecutionControlsState } from '../state/execution-controls';

const FRESH_SIMULATION_AFTER_NOTHING_SENT: readonly string[] = ['public', 'solana-swap', 'solana-pool', 'solana-composition', 'solana-transfer'];
/** A Solana composition whose swap is reconciled and bound, and whose position has no transaction yet. */
function awaitsPosition(source: ExecutionControlsState['source']): boolean {
  if (source.kind !== 'solana-composition') return false;
  const v = source.state.record;
  return Boolean(v && v.record.binding && (v.phase === 'BOUND' || v.phase === 'CONSUMING' && !v.liquidity?.attempt));
}
/** `processing` (UX-003): simulating or waiting for the wallet; the CTA stays in place as a locked, active button. */
export type CanvasAction = { kind: 'simulate' | 'approve' | 'execute' | 'continue' | 'recover' | 'status'; label: string; disabled: boolean; processing?: true };
/**
 * BUILD-SOLANA-TRANSFER-UX-001: the one owner action after a simulation, for every network and action. It accepts the current Review and makes
 * the first wallet request (`useExecutionControls().authorize`); with the Review already accepted it is that wallet request alone.
 */
export const AUTHORIZE_LABEL = 'Authorize in wallet';
/** Presentation only. Authority remains in Review and the existing execution/recovery capabilities. */
export function projectCanvasAction(props: ExecutionControlsState, controls: {
  requesting: boolean; verifying: boolean; canContinue: boolean; canCheck: boolean; authorizing?: boolean;
}, now = Date.now()): CanvasAction {
  // A final run remains this workflow's result. A new or edited workflow can start
  // a fresh simulation; an unresolved run always retains recovery.
  const progress = currentExecution(props.progress);
  const op = progress?.active?.operations.find(o => !['waiting', 'confirmed'].includes(o.state));
  if (controls.requesting || op?.state === 'wallet' && !controls.canCheck) return { kind: 'status', label: 'Waiting for wallet…', disabled: true, processing: true };
  if (controls.authorizing) return { kind: 'status', label: 'Preparing authorization…', disabled: true, processing: true };
  if (controls.verifying) return { kind: 'status', label: 'Reconciling…', disabled: true };
  if (progress) {
    if (controls.canContinue) return { kind: 'continue', label: props.execution.nextLabel ?? 'Continue to wallet', disabled: false };
    if (controls.canCheck) return { kind: 'recover', label: progress.restored || progress.state === 'uncertain' ? 'Recover execution' : props.recovery?.recordOnly ? 'Refresh status' : props.recovery ? 'Check status' : 'Check confirmation', disabled: false };
    // BUILD-FIX-UX-001: a public swap whose wallet request was declined before submission submitted nothing; starting over needs a fresh
    // quote, Review and wallet confirmation and cannot repeat anything (its record stays saved). The Solana runs record the same
    // pre-submission outcome (declined, wallet error, changed or stale bytes refused before any broadcast) and recover the same way.
    if (FRESH_SIMULATION_AFTER_NOTHING_SENT.includes(props.source.kind) && nothingSubmitted(progress)) return { kind: 'simulate', label: 'Simulate again', disabled: Boolean(props.invalidWorkflow || props.source.state.busy) };
    // A confirmed prefix can need a fresh quote/Review before its still-unattempted suffix.
    // Never offer simulation as a retry for an unresolved submitted operation.
    const unresolved = progress.steps.some(step => step.operations.some(operation => !['waiting', 'confirmed', 'cancelled'].includes(operation.state)));
    if (progress.state === 'active' && !progress.busy && !unresolved && !props.recovery?.contextIssue) {
      const review = projectReview(props.workflow, props.context, props.source, props.authorization, props.wallet, now, props.invalidWorkflow);
      if (review.canApprove) return { kind: 'approve', label: AUTHORIZE_LABEL, disabled: false };
      // P0: after a reconciled swap, the composition's next action prepares the position's own fresh Review (read-only); the swap is never offered again.
      if (review.status !== 'approved') return { kind: 'simulate', label: awaitsPosition(props.source) ? 'Continue to liquidity' : 'Simulate again', disabled: Boolean(props.invalidWorkflow) };
    }
    return { kind: 'status', label: progress.state === 'complete' ? 'Execution completed' : progress.state === 'uncertain' || progress.restored && !isFinalExecutionResult(progress) ? 'Recover execution' : progress.busy ? 'Reconciling…' : progress.label, disabled: true };
  }
  if (props.source.state.busy) return { kind: 'status', label: 'Simulating workflow…', disabled: true, processing: true };
  const review = projectReview(props.workflow, props.context, props.source, props.authorization, props.wallet, now, props.invalidWorkflow);
  if (review.status === 'approved') return { kind: 'execute', label: AUTHORIZE_LABEL, disabled: !props.execution.ready };
  if (props.authorization.key && !['expired', 'invalidated'].includes(review.status)) return { kind: 'approve', label: AUTHORIZE_LABEL, disabled: !review.canApprove };
  return { kind: 'simulate', label: props.authorization.key ? 'Simulate again' : 'Simulate workflow', disabled: Boolean(props.invalidWorkflow) };
}
