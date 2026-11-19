// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (EXEC-01): continuing a Uniswap v3 liquidity run after its Review stopped standing between two
 * wallet requests (it expired, or the pool, fees or gas moved), on the SAME run. The server's `refresh` re-reads the chain and builds an
 * updated Review of only what remains (an approval whose allowance now suffices is not asked again); the owner authorizes that Review
 * explicitly; the confirmed steps and their evidence stay on the run. Nothing here authorizes, prepares or sends anything.
 */
import { supersededUnsent } from './execution-lifecycle';

type Attempt = { readonly step: string; readonly state: string; readonly reconciled: boolean; readonly reviewCommitment: string;
  readonly transactionHash: string | null; readonly replacementHash: string | null };
type Run = { readonly verdict: string; readonly attempts: readonly Attempt[]; readonly review: { readonly commitment: string } };

/** A refusal before any wallet request after which the run's Review no longer stands and is refreshed in place (nothing was sent). */
export const UNISWAP_REFRESH_IN_PLACE = /^UNISWAP_(?:REVIEW_EXPIRED|STATE_CHANGED_REVIEW_REQUIRED|FEES_CHANGED_REVIEW_REQUIRED|GAS_CHANGED_REVIEW_REQUIRED|L1_FEES_CHANGED_REVIEW_REQUIRED)$/;
/** The run log holds at most 16 attempts; a continuation keeps room for the (at most three) remaining requests. */
const ATTEMPT_ROOM = 16 - 3;

/**
 * A confirmed, reconciled approval: evidence that stays, never authority for what follows. BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 (defence in depth):
 * only an exact APPROVE_* step counts. A position-management step (COLLECT / DECREASE / EXIT) is never an approval, so a confirmed withdrawal
 * can never make a position run "resumable" by the mint continuation.
 */
export const confirmedApproval = (a: Attempt) => /^APPROVE_TOKEN[01]$/.test(a.step) && a.state === 'CONFIRMED' && a.reconciled;
/**
 * Every attempt of the run is either a confirmed, reconciled approval or was cancelled before any broadcast (no hash): nothing of it is
 * pending, unknown, reverted or minted, so a refreshed Review of the same run can never repeat or race a request. Anything else keeps the
 * existing paths (observation, or a separate new simulation).
 */
export function uniswapRunResumable(record: Run | null | undefined): boolean {
  if (!record || record.verdict !== 'PENDING' || record.attempts.length > ATTEMPT_ROOM) return false;
  return record.attempts.every(a => confirmedApproval(a) || a.state === 'CANCELLED' && !a.transactionHash && !a.replacementHash);
}
/**
 * "Simulate again" of a started run (an approval already landed) refreshes that run in place instead of starting a separate one. A run that
 * already attempted its mint starts a new simulation, as before: its duplicate-position guard (never weakened) could otherwise keep the same
 * run refusing once the owner's positions changed elsewhere.
 */
export function uniswapRefreshInPlace(record: Run | null | undefined, retired: boolean): boolean {
  return Boolean(record && !retired && uniswapRunResumable(record) && record.attempts.some(confirmedApproval) && !record.attempts.some(a => a.step === 'MINT'));
}
/**
 * The run's current Review may be authorized: nothing was attempted yet, or every earlier request that did not land was made under an
 * EARLIER Review (the current one is the refresh that followed it). A Review under which a request was already declined or refused is not
 * authorized again as it is: the owner refreshes it first.
 */
export function uniswapReviewAuthorizable(record: Run | null | undefined): boolean {
  if (!record) return false;
  if (!record.attempts.length) return true;
  return uniswapRunResumable(record) && record.attempts.every(a => confirmedApproval(a) || supersededUnsent(a, record.review.commitment));
}
/** The run's attempts that still hold their step: a never-sent attempt of an earlier Review (superseded by a refresh) does not. */
export function currentUniswapAttempts<T extends Attempt>(record: { readonly attempts: readonly T[]; readonly review: { readonly commitment: string } }): T[] {
  return record.attempts.filter(a => !supersededUnsent(a, record.review.commitment));
}

/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a Uniswap position run (one wallet request per run) whose Review stopped standing before that request
 * (expired, the position or pool moved, fees moved) is refreshed in place exactly like a mint run (`requoted`): the server refused before any
 * nonce reservation or wallet request, so nothing was sent, and the refreshed Review waits for the owner's explicit authorization.
 */
export const UNISWAP_POSITION_REFRESH_IN_PLACE = /^(?:UNISWAP_(?:REVIEW_EXPIRED|POSITION_STATE_CHANGED_REVIEW_REQUIRED|STATE_CHANGED_REVIEW_REQUIRED|FEES_CHANGED_REVIEW_REQUIRED|GAS_CHANGED_REVIEW_REQUIRED|L1_FEES_CHANGED_REVIEW_REQUIRED)|STOCK_MULTIPLIER_CHANGED_REVIEW_REQUIRED)$/;
type PositionRun = { readonly format: 'flofi.uniswap-position-run.v1'; readonly verdict: string; readonly attempts: readonly Attempt[] };
/**
 * A position run may be refreshed in place only while nothing of it can have reached the network: every attempt was cancelled before any
 * broadcast (no hash). A confirmed, pending, unknown or reverted operation never gets a new Review on the same run (the server refuses it too).
 */
export function uniswapPositionRunResumable(record: PositionRun | null | undefined): boolean {
  if (!record || record.format !== 'flofi.uniswap-position-run.v1' || record.verdict !== 'PENDING' || record.attempts.length > ATTEMPT_ROOM) return false;
  return record.attempts.every(a => a.state === 'CANCELLED' && !a.transactionHash && !a.replacementHash);
}
/** The current Review of a position run may be authorized: no attempt yet, or only never-sent attempts of EARLIER Reviews (refreshed since). */
export function uniswapPositionReviewAuthorizable(record: (PositionRun & { readonly review: { readonly commitment: string } }) | null | undefined): boolean {
  if (!record || record.format !== 'flofi.uniswap-position-run.v1' || record.verdict !== 'PENDING') return false;
  return record.attempts.every(a => supersededUnsent(a, record.review.commitment));
}
