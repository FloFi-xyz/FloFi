// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Minimal stateless HTTP boundary on node:http (no framework). Any instance can serve any request; nothing
 * is kept between requests except in PostgreSQL. Bearer-token authentication (constant-time comparison),
 * JSON-only bodies with a size limit, no-store responses, W3C trace propagation and structured access logs.
 * Errors never echo internal messages: only allowlisted upper-case codes leave the process.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseTraceparent, withSpan, type Logger } from './telemetry.js';

export type HttpRequest = { readonly method: string; readonly path: string; readonly query: URLSearchParams;
  readonly headers: IncomingMessage['headers']; readonly body: unknown; readonly requestId: string;
  /**
   * P0 catalog reliability: aborted when the caller disconnects before its response is written (its own deadline passed, or the browser
   * request it served was cancelled). A read-only handler may stop on it; a mutating handler must not treat it as "not done" (the caller
   * re-reads status). Optional so handlers built outside this server (tests, the embedded runtime) need not supply one.
   */
  readonly signal?: AbortSignal };
export type HttpResponse = { readonly status: number; readonly body: unknown };
export type Route = { readonly method: 'GET' | 'POST'; readonly pattern: RegExp; readonly name: string;
  readonly handler: (request: HttpRequest, match: RegExpExecArray) => Promise<HttpResponse> };
export class HttpError extends Error {
  constructor(readonly status: number, code: string) { super(code); }
}
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const digest = (value: string) => createHash('sha256').update(value).digest();

async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  if (request.method !== 'POST') return null;
  if (!/^application\/json(\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'CONTENT_TYPE_UNSUPPORTED');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'BODY_TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'BODY_INVALID'); }
}
function send(response: ServerResponse, status: number, body: unknown, requestId: string, draining: boolean): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'x-request-id': requestId, 'content-length': Buffer.byteLength(text), ...draining ? { connection: 'close' } : {} });
  response.end(text);
}

export type HttpServerOptions = { readonly routes: readonly Route[]; readonly logger: Logger; readonly authToken: string | null;
  readonly maxBodyBytes?: number; readonly ready?: () => Promise<boolean> };
export type HttpServer = Server & {
  /** Resolves once no route handler is running, including one whose caller already disconnected (a mutation keeps going; see `signal`). */
  readonly drained: () => Promise<void>;
};
export function createHttpServer(options: HttpServerOptions): HttpServer {
  const limit = options.maxBodyBytes ?? 1_048_576, expected = options.authToken ? digest(options.authToken) : null;
  /**
   * BUILD-INFRA-API-FAILOVER-CERT-001: once `server.close()` was called (the API's SIGTERM drain) the server no longer listens, so new
   * connections already reach another replica — but Node keeps serving NEW requests on connections kept alive, and a reverse proxy reuses
   * its pooled ones. While draining, every answer (including one to a request that arrived before) closes its connection, and readiness
   * reports false: no new work starts on the draining replica and the server closes once its last answer is written. `drained()` then
   * covers handlers whose caller left before its answer, so the database is closed only after every handler ended.
   */
  const reply = (response: ServerResponse, status: number, body: unknown, requestId: string) => send(response, status, body, requestId, !server.listening);
  let active = 0;
  const waiting: (() => void)[] = [];
  const drained = () => active === 0 ? Promise.resolve() : new Promise<void>(resolve => { waiting.push(resolve); });
  const settled = () => { if (--active === 0) for (const resolve of waiting.splice(0)) resolve(); };
  const server = createServer((request, response) => {
    const requestId = randomUUID(), url = new URL(request.url ?? '/', 'http://internal'), method = request.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/healthz') { reply(response, 200, { ok: true }, requestId); return; }
    if (method === 'GET' && url.pathname === '/readyz') {
      if (!server.listening) { reply(response, 503, { ok: false }, requestId); return; }
      (options.ready?.() ?? Promise.resolve(true)).then(ok => { const ready = ok && server.listening; reply(response, ready ? 200 : 503, { ok: ready }, requestId); },
        () => reply(response, 503, { ok: false }, requestId));
      return;
    }
    const route = options.routes.find(r => r.method === method && r.pattern.test(url.pathname));
    const match = route ? route.pattern.exec(url.pathname)! : null;
    const disconnected = new AbortController();
    response.once('close', () => { if (!response.writableFinished) disconnected.abort(); });
    active++;
    void withSpan(options.logger, 'http.request', { http_method: method, http_route: route?.name ?? 'unmatched', request_id: requestId }, async () => {
      try {
        if (expected) {
          const header = request.headers.authorization ?? '';
          const supplied = header.startsWith('Bearer ') ? digest(header.slice(7)) : null;
          if (!supplied || !timingSafeEqual(supplied, expected)) throw new HttpError(401, 'UNAUTHORIZED');
        }
        if (!route || !match) throw new HttpError(404, 'NOT_FOUND');
        const body = await readBody(request, limit);
        const result = await route.handler({ method, path: url.pathname, query: url.searchParams, headers: request.headers, body, requestId,
          signal: disconnected.signal }, match);
        reply(response, result.status, result.body, requestId);
        // The span sees the answer, so a refusal answered as `{ ok: false, code }` is logged as refused (telemetry.ts), never as ok.
        return result;
      } catch (error) {
        if (error instanceof HttpError) { reply(response, error.status, { ok: false, code: CODE.test(error.message) ? error.message : 'REQUEST_INVALID' }, requestId); throw error; }
        reply(response, 500, { ok: false, code: 'INTERNAL_ERROR' }, requestId);
        throw error;
      }
    }, parseTraceparent(typeof request.headers.traceparent === 'string' ? request.headers.traceparent : null)).catch(() => undefined).finally(settled);
  });
  return Object.assign(server, { drained });
}
