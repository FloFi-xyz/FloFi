// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The flow runtime as FloFi's /app server actions use it. BUILD-FLOFI-FLIGHT-001: loading this module registers the Flight FloFi
 * simulation record as the flow runtime's simulation observer (`server/simulation-observer.ts`), in the very function that runs the
 * action, so a successful /app simulation can earn a boarding pass. The flow runtime never imports the campaign, its accounts or its
 * requests; MCP, channels and the Developer API call the runtime directly and record nothing.
 */
import { observeSimulations } from '../server/simulation-observer';

const REGISTERED = Symbol.for('flofi.flight.observer.registered');
// The record (with the account and request code it needs) loads on the first successful hosted simulation, never when an action module
// is merely imported (tests and tools import these modules outside a Next.js request).
observeSimulations(async (call, env) => (await import('../flight/simulation-evidence')).recordFlightSimulation(call, env));
if (!(globalThis as Record<symbol, unknown>)[REGISTERED]) {
  (globalThis as Record<symbol, unknown>)[REGISTERED] = true;
  // A fixed, content-free line, so a deployment's runtime logs show the observer is in place.
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), severity: 'INFO', event: 'flight.observer.registered', service: 'flofi-web' }) + '\n');
}

export { cloudFlow, cloudFlowMode, cloudRuns } from '../server/flow-runtime';
