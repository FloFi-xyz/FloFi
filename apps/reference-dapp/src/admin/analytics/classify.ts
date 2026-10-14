// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: what one durable run's projection says about its execution, in the domain's own terms. Pure and conservative:
 *
 *   started    an attempt moved past PREPARED/CANCELLED (the owner's wallet was asked), evidence exists, or a composition phase began;
 *   submitted  a transaction exists (hash/signature, or a post-broadcast attempt state), or evidence exists;
 *   outcome    COMPLETED only for a reconciled verdict with nothing left to observe — a submitted hash alone is never success.
 *
 * Statuses come from each flow's projector (`backend/flows.ts`): run verdicts (RECONCILED, DIVERGENT, INCONCLUSIVE, NOT_EXECUTED,
 * REFUNDED, FAILED), the open attempt's state, router/payment/lending phases and the Solana composition phase. Any status not listed
 * here is UNCLASSIFIED and reported as such, never folded into success or failure.
 */
export type ExecutionOutcome = 'NOT_STARTED' | 'NOT_EXECUTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'PARTIAL' | 'UNCERTAIN' | 'UNCLASSIFIED';
export type AttemptFact = { readonly step: string; readonly state: string; readonly hash: boolean; readonly reconciled: boolean };
export type RunFact = { readonly flow: string; readonly status: string; readonly needsObservation: boolean; readonly attentionRequired: boolean;
  readonly hasEvidence: boolean; readonly journalAuthorized: boolean; readonly attempts: readonly AttemptFact[] };
export type RunClassification = { readonly authorized: boolean; readonly started: boolean; readonly submitted: boolean; readonly outcome: ExecutionOutcome;
  readonly attention: boolean };

const set = (...values: string[]) => new Set(values);
export const COMPLETED_STATUSES = set('RECONCILED', 'COMPLETED', 'PAYMENT_SETTLED');
export const FAILED_STATUSES = set('DIVERGENT', 'FAILED', 'REVERTED', 'REFUNDED');
export const PARTIAL_STATUSES = set('PARTIAL', 'PARTIALLY_COMPLETED');
export const UNCERTAIN_STATUSES = set('INCONCLUSIVE', 'RECONCILIATION_REQUIRED', 'RECOVERY_REQUIRED', 'ATTENTION', 'UNKNOWN', 'SUBMISSION_RESULT_UNKNOWN', 'NOT_FOUND');
export const NOT_EXECUTED_STATUSES = set('NOT_EXECUTED', 'REJECTED', 'CANCELLED', 'EXPIRED');
export const NOT_STARTED_STATUSES = set('SIMULATED', 'AUTHORIZED', 'REVIEWED', 'QUOTED', 'DRAFT', 'PREPARED');
export const IN_PROGRESS_STATUSES = set('SUBMITTING', 'PENDING', 'HASH', 'CONFIRMED', 'SOURCE_SUBMITTED', 'SOURCE_CONFIRMED', 'IN_FLIGHT', 'DESTINATION_OBSERVED',
  'EXECUTING', 'PAUSED', 'PAYMENT_PENDING', 'PRODUCING', 'BOUND', 'CONSUMING');
/** Solana composition phases that mean the swap step began (the coordinator itself carries no attempts). */
const COMPOSITION_STARTED = set('PRODUCING', 'BOUND', 'CONSUMING', 'COMPLETED', 'PARTIAL', 'ATTENTION', 'FAILED');
const BEFORE_WALLET = set('PREPARED', 'CANCELLED');
const AFTER_BROADCAST = set('HASH', 'PENDING', 'CONFIRMED', 'REVERTED', 'RECONCILIATION_REQUIRED', 'NOT_FOUND', 'SUBMISSION_RESULT_UNKNOWN', 'UNKNOWN');
const PRE_AUTHORIZATION = set('SIMULATED', 'QUOTED', 'DRAFT', 'REVIEWED');
export const COMPOSITION_FLOWS = set('solana-devnet-composition');
/** Whether one attempt put a transaction on chain (a hash or signature, or a post-broadcast state). */
export const attemptSubmitted = (attempt: AttemptFact): boolean => attempt.hash || AFTER_BROADCAST.has(attempt.state);

export function classifyRun(run: RunFact): RunClassification {
  const composition = COMPOSITION_FLOWS.has(run.flow);
  const started = run.hasEvidence || run.attempts.some(a => !BEFORE_WALLET.has(a.state)) || (composition && COMPOSITION_STARTED.has(run.status));
  const submitted = run.hasEvidence || run.attempts.some(attemptSubmitted) || (composition && run.status !== 'PRODUCING' && COMPOSITION_STARTED.has(run.status));
  const authorized = started || run.journalAuthorized || !(PRE_AUTHORIZATION.has(run.status) || (run.status === 'PREPARED' && run.attempts.length === 0)
    || NOT_EXECUTED_STATUSES.has(run.status));
  let outcome: ExecutionOutcome;
  if (!started) outcome = NOT_EXECUTED_STATUSES.has(run.status) || FAILED_STATUSES.has(run.status) ? 'NOT_EXECUTED' : 'NOT_STARTED';
  else if (COMPLETED_STATUSES.has(run.status)) outcome = run.needsObservation ? 'IN_PROGRESS' : 'COMPLETED';
  else if (FAILED_STATUSES.has(run.status)) outcome = submitted ? 'FAILED' : 'NOT_EXECUTED';
  else if (PARTIAL_STATUSES.has(run.status)) outcome = 'PARTIAL';
  else if (UNCERTAIN_STATUSES.has(run.status)) outcome = run.needsObservation && !run.attentionRequired ? 'IN_PROGRESS' : 'UNCERTAIN';
  else if (NOT_EXECUTED_STATUSES.has(run.status)) outcome = 'NOT_EXECUTED'; // the service's own verdict: nothing landed
  else if (IN_PROGRESS_STATUSES.has(run.status) || NOT_STARTED_STATUSES.has(run.status)) outcome = 'IN_PROGRESS';
  else outcome = 'UNCLASSIFIED';
  const attention = run.attentionRequired || outcome === 'UNCERTAIN' || outcome === 'PARTIAL' || outcome === 'UNCLASSIFIED';
  return { authorized, started, submitted, outcome, attention };
}

/** An execution counts as executed once a transaction was submitted and the service has not established that nothing landed. */
export const executed = (c: RunClassification): boolean => c.submitted && c.outcome !== 'NOT_EXECUTED' && c.outcome !== 'NOT_STARTED';
/** Outcomes that count in success/failure rates: resolved or unresolved-final; in-progress executions are excluded. */
export const RATE_OUTCOMES: ReadonlySet<ExecutionOutcome> = new Set(['COMPLETED', 'FAILED', 'PARTIAL', 'UNCERTAIN']);
