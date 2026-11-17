// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (EXEC-02): after a bridge deposit confirmed at the source, the run settles server-side — the backend
 * worker observes the fill and both chains' safe heads and reconciles the durable record. The browser stopped reading that record once the source
 * attempt confirmed, so the Canvas, Execute, the Assistant and the Dashboard kept showing the state from the moment of the deposit until the owner
 * pressed "Check status".
 *
 * These helpers decide when the browser re-reads the DURABLE record (the `status` read: a database read, no chain RPC, never an observation) and
 * whether a read answer may replace the record already shown. Presentation only: nothing here observes, reconciles, signs or submits.
 */

/** The run phases in which a bridge settles on its own (the deposit confirmed; only the worker's observation moves it). */
export const SETTLING_PHASES: readonly string[] = ['SOURCE_CONFIRMED', 'IN_FLIGHT', 'DESTINATION_OBSERVED', 'RECOVERY_REQUIRED'];
/** Cadence of the durable re-read while a run settles and the page is visible (the worker's own first retries are 15 s apart). */
export const SETTLEMENT_SYNC_MS = 15_000;

/** The fields every bridge record (cross-chain router, universal router) shares that order its settlement. */
export type SettlementRecord = {
  readonly id: string; readonly verdict: string; readonly phase: string;
  /** The run's owner wallet, where the record carries it: a read for another owner is never adopted (defence in depth; reads are owner-scoped). */
  readonly owner?: string;
  /** Router records mark each side `safe` once its block is final; universal records mark each side `final`. */
  readonly source: object | null; readonly destination: object | null;
};
const flag = (side: object | null, name: 'safe' | 'final'): boolean => Boolean(side && (side as Record<string, unknown>)[name] === true);

/** Whether the run is settling: its durable record can still change without any owner action. */
export function settlementSyncDue(record: SettlementRecord | null | undefined): boolean {
  return Boolean(record && record.verdict === 'PENDING' && SETTLING_PHASES.includes(record.phase));
}

/**
 * The PENDING phases in the order a run can move through them. RECOVERY_REQUIRED (fill deadline passed, refund expected) ranks before
 * DESTINATION_OBSERVED: a fill verified after the deadline legally moves the run on to DESTINATION_OBSERVED (router-service `observeSettlement`).
 * Any other phase ranks last.
 */
const LIFECYCLE = ['PREPARED', 'AUTHORIZED', 'SOURCE_SUBMITTED', 'SOURCE_CONFIRMED', 'IN_FLIGHT', 'RECOVERY_REQUIRED', 'DESTINATION_OBSERVED'];
/** How far a PENDING record has settled: its phase, then the facts it holds (destination observed, each side final). */
function progress(record: SettlementRecord): readonly number[] {
  const phase = LIFECYCLE.indexOf(record.phase);
  return [phase < 0 ? LIFECYCLE.length : phase, record.destination ? 1 : 0, flag(record.source, 'safe') || flag(record.source, 'final') ? 1 : 0,
    flag(record.destination, 'safe') || flag(record.destination, 'final') ? 1 : 0];
}

/**
 * Whether `incoming` (a durable read that may have been answered late) may replace `shown`. Another run is never adopted here. For the same run:
 * a terminal record (reconciled, refunded, divergent, failed) is always adopted — whatever facts it holds, it is the newer truth; a PENDING record
 * is adopted unless it would move the run back (an earlier phase, an observed destination or a final side no longer there), which only a stale
 * answer can do (the record is append-only and never regresses). Nothing replaces a terminal record shown.
 */
export function adoptSettlementRead(shown: SettlementRecord | null | undefined, incoming: SettlementRecord): boolean {
  if (!shown || shown.id !== incoming.id || shown.verdict !== 'PENDING') return false;
  if (shown.owner !== undefined && incoming.owner !== undefined && shown.owner.toLowerCase() !== incoming.owner.toLowerCase()) return false;
  if (incoming.verdict !== 'PENDING') return true;
  const before = progress(shown), after = progress(incoming);
  return after.every((value, index) => value >= before[index]!);
}
