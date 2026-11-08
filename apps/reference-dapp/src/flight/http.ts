// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: the public /api/board routes. Every write is same-origin, JSON, size-bounded and closed-schema; anything that
 * concerns a person needs their signed-in FloFi account; answers are fixed codes. The list form answers a new and a repeated address
 * the same way. No route can sign, simulate, move funds or grant product access: they read and write the campaign only.
 */
import { accessResultDetail, flightPhase, listFor, normalizeEmail, normalizeHandle,
  normalizeInviteCode, parseClientEvent, type FlightOrigin } from './campaign';
import { clientDigest, flightNow, flightPerson, flightStore } from './host';
import type { AccountFlight, FlightStore } from './store';

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-type': 'application/json; charset=utf-8' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const refuse = (status: number, code: string) => json(status, { ok: false, code });

/** Same-origin JSON POST with a bounded body; the parsed object or a refusal. */
async function readRequest(request: Request, limit: number): Promise<Record<string, unknown> | Response> {
  if (request.method !== 'POST') return refuse(405, 'FLIGHT_METHOD');
  // As the journey receiver (server/journey-telemetry.ts): the browser's own Sec-Fetch-Site when it sends one, else the Origin.
  const site = request.headers.get('sec-fetch-site'), origin = request.headers.get('origin');
  const sameOrigin = site ? site === 'same-origin' : origin !== null && origin === new URL(request.url).origin;
  if (!sameOrigin) return refuse(403, 'FLIGHT_CROSS_ORIGIN');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return refuse(415, 'FLIGHT_JSON_REQUIRED');
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > limit) return refuse(413, 'FLIGHT_BODY_TOO_LARGE');
  const text = await request.text().catch(() => null);
  if (text === null || text.length > limit) return refuse(413, 'FLIGHT_BODY_TOO_LARGE');
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : refuse(400, 'FLIGHT_BODY_INVALID');
  } catch { return refuse(400, 'FLIGHT_BODY_INVALID'); }
}
async function storeOr503(): Promise<FlightStore | Response> {
  try { return await flightStore() ?? refuse(503, 'FLIGHT_UNAVAILABLE'); } catch { return refuse(503, 'FLIGHT_UNAVAILABLE'); }
}
const language = (value: unknown): 'EN' | 'PT' => value === 'PT' ? 'PT' : 'EN';

/** What the page needs: the phase, the real counters, the public departures and, when signed in, the person's own place. */
export type FlightState = {
  readonly ok: true; readonly now: number; readonly phase: ReturnType<typeof flightPhase>; readonly closesAt: number; readonly boardingOpensAt: number;
  readonly counters: Awaited<ReturnType<FlightStore['counters']>>; readonly departures: Awaited<ReturnType<FlightStore['departures']>>;
  readonly me: { readonly signedIn: boolean; readonly hasEmail: boolean; readonly flight: AccountFlight | null };
};
// The retention periods hold without traffic: the page prunes expired campaign records at most every five minutes per instance.
const PRUNE_EVERY_MS = 5 * 60_000;
let prunedAt = 0;
export async function flightState(): Promise<FlightState | null> {
  try {
    const store = await flightStore();
    if (!store) return null;
    const now = await flightNow(), person = await flightPerson();
    if (Date.now() - prunedAt > PRUNE_EVERY_MS) { prunedAt = Date.now(); await store.prune(now).catch(() => { prunedAt = 0; }); }
    const [counters, departures, flight] = await Promise.all([store.counters(), store.departures(), person ? store.account({ ...person, now }) : Promise.resolve(null)]);
    const calendar = store.calendar;
    return { ok: true, now, phase: flightPhase(now, calendar), closesAt: calendar.listClosesAt, boardingOpensAt: calendar.boardingOpensAt, counters, departures,
      me: { signedIn: person !== null, hasEmail: (person?.emails.length ?? 0) > 0, flight } };
  } catch { return null; }
}
export async function handleState(): Promise<Response> {
  const state = await flightState();
  return state ? json(200, state) : refuse(503, 'FLIGHT_UNAVAILABLE');
}

/** Join the beta list (until it closes) or the next flight's list (afterwards). A filled honeypot is accepted and discarded. */
export async function handleJoin(request: Request): Promise<Response> {
  const body = await readRequest(request, 2048);
  if (body instanceof Response) return body;
  const store = await storeOr503();
  if (store instanceof Response) return store;
  try {
    const now = await flightNow(), flight = listFor(flightPhase(now, store.calendar));
    // A filled honeypot gets the same answer as a person and is discarded.
    if (typeof body.company === 'string' && body.company.trim()) return json(200, { ok: true, flight });
    // A signed-in person may join with the address their account verified ("Join the next flight" on the Not-on-the-list state).
    const person = body.email === undefined ? await flightPerson() : null;
    const email = normalizeEmail(person ? person.emails[0] : body.email);
    if (!email) return refuse(400, 'FLIGHT_EMAIL_INVALID');
    if (body.consent !== true) return refuse(400, 'FLIGHT_NOTICE_REQUIRED');
    const joined = await store.joinList({ email, language: language(body.language), flight, client: await clientDigest(), now });
    if (joined.status === 'RATE_LIMITED') return refuse(429, 'FLIGHT_RATE_LIMITED');
    if (joined.status === 'BUSY') return refuse(503, 'FLIGHT_BUSY');
    return json(200, { ok: true, flight });
  } catch { return refuse(503, 'FLIGHT_UNAVAILABLE'); }
}

/** "Board now": the signed-in person's access (list · invite · batch_closed · not_listed), recorded as the funnel's access_result. */
export async function handleBoard(request: Request): Promise<Response> {
  const body = await readRequest(request, 256);
  if (body instanceof Response) return body;
  const store = await storeOr503();
  if (store instanceof Response) return store;
  try {
    const person = await flightPerson();
    if (!person) return refuse(401, 'FLIGHT_SIGN_IN_REQUIRED');
    const now = await flightNow(), state = await store.account({ ...person, now }), detail = accessResultDetail(state.access);
    const origin: FlightOrigin | null = state.access.kind === 'eligible' ? state.access.origin : null;
    if (detail) await store.recordEvent('access_result', detail, origin, now);
    return json(200, { ok: true, flight: state });
  } catch { return refuse(503, 'FLIGHT_UNAVAILABLE'); }
}

export async function handleInvite(request: Request): Promise<Response> {
  const body = await readRequest(request, 256);
  if (body instanceof Response) return body;
  const code = normalizeInviteCode(body.code);
  if (!code) return refuse(400, 'INVITE_INVALID');
  const store = await storeOr503();
  if (store instanceof Response) return store;
  try {
    const person = await flightPerson();
    if (!person) return refuse(401, 'FLIGHT_SIGN_IN_REQUIRED');
    const now = await flightNow(), result = await store.redeemInvite({ accountId: person.accountId, code, now });
    if (result !== 'REDEEMED') return refuse(409, result);
    return json(200, { ok: true, flight: await store.account({ ...person, now }) });
  } catch { return refuse(503, 'FLIGHT_UNAVAILABLE'); }
}

/**
 * Issue the pass for the simulation the person just ran in /app: the server's own record of it (route included). The browser only
 * names the workflow in Review (`workflowId`, optional); it cannot supply or change the route.
 */
export async function handlePass(request: Request): Promise<Response> {
  const body = await readRequest(request, 512);
  if (body instanceof Response) return body;
  const workflowId = body.workflowId === undefined ? null : typeof body.workflowId === 'string' && body.workflowId.length >= 1 && body.workflowId.length <= 200
    ? body.workflowId : undefined;
  if (workflowId === undefined) return refuse(400, 'FLIGHT_WORKFLOW_INVALID');
  const store = await storeOr503();
  if (store instanceof Response) return store;
  try {
    const person = await flightPerson();
    if (!person) return refuse(401, 'FLIGHT_SIGN_IN_REQUIRED');
    const now = await flightNow();
    const result = await store.issuePass({ ...person, workflowId, handle: null, public: false, now });
    return result.ok ? json(200, { ok: true, issued: result.issued, pass: result.pass }) : refuse(409, result.code);
  } catch { return refuse(503, 'FLIGHT_UNAVAILABLE'); }
}

/** The pass holder's X handle and whether the public departures board shows it (their choice; empty handle removes it). */
export async function handleHandle(request: Request): Promise<Response> {
  const body = await readRequest(request, 256);
  if (body instanceof Response) return body;
  const empty = typeof body.handle === 'string' && body.handle.trim() === '';
  const handle = empty ? null : normalizeHandle(body.handle);
  if (!empty && !handle) return refuse(400, 'FLIGHT_HANDLE_INVALID');
  const store = await storeOr503();
  if (store instanceof Response) return store;
  try {
    const person = await flightPerson();
    if (!person) return refuse(401, 'FLIGHT_SIGN_IN_REQUIRED');
    const pass = await store.setHandle({ accountId: person.accountId, handle, public: body.public === true });
    return pass ? json(200, { ok: true, pass }) : refuse(409, 'FLIGHT_NO_PASS');
  } catch { return refuse(503, 'FLIGHT_UNAVAILABLE'); }
}

// Browser-reported funnel events: closed codes only, limited per instance (they are counters, not evidence).
const EVENT_WINDOW_MS = 60_000, EVENT_LIMIT = 600;
let windowStart = 0, windowCount = 0;
export async function handleEvent(request: Request): Promise<Response> {
  const body = await readRequest(request, 256);
  if (body instanceof Response) return body;
  const event = parseClientEvent(body);
  if (!event) return refuse(400, 'FLIGHT_EVENT_INVALID');
  const clock = Date.now();
  if (clock - windowStart > EVENT_WINDOW_MS) { windowStart = clock; windowCount = 0; }
  if (++windowCount > EVENT_LIMIT) return json(202, { ok: true });
  const store = await storeOr503();
  if (store instanceof Response) return json(202, { ok: true });
  try { await store.recordEvent(event.event, event.detail, null, await flightNow()); } catch { /* Counters are best effort. */ }
  return json(202, { ok: true });
}
