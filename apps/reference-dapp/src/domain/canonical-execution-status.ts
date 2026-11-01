// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: one canonical lifecycle status for a durable run summary, so chat, MCP, channels and the Dashboard
 * name the same moment the same way. It is derived only from the run's recorded facts (status, latest attempt, observation and attention
 * flags), never from a provider answer, and it never upgrades evidence:
 *
 *   NOT_STARTED                simulated or reviewed only; no wallet request was made
 *   AUTHORIZATION_PENDING      an attempt is prepared; the owner's wallet decision is pending
 *   REJECTED                   recorded as declined or cancelled; nothing was submitted
 *   SUBMITTED                  a submission is recorded; its transaction hash is not yet known
 *   HASH_KNOWN                 the transaction hash is known; awaiting onchain confirmation
 *   CONFIRMED_ONCHAIN          a transaction is confirmed onchain; the workflow outcome is not reconciled yet
 *   SETTLEMENT_PENDING         cross-chain: the origin side is recorded; destination settlement is not proven yet
 *   RECONCILED                 the outcome is reconciled (the only "completed" status)
 *   RECONCILED_WITH_ATTENTION  reconciled, with a recorded attention item
 *   PARTIALLY_COMPLETED        earlier actions completed; a later one did not
 *   REVERTED / FAILED          the transaction reverted / the action failed (final)
 *   INCONCLUSIVE               a recorded request still needs verification (FloFi never repeats it)
 *   INTERVENTION_REQUIRED      a recorded state FloFi cannot classify safely; the person should open the run
 *
 * Origin confirmation is never settlement, and a hash or a provider's "success" is never completion.
 */
export const CANONICAL_EXECUTION_STATUSES = Object.freeze(['NOT_STARTED', 'AUTHORIZATION_PENDING', 'REJECTED', 'SUBMITTED', 'HASH_KNOWN', 'CONFIRMED_ONCHAIN',
  'SETTLEMENT_PENDING', 'RECONCILED', 'RECONCILED_WITH_ATTENTION', 'PARTIALLY_COMPLETED', 'REVERTED', 'FAILED', 'INCONCLUSIVE', 'INTERVENTION_REQUIRED'] as const);
export type CanonicalExecutionStatus = typeof CANONICAL_EXECUTION_STATUSES[number];
export type CanonicalLifecycle = { readonly status: CanonicalExecutionStatus; readonly final: boolean; readonly completed: boolean };
export type RunSummaryFacts = { readonly status: string; readonly needsObservation?: unknown; readonly attentionRequired?: unknown; readonly errorCode?: unknown;
  readonly attempts?: readonly unknown[] };

const FINAL: ReadonlySet<CanonicalExecutionStatus> = new Set(['REJECTED', 'RECONCILED', 'RECONCILED_WITH_ATTENTION', 'PARTIALLY_COMPLETED', 'REVERTED', 'FAILED']);
const NOT_STARTED = new Set(['PREPARED', 'SIMULATED', 'AUTHORIZED', 'REVIEWED', 'QUOTED']);
const SETTLING = new Set(['SOURCE_CONFIRMED', 'IN_FLIGHT', 'DESTINATION_OBSERVED', 'SETTLING']);
const SUBMITTED = new Set(['RESERVED', 'SIGNED', 'POSTING', 'POSTED', 'OPEN', 'FULFILLED', 'PARTIALLY_FILLED']);

const of = (status: CanonicalExecutionStatus): CanonicalLifecycle =>
  ({ status, final: FINAL.has(status), completed: status === 'RECONCILED' || status === 'RECONCILED_WITH_ATTENTION' });

/** The latest attempt's recorded state, when the summary carries attempts. */
function latestAttempt(run: RunSummaryFacts): { state: string; hash: boolean } | null {
  const last = Array.isArray(run.attempts) ? run.attempts.at(-1) : undefined;
  if (!last || typeof last !== 'object') return null;
  const value = last as { state?: unknown; transactionHash?: unknown };
  return typeof value.state === 'string' ? { state: value.state, hash: typeof value.transactionHash === 'string' && value.transactionHash.length > 0 } : null;
}

export function canonicalRunLifecycle(run: RunSummaryFacts): CanonicalLifecycle {
  const observing = run.needsObservation === true, attention = run.attentionRequired === true || (typeof run.errorCode === 'string' && run.errorCode.length > 0);
  const status = run.status;
  if (status === 'RECONCILED' && !observing) return of(attention ? 'RECONCILED_WITH_ATTENTION' : 'RECONCILED');
  if ((status === 'CANCELLED' || status === 'REJECTED') && !observing) return of('REJECTED');
  if (status === 'PARTIAL' || status === 'PARTIALLY_COMPLETED') return of('PARTIALLY_COMPLETED');
  if (status === 'REVERTED' && !observing) return of('REVERTED');
  if (status === 'FAILED' && !observing) return of('FAILED');
  if (status === 'SUBMITTING' || status === 'UNKNOWN') return of('INCONCLUSIVE');
  if (SETTLING.has(status)) return of('SETTLEMENT_PENDING');
  const attempt = latestAttempt(run);
  if (NOT_STARTED.has(status)) {
    if (/SUBMISSION_EXPIRED_NOT_EXECUTED$/.test(typeof run.errorCode === 'string' ? run.errorCode : '') || observing) return of('INCONCLUSIVE');
    return of(attempt?.state === 'PREPARED' ? 'AUTHORIZATION_PENDING' : 'NOT_STARTED');
  }
  if (status === 'HASH' || status === 'PENDING') return of(attempt?.hash === false && status === 'PENDING' ? 'SUBMITTED' : 'HASH_KNOWN');
  if (SUBMITTED.has(status)) return of('SUBMITTED');
  if (status === 'CONFIRMED') return of('CONFIRMED_ONCHAIN');
  if (observing && ['RECONCILED', 'REVERTED', 'FAILED', 'CANCELLED', 'REJECTED'].includes(status)) return of('INCONCLUSIVE');
  return of('INTERVENTION_REQUIRED');
}
