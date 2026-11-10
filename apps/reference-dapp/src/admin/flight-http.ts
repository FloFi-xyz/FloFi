// SPDX-License-Identifier: AGPL-3.0-only
/** Flight Admin reads use the existing session boundary; PII reads/exports additionally require OPERATOR, same-origin POST and CSRF. */
import { authenticateAdmin, adminSessionToken } from './guard.ts';
import { adminMutation, adminRequest, json, readJsonObject, type AdminHttpOptions } from './http.ts';
import { createFlightAdminStore, flightAdminFilters, flightCsv } from './flight.ts';
import { flightCalendarFrom } from '../flight/campaign.ts';
import { emailLimitsFrom } from '../flight/email/outbox.ts';

function privateHeaders(response: Response): Response {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('x-robots-tag', 'noindex, nofollow');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('vary', 'Cookie');
  return response;
}
function store(host: Parameters<typeof createFlightAdminStore>[0], options: AdminHttpOptions) {
  const env = options.env ?? process.env, { calendar } = flightCalendarFrom(env);
  if (!calendar) throw new Error('ADMIN_FLIGHT_CALENDAR_UNAVAILABLE');
  return createFlightAdminStore(host, calendar, emailLimitsFrom(env));
}
/** GET /admin/api/flight: aggregates only. No recipient, token, code or account identity is included. */
export async function handleFlightSummary(request: Request, options: AdminHttpOptions = {}): Promise<Response> {
  if (request.method !== 'GET') return privateHeaders(json(405, { ok: false, code: 'METHOD_NOT_ALLOWED' }));
  const base = await adminRequest(request, options);
  if (base instanceof Response) return privateHeaders(base);
  const context = await authenticateAdmin({ key: base.key, store: base.store, token: adminSessionToken(request), domain: base.origin.domain, now: base.now });
  if (!context) return privateHeaders(json(401, { ok: false, code: 'ADMIN_SESSION_REQUIRED' }));
  try { return privateHeaders(json(200, { ok: true, summary: await store(base.host, options).summary(base.now.getTime()) })); }
  catch { return privateHeaders(json(503, { ok: false, code: 'ADMIN_FLIGHT_UNAVAILABLE' })); }
}

/** Body filters keep email searches out of request URLs, audit detail and application logs. Success auditing fails closed. */
export async function handleFlightEntries(request: Request, options: AdminHttpOptions = {}, csv = false): Promise<Response> {
  const allowed = await adminMutation(request, options, 'write');
  if (allowed instanceof Response) return privateHeaders(allowed);
  const { context, request: base } = allowed;
  const kind = csv ? 'ADMIN_FLIGHT_EXPORTED' : 'ADMIN_FLIGHT_VIEWED';
  let filters;
  try { filters = flightAdminFilters(await readJsonObject(request)); }
  catch { return privateHeaders(json(400, { ok: false, code: 'ADMIN_FLIGHT_FILTER_INVALID' })); }
  try {
    const projection = store(base.host, options);
    const data = csv ? await projection.exportEntries(filters, base.now.getTime()) : await projection.entries(filters, base.now.getTime());
    // Never record search strings, addresses, individual record ids or access material in the audit trail.
    await base.store.audit({ actor: context.principal.principalId, kind, outcome: 'OK', target: 'flight:entries', detail: {
      rows: Array.isArray(data) ? data.length : (data as Awaited<ReturnType<typeof projection.entries>>).rows.length,
      searched: filters.search.length > 0, flight: filters.flight, language: filters.language, group: filters.group,
      from: filters.from, to: filters.to, status: filters.status, page: csv ? null : filters.page, pageSize: csv ? null : filters.pageSize } });
    if (csv) return privateHeaders(new Response(flightCsv(data as Awaited<ReturnType<typeof projection.exportEntries>>), { status: 200, headers: {
      'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="flofi-flight.csv"' } }));
    return privateHeaders(json(200, { ok: true, entries: data }));
  } catch (error) {
    const code = error instanceof Error && error.message === 'ADMIN_FLIGHT_EXPORT_TOO_LARGE' ? 'ADMIN_FLIGHT_EXPORT_TOO_LARGE' : 'ADMIN_FLIGHT_UNAVAILABLE';
    await base.store.audit({ actor: context.principal.principalId, kind, outcome: 'FAILED', code, target: 'flight:entries' }).catch(() => undefined);
    return privateHeaders(json(code === 'ADMIN_FLIGHT_EXPORT_TOO_LARGE' ? 413 : 503, { ok: false, code }));
  }
}
