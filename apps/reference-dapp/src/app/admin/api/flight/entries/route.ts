// SPDX-License-Identifier: AGPL-3.0-only
import { handleFlightEntries } from '../../../../../admin/flight-http';
export const dynamic = 'force-dynamic';
export const POST = (request: Request): Promise<Response> => handleFlightEntries(request);
// Explicitly refuse navigations with the same private response headers as POST.
export const GET = (request: Request): Promise<Response> => handleFlightEntries(request);
