// SPDX-License-Identifier: AGPL-3.0-only
/** Canonical summaries use attempts as well as phases. A phase alone cannot establish a financial submission. */
type Attempt = { state: string; step?: string; note?: string | null };
export function financialAttemptState(attempt: Attempt | null | undefined): string | null {
  if (!attempt) return null;
  if (attempt.state === 'NOT_FOUND' && /SUBMISSION_EXPIRED_NOT_EXECUTED$/.test(attempt.note ?? '') && attempt.step?.includes('APPROV')) return 'SUBMISSION_RESULT_UNKNOWN';
  if (attempt.state === 'CANCELLED' && /_(REJECTED|WALLET_REJECTED)$/.test(attempt.note ?? '')) return 'REJECTED';
  if (attempt.state === 'CANCELLED' && /_(WALLET_NOT_SUBMITTED|WRONG_OWNER|WRONG_CHAIN|SEMANTIC_REVISION_CHANGED)$/.test(attempt.note ?? '')) return 'NOT_SUBMITTED';
  return attempt.state;
}
export function financialRunStatus(record: { verdict: string; phase: string; attempts: readonly Attempt[]; source?: unknown }): string {
  if (record.verdict !== 'PENDING') return record.verdict;
  const states = record.attempts.map(financialAttemptState);
  const unresolved = states.find(s => ['PREPARED', 'SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'].includes(s ?? ''));
  if (unresolved) return unresolved;
  if (record.source) return record.phase;
  const last = states.at(-1);
  if (['CANCELLED', 'REJECTED', 'NOT_SUBMITTED', 'REVERTED'].includes(last ?? '')) return states.includes('CONFIRMED') ? 'PARTIAL' : last!;
  return record.phase;
}
