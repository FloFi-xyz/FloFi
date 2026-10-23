// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: workflow runs on a worker process (`backend/main.ts worker` with FLOFI_WORKFLOW_RUNS=enabled). The `workflow-run.advance`
 * handler observes in-flight owner-signed steps through the worker's own flow services (read-only, as the step's wallet) and mirrors delegated
 * executions into their runs; it never signs or submits, and it never makes a step READY (that needs the requester surface's own policy, so it
 * happens when the owner continues in FloFi). The sweep expires runs that never started and re-arms open runs whose work item is missing.
 */
import type { Database, Logger, WorkHandler } from '@defi-workflow-engine/cloud-runtime';
import { createPgDelegationStore } from '../delegation/pg-store.ts';
import type { McpRuntime as EngineRuntime } from '../mcp/runtime.ts';
import { createPgWorkflowRunStore, type WorkflowRunStore } from './pg-store.ts';
import { advanceRun, type RunnerDeps } from './runner.ts';
import { WORKFLOW_RUN_ADVANCE_KIND } from './state-machine.ts';

type Env = Readonly<Record<string, string | undefined>>;
const RUN_ID = /^wfr_[a-z2-7]{26}$/;
export const WORKFLOW_RUN_WORK_KINDS = Object.freeze([WORKFLOW_RUN_ADVANCE_KIND] as const);

/** The advance handler: at-least-once, idempotent; a wait is a retry of the same item, an owner wait completes it (the owner's action re-arms). */
export function workflowRunHandlers(deps: RunnerDeps): Record<(typeof WORKFLOW_RUN_WORK_KINDS)[number], WorkHandler> {
  return {
    [WORKFLOW_RUN_ADVANCE_KIND]: async (item, settle) => {
      const runId = item.payload.runId;
      if (typeof runId !== 'string' || !RUN_ID.test(runId)) { await settle({ outcome: 'DEAD', reason: 'WORK_PAYLOAD_INVALID' }); return; }
      const result = await advanceRun(deps, runId);
      deps.log('workflow_run.advanced', { run: runId, state: result.state, code: result.code });
      await settle(result.retryMs === null ? { outcome: 'DONE' } : { outcome: 'RETRY', delayMs: result.retryMs, reason: 'WORKFLOW_RUN_WAITING' });
    },
  };
}

/** Expires runs that never started and re-arms open runs without a pending advance item (defense in depth after a crash). */
export async function sweepWorkflowRuns(store: WorkflowRunStore, db: Database, tenantId: string, now: Date): Promise<{ readonly expired: number; readonly rearmed: number }> {
  const expired = (await db.query(`SELECT run_id, version FROM workflow_runs WHERE tenant_id = $1 AND state = 'PENDING' AND expires_at <= $2 LIMIT 100`, [tenantId, now])).rows;
  let n = 0;
  for (const row of expired) if (await store.transition(String(row.run_id), { version: Number(row.version), from: ['PENDING'] }, 'EXPIRED', { code: 'WORKFLOW_RUN_EXPIRED' })) n++;
  const open = await store.openWithoutWork(100);
  for (const runId of open) await store.advanceLater(runId);
  return { expired: n, rearmed: open.length };
}

export type WorkflowRunWorkerParts = { readonly handlers: Readonly<Record<string, WorkHandler>>; readonly sweep: () => Promise<unknown> };
export function workflowRunWorkerParts(env: Env, db: Database, tenantId: string, logger: Logger, runtime: EngineRuntime):
  WorkflowRunWorkerParts | { readonly disabled: string; readonly reason: string | null } {
  if (env.FLOFI_WORKFLOW_RUNS !== 'enabled') return { disabled: 'WORKFLOW_RUNS_NOT_ENABLED', reason: null };
  const store = createPgWorkflowRunStore(db, tenantId);
  const delegation = env.FLOFI_DELEGATION === 'enabled' ? createPgDelegationStore(db, tenantId) : null;
  const deps: RunnerDeps = { store, runtime, delegation, policyFor: () => null, now: () => new Date(), log: (event, fields) => logger.info(event, fields) };
  return { handlers: workflowRunHandlers(deps), sweep: () => sweepWorkflowRuns(store, db, tenantId, new Date()) };
}
