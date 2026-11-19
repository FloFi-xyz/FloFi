// SPDX-License-Identifier: AGPL-3.0-only
/** Canonical summaries use attempts as well as phases. A phase alone cannot establish a financial submission. */
type Attempt = { state: string; step?: string; note?: string | null };
export function financialAttemptState(attempt: Attempt | null | undefined): string | null {
  if (!attempt) return null;
  if (attempt.state === 'NOT_FOUND' && /SUBMISSION_EXPIRED_NOT_EXECUTED$/.test(attempt.note ?? '') && attempt.step?.includes('APPROV')) return 'SUBMISSION_RESULT_UNKNOWN';
  if (attempt.state === 'CANCELLED' && /_(REJECTED|WALLET_REJECTED)$/.test(attempt.note ?? '')) return 'REJECTED';
  if (attempt.state === 'CANCELLED' && /_(WALLET_NOT_SUBMITTED|WRONG_OWNER|WRONG_CHAIN|SEMANTIC_REVISION_CHANGED)$/.test(attempt.note ?? '')) return 'NOT_SUBMITTED';
  // BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (EXEC-01): the Review expired before the wallet was asked (the server concludes the prepared attempt
  // at the hand-off, or the hand-off refused it as no longer authorized): never a refusal or a cancellation by the owner, and nothing was sent.
  if (attempt.state === 'CANCELLED' && /_(REVIEW_EXPIRED|WALLET_HANDOFF_NOT_AUTHORIZED)$/.test(attempt.note ?? '')) return 'NOT_SUBMITTED';
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a Uniswap request refused before the wallet was asked because its Review no longer stood (the position, pool
  // or fees moved) or the position changed hands: the attempt is concluded unsent (the service records CANCELLED for these only with no wallet invocation).
  if (attempt.state === 'CANCELLED' && /^UNISWAP_(?:[A-Z0-9_]+_REVIEW_REQUIRED|POSITION_OWNER_MISMATCH)$/.test(attempt.note ?? '')) return 'NOT_SUBMITTED';
  // BUILD-P0-MAINNET-EXECUTION-RELIABILITY: a refusal FloFi made before the wallet's send method was ever called (the server records CANCELLED for
  // these only from PREPARED with no wallet invocation): the wallet's nonce disagreed, FloFi's own nonce read moved at the hand-off, the wallet
  // provider or the visible run changed, or a read failed first. Nothing of it can have reached the network.
  if (attempt.state === 'CANCELLED' && /_(WALLET_NONCE_(MISMATCH|BEHIND|AHEAD|RESPONSE_INVALID)|NONCE_CHANGED|WALLET_PROVIDER_CHANGED|RUN_CHANGED|RPC_ERROR_BEFORE_WALLET_SUBMISSION|WALLET_PREFLIGHT)$/.test(attempt.note ?? '')) return 'NOT_SUBMITTED';
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
