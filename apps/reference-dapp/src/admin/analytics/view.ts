// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: what an analytics page loads for one filter set. A small, time-bounded indexing pass first brings the facts cache up
 * to date for the range (off the execution path; what remains is reported), then one bounded read of the range is folded into
 * executions and summarized. Read failures are returned as closed codes; nothing is estimated. What the figures leave out (delegated
 * executions, a truncated range, unindexed records) is returned with them so every page can say so.
 */
import type { AdminHost } from '../host.ts';
import { indexRunFacts, type IndexSummary } from './indexer.ts';
import { analyticsRange, defaultEnvironment, environmentOfFilter, executionsOf, kindOfFilter, loadRuns, outcomeOfFilter, summarize, type AnalyticsRange, type Execution,
  type OutcomeFilter, type WorkflowAnalytics } from './workflows.ts';
import type { ActionKind } from './actions.ts';
import type { AnalyticsEnvironment } from './networks.ts';

export type AnalyticsParams = { readonly range?: string; readonly from?: string; readonly to?: string; readonly env?: string; readonly action?: string; readonly outcome?: string };
export type WorkflowView = { readonly ok: true; readonly range: AnalyticsRange; readonly environment: AnalyticsEnvironment; readonly environmentDefaulted: boolean;
  readonly action: ActionKind | 'ALL'; readonly outcome: OutcomeFilter; readonly indexing: IndexSummary | null; readonly indexingCode: string | null;
  readonly analytics: WorkflowAnalytics; readonly executions: readonly Execution[]; readonly savedInRange: number | null;
  /** Delegated (automation) executions created in the range: separate records, never in these figures. null: could not be counted. */
  readonly delegatedInRange: number | null } | { readonly ok: false; readonly code: string };

export const INDEX_BATCH = 400, INDEX_BUDGET_MS = 2_500;
export const param = (value: string | string[] | undefined) => typeof value === 'string' ? value : undefined;

export async function workflowView(host: AdminHost, params: AnalyticsParams, now: Date): Promise<WorkflowView> {
  const range = analyticsRange(params, now);
  let indexing: IndexSummary | null = null, indexingCode: string | null = null;
  try { indexing = await indexRunFacts(host.db, host.tenantId, { from: range.from, to: range.to, limit: INDEX_BATCH, budgetMs: INDEX_BUDGET_MS }); }
  catch { indexingCode = 'ADMIN_INDEXING_FAILED'; }
  try {
    const { runs, idle, coverage } = await loadRuns(host.db, host.tenantId, range);
    const executions = executionsOf(runs), requested = environmentOfFilter(params.env), environment = requested ?? defaultEnvironment(executions);
    const action = kindOfFilter(params.action), outcome = outcomeOfFilter(params.outcome);
    const saved = await host.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM saved_workflows WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [host.tenantId, range.from, range.to]).then(r => r.rows[0]?.n ?? 0, () => null);
    // The console only opens on the exact shipped schema, which includes delegated execution (0011).
    const delegated = await host.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM delegated_executions WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [host.tenantId, range.from, range.to]).then(r => r.rows[0]?.n ?? 0, () => null);
    return { ok: true, range, environment, environmentDefaulted: requested === null, action, outcome, indexing, indexingCode,
      analytics: summarize(executions, range, environment, { action, outcome }, coverage, idle), executions, savedInRange: saved, delegatedInRange: delegated };
  } catch { return { ok: false, code: 'ADMIN_ANALYTICS_UNAVAILABLE' }; }
}

/** A query string for links that change one filter and keep the others. */
export function withParams(base: string, current: Readonly<Partial<Record<keyof AnalyticsParams, string | null>>>,
  change: Partial<Record<keyof AnalyticsParams, string | null>>): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...current, ...change })) if (typeof value === 'string' && value) next.set(key, value);
  const query = next.toString();
  return query ? `${base}?${query}` : base;
}
