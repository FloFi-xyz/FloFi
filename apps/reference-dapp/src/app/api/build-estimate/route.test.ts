// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-BRIDGE-RECONCILIATION-003 (Workstream B): the Live Quote endpoint streams NDJSON when asked — the token estimate is the
 * first line and is sent before the optional USD read finishes; USD is a second line only when one exists. A client that does not ask for the
 * stream, or any refused estimate, gets the unchanged JSON answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildEstimate, BuildEstimateResult } from '../../../domain/build-estimate';
import type { UsdEstimate } from '../../../domain/usd-estimate';

type Seams = { correlationId?: string; signal?: AbortSignal; onUsd?: (pending: Promise<UsdEstimate | null>) => void };
const h = vi.hoisted(() => ({ read: null as null | ((seams: Seams) => Promise<unknown>) }));
vi.mock('../../../server/flight-access', () => ({ withFlightAccess: <T>(work: () => Promise<T>) => work() }));
vi.mock('../../../server/build-estimate', () => ({ readBuildEstimate: (_input: unknown, _env: unknown, seams: Seams) => h.read!(seams) }));
const { POST } = await import('./route');
const { BUILD_ESTIMATE_STREAM } = await import('../../../domain/build-estimate');

const STREAM = 'application/x-ndjson';
const CORRELATION = '12345678-abcd-4321-9876-123456789abc';
const estimate: BuildEstimate = { workflowHash: 'sha256:fixture', nodeId: 'node-002', chain: 'eip155:1', provider: 'Uniswap V3', expected: '0.004',
  minimum: '0.00398', symbol: 'WETH', slippageBps: 50, expiresAt: '2099-01-01T00:00:00.000Z', usd: null };
const usd: UsdEstimate = { input: '10.00', output: '9.98', source: 'FIXTURE', evidence: 'MOCKED', observedAt: '2026-11-24T12:00:00.000Z' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const post = (accept?: string, signal?: AbortSignal) => POST(new Request('https://flofi.test/api/build-estimate', { method: 'POST', body: '{"workflow":{}}',
  headers: { 'content-type': 'application/json', 'x-quote-correlation-id': CORRELATION, ...accept ? { accept } : {} }, ...signal ? { signal } : {} }));
/** Reads one NDJSON line at a time, so a test can observe what arrived before the USD promise settled. */
function lines(response: Response) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  return async (): Promise<unknown> => {
    while (!buffer.includes('\n')) { const chunk = await reader.read(); if (chunk.done) return buffer ? JSON.parse(buffer) : 'END'; buffer += chunk.value; }
    const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    return JSON.parse(line);
  };
}

describe('POST /api/build-estimate NDJSON token-first stream', () => {
  beforeEach(() => { h.read = null; });

  it('uses the shared stream content type', () => { expect(BUILD_ESTIMATE_STREAM).toBe(STREAM); });

  it('sends the token estimate before USD resolves, then the USD line, then closes', async () => {
    const pendingUsd = deferred<UsdEstimate | null>();
    h.read = async seams => { seams.onUsd!(pendingUsd.promise); return { ok: true, estimate } satisfies BuildEstimateResult; };
    const response = await post(STREAM);
    expect(response.headers.get('content-type')).toBe(STREAM);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-quote-correlation-id')).toBe(CORRELATION);
    const next = lines(response);
    // USD is still pending here: the token amount is already on the wire.
    expect(await next()).toEqual({ ok: true, estimate: { ...estimate, correlationId: CORRELATION } });
    pendingUsd.resolve(usd);
    expect(await next()).toEqual(usd);
    expect(await next()).toBe('END');
  });

  it('closes after the token line when no USD equivalent exists', async () => {
    h.read = async seams => { seams.onUsd!(Promise.resolve(null)); return { ok: true, estimate }; };
    const next = lines(await post(STREAM));
    expect(await next()).toMatchObject({ ok: true, estimate: { expected: '0.004', usd: null } });
    expect(await next()).toBe('END');
  });

  it('never streams a refused estimate, and a client that did not ask gets plain JSON without a USD seam', async () => {
    h.read = async seams => { seams.onUsd?.(Promise.resolve(usd)); return { ok: false, code: 'ESTIMATE_UNAVAILABLE' }; };
    const refused = await post(STREAM);
    expect(refused.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await refused.json()).toEqual({ ok: false, code: 'ESTIMATE_UNAVAILABLE', correlationId: CORRELATION });
    let offered = false;
    h.read = async seams => { offered = Boolean(seams.onUsd); return { ok: true, estimate: { ...estimate, usd } }; };
    const plain = await post();
    expect(offered).toBe(false);
    expect(plain.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await plain.json()).toEqual({ ok: true, estimate: { ...estimate, usd, correlationId: CORRELATION } });
  });

  it('a USD read that fails still ends the stream after the token line', async () => {
    h.read = async seams => { seams.onUsd!(Promise.reject(new Error('price source down'))); return { ok: true, estimate }; };
    const next = lines(await post(STREAM));
    expect(await next()).toMatchObject({ ok: true, estimate: { expected: '0.004' } });
    expect(await next()).toBe('END');
  });

  it('a client that closes the stream before USD settles leaves nothing pending and nothing thrown', async () => {
    const pendingUsd = deferred<UsdEstimate | null>(), unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      h.read = async seams => { seams.onUsd!(pendingUsd.promise); return { ok: true, estimate }; };
      const response = await post(STREAM), reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
      pendingUsd.resolve(usd);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });

  it('does not send a late USD line after the browser cancelled', async () => {
    const pendingUsd = deferred<UsdEstimate | null>(), browser = new AbortController();
    h.read = async seams => { seams.onUsd!(pendingUsd.promise); return { ok: true, estimate }; };
    const next = lines(await post(STREAM, browser.signal));
    expect(await next()).toMatchObject({ ok: true });
    browser.abort();
    pendingUsd.resolve(usd);
    expect(await next()).toBe('END');
  });
});
