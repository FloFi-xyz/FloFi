// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (EXEC-02): the settling bridge re-reads its durable record (a status read, never an observation) on a
 * modest cadence while visible, follows the worker's reconciliation, discards a late answer, and stops once the run is final.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookHarness, deferred } from '../test-utils/hook-harness';
import { useSettlementSync } from './settlement-sync';
import { SETTLEMENT_SYNC_MS, type SettlementRecord } from '../domain/settlement-sync';
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));

type Run = SettlementRecord & { owner: string };
const run = (over: Partial<Run> = {}): Run => ({ id: 'xroute-1', owner: '0xowner', verdict: 'PENDING', phase: 'IN_FLIGHT', source: { safe: true }, destination: null, ...over });
let host: HookHarness, doc: EventTarget & { visibilityState: string };
let state: { record: Run | null; busy: boolean; epoch: number; accepted: Run[] };
type Read = (shown: Run) => Promise<{ ok: true; value: Run } | { ok: false }>;
let read: ReturnType<typeof vi.fn<Read>>;
const mount = () => host.render(() => useSettlementSync<Run>({ record: state.record, busy: () => state.busy, epoch: () => state.epoch, visible: () => state.record?.id,
  read: shown => read(shown), accept: value => { state.accepted.push(value); state.record = value; } }));
const tick = async (ms = SETTLEMENT_SYNC_MS) => { await vi.advanceTimersByTimeAsync(ms); mount(); };

beforeEach(() => {
  vi.useFakeTimers(); host = new HookHarness();
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('document', doc); vi.stubGlobal('window', { setInterval, clearInterval });
  state = { record: run(), busy: false, epoch: 0, accepted: [] };
  read = vi.fn<Read>(async () => ({ ok: true as const, value: run({ phase: 'DESTINATION_OBSERVED', destination: { safe: false } }) }));
});
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('settlement sync', () => {
  it('re-reads every 15 s while settling and adopts the worker’s progress, then stops once final', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(SETTLEMENT_SYNC_MS - 1); expect(read).not.toHaveBeenCalled();
    await tick(1);
    expect(read).toHaveBeenCalledTimes(1); expect(state.accepted.map(r => r.phase)).toEqual(['DESTINATION_OBSERVED']);
    read.mockResolvedValueOnce({ ok: true, value: run({ phase: 'RECONCILED', verdict: 'RECONCILED', destination: { safe: true } }) });
    await tick();
    expect(state.accepted.at(-1)).toMatchObject({ phase: 'RECONCILED', verdict: 'RECONCILED' });
    await tick(); await tick();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('never reads before the deposit settles, nor while hidden or busy; a visible page reads once on return', async () => {
    state.record = run({ phase: 'AUTHORIZED' }); mount(); await tick(); expect(read).not.toHaveBeenCalled();
    state.record = run(); mount();
    doc.visibilityState = 'hidden'; await tick(); expect(read).not.toHaveBeenCalled();
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    state.busy = true; await tick(); expect(read).toHaveBeenCalledTimes(1);
  });
  it('discards an answer that arrives after another operation or run, and one that would move the run back', async () => {
    const late = deferred<{ ok: true; value: Run }>();
    read.mockReturnValueOnce(late.promise);
    mount(); await tick();
    state.epoch++; // e.g. the owner pressed "Check status" and its observation answered first
    late.resolve({ ok: true, value: run({ phase: 'DESTINATION_OBSERVED', destination: { safe: false } }) }); await vi.advanceTimersByTimeAsync(0);
    expect(state.accepted).toEqual([]);
    state.record = run({ phase: 'DESTINATION_OBSERVED', destination: { safe: true } }); mount();
    read.mockResolvedValueOnce({ ok: true, value: run({ phase: 'IN_FLIGHT' }) });
    await tick(); expect(state.accepted).toEqual([]);
    read.mockResolvedValueOnce({ ok: false }); await tick(); expect(state.accepted).toEqual([]);
  });
});
