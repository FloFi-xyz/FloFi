// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: bounded JSON transport for the universal router's routing providers (read-only quote,
 * route-discovery and status APIs). HTTPS only (loopback for the MOCKED harness), no redirects, no caching, size and time
 * bounds. Provider keys are optional server-side headers and never leave the server.
 */
/** `signal` (BUILD-FLOFI-EXECUTION-PERFORMANCE-001) is request-scoped cancellation: discovery aborts a provider it no longer waits for. */
export type UniversalHttpOptions = { readonly signal?: AbortSignal };
export type UniversalHttp = {
  readonly get: (url: string, headers?: Readonly<Record<string, string>>, options?: UniversalHttpOptions) => Promise<unknown>;
  readonly post: (url: string, body: unknown, headers?: Readonly<Record<string, string>>, options?: UniversalHttpOptions) => Promise<unknown>;
};
const fail = (code: string): never => { throw new Error(code); };
const LIMIT = 4_000_000;

export function createUniversalHttp(fetcher: typeof fetch = fetch, timeoutMs = 20_000): UniversalHttp {
  async function request(url: string, init: { method: 'GET' | 'POST'; body?: string; headers: Record<string, string>; signal?: AbortSignal }): Promise<unknown> {
    let target: URL;
    try { target = new URL(url); } catch { return fail('UNIVERSAL_PROVIDER_URL_INVALID'); }
    if (target.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(target.hostname)) fail('UNIVERSAL_PROVIDER_URL_INVALID');
    let response: Response;
    try {
      response = await fetcher(target, { method: init.method, headers: { Accept: 'application/json', 'User-Agent': 'Flofi/BUILD-CROSSCHAIN-UNIVERSAL-001', ...init.headers },
        ...init.body !== undefined ? { body: init.body } : {}, cache: 'no-store', redirect: 'error',
        signal: init.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), init.signal]) : AbortSignal.timeout(timeoutMs) });
    } catch { return fail('UNIVERSAL_PROVIDER_UNAVAILABLE'); }
    if (response.status === 429) fail('UNIVERSAL_PROVIDER_RATE_LIMITED');
    if (Number(response.headers.get('content-length') ?? '0') > LIMIT) fail('UNIVERSAL_PROVIDER_RESPONSE_TOO_LARGE');
    const text = await response.text();
    if (text.length > LIMIT) fail('UNIVERSAL_PROVIDER_RESPONSE_TOO_LARGE');
    let value: unknown;
    try { value = JSON.parse(text); } catch { return fail(response.ok ? 'UNIVERSAL_PROVIDER_RESPONSE_INVALID' : 'UNIVERSAL_PROVIDER_HTTP_' + response.status); }
    // A provider "no route" answer (4xx with a JSON message) is information, not a transport failure: the adapter classifies it.
    if (!response.ok) return { __httpStatus: response.status, __body: value };
    return value;
  }
  return {
    get: (url, headers = {}, options = {}) => request(url, { method: 'GET', headers: { ...headers }, ...options.signal ? { signal: options.signal } : {} }),
    post: (url, body, headers = {}, options = {}) => request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers },
      ...options.signal ? { signal: options.signal } : {} }),
  };
}
/** A provider's non-2xx JSON answer, as returned by `createUniversalHttp` (status and body), or null. */
export function providerHttpError(value: unknown): { status: number; message: string } | null {
  if (!value || typeof value !== 'object' || !('__httpStatus' in value)) return null;
  const body = (value as { __body?: unknown }).__body as Record<string, unknown> | undefined;
  // Relay answers `message`; Mayan answers `code` and `msg` (e.g. SDK_VERSION_TOO_OLD).
  const text = (key: string) => body && typeof body === 'object' && typeof body[key] === 'string' ? body[key] as string : '';
  const message = (text('message') || [text('code'), text('msg')].filter(Boolean).join(': ')).slice(0, 300);
  return { status: Number((value as { __httpStatus: unknown }).__httpStatus), message };
}

/** Closed technical codes only: never propagate provider bodies, URLs or credentials. */
export function providerRefusalCode(provider: string, refused: { status: number; message: string }): string {
  if ([401, 403, 408, 425, 429].includes(refused.status) || refused.status >= 500) return `${provider}_HTTP_${refused.status}`;
  const message = refused.message;
  if (/insufficient liquidity|not enough liquidity|liquidity unavailable/i.test(message)) return `${provider}_INSUFFICIENT_LIQUIDITY`;
  if (/too (?:small|low)|below.*minimum|minimum.*amount|amount.*minimum|AMOUNT_TOO_LOW/i.test(message)) return `${provider}_AMOUNT_TOO_LOW`;
  if (/too (?:large|high)|above.*maximum|maximum.*amount|amount.*maximum|AMOUNT_TOO_HIGH/i.test(message)) return `${provider}_AMOUNT_TOO_HIGH`;
  return `${provider}_NO_ROUTE`;
}
