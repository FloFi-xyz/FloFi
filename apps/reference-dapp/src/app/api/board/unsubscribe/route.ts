// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-FLIGHT-LAUNCH-001: Flight FloFi (/board) access and email, see src/flight/http.ts.
import { handleUnsubscribe } from '../../../../flight/http';

export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleUnsubscribe(request);
