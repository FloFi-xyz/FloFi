// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { OBSERVATION_DELAYS_MS, OBSERVATION_TIMEOUT_MS, observeUntilSettled } from './observation-schedule';

describe('BUILD-FLOFI-EXECUTION-PERFORMANCE-001 observation schedule', () => {
  it('asks every 2 s for the first 30 s (as before), then backs off and keeps following for about four more minutes', () => {
    expect(OBSERVATION_DELAYS_MS.slice(0, 15).every(ms => ms === 2_000)).toBe(true);
    expect(OBSERVATION_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBe(30_000 + 60_000 + 180_000);
    expect([...OBSERVATION_DELAYS_MS].sort((a, b) => a - b)).toEqual([...OBSERVATION_DELAYS_MS]);
  });
  it('stops at the first settled observation and never observes again', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const result = await observeUntilSettled(async () => ++n, value => value === 3, { sleep: async ms => { sleeps.push(ms); } });
    expect(result).toEqual({ value: 3, settled: true, observations: 3 });
    expect(sleeps).toEqual([2_000, 2_000]);
  });
  it('is bounded by the schedule and by its owner (an unmounted page stops asking)', async () => {
    let n = 0;
    const bounded = await observeUntilSettled(async () => ++n, () => false, { delays: [1, 1], sleep: async () => undefined });
    expect(bounded).toEqual({ value: 3, settled: false, observations: 3 });
    let alive = true, m = 0;
    const stopped = await observeUntilSettled(async () => { if (++m === 2) alive = false; return m; }, () => false, { sleep: async () => undefined, active: () => alive });
    expect(stopped.observations).toBe(2);
  });
  it('a failed observation ends the loop with its error (no hidden retry)', async () => {
    let n = 0;
    await expect(observeUntilSettled(async () => { n++; throw new Error('PUBLIC_RPC_UNAVAILABLE'); }, () => false, { sleep: async () => undefined })).rejects.toThrow('PUBLIC_RPC_UNAVAILABLE');
    expect(n).toBe(1);
  });
  it('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: a bounded observation that never answers ends the follow with OBSERVATION_TIMEOUT', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const follow = observeUntilSettled(() => { calls++; return new Promise<never>(() => undefined); }, () => false, { timeoutMs: OBSERVATION_TIMEOUT_MS });
      const outcome = expect(follow).rejects.toThrow('OBSERVATION_TIMEOUT');
      await vi.advanceTimersByTimeAsync(OBSERVATION_TIMEOUT_MS + 1);
      await outcome;
      expect(calls).toBe(1);
      expect(OBSERVATION_TIMEOUT_MS).toBe(30_000);
    } finally { vi.useRealTimers(); }
  });
  it('without a bound an observation is awaited as before; a timely answer is never cut short', async () => {
    const outcome = await observeUntilSettled(async () => 'done', value => value === 'done', { timeoutMs: 1_000 });
    expect(outcome).toEqual({ value: 'done', settled: true, observations: 1 });
  });
});
