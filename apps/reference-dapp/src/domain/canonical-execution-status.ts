// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: one canonical lifecycle status for a durable run summary, so chat, MCP, channels and the Dashboard
 * name the same moment the same way. It is derived only from the run's recorded facts (status, latest attempt, observation and attention
 * flags), never from a provider answer, and it never upgrades evidence:
 *
 *   NOT_STARTED                simulated or reviewed only; no wallet request was made and no earlier step is confirmed
 *   AUTHORIZATION_PENDING      an attempt is prepared; the owner's wallet decision is pending
 *   REJECTED                   the latest request was declined, cancelled or never submitted (earlier confirmed steps, if any, stay recorded)
 *   SUBMITTED                  a submission is recorded; its transaction hash is not yet known
 *   HASH_KNOWN                 the transaction hash is known; awaiting onchain confirmation
 *   CONFIRMED_ONCHAIN          a transaction is confirmed onchain; the workflow outcome is not reconciled yet
 *   SETTLEMENT_PENDING         cross-chain: the origin side is recorded; destination settlement is not proven yet
 *   RECONCILED                 the outcome is reconciled (the only "completed" status)
 *   RECONCILED_WITH_ATTENTION  reconciled, with a recorded attention item
 *   PARTIALLY_COMPLETED        earlier actions completed; a later one did not
 *   REVERTED / FAILED          the transaction reverted / the action failed (final)
 *   INCONCLUSIVE               a recorded request still needs verification (FloFi never repeats it)
 *   INTERVENTION_REQUIRED      a recorded divergence or required recovery, or a state FloFi cannot classify safely; the person should open the run
 *
 * `final` means nothing changes without a new owner action (a declined run may still be authorized again by its owner).
 * Origin confirmation is never settlement, and a hash or a provider's "success" is never completion.
 */
export const CANONICAL_EXECUTION_STATUSES = Object.freeze(['NOT_STARTED', 'AUTHORIZATION_PENDING', 'REJECTED', 'SUBMITTED', 'HASH_KNOWN', 'CONFIRMED_ONCHAIN',
  'SETTLEMENT_PENDING', 'RECONCILED', 'RECONCILED_WITH_ATTENTION', 'PARTIALLY_COMPLETED', 'REVERTED', 'FAILED', 'INCONCLUSIVE', 'INTERVENTION_REQUIRED'] as const);
export type CanonicalExecutionStatus = typeof CANONICAL_EXECUTION_STATUSES[number];
export type CanonicalLifecycle = { readonly status: CanonicalExecutionStatus; readonly final: boolean; readonly completed: boolean };
export type RunSummaryFacts = { readonly status: string; readonly needsObservation?: unknown; readonly attentionRequired?: unknown; readonly errorCode?: unknown;
  readonly hasEvidence?: unknown; readonly attempts?: readonly unknown[] };

const FINAL: ReadonlySet<CanonicalExecutionStatus> = new Set(['REJECTED', 'RECONCILED', 'RECONCILED_WITH_ATTENTION', 'PARTIALLY_COMPLETED', 'REVERTED', 'FAILED']);
// Recorded statuses, grouped as FloFi's flows emit them (run verdicts, flow phases and attempt states; domain/financial-run-status.ts).
const NOT_STARTED = new Set(['DRAFT', 'PREPARED', 'SIMULATED', 'AUTHORIZED', 'REVIEWED', 'QUOTED']);
const DECLINED = new Set(['CANCELLED', 'REJECTED', 'NOT_SUBMITTED', 'NOT_EXECUTED', 'EXPIRED']);
// Pix: PAYMENT_PENDING is the source confirmed with the payout not yet proven.
const SETTLING = new Set(['SOURCE_CONFIRMED', 'IN_FLIGHT', 'DESTINATION_OBSERVED', 'SETTLING', 'PAYMENT_PENDING']);
const SUBMITTED = new Set(['RESERVED', 'SIGNED', 'POSTING', 'POSTED', 'OPEN', 'FULFILLED', 'PARTIALLY_FILLED', 'SOURCE_SUBMITTED']);
const INCONCLUSIVE = new Set(['SUBMITTING', 'UNKNOWN', 'SUBMISSION_RESULT_UNKNOWN', 'RECONCILIATION_REQUIRED', 'INCONCLUSIVE', 'NOT_FOUND']);
const INTERVENTION = new Set(['DIVERGENT', 'RECOVERY_REQUIRED']);
// A step that reached the chain but whose workflow is not reconciled yet (a flow phase, never a verdict).
const CONFIRMED_STEP = new Set(['CONFIRMED', 'COMPLETED', 'SETTLED']);
// A flow's own settled end state (a composition's COMPLETED, Pix's PAYMENT_SETTLED): reconciled only with recorded evidence, never on the label alone.
const SETTLED_WITH_EVIDENCE = new Set(['COMPLETED', 'PAYMENT_SETTLED']);
// Compositions' working phases (lending EXECUTING and PAUSED, which can follow confirmed steps; a bound composition PRODUCING → BOUND →
// CONSUMING): what is happening is the latest attempt's (the same in-progress group as admin/analytics/classify.ts).
const WORKING = new Set(['EXECUTING', 'PAUSED', 'PRODUCING', 'BOUND', 'CONSUMING']);
// Attempt states that are declines (a wallet refusal, a cancellation, a request never submitted).
const ATTEMPT_DECLINED = new Set(['REFUSED', 'CANCELLED', 'REJECTED', 'NOT_SUBMITTED', 'NOT_EXECUTED', 'EXPIRED']);
/**
 * A recorded error saying a wallet or submission result is unknown (e.g. PAYMENT_WALLET_RESULT_UNKNOWN, *_SUBMISSION_EXPIRED_NOT_EXECUTED):
 * something may have been sent, so the run is never shown as not started. Shared with the Dashboard's summary mapping.
 */
export const recordedResultUnknown = (errorCode: unknown) =>
  typeof errorCode === 'string' && /(?:^|_)RESULT_UNKNOWN$|SUBMISSION_EXPIRED_NOT_EXECUTED$/.test(errorCode);
/** A flow's settled end state that counts as reconciled only with recorded evidence (shared with the Dashboard's summary mapping). */
export const settledWithEvidence = (run: { readonly status: string; readonly hasEvidence?: unknown }) =>
  run.status === 'RECONCILED' || SETTLED_WITH_EVIDENCE.has(run.status) && run.hasEvidence === true;

const of = (status: CanonicalExecutionStatus): CanonicalLifecycle =>
  ({ status, final: FINAL.has(status), completed: status === 'RECONCILED' || status === 'RECONCILED_WITH_ATTENTION' });

const attemptsOf = (run: RunSummaryFacts) => (Array.isArray(run.attempts) ? run.attempts : [])
  .filter((a): a is { state?: unknown; transactionHash?: unknown; reconciled?: unknown } => !!a && typeof a === 'object');
/** The latest attempt's recorded state, when the summary carries attempts. */
function latestAttempt(run: RunSummaryFacts): { state: string; hash: boolean } | null {
  const last = attemptsOf(run).at(-1);
  return last && typeof last.state === 'string' ? { state: last.state, hash: typeof last.transactionHash === 'string' && last.transactionHash.length > 0 } : null;
}
/** Whether an earlier step of this run is already confirmed onchain (e.g. an approval before the swap, the first leg of a composition). */
const earlierConfirmed = (run: RunSummaryFacts) => attemptsOf(run).some(a => a.state === 'CONFIRMED' || a.reconciled === true);
/**
 * What the latest attempt says, when the run's own status does not settle it (it still reads as not started, or is a working phase). Anything
 * after the wallet was asked is never "nothing was sent": an attempt being submitted, or with an unknown result, is INCONCLUSIVE.
 */
function attemptLifecycle(attempt: { state: string; hash: boolean }, confirmed: boolean): CanonicalExecutionStatus {
  const state = attempt.state;
  if (state === 'PREPARED') return 'AUTHORIZATION_PENDING';
  if (ATTEMPT_DECLINED.has(state)) return confirmed ? 'CONFIRMED_ONCHAIN' : 'REJECTED';
  if (state === 'CONFIRMED') return 'CONFIRMED_ONCHAIN';
  if (state === 'PENDING' || state === 'SUBMITTED' || state === 'HASH' || SUBMITTED.has(state)) return attempt.hash ? 'HASH_KNOWN' : 'SUBMITTED';
  if (INCONCLUSIVE.has(state) || state === 'REVERTED' || state === 'FAILED') return 'INCONCLUSIVE';
  return 'INTERVENTION_REQUIRED';
}

export function canonicalRunLifecycle(run: RunSummaryFacts): CanonicalLifecycle {
  const observing = run.needsObservation === true, attention = run.attentionRequired === true || (typeof run.errorCode === 'string' && run.errorCode.length > 0);
  const status = run.status, confirmed = earlierConfirmed(run);
  if (settledWithEvidence(run) && !observing)
    return of(attention ? 'RECONCILED_WITH_ATTENTION' : 'RECONCILED');
  // The latest request was declined, cancelled, expired or never submitted. With an earlier step confirmed, the run is partially completed.
  if (DECLINED.has(status) && !observing) return of(confirmed ? 'PARTIALLY_COMPLETED' : 'REJECTED');
  // Earlier steps completed (the Dashboard's "Partially completed"); while an observation is still pending the outcome can still change.
  if (status === 'PARTIAL' || status === 'PARTIALLY_COMPLETED') return { ...of('PARTIALLY_COMPLETED'), final: !observing };
  if (status === 'REVERTED' && !observing) return of('REVERTED');
  // A bridge refunded on its origin chain: the transfer did not settle; the funds came back (final, never completion).
  if ((status === 'FAILED' || status === 'REFUNDED') && !observing) return of('FAILED');
  if (INCONCLUSIVE.has(status)) return of('INCONCLUSIVE');
  if (INTERVENTION.has(status)) return of('INTERVENTION_REQUIRED');
  if (SETTLING.has(status)) return of('SETTLEMENT_PENDING');
  const attempt = latestAttempt(run);
  if (NOT_STARTED.has(status)) {
    // A recorded unknown wallet result (the run itself may still read AUTHORIZED, as Pix's does) or a pending observation: never "nothing sent".
    if (recordedResultUnknown(run.errorCode) || observing) return of('INCONCLUSIVE');
    if (attempt) return of(attemptLifecycle(attempt, confirmed));
    // Never "nothing was sent" when an earlier step (an approval, a first leg) is confirmed onchain.
    return of(confirmed ? 'CONFIRMED_ONCHAIN' : 'NOT_STARTED');
  }
  if (WORKING.has(status)) return of(attempt ? attemptLifecycle(attempt, confirmed) : 'INCONCLUSIVE');
  // A hash is claimed only when one is recorded (HASH is the flow saying so); a summary without attempts says SUBMITTED.
  if (status === 'HASH') return of('HASH_KNOWN');
  if (status === 'PENDING' || SUBMITTED.has(status)) return of(attempt?.hash ? 'HASH_KNOWN' : 'SUBMITTED');
  // Pix's settled payout without recorded evidence yet: the settlement is not proven.
  if (status === 'PAYMENT_SETTLED') return of('SETTLEMENT_PENDING');
  if (CONFIRMED_STEP.has(status)) return of('CONFIRMED_ONCHAIN');
  if (observing && (DECLINED.has(status) || ['RECONCILED', 'REVERTED', 'FAILED', 'REFUNDED'].includes(status))) return of('INCONCLUSIVE');
  return of('INTERVENTION_REQUIRED');
}
