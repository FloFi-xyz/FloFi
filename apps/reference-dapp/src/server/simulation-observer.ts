// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: the one observer of successful simulations (`simulate`, and `prepare`, the catalog swaps' quote and owner
 * preflight), called by `cloudFlow`: the Flight FloFi boarding-pass record, registered by `src/app/cloud-flow.ts`, the flow runtime as
 * the /app server actions import it. This module imports nothing, so the flow runtime never loads the campaign, its accounts or its
 * requests through it. The observer only reads; whatever it does (throw, reject, hang), the simulation's result is
 * returned unchanged, after at most SIMULATION_OBSERVER_MS. Kept on `globalThis` so every bundle of one server process sees the same
 * slot; only code running in that process can reach it.
 */
type Env = Readonly<Record<string, string | undefined>>;
export type SimulationCall = { readonly flow: string; readonly method: string; readonly args: readonly unknown[]; readonly value: unknown };
export type SimulationObserver = (call: SimulationCall, env: Env) => Promise<void>;
const SIMULATION_OBSERVER = Symbol.for('flofi.flow-runtime.simulation-observer');
export const SIMULATION_OBSERVER_MS = 2_000;
type ObserverSlot = { [SIMULATION_OBSERVER]?: SimulationObserver | null };

export function observeSimulations(observer: SimulationObserver | null): void { (globalThis as ObserverSlot)[SIMULATION_OBSERVER] = observer; }
export async function notifySimulation(call: SimulationCall, env: Env): Promise<void> {
  const observer = (globalThis as ObserverSlot)[SIMULATION_OBSERVER];
  if (!observer) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([observer(call, env), new Promise<void>(resolve => { timer = setTimeout(resolve, SIMULATION_OBSERVER_MS); })]);
  } catch { /* An observer never affects the simulation. */ } finally { clearTimeout(timer); }
}
