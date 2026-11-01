// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OBSERVATION_DELAYS_MS, observeUntilSettled } from './observation-schedule';

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
});
