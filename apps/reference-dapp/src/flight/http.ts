// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: the public /api/board routes. Every write is same-origin, JSON, size-bounded and closed-schema; anything that
 * concerns a person needs their signed-in FloFi account; answers are fixed codes. The list form answers a new and a repeated address
 * the same way. No route can sign, simulate, move funds or grant product access: they read and write the campaign only.
 *
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: no public answer carries an aggregate count of people (only `foundingOpen`, a yes/no); the access routes
 * (request a link, use a link, use a code) prove a beta-list address and bind it to the signed-in account, or to an HttpOnly browser session
 * until sign-in; unsubscribe is one click. None of them signs anyone in, creates an account or touches a wallet.
 */
import { accessResultDetail, flightPhase, listFor, normalizeEmail, normalizeHandle,
  normalizeInviteCode, parseClientEvent, type FlightOrigin } from './campaign';
import { cookies } from 'next/headers';
import { ACCESS_SESSION_COOKIE, ACCESS_SESSION_MS, normalizeCode, readUnsubscribeToken, accessSecret } from './access';
import { isHostedDeployment } from '../server/deployment';
import type { ConsumeResult } from './access-store';
import { clientDigest, flightAccessStore, flightNow, flightOutbox, flightPerson, flightStore, requestClient, type FlightPerson } from './host';
import { sessionCookieName } from '../server/session-cookie';
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

/**
 * What the page needs: the phase, whether Founding seats are still open (never a count), the public departures and, when signed in, the
 * person's own place. No aggregate count of people is ever part of it (team decision, 9 Nov 2026).
 */
export type FlightState = {
  readonly ok: true; readonly now: number; readonly phase: ReturnType<typeof flightPhase>; readonly closesAt: number; readonly boardingOpensAt: number;
  readonly creatorsOpenAt: number; readonly foundingOpen: boolean; readonly departures: Awaited<ReturnType<FlightStore['departures']>>;
  readonly me: { readonly signedIn: boolean; readonly hasEmail: boolean; readonly flight: AccountFlight | null; readonly accessPending: boolean };
};
// The retention periods hold without traffic: the page prunes expired campaign records at most every five minutes per instance.
const PRUNE_EVERY_MS = 5 * 60_000;
let prunedAt = 0;
export async function flightState(): Promise<FlightState | null> {
  try {
    const store = await flightStore();
    if (!store) return null;
    const now = await flightNow(), person = await flightPerson();
    if (Date.now() - prunedAt > PRUNE_EVERY_MS) {
      prunedAt = Date.now();
      await Promise.all([store.prune(now), flightAccessStore().then(access => access?.prune(now)), flightOutbox().then(outbox => outbox?.prune(now))])
        .catch(() => { prunedAt = 0; });
    }
    // A pending access session binds only on the person's own "Board now" (handleBoard), never on a page view.
    const pending = await pendingSession();
    if (person) await store.ensurePublicId(person.accountId).catch(() => null);
    const [foundingOpen, departures, flight] = await Promise.all([store.foundingOpen(), store.departures(), person ? store.account({ ...person, now }) : Promise.resolve(null)]);
    const calendar = store.calendar;
    return { ok: true, now, phase: flightPhase(now, calendar), closesAt: calendar.listClosesAt, boardingOpensAt: calendar.boardingOpensAt,
      creatorsOpenAt: calendar.creatorsOpenAt, foundingOpen, departures,
      me: { signedIn: person !== null, hasEmail: (person?.emails.length ?? 0) > 0, flight, accessPending: pending !== null } };
  } catch { return null; }
}

/**
 * The access cookie's name: `__Host-` (Secure, host-only) on every hosted deployment, the plain name only on a loopback HTTP server. A hosted
 * request never falls back to the plain name, so a same-site sibling cannot plant a Domain cookie that binds its entry to someone's account.
 */
const secureCookies = (request?: Request) => isHostedDeployment(process.env) || (request ? new URL(request.url).protocol === 'https:' : false);
/** The browser's pending access session (a proven list address before sign-in), if any. */
async function pendingSession(request?: Request): Promise<string | null> {
  const value = (await cookies()).get(sessionCookieName(ACCESS_SESSION_COOKIE, secureCookies(request)))?.value ?? null;
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
/** Bind a pending access session to the signed-in account (the session row is deleted either way; the cookie then means nothing). */
async function bindPending(person: FlightPerson, session: string, now: number): Promise<string> {
  const access = await flightAccessStore();
  return access ? access.bindSession({ session, accountId: person.accountId, now }) : 'NONE';
}
function sessionCookie(request: Request, value: string | null): string {
  const secure = secureCookies(request);
  const name = sessionCookieName(ACCESS_SESSION_COOKIE, secure);
  return `${name}=${value ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? Math.floor(ACCESS_SESSION_MS / 1000) : 0}${secure ? '; Secure' : ''}`;
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
    const now = await flightNow(), pending = await pendingSession(request);
    const bound = pending ? await bindPending(person, pending, now) : 'NONE';
    const state = await store.account({ ...person, now }), detail = accessResultDetail(state.access);
    const origin: FlightOrigin | null = state.access.kind === 'eligible' ? state.access.origin : null;
    if (detail) await store.recordEvent('access_result', detail, origin, now);
    const response = json(200, { ok: true, flight: state, ...bound === 'CLAIMED_ELSEWHERE' || bound === 'ACCOUNT_HAS_OTHER_ENTRY' ? { access: bound } : {} });
    if (pending) response.headers.append('set-cookie', sessionCookie(request, null));
    return response;
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
    // A creator's test flight: the TEST card of their recorded simulation, never stored, numbered or shared.
    const early = await store.account({ ...person, now });
    if (early.access.kind === 'test_flight') return early.testPass ? json(200, { ok: true, issued: false, test: true, pass: early.testPass }) : refuse(409, 'FLIGHT_SIMULATION_NOT_FOUND');
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

// BUILD-FLOFI-FLIGHT-LAUNCH-001: access by link and code, and unsubscribe.
async function accessOr503() {
  try { return await flightAccessStore() ?? refuse(503, 'FLIGHT_UNAVAILABLE'); } catch { return refuse(503, 'FLIGHT_UNAVAILABLE'); }
}
/** A consumed link or code: the account now has the entry, or the browser holds a session until sign-in. Other outcomes are fixed codes. */
function consumed(request: Request, result: ConsumeResult): Response {
  if (result.status === 'CLAIMED') return json(200, { ok: true, status: 'CLAIMED', next: '/board?board=1' });
  if (result.status === 'SESSION') {
    const response = json(200, { ok: true, status: 'SESSION', next: '/board?board=1' });
    response.headers.append('set-cookie', sessionCookie(request, result.session));
    return response;
  }
  const status = result.status === 'RATE_LIMITED' ? 429 : result.status === 'INVALID' ? 400 : 409;
  return refuse(status, `ACCESS_${result.status}`);
}

/** "Continue" on the link's page: the token comes in the body (it travels in the URL fragment, which no server ever sees). */
export async function handleAccessConsume(request: Request): Promise<Response> {
  const body = await readRequest(request, 512);
  if (body instanceof Response) return body;
  if (typeof body.token !== 'string' || body.token.length > 64) return refuse(400, 'ACCESS_INVALID');
  const access = await accessOr503();
  if (access instanceof Response) return access;
  try {
    const person = await flightPerson(), now = await flightNow();
    return consumed(request, await access.consumeLink({ token: body.token, accountId: person?.accountId ?? null, client: await requestClient(), now }));
  } catch { return refuse(503, 'FLIGHT_UNAVAILABLE'); }
}

/** The Continue page asks which address a link proves (masked), before the person confirms. Consumes nothing. */
export async function handleAccessPeek(request: Request): Promise<Response> {
  const body = await readRequest(request, 512);
  if (body instanceof Response) return body;
  if (typeof body.token !== 'string' || body.token.length > 64) return refuse(400, 'ACCESS_INVALID');
  const access = await accessOr503();
  if (access instanceof Response) return access;
  try {
    const result = await access.peekLink({ token: body.token, client: await requestClient(), now: await flightNow() });
    return result === 'INVALID' ? refuse(400, 'ACCESS_INVALID') : result === 'RATE_LIMITED' ? refuse(429, 'ACCESS_RATE_LIMITED') : json(200, { ok: true, address: result.address });
  } catch { return refuse(503, 'FLIGHT_UNAVAILABLE'); }
}

/** The address and the six-digit code (another device). Unknown address and wrong code answer alike. */
export async function handleAccessCode(request: Request): Promise<Response> {
  const body = await readRequest(request, 512);
  if (body instanceof Response) return body;
  const email = normalizeEmail(body.email), code = normalizeCode(body.code);
  if (!email || !code) return refuse(400, 'ACCESS_INVALID');
  const access = await accessOr503();
  if (access instanceof Response) return access;
  try {
    const person = await flightPerson(), now = await flightNow();
    return consumed(request, await access.consumeCode({ email, code, accountId: person?.accountId ?? null, client: await requestClient(), now }));
  } catch { return refuse(503, 'FLIGHT_UNAVAILABLE'); }
}

/**
 * "Send me a link and a code": the same answer whether or not the address is listed or its group open. The email (ESSENTIAL) is sent by the
 * worker. Before boarding opens nothing is sent (there is nothing to board yet).
 */
export async function handleAccessRequest(request: Request): Promise<Response> {
  const body = await readRequest(request, 512);
  if (body instanceof Response) return body;
  const email = normalizeEmail(body.email);
  if (!email) return refuse(400, 'FLIGHT_EMAIL_INVALID');
  const [store, access] = await Promise.all([storeOr503(), accessOr503()]);
  if (store instanceof Response) return store;
  if (access instanceof Response) return access;
  try {
    const now = await flightNow(), calendar = store.calendar;
    const result = await access.requestAccess({ email, language: language(body.language), client: await requestClient(), now,
      groupOpen: entry => flightPhase(now, calendar) === 'BOARDING' && now >= Math.max(entry.opensAt ?? calendar.boardingOpensAt, calendar.boardingOpensAt) });
    return result === 'RATE_LIMITED' ? refuse(429, 'FLIGHT_RATE_LIMITED') : json(200, { ok: true });
  } catch { return refuse(503, 'FLIGHT_UNAVAILABLE'); }
}

/**
 * One-click unsubscribe (RFC 8058): the mail provider POSTs `List-Unsubscribe=One-Click` to the URL in the email's header, and the page
 * /board/unsubscribe posts here after the person's click. The signed token names one email; its recipient stops receiving campaign email.
 * Not a same-origin route by design (the provider's own servers call it); it can only ever unsubscribe the recipient of a real email.
 */
export async function handleUnsubscribe(request: Request): Promise<Response> {
  if (request.method !== 'POST') return refuse(405, 'FLIGHT_METHOD');
  const secret = accessSecret(process.env);
  const token = secret ? readUnsubscribeToken(secret, new URL(request.url).searchParams.get('t')) : null;
  if (!token) return refuse(400, 'UNSUBSCRIBE_INVALID');
  try {
    const outbox = await flightOutbox();
    if (!outbox) return refuse(503, 'FLIGHT_UNAVAILABLE');
    await outbox.unsubscribe(token.addressHash);
    return json(200, { ok: true });
  } catch { return refuse(503, 'FLIGHT_UNAVAILABLE'); }
}
