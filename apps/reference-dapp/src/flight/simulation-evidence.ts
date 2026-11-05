// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: records that a signed-in account eligible to board completed a server-side simulation, so its boarding pass
 * is issued from something the browser cannot forge: the run, and the route projected (`flightRoute`: networks and step labels, never
 * an amount) from the workflow the server itself simulated. The flow runtime calls it after a successful simulation, on the embedded
 * and the remote runtime, as its simulation observer registered at server start (`instrumentation-node.ts`): `simulate` for every
 * flow, and `prepare` for the catalog swaps (Ethereum, Base, Arbitrum, Robinhood Chain), whose prepare is their quote and simulation.
 * It never changes or fails a simulation: any problem (no request, no account, no database, not boarding) is a no-op.
 */
import { flightPhase } from './campaign';
import { flightNow, flightPerson, flightStore } from './host';
import { simulationRecord, type SimulationCall } from './simulation-record';

type Env = Readonly<Record<string, string | undefined>>;

export async function recordFlightSimulation(call: SimulationCall, env: Env = process.env): Promise<void> {
  try {
    const record = simulationRecord(call);
    if (!record) return;
    const now = await flightNow(env);
    if (flightPhase(now) !== 'BOARDING') return;
    const person = await flightPerson(env);
    if (!person) return;
    const store = await flightStore(env);
    if (!store) return;
    const state = await store.account({ ...person, now });
    if (state.access.kind !== 'eligible') return;
    await store.recordSimulation({ accountId: person.accountId, ...record, now });
  } catch { /* A campaign record never affects the person's simulation. */ }
}
