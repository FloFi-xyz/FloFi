// SPDX-License-Identifier: AGPL-3.0-only
/** Jupiter swap-build HTTP client shared by the in-process server action and the cloud backend (read-only quotes/builds). */
import type { JupiterHttp } from '@defi-workflow-engine/reference-compiler';

const ATTEMPT_TIMEOUT_MS = 8_000;
const RETRY_WAIT_LIMIT_MS = 1_500;

function retryDelay(retryAfter: string | null): number {
  const jitter = Math.floor(Math.random() * 200);
  if (retryAfter === null) return 500 + jitter;
  const wait = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(wait) ? Math.max(0, wait) + jitter : Infinity;
}

export function createJupiterHttp(buildEndpoint: string, apiKey: string | undefined): JupiterHttp {
  return async (query, callerSignal) => {
    const url = buildEndpoint + '?' + new URLSearchParams(query);
    const cancelled = () => { if (callerSignal?.aborted) throw new Error('JUPITER_QUOTE_CANCELLED'); };
    const wait = (ms: number) => new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      if (callerSignal?.aborted) finish();
      else callerSignal?.addEventListener('abort', finish, { once: true });
    });
    // One retry within the existing request budget, only for the read-only /build GET.
    for (let attempt = 0; attempt < 2; attempt++) {
      cancelled();
      const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
      const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
      let response: Response;
      let body: string;
      try {
        response = await fetch(url, { cache: 'no-store', signal, headers: apiKey ? { 'x-api-key': apiKey } : {} });
        body = await response.text();
      } catch {
        cancelled();
        if (attempt) throw new Error(timeout.aborted ? 'JUPITER_QUOTE_TIMEOUT' : 'JUPITER_UNAVAILABLE');
        await wait(retryDelay(null));
        continue;
      }
      cancelled();
      if (body.length > 1_048_576) throw new Error('JUPITER_RESPONSE_TOO_LARGE');
      const transient = [429, 502, 503, 504].includes(response.status);
      if (!attempt && transient) {
        const ms = retryDelay(response.headers.get('retry-after'));
        if (ms <= RETRY_WAIT_LIMIT_MS) {
          await wait(ms);
          continue;
        }
      }
      if (response.status === 429) throw new Error('JUPITER_RATE_LIMITED');
      if (response.status === 400 && /No routes found/.test(body)) throw new Error('JUPITER_NO_ROUTE');
      if (!response.ok) throw new Error('JUPITER_UNAVAILABLE');
      return JSON.parse(body) as unknown;
    }
    throw new Error('JUPITER_UNAVAILABLE');
  };
}
