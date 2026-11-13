// SPDX-License-Identifier: AGPL-3.0-only
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import type { RouterRecord } from '../server/router-service';
import type { UniversalRecord } from '../server/universal-router/service';
import type { EditorState } from './editor';
import { shortDecimal } from './review-block';

/**
 * Refresh only an unsubmitted suffix of this exact run. Approval is evidence, never bridge completion or renewed authority.
 * BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a run whose quote changed at the execution boundary (`requote`, nothing ever attempted) is re-quoted in place,
 * so its route changes stay on the same record (and the Dashboard does not gain an empty run); the new quote still needs its own Review.
 */
export function refreshBridgeAfterApproval(record: RouterRecord | UniversalRecord | null, workflow: EditorState['workflow'], retired: boolean): boolean {
  if (!record || retired || record.verdict !== 'PENDING' || !['PREPARED', 'AUTHORIZED'].includes(record.phase)) return false;
  if (hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(record.workflow))) !==
    hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow)))) return false;
  if (record.requote && record.attempts.length === 0) return true;
  return record.attempts.some(a => a.step === 'APPROVAL' && a.state === 'CONFIRMED' && a.reconciled) &&
    record.attempts.every(a => a.step === 'APPROVAL' && ['CONFIRMED','CANCELLED','NOT_FOUND'].includes(a.state));
}

/**
 * BUILD-FLOFI-MAINNET-EXEC-002: what an automatic in-place re-quote changed, material values only (the guaranteed minimum, the expected
 * output, the provider fee, the network-fee maximum, the recipient, the provider), as the owner sees them. Minimums and receipts round down,
 * fees round up (`shortDecimal`): the shown value never overstates what is received nor understates what is paid. Empty: nothing material moved.
 */
export type BridgeReviewChange = { readonly label: string; readonly before: string; readonly after: string };
type RouterReviewShape = RouterRecord['review'];
type UniversalReviewShape = UniversalRecord['review'];
const isRouterReview = (review: RouterReviewShape | UniversalReviewShape): review is RouterReviewShape => review.format === 'flofi.router-review.v1';
export function bridgeReviewChanges(previous: RouterReviewShape | UniversalReviewShape, next: RouterReviewShape | UniversalReviewShape): readonly BridgeReviewChange[] {
  if (isRouterReview(previous) !== isRouterReview(next)) return [];
  const changes: BridgeReviewChange[] = [];
  const compare = (label: string, before: string, after: string) => { if (before !== after) changes.push({ label, before, after }); };
  const token = (units: string, decimals: number, symbol: string, mode: 'down' | 'up') => `${shortDecimal(units, decimals, mode)} ${symbol}`;
  if (isRouterReview(previous) && isRouterReview(next)) {
    const a = previous.route, b = next.route;
    compare('Minimum', token(a.minimumOutput, a.outputToken.decimals, a.outputToken.symbol, 'down'), token(b.minimumOutput, b.outputToken.decimals, b.outputToken.symbol, 'down'));
    compare('Receives ≈', token(a.expectedOutput, a.outputToken.decimals, a.outputToken.symbol, 'down'), token(b.expectedOutput, b.outputToken.decimals, b.outputToken.symbol, 'down'));
    compare('Provider fee', token(a.feeTotal, a.inputToken.decimals, a.inputToken.symbol, 'up'), token(b.feeTotal, b.inputToken.decimals, b.inputToken.symbol, 'up'));
    const fee = (r: RouterReviewShape) => r.fees.totalUpperBoundWei ?? r.fees.executionFeeUpperBoundWei;
    compare('Network fee, at most', token(fee(previous), 18, 'ETH', 'up'), token(fee(next), 18, 'ETH', 'up'));
    compare('Destination', previous.recipient, next.recipient);
    compare('Provider', a.routingProvider, b.routingProvider);
    return changes;
  }
  const a = (previous as UniversalReviewShape), b = (next as UniversalReviewShape);
  compare('Minimum', token(a.route.minimumOutput, a.route.outputToken.decimals, a.route.outputToken.symbol, 'down'),
    token(b.route.minimumOutput, b.route.outputToken.decimals, b.route.outputToken.symbol, 'down'));
  compare('Receives ≈', token(a.route.expectedOutput, a.route.outputToken.decimals, a.route.outputToken.symbol, 'down'),
    token(b.route.expectedOutput, b.route.outputToken.decimals, b.route.outputToken.symbol, 'down'));
  compare('Network fee, at most', token(a.feePolicy.networkFeeUpperBound, a.feePolicy.networkFeeDecimals, a.feePolicy.networkFeeSymbol, 'up'),
    token(b.feePolicy.networkFeeUpperBound, b.feePolicy.networkFeeDecimals, b.feePolicy.networkFeeSymbol, 'up'));
  compare('Destination', a.recipient, b.recipient);
  compare('Provider', a.route.provider, b.route.provider);
  return changes;
}
/** A refusal at the execution boundary after which the run can be re-quoted in place (nothing was sent; the Review no longer stands). */
export const REQUOTE_IN_PLACE = /ROUTE_CHANGED|STATE_CHANGED|GAS_CHANGED|FEES_CHANGED|REVIEW_EXPIRED/;
/** The run may be re-quoted in place: still pending, back at PREPARED with `requote`, and no deposit was ever attempted. */
export function requotableInPlace(record: RouterRecord | UniversalRecord | null): boolean {
  return Boolean(record && record.verdict === 'PENDING' && record.phase === 'PREPARED' && record.requote &&
    !record.attempts.some(a => a.step === 'DEPOSIT' && !['CANCELLED', 'NOT_FOUND'].includes(a.state)));
}
