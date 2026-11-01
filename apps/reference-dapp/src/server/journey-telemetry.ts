// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: receives a finished journey's content-free timing (domain/journey-metrics.ts) and writes it to the
 * existing structured log stream (`createLogger`, the same pipeline as quote and flow spans). No database table, no second analytics system,
 * no cookie, account, address, amount, hash, signature or chat text: the closed schema admits none, and anything else is refused.
 * Abuse and cost bounds: same-origin only; a body of at most 4 KiB (also without Content-Length); a signed-in FloFi session is required — its
 * sealed, host-bound cookie is checked cryptographically (no database read), so a forger needs a real account; at most 60 events per account per
 * 10 minutes and 600 per minute, both per server instance (counters live in memory, so N instances admit up to N times as many); a journey id is
 * logged once. One log line (at most about 0.8 KB) per accepted event. The account is used only as an in-memory rate-limit key, an HMAC under a
 * per-process random key: it is never logged or stored, and its window is dropped once it ends. `FLOFI_JOURNEY_TELEMETRY` other than unset or
 * `on` (for example `off` or `disabled`) accepts and drops every event: a misconfigured switch turns logging off, never on. The timings are
 * still client-reported, so every line and the report say CLIENT_REPORTED: operational signals, never certification or financial evidence.
 * Each line names the deployment that wrote it and the network's registry environment, so a report can refuse mixed or mislabelled logs.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createLogger } from '@defi-workflow-engine/cloud-runtime';
import { journeyNetworkEnvironment, journeyTotals, parseJourneyEvent } from '../domain/journey-metrics.ts';
import { deploymentEnvironment } from './deployment.ts';
import { ACCOUNT_SESSION_COOKIE, readAccountSession } from '../accounts/account-session.ts';
import { sessionCookieName } from './session-cookie.ts';
import { originFromHeaders } from './session-principal.ts';

type Env = Readonly<Record<string, string | undefined>>;
const MAX_BYTES = 4_096, WINDOW_MS = 60_000, LIMIT_PER_WINDOW = 600, ACCOUNT_WINDOW_MS = 600_000, LIMIT_PER_ACCOUNT = 60, ACCOUNTS_TRACKED = 5_000,
  JOURNEYS_REMEMBERED = 10_000;
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
/**
 * The signed-in account of this request from its sealed session cookie (MAC, host and expiry only), or null — for this content-free telemetry
 * rate key ONLY. It deliberately skips the account store's revocation check (`verifySession`) to keep a database read off every beacon, so a
 * revoked session can still send rate-bounded timings until its cookie expires. Never reuse it to authenticate anything: use
 * `currentAccountSession`, which consults the store. Module-private for that reason; a malformed cookie is simply no session.
 */
function telemetryRateKeyAccount(request: Request, env: Env, now: Date): string | null {
  try {
    const origin = originFromHeaders(request.headers), name = sessionCookieName(ACCOUNT_SESSION_COOKIE, origin.secure);
    const cookie = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(name + '='));
    const token = cookie ? readAccountSession(env, decodeURIComponent(cookie.slice(name.length + 1)), now, origin.domain) : null;
    return token && token.expiresAt * 1000 > now.getTime() ? token.accountId : null;
  } catch { return null; }
}

export function createJourneyReceiver(options: { readonly env?: Env; readonly now?: () => number; readonly log?: (fields: Fields) => void;
  readonly account?: (request: Request) => string | null } = {}) {
  const env = options.env ?? process.env, now = options.now ?? Date.now;
  const setting = env.FLOFI_JOURNEY_TELEMETRY?.trim().toLowerCase(), enabled = !setting || setting === 'on';
  const deployment = deploymentEnvironment(env);
  const log = options.log ?? (fields => createLogger({ service: 'flofi-journey' }).info('journey.timing', fields));
  const account = options.account ?? (request => telemetryRateKeyAccount(request, env, new Date(now())));
  let windowStart = 0, accepted = 0;
  // Per-account windows keyed by an HMAC under a key that never leaves this process (the account id never sits in memory as such, and the keys
  // cannot be matched against an account list). Insertion order is window-start order, so ended windows are dropped from the front; the map
  // is also bounded in size (oldest first).
  const rateKey = randomBytes(32), perAccount = new Map<string, { start: number; count: number }>();
  const allowAccount = (accountId: string, at: number) => {
    for (const [stale, entry] of perAccount) { if (at - entry.start < ACCOUNT_WINDOW_MS) break; perAccount.delete(stale); }
    const key = createHmac('sha256', rateKey).update(accountId).digest('base64url');
    const entry = perAccount.get(key);
    if (!entry) {
      perAccount.set(key, { start: at, count: 1 });
      while (perAccount.size > ACCOUNTS_TRACKED) perAccount.delete(perAccount.keys().next().value!);
      return true;
    }
    return ++entry.count <= LIMIT_PER_ACCOUNT;
  };
  // Journey ids already logged (bounded, oldest first): a duplicated or replayed report is never counted twice.
  const seen = new Set<string>();
  const remember = (journeyId: string) => { seen.add(journeyId); if (seen.size > JOURNEYS_REMEMBERED) seen.delete(seen.values().next().value!); };
  return async function receive(request: Request): Promise<Response> {
    // Any unexpected failure is a refusal, never a 500 with a stack trace in the logs.
    try { return await handle(request); } catch { return new Response(null, { status: 400, headers }); }
  };
  async function handle(request: Request): Promise<Response> {
    const site = request.headers.get('sec-fetch-site'), origin = request.headers.get('origin');
    let sameOrigin: boolean;
    try { sameOrigin = site ? site === 'same-origin' : origin !== null && origin === new URL(request.url).origin; } catch { sameOrigin = false; }
    if (!sameOrigin) return new Response(null, { status: 403, headers });
    // Cheapest refusals first: turned off, then no signed-in session, then size; the body is read only for a signed-in sender.
    if (!enabled) return new Response(null, { status: 204, headers });
    const accountId = account(request);
    if (!accountId) return new Response(null, { status: 401, headers });
    if (Number(request.headers.get('content-length') ?? '0') > MAX_BYTES) return new Response(null, { status: 413, headers });
    const text = await boundedText(request, MAX_BYTES);
    if (text === null) return new Response(null, { status: 413, headers });
    let event;
    try { event = parseJourneyEvent(JSON.parse(text)); } catch { event = null; }
    if (!event) return new Response(null, { status: 400, headers });
    if (seen.has(event.journeyId)) return new Response(null, { status: 409, headers });
    const at = now();
    if (!allowAccount(accountId, at)) return new Response(null, { status: 429, headers });
    if (at - windowStart >= WINDOW_MS) { windowStart = at; accepted = 0; }
    if (++accepted > LIMIT_PER_WINDOW) return new Response(null, { status: 429, headers });
    remember(event.journeyId);
    // Totals are recomputed from the accepted metrics (the client's own figures are ignored); null when nothing contributing was measured.
    const totals = journeyTotals(event.metrics);
    log({ ...event.metrics, evidence: 'CLIENT_REPORTED', deployment, network_environment: journeyNetworkEnvironment(event.network), journey_id: event.journeyId,
      operation: event.operation, network: event.network, provider: event.provider, wallet: event.wallet, outcome: event.outcome,
      user_ms: totals.userMs, system_ms: totals.systemMs });
    return new Response(null, { status: 204, headers });
  }
}
