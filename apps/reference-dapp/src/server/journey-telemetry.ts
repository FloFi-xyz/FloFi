// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: receives a finished journey's content-free timing (domain/journey-metrics.ts) and writes it to the
 * existing structured log stream (`createLogger`, the same pipeline as quote and flow spans). No database table, no second analytics system,
 * no cookie, account, address, amount, hash, signature or chat text: the closed schema admits none, and anything else is refused.
 * Same-origin only, bounded in size (also without Content-Length) and per-process rate. `FLOFI_JOURNEY_TELEMETRY=off` accepts and drops every event.
 * The events are client-reported and unauthenticated: a non-browser client can forge the same-origin headers, so the report labels them
 * CLIENT_REPORTED and they are operational signals, never certification or financial evidence.
 */
import { createLogger } from '@defi-workflow-engine/cloud-runtime';
import { parseJourneyEvent } from '../domain/journey-metrics.ts';

type Env = Readonly<Record<string, string | undefined>>;
const MAX_BYTES = 4_096, WINDOW_MS = 60_000, LIMIT_PER_WINDOW = 600;
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
export function createJourneyReceiver(options: { readonly env?: Env; readonly now?: () => number; readonly log?: (fields: Fields) => void } = {}) {
  const env = options.env ?? process.env, now = options.now ?? Date.now;
  const log = options.log ?? (fields => createLogger({ service: 'flofi-journey' }).info('journey.timing', fields));
  let windowStart = 0, accepted = 0;
  return async function receive(request: Request): Promise<Response> {
    const site = request.headers.get('sec-fetch-site'), origin = request.headers.get('origin');
    let sameOrigin: boolean;
    try { sameOrigin = site ? site === 'same-origin' : origin !== null && origin === new URL(request.url).origin; } catch { sameOrigin = false; }
    if (!sameOrigin) return new Response(null, { status: 403, headers });
    if (Number(request.headers.get('content-length') ?? '0') > MAX_BYTES) return new Response(null, { status: 413, headers });
    const text = await boundedText(request, MAX_BYTES);
    if (text === null) return new Response(null, { status: 413, headers });
    let event;
    try { event = parseJourneyEvent(JSON.parse(text)); } catch { event = null; }
    if (!event) return new Response(null, { status: 400, headers });
    if (env.FLOFI_JOURNEY_TELEMETRY === 'off') return new Response(null, { status: 204, headers });
    const at = now();
    if (at - windowStart >= WINDOW_MS) { windowStart = at; accepted = 0; }
    if (++accepted > LIMIT_PER_WINDOW) return new Response(null, { status: 429, headers });
    log({ evidence: 'CLIENT_REPORTED', journey_id: event.journeyId, operation: event.operation, network: event.network, provider: event.provider, wallet: event.wallet,
      outcome: event.outcome, user_ms: event.userMs, system_ms: event.systemMs, ...event.metrics });
    return new Response(null, { status: 204, headers });
  };
}
