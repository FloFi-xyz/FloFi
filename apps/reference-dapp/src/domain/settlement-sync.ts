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
  /** Router records mark each side `safe` once its block is final; universal records mark the delivery `final`. */
  readonly source: object | null; readonly destination: object | null;
};
const flag = (side: object | null, name: 'safe' | 'final'): boolean => Boolean(side && (side as Record<string, unknown>)[name] === true);

/** Whether the run is settling: its durable record can still change without any owner action. */
export function settlementSyncDue(record: SettlementRecord | null | undefined): boolean {
  return Boolean(record && record.verdict === 'PENDING' && SETTLING_PHASES.includes(record.phase));
}

const LIFECYCLE = ['PREPARED', 'AUTHORIZED', 'SOURCE_SUBMITTED', 'SOURCE_CONFIRMED', 'IN_FLIGHT', 'DESTINATION_OBSERVED'];
/**
 * How far a record has settled: a terminal verdict, then its phase (any phase after the lifecycle — recovery, reconciliation required, reconciled,
 * refunded — ranks last), then the facts it holds (destination observed, each side final).
 */
function progress(record: SettlementRecord): readonly number[] {
  const phase = LIFECYCLE.indexOf(record.phase);
  return [record.verdict === 'PENDING' ? 0 : 1, phase < 0 ? LIFECYCLE.length : phase, record.destination ? 1 : 0,
    flag(record.source, 'safe') ? 1 : 0, flag(record.destination, 'safe') || flag(record.destination, 'final') ? 1 : 0];
}

/**
 * Whether `incoming` (a durable read that may have been answered late) may replace `shown`. Another run is never adopted here; the same run is
 * adopted unless it would move back — a terminal verdict back to PENDING, an observed destination or a final side back to unobserved — which only
 * a stale answer can do (the record is append-only and never regresses).
 */
export function adoptSettlementRead(shown: SettlementRecord | null | undefined, incoming: SettlementRecord): boolean {
  if (!shown || shown.id !== incoming.id) return false;
  const before = progress(shown), after = progress(incoming);
  if (shown.verdict !== 'PENDING') return false;
  return after.every((value, index) => value >= before[index]!);
}
