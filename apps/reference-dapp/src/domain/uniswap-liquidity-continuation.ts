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

/** A confirmed, reconciled approval: evidence that stays, never authority for what follows. */
export const confirmedApproval = (a: Attempt) => a.step !== 'MINT' && a.state === 'CONFIRMED' && a.reconciled;
/**
 * Every attempt of the run is either a confirmed, reconciled approval or was cancelled before any broadcast (no hash): nothing of it is
 * pending, unknown, reverted or minted, so a refreshed Review of the same run can never repeat or race a request. Anything else keeps the
 * existing paths (observation, or a separate new simulation).
 */
export function uniswapRunResumable(record: Run | null | undefined): boolean {
  if (!record || record.verdict !== 'PENDING' || record.attempts.length > ATTEMPT_ROOM) return false;
  return record.attempts.every(a => confirmedApproval(a) || a.state === 'CANCELLED' && !a.transactionHash && !a.replacementHash);
}
/** "Simulate again" of a started run (an approval already landed) refreshes that run in place instead of starting a separate one. */
export function uniswapRefreshInPlace(record: Run | null | undefined, retired: boolean): boolean {
  return Boolean(record && !retired && uniswapRunResumable(record) && record.attempts.some(confirmedApproval));
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
