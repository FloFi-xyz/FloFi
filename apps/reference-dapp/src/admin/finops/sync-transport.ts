// SPDX-License-Identifier: AGPL-3.0-only

export const financialObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const financialInvalid = () => new Error('FINOPS_PROVIDER_RESPONSE_INVALID');

/** Each adapter supplies a fixed endpoint or validates a provider-issued download URL before calling. */
export async function requestFinancial(url: URL, init: RequestInit, fetcher: typeof fetch, overall: AbortSignal, maxBytes = 1_048_576): Promise<string> {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw financialInvalid();
  const signal = AbortSignal.any([overall, AbortSignal.timeout(10_000)]);
  try {
    const response = await fetcher(url, { ...init, signal, cache: 'no-store', redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const code = response.status === 401 || response.status === 403 ? 'FINOPS_PROVIDER_FORBIDDEN'
        : response.status === 404 ? 'FINOPS_PROVIDER_NO_COST_DATA' : response.status === 429 ? 'FINOPS_PROVIDER_RATE_LIMITED'
          // An expired pagination cursor (Anthropic analytics after a data refresh): restart the whole read later.
          : response.status === 410 ? 'FINOPS_PROVIDER_RETRY_LATER'
          : response.status >= 500 ? 'FINOPS_PROVIDER_UNAVAILABLE' : 'FINOPS_PROVIDER_RESPONSE_INVALID';
      throw new Error(code);
    }
    if (!response.body || Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw financialInvalid();
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const piece = await reader.read();
        if (piece.done) break;
        size += piece.value.length;
        if (size > maxBytes) { await reader.cancel(); throw financialInvalid(); }
        chunks.push(piece.value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size).toString('utf8');
  } catch (cause) {
    // Provider bodies, URLs, credentials and transport exception text never
    // reach the worker's durable status or the admin response.
    if (cause instanceof Error && /^FINOPS_PROVIDER_(FORBIDDEN|NO_COST_DATA|RATE_LIMITED|RETRY_LATER|UNAVAILABLE|RESPONSE_INVALID)$/.test(cause.message)) throw cause;
    // The transport cause is deliberately dropped: its text can carry the request URL or a provider body.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('FINOPS_PROVIDER_UNAVAILABLE');
  }
}

export function financialJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { throw financialInvalid(); }
}
