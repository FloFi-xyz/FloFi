// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: receives a finished journey's content-free timing (domain/journey-metrics.ts) and writes it to the
 * existing structured log stream (`createLogger`, the same pipeline as quote and flow spans). No database table, no second analytics system,
 * no cookie, account, address, amount, hash, signature or chat text: the closed schema admits none, and anything else is refused.
 * Abuse and cost bounds: same-origin only; a body of at most 4 KiB (also without Content-Length); a signed-in FloFi session is required — its
 * sealed, host-bound cookie is checked cryptographically (no database read), so a forger needs a real account; at most 60 events per account per
 * 10 minutes and 600 per process per minute, so one sender cannot flood the logs or crowd out everyone else (one log line, about 0.5 KB, per
 * accepted event). The account is used only as an in-memory, hashed rate-limit key: it is never logged or stored. `FLOFI_JOURNEY_TELEMETRY=off`
 * accepts and drops every event. The timings are still client-reported, so the report labels them CLIENT_REPORTED: operational signals,
 * never certification or financial evidence.
 */
import { createHash } from 'node:crypto';
import { createLogger } from '@defi-workflow-engine/cloud-runtime';
import { parseJourneyEvent } from '../domain/journey-metrics.ts';
import { ACCOUNT_SESSION_COOKIE, readAccountSession } from '../accounts/account-session.ts';
import { sessionCookieName } from './session-cookie.ts';
import { originFromHeaders } from './session-principal.ts';

type Env = Readonly<Record<string, string | undefined>>;
const MAX_BYTES = 4_096, WINDOW_MS = 60_000, LIMIT_PER_WINDOW = 600, ACCOUNT_WINDOW_MS = 600_000, LIMIT_PER_ACCOUNT = 60, ACCOUNTS_TRACKED = 5_000;
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

type Fields = Readonly<Record<string, string | number | null>>;
/** The body as text, or null once it exceeds `limit` bytes (read incrementally; a chunked body is never buffered past the limit). */
async function boundedText(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
/** The signed-in account of this request from its sealed session cookie (MAC and expiry only; no database read), or null. */
export function journeyAccount(request: Request, env: Env, now: Date): string | null {
  const origin = originFromHeaders(request.headers), name = sessionCookieName(ACCOUNT_SESSION_COOKIE, origin.secure);
  const cookie = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(name + '='));
  const token = cookie ? readAccountSession(env, decodeURIComponent(cookie.slice(name.length + 1)), now, origin.domain) : null;
  return token && token.expiresAt * 1000 > now.getTime() ? token.accountId : null;
}

export function createJourneyReceiver(options: { readonly env?: Env; readonly now?: () => number; readonly log?: (fields: Fields) => void;
  readonly account?: (request: Request) => string | null } = {}) {
  const env = options.env ?? process.env, now = options.now ?? Date.now;
  const log = options.log ?? (fields => createLogger({ service: 'flofi-journey' }).info('journey.timing', fields));
  const account = options.account ?? (request => journeyAccount(request, env, new Date(now())));
  let windowStart = 0, accepted = 0;
  // Per-account windows, keyed by a hash (the account id never sits in memory as such), bounded in size (oldest first).
  const perAccount = new Map<string, { start: number; count: number }>();
  const allowAccount = (accountId: string, at: number) => {
    const key = createHash('sha256').update('flofi-journey:' + accountId).digest('hex').slice(0, 32);
    const entry = perAccount.get(key);
    if (!entry || at - entry.start >= ACCOUNT_WINDOW_MS) {
      perAccount.delete(key); perAccount.set(key, { start: at, count: 1 });
      while (perAccount.size > ACCOUNTS_TRACKED) perAccount.delete(perAccount.keys().next().value!);
      return true;
    }
    return ++entry.count <= LIMIT_PER_ACCOUNT;
  };
  return async function receive(request: Request): Promise<Response> {
    const site = request.headers.get('sec-fetch-site'), origin = request.headers.get('origin');
    let sameOrigin: boolean;
    try { sameOrigin = site ? site === 'same-origin' : origin !== null && origin === new URL(request.url).origin; } catch { sameOrigin = false; }
    if (!sameOrigin) return new Response(null, { status: 403, headers });
    // Cheapest refusals first: turned off, then no signed-in session, then size; the body is read only for a signed-in sender.
    if (env.FLOFI_JOURNEY_TELEMETRY === 'off') return new Response(null, { status: 204, headers });
    const accountId = account(request);
    if (!accountId) return new Response(null, { status: 401, headers });
    if (Number(request.headers.get('content-length') ?? '0') > MAX_BYTES) return new Response(null, { status: 413, headers });
    const text = await boundedText(request, MAX_BYTES);
    if (text === null) return new Response(null, { status: 413, headers });
    let event;
    try { event = parseJourneyEvent(JSON.parse(text)); } catch { event = null; }
    if (!event) return new Response(null, { status: 400, headers });
    const at = now();
    if (!allowAccount(accountId, at)) return new Response(null, { status: 429, headers });
    if (at - windowStart >= WINDOW_MS) { windowStart = at; accepted = 0; }
    if (++accepted > LIMIT_PER_WINDOW) return new Response(null, { status: 429, headers });
    log({ evidence: 'CLIENT_REPORTED', journey_id: event.journeyId, operation: event.operation, network: event.network, provider: event.provider, wallet: event.wallet,
      outcome: event.outcome, user_ms: event.userMs, system_ms: event.systemMs, ...event.metrics });
    return new Response(null, { status: 204, headers });
  };
}
