// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: records that a signed-in account eligible to board completed a server-side simulation, so its boarding pass
 * is issued from something the browser cannot forge: the run, and the route projected (`flightRoute`: networks and step labels, never
 * an amount) from the workflow the server itself simulated. The flow runtime calls it after a successful simulation, on the embedded
 * and the remote runtime, as its simulation observer, registered by the /app server actions' `app/cloud-flow.ts`: `simulate` for every
 * flow, and `prepare` for the catalog swaps (Ethereum, Base, Arbitrum, Robinhood Chain) once the owner's preflight is in it.
 * It never changes or fails a simulation: any problem (no request, no account, no database, not boarding) is a no-op.
 */
import { createLogger } from '@defi-workflow-engine/cloud-runtime';
import { flightPhase } from './campaign';
import { flightCalendar, flightNow, flightPerson, flightStore } from './host';
import { simulationRecord, type SimulationCall } from './simulation-record';

type Env = Readonly<Record<string, string | undefined>>;
/** What happened to a boarding-phase simulation, as a fixed code (no identity, address, amount or route). */
export type EvidenceOutcome = 'recorded' | 'no_session' | 'not_eligible' | 'unavailable' | 'failed';
const report = (outcome: EvidenceOutcome, flow: string) => createLogger({ service: 'flofi-web' }).info('flight.evidence', { outcome, flow });

export async function recordFlightSimulation(call: SimulationCall, env: Env = process.env): Promise<void> {
  const record = simulationRecord(call);
  if (!record) return;
  try {
    const now = await flightNow(env);
    // A refused calendar (null) means the campaign is unavailable: nothing is recorded.
    const calendar = flightCalendar(env);
    // Before boarding only an invited creator's test flight records anything (its TEST card); afterwards, every eligible boarder.
    if (!calendar || (flightPhase(now, calendar) !== 'BOARDING' && now < calendar.creatorsOpenAt)) return;
    const person = await flightPerson(env);
    if (!person) return report('no_session', record.flow);
    const store = await flightStore(env);
    if (!store) return report('unavailable', record.flow);
    const state = await store.account({ ...person, now });
    if (state.access.kind !== 'eligible' && state.access.kind !== 'test_flight') return report('not_eligible', record.flow);
    await store.recordSimulation({ accountId: person.accountId, ...record, now });
    report('recorded', record.flow);
  } catch { report('failed', record.flow); /* A campaign record never affects the person's simulation. */ }
}
