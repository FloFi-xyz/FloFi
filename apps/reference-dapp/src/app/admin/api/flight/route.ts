// SPDX-License-Identifier: AGPL-3.0-only
import { handleFlightSummary } from '../../../../admin/flight-http';
export const dynamic = 'force-dynamic';
export const GET = (request: Request): Promise<Response> => handleFlightSummary(request);
export const POST = (request: Request): Promise<Response> => handleFlightSummary(request);
