// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (execution continuity): ONE vocabulary for where a workflow run, a group or a step stands, shared by the Editor (Execute), the FloFi
 * Assistant, the Dashboard and the run views. Every surface derives its phase from durable records (run / group / step / attempt states and
 * reconciled facts) through these labels, so no two surfaces word the same fact differently (e.g. "Pending confirmation" beside a step another
 * surface already shows as confirmed).
 *
 * Presentation only: a phase is never authority. Nothing here signs, submits, retries or decides that funds moved.
 *
 *   PREPARED                 the exact request is built (and simulated) and nothing was handed to a wallet
 *   AWAITING_AUTHORIZATION   the owner has not approved it in their wallet yet (the run waits for them; nothing is sent by FloFi)
 *   SENT_TO_WALLET           handed to the owner's wallet; FloFi waits for the wallet's answer
 *   SUBMITTED                the wallet sent it to the network; not yet confirmed
 *   CONFIRMED_AT_SOURCE      confirmed on its own (source) network; a cross-chain delivery may still be pending
 *   AWAITING_DESTINATION     a bridge deposit confirmed at the source; the delivery on the destination network is not observed yet
 *   RECONCILED               FloFi read the confirmed outcome from the chain (what was spent and received)
 *   COMPLETED                every step of the workflow reconciled (written once; never before the last reconciliation)
 *   FAILED                   it reverted or was refused; what already reconciled stays reconciled
 *   OUTCOME_UNKNOWN          it may have been sent and its outcome is not known yet: observed only, never sent again
 */
export const EXECUTION_PHASES = ['PREPARED', 'AWAITING_AUTHORIZATION', 'SENT_TO_WALLET', 'SUBMITTED', 'CONFIRMED_AT_SOURCE', 'AWAITING_DESTINATION',
  'RECONCILED', 'COMPLETED', 'FAILED', 'OUTCOME_UNKNOWN'] as const;
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

/** English presentation keys (translated through the locale catalog; `{0}` is a network name where the phase names one). */
export const EXECUTION_PHASE_LABEL: Readonly<Record<ExecutionPhase, string>> = Object.freeze({
  PREPARED: 'Prepared',
  AWAITING_AUTHORIZATION: 'Waiting for your authorization',
  SENT_TO_WALLET: 'Sent to your wallet',
  SUBMITTED: 'Sent to the network',
  CONFIRMED_AT_SOURCE: 'Confirmed on {0}',
  AWAITING_DESTINATION: 'Waiting for delivery on {0}',
  RECONCILED: 'Reconciled',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  OUTCOME_UNKNOWN: 'Outcome unknown',
});

/** The tone a surface may give a phase (never green before RECONCILED/COMPLETED). */
export const EXECUTION_PHASE_TONE: Readonly<Record<ExecutionPhase, 'neutral' | 'active' | 'done' | 'attention' | 'blocked'>> = Object.freeze({
  PREPARED: 'neutral', AWAITING_AUTHORIZATION: 'attention', SENT_TO_WALLET: 'active', SUBMITTED: 'active', CONFIRMED_AT_SOURCE: 'active',
  AWAITING_DESTINATION: 'active', RECONCILED: 'done', COMPLETED: 'done', FAILED: 'blocked', OUTCOME_UNKNOWN: 'attention',
});

/** A phase that counts as a finished step in "X of N steps completed" (only a reconciled outcome counts). */
export const phaseCompletesStep = (phase: ExecutionPhase): boolean => phase === 'RECONCILED' || phase === 'COMPLETED';
/** A phase in which nothing may be offered to the wallet again (it may already be on its way or on chain). */
export const phaseLocksResubmission = (phase: ExecutionPhase): boolean =>
  phase === 'SENT_TO_WALLET' || phase === 'SUBMITTED' || phase === 'CONFIRMED_AT_SOURCE' || phase === 'AWAITING_DESTINATION' || phase === 'OUTCOME_UNKNOWN';

/** "X of N steps completed": counted from per-step phases only (never from a group or a transaction count). */
export function workflowProgress(phases: readonly ExecutionPhase[]): { readonly completed: number; readonly total: number } {
  return { completed: phases.filter(phaseCompletesStep).length, total: phases.length };
}
