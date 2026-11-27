// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (WS-REVENUE): the durable platform fee ledger (`platform_fee_ledger`, migration 0037).
 *
 * One row per canonical execution identity: a workflow run (`wfr_…`), never the saved workflow it came from, so a new, independently authorized
 * execution of the same saved workflow is a new row (F14) and a retry, a reconciliation pass, a restarted worker, a duplicate request or a
 * continuation can never add a second one (F07/F08: the unique key and `ON CONFLICT DO NOTHING`). What a row records:
 *   COMPLETED run              DUE (a positive fee in at least one asset), NOT_APPLICABLE (nothing feeable) or UNSUPPORTED (unreadable: never
 *                              charged). The amount is `settledFee`: per asset, never above what the estimate at Review would have been and
 *                              never above the final basis from the reconciled deliveries (F16).
 *   FAILED/CANCELLED/EXPIRED   WAIVED, once any step had started (F09/F10/F11: a failed, rejected, expired or cancelled execution owes nothing).
 *                              A run that never started records nothing.
 *   PENDING/RUNNING/HALTED/    nothing yet: a partly executed workflow owes nothing before its remaining outcome is known (F10).
 *   ATTENTION
 * Accounting runs only from its explicit activation instant (`activation.ts`): nothing created before it is accounted (F13). Collection is not
 * implemented (`activation.ts`): this module never writes COLLECTION_PENDING or COLLECTED, and never moves funds.
 * Single-flow executions (`execution_runs` without a workflow run) are not accounted here; the universal bridge keeps its own obligation record.
 */
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { composeWorkflow } from '../engine/strategy-engine';
import { stepOutput } from '../engine/workflow-bindings';
import { assetKey } from '../delegation/steps.ts';
import { effectiveOrigins, revenueOriginsActive, type ExecutionOrigin } from '../workflow-runs/execution-origins.ts';
import { PLATFORM_FEE_BPS, PLATFORM_FEE_POLICY_ID } from './policy';
import { settledFee, workflowFeeBasis, type FeeLine } from './principal';
import { accountedExecution, type FeeActivation } from './activation';

export type LedgerState = 'DUE' | 'NOT_APPLICABLE' | 'WAIVED' | 'UNSUPPORTED' | 'COLLECTION_PENDING' | 'COLLECTED' | 'COLLECTION_FAILED';
export type LedgerEntry = { readonly workflowRunId: string; readonly state: LedgerState; readonly reason: string | null; readonly lines: readonly FeeLine[];
  readonly networkEnvironment: 'MAINNET' | 'PUBLIC_TESTNET' | 'MOCKED'; readonly origin: ExecutionOrigin | null };

type RunRow = { run_id: string; state: string; strategy: unknown; created_at: Date; network_environment: string;
  steps: { state: string; outcome: { received?: { asset: string; amount: string }[]; evidence?: { environment?: string } | null } | null }[] };

/** What one terminal workflow run owes (pure). `null`: nothing to record yet (still open, or never started). */
export function ledgerEntryOf(run: Pick<RunRow, 'run_id' | 'state' | 'strategy' | 'network_environment' | 'steps'>, origin: ExecutionOrigin | null): LedgerEntry | null {
  const mocked = run.steps.some(s => s.outcome?.evidence?.environment === 'MOCKED');
  const networkEnvironment = mocked ? 'MOCKED' : run.network_environment === 'MAINNET' ? 'MAINNET' : run.network_environment === 'PUBLIC_TESTNET' ? 'PUBLIC_TESTNET' : null;
  if (!networkEnvironment) return null;
  const base = { workflowRunId: run.run_id, networkEnvironment, origin } as const;
  if (run.state === 'FAILED' || run.state === 'CANCELLED' || run.state === 'EXPIRED') {
    const started = run.steps.some(s => s.state !== 'PENDING' && s.state !== 'READY');
    return started ? { ...base, state: 'WAIVED', reason: `WORKFLOW_${run.state}`, lines: [] } : null;
  }
  if (run.state !== 'COMPLETED') return null;
  const workflow = composeWorkflow(run.strategy);
  if (!workflow.ok) return { ...base, state: 'UNSUPPORTED', reason: 'PLATFORM_FEE_WORKFLOW_UNREADABLE', lines: [] };
  // What each producer step actually delivered to the owner (reconciled outcome), in the step's own output asset.
  const delivered = new Map<number, bigint>();
  for (const [index, step] of workflow.steps.entries()) {
    const out = stepOutput(step), facts = run.steps[index]?.outcome?.received ?? [];
    if (!out) continue;
    const key = assetKey({ chain: out.chainId, address: out.address });
    const amounts = facts.filter(f => f.asset === key && /^(0|[1-9][0-9]{0,77})$/.test(f.amount));
    if (amounts.length) delivered.set(index, amounts.reduce((sum, f) => sum + BigInt(f.amount), 0n));
  }
  const estimate = workflowFeeBasis(workflow), final = workflowFeeBasis(workflow, { delivered });
  if (estimate.status === 'UNSUPPORTED' || final.status === 'UNSUPPORTED') return { ...base, state: 'UNSUPPORTED', reason: final.reason ?? estimate.reason, lines: [] };
  const lines = settledFee(estimate, final);
  return lines.length ? { ...base, state: 'DUE', reason: null, lines } : { ...base, state: 'NOT_APPLICABLE', reason: final.reason ?? 'PLATFORM_FEE_NO_FEEABLE_PRINCIPAL', lines: [] };
}

export type AccrualReport = { readonly mode: 'DRY_RUN' | 'APPLY'; readonly examined: number; readonly recorded: number;
  readonly byState: Readonly<Partial<Record<LedgerState, number>>>; readonly code: string | null };

/**
 * Accrues every terminal workflow run created at or after the activation instant that has no ledger row yet. Idempotent and safe to run
 * concurrently or repeatedly (an existing row is never changed by accrual). Dry run unless `apply`.
 */
export async function accruePlatformFees(db: Database, tenantId: string, activation: FeeActivation, options: { readonly apply: boolean; readonly limit: number }): Promise<AccrualReport> {
  if (!activation.accounting.active || !activation.accounting.from) return { mode: options.apply ? 'APPLY' : 'DRY_RUN', examined: 0, recorded: 0, byState: {},
    code: activation.accounting.code ?? 'PLATFORM_FEE_ACCOUNTING_NOT_ACTIVATED' };
  if (!await revenueOriginsActive(db)) return { mode: options.apply ? 'APPLY' : 'DRY_RUN', examined: 0, recorded: 0, byState: {}, code: 'PLATFORM_FEE_LEDGER_NOT_MIGRATED' };
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_000) throw new Error('PLATFORM_FEE_ACCRUAL_REQUEST_INVALID');
  const { rows } = await db.query<RunRow>(`
    SELECT r.run_id, r.state, r.strategy, r.created_at, h.network_environment,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('state', s.state, 'outcome', s.outcome) ORDER BY s.step_index), '[]'::jsonb)
         FROM workflow_run_steps s WHERE s.tenant_id = r.tenant_id AND s.run_id = r.run_id) AS steps
    FROM workflow_runs r JOIN mcp_handoffs h ON h.tenant_id = r.tenant_id AND h.handoff_id = r.handoff_id
    WHERE r.tenant_id = $1 AND r.created_at >= $2 AND r.state IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')
      AND NOT EXISTS (SELECT 1 FROM platform_fee_ledger l WHERE l.tenant_id = r.tenant_id AND l.workflow_run_id = r.run_id)
    ORDER BY r.created_at, r.run_id LIMIT $3`, [tenantId, activation.accounting.from, options.limit]);
  const origins = await effectiveOrigins(db, tenantId, { runIds: [], workflowRunIds: rows.map(r => r.run_id) });
  const byState: Partial<Record<LedgerState, number>> = {};
  let recorded = 0;
  for (const row of rows) {
    if (!accountedExecution(activation, row.created_at)) continue;
    const entry = ledgerEntryOf(row, origins.workflowRuns.get(row.run_id)?.origin ?? null);
    if (!entry) continue;
    byState[entry.state] = (byState[entry.state] ?? 0) + 1;
    if (!options.apply) continue;
    const result = await db.query(`INSERT INTO platform_fee_ledger (tenant_id, workflow_run_id, policy_id, rate_bps, state, reason, lines, origin, network_environment,
        execution_completed_at) SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, r.completed_at FROM workflow_runs r WHERE r.tenant_id = $1 AND r.run_id = $2
      ON CONFLICT DO NOTHING`, [tenantId, entry.workflowRunId, PLATFORM_FEE_POLICY_ID, PLATFORM_FEE_BPS, entry.state, entry.reason, JSON.stringify(entry.lines),
      entry.origin, entry.networkEnvironment]);
    recorded += result.rowCount ?? 0;
  }
  return { mode: options.apply ? 'APPLY' : 'DRY_RUN', examined: rows.length, recorded, byState, code: null };
}

/** Admin read model: ledger rows whose execution completed (or, for a waived one, was accounted) in the period, aggregated per state, exact asset and
 * origin; no identifier leaves. Never converted to money. */
export type FeeTotals = {
  readonly migrated: boolean;
  readonly byState: Readonly<Partial<Record<LedgerState, number>>>;
  /** Per exact asset of DUE rows: the fee owed and not collected (native units). */
  readonly dueByAsset: readonly { readonly chainId: string; readonly address: string; readonly decimals: number; readonly fee: string; readonly executions: number }[];
  /** Per exact asset of COLLECTED rows (always empty while no collector exists). */
  readonly collectedByAsset: readonly { readonly chainId: string; readonly address: string; readonly decimals: number; readonly fee: string }[];
  readonly byOrigin: Readonly<Partial<Record<ExecutionOrigin | 'unrecorded', number>>>;
};
export async function loadFeeTotals(db: Queryable, tenantId: string, period: { readonly from: Date; readonly to: Date }, environment: string): Promise<FeeTotals> {
  if (!await revenueOriginsActive(db)) return { migrated: false, byState: {}, dueByAsset: [], collectedByAsset: [], byOrigin: {} };
  const { rows } = await db.query<{ state: LedgerState; origin: string | null; lines: FeeLine[] }>(`SELECT state, origin, lines FROM platform_fee_ledger
    WHERE tenant_id = $1 AND coalesce(execution_completed_at, created_at) >= $2 AND coalesce(execution_completed_at, created_at) < $3 AND network_environment = $4
    LIMIT 20001`, [tenantId, period.from, period.to, environment]);
  if (rows.length > 20_000) throw new Error('PLATFORM_FEE_TOTALS_TRUNCATED');
  const byState: Partial<Record<LedgerState, number>> = {}, byOrigin: Partial<Record<string, number>> = {};
  const due = new Map<string, { chainId: string; address: string; decimals: number; fee: bigint; executions: number }>();
  const collected = new Map<string, { chainId: string; address: string; decimals: number; fee: bigint }>();
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
    if (row.state === 'DUE' || row.state === 'COLLECTED') byOrigin[row.origin ?? 'unrecorded'] = (byOrigin[row.origin ?? 'unrecorded'] ?? 0) + 1;
    for (const line of row.lines) {
      const key = `${line.chainId}|${line.address}|${line.decimals}`;
      if (row.state === 'DUE') { const d = due.get(key) ?? { chainId: line.chainId, address: line.address, decimals: line.decimals, fee: 0n, executions: 0 };
        d.fee += BigInt(line.fee); d.executions++; due.set(key, d); }
      if (row.state === 'COLLECTED') { const c = collected.get(key) ?? { chainId: line.chainId, address: line.address, decimals: line.decimals, fee: 0n };
        c.fee += BigInt(line.fee); collected.set(key, c); }
    }
  }
  return { migrated: true, byState, byOrigin: byOrigin as FeeTotals['byOrigin'],
    dueByAsset: [...due.values()].map(d => ({ ...d, fee: d.fee.toString() })).sort((a, b) => a.chainId.localeCompare(b.chainId) || a.address.localeCompare(b.address)),
    collectedByAsset: [...collected.values()].map(c => ({ ...c, fee: c.fee.toString() })) };
}
