// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-EXECUTION-PERFORMANCE-001: `POST /api/flofi/journey` — a finished journey's content-free timing (see server/journey-telemetry.ts). */
import { createJourneyReceiver } from '../../../../server/journey-telemetry';

export const dynamic = 'force-dynamic';
const receive = createJourneyReceiver();
export async function POST(request: Request): Promise<Response> { return receive(request); }
