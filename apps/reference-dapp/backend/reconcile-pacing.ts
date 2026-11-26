// SPDX-License-Identifier: AGPL-3.0-only
/**
 * When the reconcile worker observes a pending run again.
 *
 * The generic worker backoff doubles from 15 s to a 10-minute cap with every delivery (`backoffMs`). That suits a run that waits for something
 * nobody can predict (an RPC outage, an unknown submission). It does not suit a bridge whose deposit is already confirmed: after a few minutes in
 * flight the next look was up to ten minutes away, so a run whose delivery and finality were already on chain stayed "awaiting finality" in
 * FloFi (and on every surface that reads its durable record) until the worker came back or the owner pressed "Check status".
 *
 * A run whose observation says only the chains move it on (a transaction found and confirming, a confirmed deposit in flight, a delivery
 * awaiting finality) is observed at the settlement cadence instead, for a bounded window. Finality itself is unchanged: the flow still waits
 * for each side's safe block before it reconciles. Nothing here observes, signs or submits.
 */
import { backoffMs } from '@defi-workflow-engine/cloud-runtime';

/**
 * Observation outcomes (`domain/financial-observation.ts`) after which only chain progress changes the run: the transaction was found and is
 * confirming (`PENDING`), the source is confirmed and the bridge fills (`CONFIRMED`), the delivery was verified and finality is pending
 * (`DESTINATION_OBSERVED`). An outage (`TEMPORARY_FAILURE`), an unknown submission (`UNDETERMINED`) or anything else keeps the backoff.
 */
export const SETTLING_OUTCOMES: readonly string[] = ['PENDING', 'CONFIRMED', 'DESTINATION_OBSERVED'];
/** The settlement cadence: the same 15 s at which an open page re-reads the durable record (`domain/settlement-sync.ts`). */
export const SETTLEMENT_CADENCE_MS = 15_000;
/** Inside the window, a network read that failed for a moment (`TEMPORARY_FAILURE`) is tried again within a minute, never the long backoff. */
export const TRANSIENT_RETRY_MS = 60_000;
/**
 * How long a settling run keeps the settlement cadence, from the later of the work item's creation and the source confirmation: covers the fill
 * and both chains' safe heads (an L2 safe head follows its batch posting and the parent chain's own safe head). Past it the backoff resumes.
 * Budget: at most 300 deliveries (60 min at the shortest jittered 12 s) of the 500 (`MAX_DELIVERIES`). A refund wait (`RECOVERY_REQUIRED`) is
 * not settling here: it keeps the backoff, so its observation budget lasts.
 */
export const SETTLEMENT_WINDOW_MS = 60 * 60_000;

export function reconcileDelayMs(input: { readonly outcome: string | null | undefined; readonly phase?: string | null | undefined; readonly deliveries: number;
  readonly createdAt: Date; readonly settlingSince?: string | null | undefined; readonly now: number; readonly random?: () => number }): number {
  const random = input.random ?? Math.random, backoff = backoffMs(input.deliveries, random);
  const confirmed = typeof input.settlingSince === 'string' ? Date.parse(input.settlingSince) : Number.NaN;
  const since = Math.max(input.createdAt.getTime(), Number.isFinite(confirmed) ? confirmed : Number.NEGATIVE_INFINITY);
  const inWindow = input.now - since < SETTLEMENT_WINDOW_MS;
  const jitter = (ms: number) => Math.round(ms * (0.8 + 0.4 * random()));
  if (inWindow && typeof input.outcome === 'string' && SETTLING_OUTCOMES.includes(input.outcome) && input.phase !== 'RECOVERY_REQUIRED')
    return Math.min(backoff, jitter(SETTLEMENT_CADENCE_MS));
  if (inWindow && input.outcome === 'TEMPORARY_FAILURE') return Math.min(backoff, jitter(TRANSIENT_RETRY_MS));
  return backoff;
}
