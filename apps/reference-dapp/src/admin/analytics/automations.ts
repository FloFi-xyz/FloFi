// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: automation and delegated-execution metrics, classified by their own state machines (migrations 0010/0011) — never by
 * UI labels. Rule states and open items are current snapshots; evaluations, occurrences and delegated executions are counted in the range.
 * Delegated executions are their own records: they are never added to the standard execution totals (no double count). No owner address
 * leaves this module.
 *
 * Proposal → execution: an owner-confirmed proposal becomes a standard execution through the shared approval handoff (`mcp_handoffs`). FloFi
 * links a run to the handoff (`run_ids`) only after verifying it is the claimant's own run, started after the claim, that reviewed exactly
 * the proposed workflow (`platform/approvals.ts` `sharedRuns`), and it records the link when the owner reopens the occurrence. Linked
 * executions are therefore a verified lower bound, and approval handoffs are deleted after 30 days, so older links are gone: both are
 * reported. These executions are owner-signed standard executions, already in the Overview totals.
 */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { ENVIRONMENTS, type AnalyticsEnvironment } from './networks.ts';
import { executionsOf, loadRunsById } from './workflows.ts';

/** How long the scheduler keeps evaluation history (`automations/pg-store.ts` purge) and the platform keeps approval handoffs. */
export const EVALUATION_RETENTION_DAYS = 90, HANDOFF_RETENTION_DAYS = 30;

/** Evaluation outcomes that are the scheduler working as designed; anything else in the range is surfaced as an automation issue. */
export const ROUTINE_EVALUATIONS = new Set(['TRIGGERED', 'WATCH_REPORTED', 'CONDITION_NOT_MET', 'CONDITION_STILL_MET', 'COOLDOWN', 'REARMED', 'MISSED', 'LIMIT_BLOCKED',
  'DONE', 'APPROVAL_APPLIED', 'OCCURRENCE_EXPIRED']);
export const DELEGATED_GROUPS: Readonly<Record<string, 'COMPLETED' | 'BLOCKED' | 'FAILED' | 'UNCERTAIN' | 'HALTED' | 'IN_PROGRESS'>> = {
  SETTLED: 'COMPLETED', BLOCKED: 'BLOCKED', FAILED: 'FAILED', UNCERTAIN: 'UNCERTAIN', HALTED: 'HALTED',
  QUEUED: 'IN_PROGRESS', AUTHORITY_VERIFIED: 'IN_PROGRESS', RESERVED: 'IN_PROGRESS', RUNNING: 'IN_PROGRESS' };
type Count = { readonly key: string; readonly count: number };
export type AutomationAnalytics = {
  readonly installed: boolean;
  readonly rules: { readonly byState: readonly Count[]; readonly byKind: readonly Count[]; readonly byMode: readonly Count[]; readonly createdInRange: number;
    readonly needRebind: number };
  readonly evaluations: { readonly total: number; readonly byOutcome: readonly Count[] };
  readonly occurrences: { readonly created: number; readonly byState: readonly Count[]; readonly pendingOwnerNow: number };
  readonly notifications: readonly Count[];
  readonly delegated: { readonly installed: boolean; readonly created: number; readonly byGroup: readonly Count[]; readonly byState: readonly Count[];
    readonly stepsByState: readonly Count[]; readonly stepsByChain: readonly Count[]; readonly openNow: number; readonly attentionNow: number;
    readonly activeAuthorizations: number };
  readonly issues: readonly { readonly source: 'EVALUATION' | 'DELEGATED_EXECUTION'; readonly code: string; readonly count: number; readonly lastAt: string }[];
  readonly proposals: { readonly withApproval: number; readonly applied: number; readonly approvalDeleted: number; readonly linkedExecutions: number;
    readonly linkedCompleted: number; readonly linkedByEnvironment: Readonly<Record<AnalyticsEnvironment, number>> };
  /** Evaluations before this instant were already deleted by the scheduler's retention (null: the range is fully retained). */
  readonly evaluationsRetainedFrom: string | null;
};

const counts = (rows: readonly { key: string; n: string }[]): Count[] => rows.map(row => ({ key: row.key, count: Number(row.n) })).sort((a, b) => b.count - a.count);
async function installed(db: Database, table: string): Promise<boolean> {
  return (await db.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`])).rows[0]?.ok === true;
}

export async function automationAnalytics(db: Database, tenantId: string, range: { readonly from: Date; readonly to: Date }, now: Date): Promise<AutomationAnalytics> {
  const q = async (sql: string, extra: unknown[] = []) => counts((await db.query<{ key: string; n: string }>(sql, [tenantId, ...extra])).rows);
  const one = async (sql: string, extra: unknown[] = []) => Number((await db.query<{ n: string }>(sql, [tenantId, ...extra])).rows[0]?.n ?? 0);
  const inRange = [range.from, range.to];
  const empty = { byState: [], byKind: [], byMode: [], createdInRange: 0, needRebind: 0 };
  const noEnvironments = Object.fromEntries(ENVIRONMENTS.map(env => [env, 0])) as Record<AnalyticsEnvironment, number>;
  const retainedFrom = new Date(now.getTime() - EVALUATION_RETENTION_DAYS * 86_400_000);
  const evaluationsRetainedFrom = range.from < retainedFrom ? retainedFrom.toISOString() : null;
  if (!await installed(db, 'automation_rules')) return { installed: false, rules: empty, evaluations: { total: 0, byOutcome: [] },
    occurrences: { created: 0, byState: [], pendingOwnerNow: 0 }, notifications: [], issues: [], evaluationsRetainedFrom,
    proposals: { withApproval: 0, applied: 0, approvalDeleted: 0, linkedExecutions: 0, linkedCompleted: 0, linkedByEnvironment: noEnvironments },
    delegated: { installed: false, created: 0, byGroup: [], byState: [], stepsByState: [], stepsByChain: [], openNow: 0, attentionNow: 0, activeAuthorizations: 0 } };
  const [byState, byKind, byMode, createdInRange, needRebind, evaluations, occurrences, pendingOwnerNow, notifications] = await Promise.all([
    q(`SELECT state AS key, count(*)::text AS n FROM automation_rules WHERE tenant_id = $1 GROUP BY state`),
    q(`SELECT kind AS key, count(*)::text AS n FROM automation_rules WHERE tenant_id = $1 AND state IN ('ACTIVE', 'PAUSED') GROUP BY kind`),
    q(`SELECT execution_mode AS key, count(*)::text AS n FROM automation_rules WHERE tenant_id = $1 AND state IN ('ACTIVE', 'PAUSED') GROUP BY execution_mode`),
    one(`SELECT count(*)::text AS n FROM automation_rules WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`, inRange),
    one(`SELECT count(*)::text AS n FROM automation_rules WHERE tenant_id = $1 AND state IN ('ACTIVE', 'PAUSED') AND attention IS NOT NULL`),
    q(`SELECT outcome AS key, count(*)::text AS n FROM automation_evaluations WHERE tenant_id = $1 AND at >= $2 AND at < $3 GROUP BY outcome`, inRange),
    q(`SELECT state AS key, count(*)::text AS n FROM automation_occurrences WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY state`, inRange),
    one(`SELECT count(*)::text AS n FROM automation_occurrences WHERE tenant_id = $1 AND state IN ('PENDING_OWNER', 'APPROVAL_CREATED') AND expires_at > $2`, [now]),
    q(`SELECT n.channel || ':' || n.status AS key, count(*)::text AS n FROM automation_notifications n WHERE n.tenant_id = $1 AND n.updated_at >= $2 AND n.updated_at < $3
      GROUP BY n.channel, n.status`, inRange),
  ]);
  const evaluationIssues = (await db.query<{ code: string; n: string; last: Date }>(`SELECT outcome AS code, count(*)::text AS n, max(at) AS last FROM automation_evaluations
    WHERE tenant_id = $1 AND at >= $2 AND at < $3 AND NOT (outcome = ANY($4::text[])) GROUP BY outcome ORDER BY max(at) DESC LIMIT 20`,
  [tenantId, ...inRange, [...ROUTINE_EVALUATIONS]])).rows.map(row => ({ source: 'EVALUATION' as const, code: row.code, count: Number(row.n), lastAt: row.last.toISOString() }));

  const delegatedInstalled = await installed(db, 'delegated_executions');
  let delegated: AutomationAnalytics['delegated'] = { installed: false, created: 0, byGroup: [], byState: [], stepsByState: [], stepsByChain: [], openNow: 0, attentionNow: 0,
    activeAuthorizations: 0 };
  let delegatedIssues: AutomationAnalytics['issues'] = [];
  if (delegatedInstalled) {
    const [byStateD, steps, chains, openNow, attentionNow, activeAuthorizations] = await Promise.all([
      q(`SELECT state AS key, count(*)::text AS n FROM delegated_executions WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY state`, inRange),
      q(`SELECT s.state AS key, count(*)::text AS n FROM delegated_execution_steps s JOIN delegated_executions e USING (tenant_id, execution_id)
        WHERE s.tenant_id = $1 AND e.created_at >= $2 AND e.created_at < $3 GROUP BY s.state`, inRange),
      q(`SELECT s.chain AS key, count(*)::text AS n FROM delegated_execution_steps s JOIN delegated_executions e USING (tenant_id, execution_id)
        WHERE s.tenant_id = $1 AND e.created_at >= $2 AND e.created_at < $3 AND s.state IN ('SUBMITTED', 'RECONCILED', 'UNCERTAIN', 'REVERTED') GROUP BY s.chain`, inRange),
      one(`SELECT count(*)::text AS n FROM delegated_executions WHERE tenant_id = $1 AND state NOT IN ('SETTLED', 'BLOCKED', 'FAILED')`),
      one(`SELECT count(*)::text AS n FROM delegated_executions WHERE tenant_id = $1 AND (attention OR state IN ('UNCERTAIN', 'HALTED'))`),
      one(`SELECT count(*)::text AS n FROM delegated_authorizations WHERE tenant_id = $1 AND state = 'ACTIVE'`),
    ]);
    const groups = new Map<string, number>();
    for (const row of byStateD) { const group = DELEGATED_GROUPS[row.key] ?? 'UNCLASSIFIED'; groups.set(group, (groups.get(group) ?? 0) + row.count); }
    delegated = { installed: true, created: byStateD.reduce((n, row) => n + row.count, 0), byGroup: [...groups.entries()].map(([key, count]) => ({ key, count })),
      byState: byStateD, stepsByState: steps, stepsByChain: chains, openNow, attentionNow, activeAuthorizations };
    delegatedIssues = (await db.query<{ code: string; n: string; last: Date }>(`SELECT code, count(*)::text AS n, max(updated_at) AS last FROM delegated_executions
      WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3 AND code IS NOT NULL AND state IN ('BLOCKED', 'FAILED', 'UNCERTAIN', 'HALTED')
      GROUP BY code ORDER BY max(updated_at) DESC LIMIT 20`, [tenantId, ...inRange])).rows
      .map(row => ({ source: 'DELEGATED_EXECUTION' as const, code: row.code, count: Number(row.n), lastAt: row.last.toISOString() }));
  }
  // Owner-confirmed proposals in range → their approval handoff → the runs FloFi verified as started from it.
  const linked = (await db.query<{ with_approval: number; applied: number; deleted: number; runs: string[] }>(`SELECT count(DISTINCT o.occurrence_id)::int AS with_approval,
      count(DISTINCT o.occurrence_id) FILTER (WHERE o.state = 'COMPLETED' OR h.status = 'APPLIED')::int AS applied,
      count(DISTINCT o.occurrence_id) FILTER (WHERE o.state = 'COMPLETED' AND h.handoff_id IS NULL)::int AS deleted,
      coalesce(array_agg(DISTINCT r.run_id) FILTER (WHERE r.run_id IS NOT NULL), '{}') AS runs
    FROM automation_occurrences o LEFT JOIN mcp_handoffs h ON h.tenant_id = o.tenant_id AND h.handoff_id = o.handoff_id
      LEFT JOIN LATERAL unnest(CASE WHEN h.status = 'APPLIED' THEN h.run_ids END) AS r(run_id) ON true
    WHERE o.tenant_id = $1 AND o.handoff_id IS NOT NULL AND o.created_at >= $2 AND o.created_at < $3`, [tenantId, ...inRange])).rows[0]!;
  const linkedExecutions = executionsOf(await loadRunsById(db, tenantId, linked.runs)).filter(e => e.executed);
  const proposals = { withApproval: linked.with_approval, applied: linked.applied, approvalDeleted: linked.deleted, linkedExecutions: linkedExecutions.length,
    linkedCompleted: linkedExecutions.filter(e => e.classification.outcome === 'COMPLETED').length,
    linkedByEnvironment: Object.fromEntries(ENVIRONMENTS.map(env => [env, linkedExecutions.filter(e => e.environment === env).length])) as Record<AnalyticsEnvironment, number> };
  return { installed: true, rules: { byState, byKind, byMode, createdInRange, needRebind }, proposals, evaluationsRetainedFrom,
    evaluations: { total: evaluations.reduce((n, row) => n + row.count, 0), byOutcome: evaluations },
    occurrences: { created: occurrences.reduce((n, row) => n + row.count, 0), byState: occurrences, pendingOwnerNow }, notifications,
    delegated, issues: [...evaluationIssues, ...delegatedIssues].sort((a, b) => b.lastAt.localeCompare(a.lastAt)) };
}
