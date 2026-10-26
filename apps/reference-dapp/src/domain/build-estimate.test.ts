// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_QUOTE_DEBOUNCE_MS, BUILD_ESTIMATE_TIMEOUT_MS, requestBuildEstimate, type BuildEstimateResult } from './build-estimate';
import { deferred } from '../test-utils/hook-harness';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const result: BuildEstimateResult = { ok: true, estimate: { workflowHash: '0x' + 'a'.repeat(64), nodeId: 'node-002', chain: 'eip155:84532', provider: 'Uniswap V3', expected: '0.001', minimum: '0.000995', symbol: 'WETH', slippageBps: 50, expiresAt: '2099-01-01T00:00:00Z' } };
describe('cancellable Build estimate requests', () => {
  it('UX-007: the live-quote debounce is a short named constant (150–250 ms)', () => {
    expect(LIVE_QUOTE_DEBOUNCE_MS).toBe(200);
    expect(LIVE_QUOTE_DEBOUNCE_MS).toBeGreaterThanOrEqual(150); expect(LIVE_QUOTE_DEBOUNCE_MS).toBeLessThanOrEqual(250);
  });
  it('debounces and publishes one successful response', async () => {
    const load = vi.fn().mockResolvedValue(result), publish = vi.fn(); requestBuildEstimate(load, publish);
    await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS - 1); expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledOnce(); expect(publish).toHaveBeenCalledExactlyOnceWith(result);
    await vi.advanceTimersByTimeAsync(20_000); expect(publish).toHaveBeenCalledOnce();
  });
  it('cancels before debounce without loading', async () => {
    const load = vi.fn(), publish = vi.fn(), cancel = requestBuildEstimate(load, publish); cancel();
    await vi.advanceTimersByTimeAsync(20_000); expect(load).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  });
  it('aborts an in-flight request and ignores completion after cancellation', async () => {
    const pending = deferred<BuildEstimateResult>(), publish = vi.fn(); let signal!: AbortSignal;
    const cancel = requestBuildEstimate(s => { signal = s; return pending.promise; }, publish);
    await vi.advanceTimersByTimeAsync(350); cancel(); expect(signal.aborted).toBe(true);
    pending.resolve(result); await Promise.resolve(); expect(publish).not.toHaveBeenCalled();
  });
  it('aborts on timeout and never publishes the late result', async () => {
    const pending = deferred<BuildEstimateResult>(), publish = vi.fn(); let signal!: AbortSignal;
    requestBuildEstimate(s => { signal = s; return pending.promise; }, publish);
    await vi.advanceTimersByTimeAsync(BUILD_ESTIMATE_TIMEOUT_MS + 350); expect(signal.aborted).toBe(true);
    expect(publish).toHaveBeenCalledExactlyOnceWith({ ok: false, code: 'ESTIMATE_TIMEOUT' });
    pending.resolve(result); await Promise.resolve(); expect(publish).toHaveBeenCalledOnce();
  });
  it('allows a 12-second cold runtime quote within the Canvas deadline', async () => {
    const publish = vi.fn(); let signal!: AbortSignal;
    requestBuildEstimate(s => { signal = s; return new Promise(resolve => setTimeout(() => resolve(result), 12_000)); }, publish);
    await vi.advanceTimersByTimeAsync(LIVE_QUOTE_DEBOUNCE_MS + 11_999);
    expect(signal.aborted).toBe(false); expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(publish).toHaveBeenCalledExactlyOnceWith(result);
  });
  it('reports failures without fabricating an estimate', async () => {
    const publish = vi.fn(); requestBuildEstimate(() => Promise.reject(Error('offline')), publish);
    await vi.advanceTimersByTimeAsync(350); expect(publish).toHaveBeenCalledExactlyOnceWith({ ok: false, code: 'ESTIMATE_UNAVAILABLE' });
  });
});
