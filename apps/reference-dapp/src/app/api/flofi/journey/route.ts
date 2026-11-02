// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: `POST /api/flofi/journey` — a finished journey's content-free timing (see server/journey-telemetry.ts).
 *
 * Issue #149: OFF unless the deployment owner opts in with `FLOFI_JOURNEY_TELEMETRY=on` (journeyTelemetryEnabled: unset, `off`, a typo or
 * any other value is off). While off no receiver exists: the route answers 204 at once and reads no cookie, header or body, keeps no
 * counter and logs nothing. Policy, legal basis and retention: docs/privacy/JOURNEY-TELEMETRY.md.
 */
import { journeyTelemetryEnabled } from '../../../../domain/journey-metrics';
import { createJourneyReceiver } from '../../../../server/journey-telemetry';

export const dynamic = 'force-dynamic';
const receive = journeyTelemetryEnabled(process.env.FLOFI_JOURNEY_TELEMETRY) ? createJourneyReceiver() : null;
export async function POST(request: Request): Promise<Response> {
  return receive ? receive(request) : new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
