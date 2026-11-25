// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJupiterHttp } from './jupiter-http';

const quote = createJupiterHttp('https://example.invalid/swap/v2/build', undefined);
const rateLimited = (wait: string) => new Response(null, { status: 429, headers: { 'retry-after': wait } });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('read-only Jupiter build transport', () => {
  it('honors a short Retry-After before one retry', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(rateLimited('1')).mockResolvedValueOnce(Response.json({ routePlan: [] }));
    vi.stubGlobal('fetch', fetcher);
    const result = quote({ amount: '1' });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(201);
    await expect(result).resolves.toEqual({ routePlan: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init.method === undefined && init.signal instanceof AbortSignal)).toBe(true);
  });

  it('declines to retry a Retry-After outside the request budget', async () => {
    const fetcher = vi.fn().mockResolvedValue(rateLimited('30'));
    vi.stubGlobal('fetch', fetcher);
    await expect(quote({})).rejects.toThrow('JUPITER_RATE_LIMITED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels an active provider read and starts no retry', async () => {
    const caller = new AbortController();
    const fetcher = vi.fn((_url: string, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
    vi.stubGlobal('fetch', fetcher);
    const result = expect(quote({}, caller.signal)).rejects.toThrow('JUPITER_QUOTE_CANCELLED');
    caller.abort();
    await result;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stops after the second temporary failure', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const result = expect(quote({})).rejects.toThrow('JUPITER_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports timeout after the bounded read attempts are exhausted', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    const fetcher = vi.fn((_url: string, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
    vi.stubGlobal('fetch', fetcher);
    const result = expect(quote({})).rejects.toThrow('JUPITER_QUOTE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(17_000);
    await result;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('returns a deterministic no-route error without a retry', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('No routes found', { status: 400 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(quote({})).rejects.toThrow('JUPITER_NO_ROUTE');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
