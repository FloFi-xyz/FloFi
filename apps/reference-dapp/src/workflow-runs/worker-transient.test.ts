// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PR #254 follow-up (bridge reconciliation within multi-step workflows): a workflow run's advance that throws for a moment (a bridge delivery read,
 * the database) is retried within a minute inside the settlement window, never after the generic doubling backoff that reaches ten minutes;
 * past the window the worker's own backoff and budget apply unchanged. The handler is the real one; only its store fails.
 */
import { describe, expect, it, vi } from 'vitest';
import { backoffMs, type WorkItem } from '@defi-workflow-engine/cloud-runtime';
import { workflowRunHandlers } from './worker.ts';
import { ADVANCE_TRANSIENT_RETRY_MS, ADVANCE_TRANSIENT_WINDOW_MS, WORKFLOW_RUN_ADVANCE_KIND } from './state-machine.ts';
import type { RunnerDeps } from './runner.ts';

const RUN = 'wfr_' + 'a'.repeat(26);
const createdAt = new Date('2026-11-26T01:00:00Z');
const item = (deliveries: number): WorkItem => ({ id: 'w1', tenantId: 'default', kind: WORKFLOW_RUN_ADVANCE_KIND, dedupeKey: RUN, runId: RUN, payload: { runId: RUN },
  deliveries, leaseToken: 'l', traceParent: null, createdAt });
function handler(at: number, failure: Error) {
  const log = vi.fn();
  const deps = { store: { byId: async () => { throw failure; } }, runtime: null, delegation: null, policyFor: () => null,
    now: () => new Date(createdAt.getTime() + at), log } as unknown as RunnerDeps;
  return { handle: workflowRunHandlers(deps)[WORKFLOW_RUN_ADVANCE_KIND], log };
}

describe('workflow-run advance: transient failures inside the settlement window', () => {
  it('retries within a minute however many deliveries the item already had (never the ten-minute backoff), with a closed code only', async () => {
    for (const deliveries of [1, 6, 12, 40]) {
      const { handle, log } = handler(7 * 60_000, new Error('USER_FUNDED_RPC_UNAVAILABLE')), settle = vi.fn(async () => true);
      await handle(item(deliveries), settle, undefined as never);
      expect(settle).toHaveBeenCalledOnce();
      const settled = (settle.mock.calls[0] as unknown as [{ outcome: string; delayMs: number; reason: string }])[0];
      expect(settled).toMatchObject({ outcome: 'RETRY', reason: 'USER_FUNDED_RPC_UNAVAILABLE' });
      expect(settled.delayMs).toBeLessThanOrEqual(ADVANCE_TRANSIENT_RETRY_MS);
      // The generic worker would have waited the doubling backoff instead (ten minutes once the item had a dozen deliveries).
      if (deliveries >= 12) expect(backoffMs(deliveries, () => 0.5)).toBe(600_000);
      expect(log).toHaveBeenCalledWith('workflow_run.advance_failed', { run: RUN, code: 'USER_FUNDED_RPC_UNAVAILABLE' });
    }
    // Provider or library text is never recorded: an unclassified failure is a closed code.
    const { handle, log } = handler(60_000, new Error('fetch failed: ECONNRESET 10.0.0.1')), settle = vi.fn(async () => true);
    await handle(item(3), settle, undefined as never);
    expect(log).toHaveBeenCalledWith('workflow_run.advance_failed', { run: RUN, code: 'WORKFLOW_RUN_ADVANCE_FAILED' });
  });
  it('past the window the failure is the worker\'s again (its backoff and observation budget, unchanged)', async () => {
    const { handle } = handler(ADVANCE_TRANSIENT_WINDOW_MS, new Error('USER_FUNDED_RPC_UNAVAILABLE')), settle = vi.fn(async () => true);
    await expect(handle(item(12), settle, undefined as never)).rejects.toThrow('USER_FUNDED_RPC_UNAVAILABLE');
    expect(settle).not.toHaveBeenCalled();
  });
});
