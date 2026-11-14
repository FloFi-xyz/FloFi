// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §5): the bounded, server-side transport to 0x's Gasless API v2, modelled on the
 * routing providers' transport (`router-providers.ts`): JSON only, https on the pinned host `api.0x.org` (or plain http on 127.0.0.1 for the
 * loopback MOCKED harness), redirects refused, no caching, timeouts and size caps. Headers `0x-api-key` (server-only secret; never logged,
 * never returned, never sent to any other host) and `0x-version: v2`.
 *
 * GET for `/gasless/quote`, `/gasless/status/{tradeHash}` and `/gasless/chains`; ONE POST (`/gasless/submit`), which the service makes at most
 * once per trade hash and only after the attempt was durably recorded. A 4xx answer is returned to the caller (it carries 0x's closed error
 * envelope); a 429, a 5xx, a timeout, a network failure, an oversized or non-JSON body fail with a closed `ZEROX_PROVIDER_*` code. For the POST
 * every such failure means "the result is unknown" to the caller, never "not submitted".
 */
import { createHash } from 'node:crypto';
import { ZEROX_API_HOST } from '../../gas-abstraction/config.ts';

export type ZeroExAnswer = { readonly status: number; readonly body: unknown; readonly rawHash: string };
export type ZeroExHttp = {
  readonly get: (path: string, query: Readonly<Record<string, string>>) => Promise<ZeroExAnswer>;
  readonly post: (path: string, body: unknown) => Promise<ZeroExAnswer>;
};
/** 0x's paths FloFi uses; anything else is refused before a request is made. */
const PATHS = /^\/gasless\/(quote|submit|chains|status\/0x[0-9a-f]{64})$/;
const MAX_BYTES = 1_000_000, GET_TIMEOUT_MS = 10_000, POST_TIMEOUT_MS = 20_000;
const fail = (code: string): never => { throw new Error(code); };
export const zeroExRawHash = (raw: unknown) => '0x' + createHash('sha256').update(JSON.stringify(raw)).digest('hex');

/** The base URL is the validated `FLOFI_ZEROX_API_URL` (gas-abstraction/config.ts); it is checked again here, so no other host is ever reached. */
export function createZeroExHttp(config: { readonly apiUrl: string; readonly apiKey: string }, fetcher: typeof fetch = fetch): ZeroExHttp {
  let base: URL;
  try { base = new URL(config.apiUrl); } catch { return fail('ZEROX_PROVIDER_URL_INVALID'); }
  const pinned = base.protocol === 'https:' && base.hostname === ZEROX_API_HOST && !base.port;
  const loopback = base.protocol === 'http:' && base.hostname === '127.0.0.1';
  if ((!pinned && !loopback) || base.username || base.password || base.search || base.hash || base.pathname !== '/') fail('ZEROX_PROVIDER_URL_INVALID');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(config.apiKey)) fail('ZEROX_API_KEY_NOT_CONFIGURED');
  const headers = { Accept: 'application/json', 'User-Agent': 'Flofi/gas-abstraction', '0x-api-key': config.apiKey, '0x-version': 'v2' };
  async function exchange(path: string, query: Readonly<Record<string, string>>, init: RequestInit, timeoutMs: number): Promise<ZeroExAnswer> {
    if (!PATHS.test(path)) fail('ZEROX_PROVIDER_URL_INVALID');
    const target = new URL(path, base);
    for (const [key, value] of Object.entries(query)) {
      if (!/^[A-Za-z]{1,32}$/.test(key) || typeof value !== 'string' || !/^[0-9A-Za-z]{1,128}$/.test(value)) fail('ZEROX_PROVIDER_URL_INVALID');
      target.searchParams.set(key, value);
    }
    if (target.origin !== base.origin) fail('ZEROX_PROVIDER_URL_INVALID');
    let response: Response;
    try { response = await fetcher(target, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { return fail('ZEROX_PROVIDER_UNAVAILABLE'); }
    if (response.status === 429) fail('ZEROX_PROVIDER_RATE_LIMITED');
    if (response.status < 200 || response.status >= 500 || (response.status >= 300 && response.status < 400)) fail('ZEROX_PROVIDER_HTTP_' + response.status);
    if (Number(response.headers.get('content-length') ?? '0') > MAX_BYTES) fail('ZEROX_PROVIDER_RESPONSE_TOO_LARGE');
    let text: string | null;
    try { text = await boundedText(response); } catch { return fail('ZEROX_PROVIDER_UNAVAILABLE'); }
    if (text === null) return fail('ZEROX_PROVIDER_RESPONSE_TOO_LARGE');
    let body: unknown;
    try { body = JSON.parse(text) as unknown; } catch { return fail('ZEROX_PROVIDER_RESPONSE_INVALID'); }
    return { status: response.status, body, rawHash: zeroExRawHash(body) };
  }
  return {
    get: (path, query) => exchange(path, query, { method: 'GET', headers }, GET_TIMEOUT_MS),
    post: (path, body) => {
      const text = JSON.stringify(body);
      if (text.length > MAX_BYTES) fail('ZEROX_PROVIDER_REQUEST_TOO_LARGE');
      return exchange(path, {}, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: text }, POST_TIMEOUT_MS);
    },
  };
}
/**
 * The body, read incrementally and never past the cap (like the Kora client's reader): a body without a usable `content-length` (chunked, or a
 * lying header) is cancelled as soon as it exceeds MAX_BYTES, so 0x (or anything in between) can never make the server buffer more than the cap.
 * null: too large. Strict UTF-8 (a malformed body fails like an unreadable one).
 */
async function boundedText(response: Response): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}
