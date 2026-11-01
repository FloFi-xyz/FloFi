// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: how long the page keeps following a submitted transaction by itself, and how often it asks.
 *
 * Every observation is the run's existing read-only `observe` (chain reads and reconciliation of what was already submitted): it never
 * signs, submits, retries a submission or creates an attempt. The first 30 s ask every 2 s, as before, while a confirmation is most likely;
 * the page then keeps following for about four more minutes at 4 s and 10 s instead of stopping after 60 s and waiting for a click. The
 * durable worker keeps reconciling after that, and a page that comes back resumes from the durable record.
 */
export const OBSERVATION_DELAYS_MS: readonly number[] = Object.freeze([
  ...Array<number>(15).fill(2_000), ...Array<number>(15).fill(4_000), ...Array<number>(18).fill(10_000),
]);

export type ObservationOutcome<T> = { readonly value: T | null; readonly settled: boolean; readonly observations: number };

/**
 * Calls `observe` until `settled` holds, the schedule ends or `active()` turns false (unmounted, replaced run). A failed observation ends the
 * loop with its error, as the stores' loops always did; the person can check again. Returns the last value seen.
 */
export async function observeUntilSettled<T>(observe: () => Promise<T>, settled: (value: T) => boolean, options: {
  readonly delays?: readonly number[]; readonly sleep?: (ms: number) => Promise<void>; readonly active?: () => boolean } = {}): Promise<ObservationOutcome<T>> {
  const delays = options.delays ?? OBSERVATION_DELAYS_MS, active = options.active ?? (() => true);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let value: T | null = null, observations = 0;
  for (let i = 0; i <= delays.length; i++) {
    if (!active()) return { value, settled: false, observations };
    value = await observe(); observations++;
    if (settled(value)) return { value, settled: true, observations };
    if (i === delays.length) break;
    await sleep(delays[i]!);
  }
  return { value, settled: false, observations };
}
