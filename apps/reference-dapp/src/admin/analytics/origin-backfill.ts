// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (KAN-25): the audited, idempotent recovery of execution origins for history written before
 * migration 0037, and explicitly approved corrections. Dry run by default; `apply` writes only `execution_origins` rows that do not exist yet
 * (first record wins) plus one audit event. It never changes an execution, its evidence, its amounts or its timestamps, never submits or replays
 * anything, and never creates a fee obligation (the fee ledger only accrues executions created after its own activation).
 *
 * Evidence rules for a root single-flow run without a recorded origin (public network runs only; steps of a workflow run are not executions):
 *   BOUND          approvals bound the run (`mcp_handoffs.run_ids`) and all of them name one origin: that origin.
 *   NO_APPROVAL    every single-flow run is created by the flow runtime, which only FloFi's /app page and approval pages reach (native signing binds
 *                  its run at once; Developer API live steps run under `wfr_…-step-N`; automations write delegated executions). An approval page
 *                  only executes a claimed approval. So when no MCP, channel, developer or automation approval was claimed by the run's owner for
 *                  the run's flow before the run started, no approval page created it: Legacy Web (Chat and the Editor cannot be told apart).
 *                  This needs the approval history to be complete over the window: only runs created at or after `approvalsCompleteSince` are
 *                  recovered, and that instant must not precede the oldest retained approval (age-based retention removes the oldest first).
 *   AMBIGUOUS      such an approval exists but never bound the run: stays Unknown origin (never guessed).
 */
import { createHash } from 'node:crypto';
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { typedId } from '../../platform/ids.ts';
import { isExecutionOrigin, originOfRequester, revenueOriginsActive, type ExecutionOrigin } from '../../workflow-runs/execution-origins.ts';
import { recordAudit } from '../store.ts';

export type BackfillClass = 'BOUND' | 'NO_APPROVAL' | 'AMBIGUOUS' | 'CONFLICTING_BINDINGS' | 'BEFORE_COMPLETE_HISTORY';
export type OriginBackfill = {
  readonly mode: 'DRY_RUN' | 'APPLY';
  /** Root single-flow runs without a recorded origin that were examined. */
  readonly investigated: number;
  readonly byClass: Readonly<Record<BackfillClass, number>>;
  /** What each class resolves to (dry run: would record; apply: recorded now). */
  readonly byOrigin: Readonly<Partial<Record<ExecutionOrigin, number>>>;
  readonly recorded: number;
  readonly remainingUnknown: number;
  readonly approvalsCompleteSince: string | null;
  readonly oldestRetainedApproval: string | null;
  readonly truncated: boolean;
  readonly note: string;
};
const APPROVAL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;
const REASON = /^[A-Z][A-Z0-9_]{2,63}$/;
const LIMIT = 5_000;
/**
 * How long after its creation an approval can still produce a run. flofi-admin-analytics review: an APPLIED approval never lapses and can be reloaded
 * until retention removes it (30 days, `HandoffStore.purge`), so a removed approval can have produced runs for up to 30 days: only runs created at
 * least 31 days after the oldest retained approval are provably approval-free. When the operator asserts (audited) that no approval was ever removed,
 * the bound is the claim lifetime (pending 900 s + claimed 600 s, `platform/approvals.ts`) plus a day.
 */
export const APPROVAL_RUN_HORIZON_MS = 31 * 86_400_000;
export const UNPURGED_APPROVAL_RUN_HORIZON_MS = 86_400_000 + (900 + 600) * 1000;

type Row = { run_id: string; created_at: Date; bound: { kind: string; client: string }[] | null; candidates: number };

/** Dry run (no `apply`) or apply. `approvalsCompleteSince` is required to recover NO_APPROVAL runs; without it they are reported only. */
export async function originBackfill(host: { readonly db: Database; readonly tenantId: string }, input: {
  readonly approvalsCompleteSince?: Date; readonly now: Date;
  /** The operator's audited statement that no approval was ever removed (retention never ran): the short horizon applies. */
  readonly approvalsNeverPurged?: boolean;
  readonly apply?: { readonly approvalRef: string; readonly actor: 'cli' };
}): Promise<OriginBackfill> {
  if (!await revenueOriginsActive(host.db)) throw new Error('EXECUTION_ORIGINS_NOT_MIGRATED');
  if (input.apply && !APPROVAL.test(input.apply.approvalRef)) throw new Error('ORIGIN_BACKFILL_APPROVAL_REQUIRED');
  const since = input.approvalsCompleteSince ?? null;
  if (since && !Number.isFinite(since.getTime())) throw new Error('ORIGIN_BACKFILL_REQUEST_INVALID');
  const oldest = (await host.db.query<{ at: Date | null }>('SELECT min(created_at) AS at FROM mcp_handoffs WHERE tenant_id = $1', [host.tenantId])).rows[0]?.at ?? null;
  // The completeness claim cannot reach back before the oldest approval retention left in place, and with no approval retained nothing is proven.
  if (since && (!oldest || since.getTime() < oldest.getTime())) throw new Error('ORIGIN_BACKFILL_HISTORY_INCOMPLETE');
  const horizon = input.approvalsNeverPurged === true ? UNPURGED_APPROVAL_RUN_HORIZON_MS : APPROVAL_RUN_HORIZON_MS;
  const provable = since && oldest ? Math.max(since.getTime(), oldest.getTime() + horizon) : null;
  const { rows } = await host.db.query<Row>(`
    WITH roots AS (
      SELECT r.tenant_id, r.run_id, r.flow, lower(r.owner_account) AS owner, r.created_at FROM execution_runs r
      WHERE r.tenant_id = $1 AND r.provenance IN ('PUBLIC_MAINNET', 'PUBLIC_TESTNET') AND r.recovery_of IS NULL AND r.workflow_id !~ '^wfr_'
        AND NOT EXISTS (SELECT 1 FROM execution_origins o WHERE o.tenant_id = r.tenant_id AND o.run_id = r.run_id)
        AND NOT EXISTS (SELECT 1 FROM workflow_run_steps s WHERE s.tenant_id = r.tenant_id AND s.outcome->>'executionId' = r.run_id))
    SELECT ro.run_id, ro.created_at,
      (SELECT jsonb_agg(DISTINCT jsonb_build_object('kind', h.requester_kind, 'client', h.client_id)) FROM mcp_handoffs h
        WHERE h.tenant_id = ro.tenant_id AND ro.run_id = ANY (h.run_ids)) AS bound,
      (SELECT count(*)::int FROM mcp_handoffs h WHERE h.tenant_id = ro.tenant_id AND h.requester_kind <> 'EDITOR_SESSION' AND h.claimed_at IS NOT NULL
        AND h.claimed_at <= ro.created_at AND (ro.owner IS NULL OR lower(h.claimed_address) = ro.owner)
        AND (h.plan->>'flow' = ro.flow OR jsonb_path_exists(h.plan, '$.steps[*] ? (@.flow == $f)', jsonb_build_object('f', ro.flow)))) AS candidates
    FROM roots ro ORDER BY ro.created_at, ro.run_id LIMIT $2`, [host.tenantId, LIMIT + 1]);
  const truncated = rows.length > LIMIT;
  const byClass: Record<BackfillClass, number> = { BOUND: 0, NO_APPROVAL: 0, AMBIGUOUS: 0, CONFLICTING_BINDINGS: 0, BEFORE_COMPLETE_HISTORY: 0 };
  const byOrigin: Partial<Record<ExecutionOrigin, number>> = {};
  const plan: { runId: string; origin: ExecutionOrigin; evidence: string }[] = [];
  for (const row of rows.slice(0, LIMIT)) {
    const bound = [...new Set((row.bound ?? []).map(b => originOfRequester(b.kind, b.client)))];
    if (bound.length === 1) { byClass.BOUND++; plan.push({ runId: row.run_id, origin: bound[0]!, evidence: 'APPROVAL_RUN_BINDING' }); continue; }
    if (bound.length > 1) { byClass.CONFLICTING_BINDINGS++; continue; }
    if (row.candidates > 0) { byClass.AMBIGUOUS++; continue; }
    if (provable === null || row.created_at.getTime() < provable) { byClass.BEFORE_COMPLETE_HISTORY++; continue; }
    byClass.NO_APPROVAL++; plan.push({ runId: row.run_id, origin: 'legacy_web', evidence: 'NO_APPROVAL_COULD_CREATE_RUN' });
  }
  for (const p of plan) byOrigin[p.origin] = (byOrigin[p.origin] ?? 0) + 1;
  let recorded = 0;
  if (input.apply) {
    await host.db.transaction(async tx => {
      for (const p of plan) {
        const result = await tx.query(`INSERT INTO execution_origins (tenant_id, run_id, origin, basis, evidence) VALUES ($1, $2, $3, 'BACKFILL', $4)
          ON CONFLICT DO NOTHING`, [host.tenantId, p.runId, p.origin, p.evidence]);
        recorded += result.rowCount ?? 0;
      }
      await recordAudit(tx, host.tenantId, { actor: input.apply!.actor, kind: 'EXECUTION_ORIGINS_BACKFILLED', outcome: 'OK',
        target: 'approval:' + createHash('sha256').update(input.apply!.approvalRef).digest('hex').slice(0, 32),
        // Flat, closed facts only (the audit detail holds scalars): the counts per class and per recovered origin.
        detail: { recorded, truncated, approvalsCompleteSince: since?.toISOString() ?? null, approvalsNeverPurged: input.approvalsNeverPurged === true,
          ...Object.fromEntries(Object.entries(byClass).map(([k, v]) => ['class_' + k, v])),
          ...Object.fromEntries(Object.entries(byOrigin).map(([k, v]) => ['origin_' + k, v ?? 0])) } });
    });
  }
  const unresolved = byClass.AMBIGUOUS + byClass.CONFLICTING_BINDINGS + byClass.BEFORE_COMPLETE_HISTORY;
  return { mode: input.apply ? 'APPLY' : 'DRY_RUN', investigated: Math.min(rows.length, LIMIT), byClass, byOrigin, recorded, remainingUnknown: unresolved,
    approvalsCompleteSince: since?.toISOString() ?? null, oldestRetainedApproval: oldest?.toISOString() ?? null, truncated,
    note: 'Origins only: no execution, evidence, amount, timestamp or fee changes; nothing is submitted or replayed. Repeated runs record nothing twice.' };
}

/**
 * An explicitly approved correction of one single-flow run's origin (an audit trail; the recorded origin itself is never rewritten). A run with
 * no recorded origin gets one (basis BACKFILL, evidence APPROVED_CORRECTION) and the correction row records the change from Unknown.
 */
export async function correctOrigin(host: { readonly db: Database; readonly tenantId: string }, input: { readonly runId: string; readonly origin: string;
  readonly approvalRef: string; readonly reasonCode: string; readonly actor: 'cli' }): Promise<{ readonly previous: ExecutionOrigin | null; readonly origin: ExecutionOrigin }> {
  if (!await revenueOriginsActive(host.db)) throw new Error('EXECUTION_ORIGINS_NOT_MIGRATED');
  if (!isExecutionOrigin(input.origin) || !APPROVAL.test(input.approvalRef) || !REASON.test(input.reasonCode) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.runId))
    throw new Error('ORIGIN_CORRECTION_REQUEST_INVALID');
  const origin = input.origin;
  return host.db.transaction(async (tx: Queryable) => {
    const run = (await tx.query('SELECT 1 FROM execution_runs WHERE tenant_id = $1 AND run_id = $2 FOR SHARE', [host.tenantId, input.runId])).rows[0];
    if (!run) throw new Error('ORIGIN_CORRECTION_RUN_NOT_FOUND');
    const current = (await tx.query<{ origin: string }>(`SELECT coalesce((SELECT c.origin FROM execution_origin_corrections c WHERE c.tenant_id = o.tenant_id
      AND c.run_id = o.run_id ORDER BY c.created_at DESC, c.correction_id DESC LIMIT 1), o.origin) AS origin
      FROM execution_origins o WHERE o.tenant_id = $1 AND o.run_id = $2`, [host.tenantId, input.runId])).rows[0];
    const previous = current && isExecutionOrigin(current.origin) ? current.origin : null;
    if (!current) await tx.query(`INSERT INTO execution_origins (tenant_id, run_id, origin, basis, evidence) VALUES ($1, $2, 'unknown', 'BACKFILL', 'APPROVED_CORRECTION')`,
      [host.tenantId, input.runId]);
    await tx.query(`INSERT INTO execution_origin_corrections (tenant_id, correction_id, run_id, origin, previous_origin, approval_ref, reason_code)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`, [host.tenantId, typedId('eoc'), input.runId, origin, previous, input.approvalRef, input.reasonCode]);
    await recordAudit(tx, host.tenantId, { actor: input.actor, kind: 'EXECUTION_ORIGIN_CORRECTED', outcome: 'OK', target: input.runId,
      detail: { previous, origin, reasonCode: input.reasonCode } });
    return { previous, origin };
  });
}
