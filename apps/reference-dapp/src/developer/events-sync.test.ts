// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-E2E-RELIABILITY-001 (workflow review): a developer approval whose run read failed never settles — its run events are synced on a
 * later sweep instead of being lost once the watch window has passed. In-memory doubles; nothing reaches a network or a database.
 */
import { describe, expect, it, vi } from 'vitest';
import { APPLIED_WATCH_MS, syncDeveloperApprovals } from './events';
import type { DeveloperStore } from './store';
import type { EngineRuntime, HandoffRecord, HandoffStore } from '../platform/index.ts';

const now = new Date('2026-11-02T12:00:00.000Z'), owner = '0x' + '1'.repeat(40);
const handoff = { handoffId: 'apr_test', status: 'APPLIED', shareStatus: true, claimed: { namespace: 'eip155', address: owner },
  claimedAt: new Date(now.getTime() - APPLIED_WATCH_MS - 60_000), appliedAt: new Date(now.getTime() - APPLIED_WATCH_MS - 1_000), plan: { flow: 'base-swap', steps: [] },
  runIds: [], workflowHash: 'sha256:' + 'a'.repeat(64) } as unknown as HandoffRecord;
function deps(runs: EngineRuntime['runs']) {
  const markSynced = vi.fn(async () => undefined);
  const store = { approvalsToSync: async () => [{ handoffId: 'apr_test', projectId: 'p', environment: 'live', strategyId: 's' }],
    recordEvents: async () => [], incrementUsage: async () => undefined, markSynced } as unknown as DeveloperStore;
  const handoffs = { forRequester: async () => handoff, bindRuns: async () => undefined } as unknown as HandoffStore;
  const runtime = { runs, run: async () => ({ ok: true, value: null }), record: async () => ({ ok: true, value: null }), evidence: async () => ({ ok: true, value: null }) } as unknown as EngineRuntime;
  return { deps: { store, handoffs, runtime, now }, markSynced };
}
describe('BUILD-FLOFI-E2E-RELIABILITY-001 developer approval sync', () => {
  it('a failed run read keeps the approval open past its watch window; a successful read lets it settle', async () => {
    const failing = deps(async () => ({ ok: false, code: 'CLOUD_RUNTIME_UNAVAILABLE' }));
    await syncDeveloperApprovals(failing.deps, {} as never, 10);
    expect(failing.markSynced).toHaveBeenCalledWith('apr_test', false, now);
    const reading = deps(async () => ({ ok: true, value: [] }));
    await syncDeveloperApprovals(reading.deps, {} as never, 10);
    expect(reading.markSynced).toHaveBeenCalledWith('apr_test', true, now);
  });
});
