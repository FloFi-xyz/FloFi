// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-FLIGHT-001: Flight FloFi (/board), see src/flight/http.ts.
import { handleEvent } from '../../../../flight/http';

export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleEvent(request);
