// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-FLIGHT-001: Node.js server start (see `instrumentation.ts`). */
import { recordFlightSimulation } from './flight/simulation-evidence';
import { observeSimulations } from './server/flow-runtime';

observeSimulations(recordFlightSimulation);
