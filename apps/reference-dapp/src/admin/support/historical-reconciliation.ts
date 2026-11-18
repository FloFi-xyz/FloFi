// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FINOPS-AUTOMATED-SYNC-002 P0: historical reconciliation of mainnet executions whose settlement the earlier verifier could not
 * prove (for example a Relay native fill paid through RelayRouter: UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE).
 *
 * Read-only on chain by construction. It never prepares, signs, submits, replays or replaces a transaction and moves no funds: for each
 * candidate it only applies the registered `execution.resume-observation` recovery (`registry.ts`), which re-queues the run's own
 * `reconcile` task under its original identity. The worker then re-observes the run with the current verifier; a delivery is recorded
 * only from transaction-specific on-chain evidence, never from a provider status.
 *
 *   dry run (default)  lists the candidates and each one's eligibility; writes nothing.
 *   apply              requires an approval reference and a reason; each run goes through `executeRecovery` (state token, per-tenant
 *                      lock, idempotency key derived from the approval reference, rate limit, audit record). Reruns are safe: an
 *                      already queued run is reported, and a repeated key returns the first result.
 */
import { createHash } from 'node:crypto';
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { freeText } from './diagnostics.ts';
import { auditRecoveryRefusal, executeRecovery, previewRecovery, RECOVERY_RATE_LIMIT, RecoveryRefusal, RUN_ID } from './recovery.ts';

const ACTION = 'execution.resume-observation' as const;
/** One apply never takes the whole tenant recovery budget: interactive Support & Recovery keeps headroom during an incident. */
export const HISTORICAL_BATCH_LIMIT = Math.max(1, RECOVERY_RATE_LIMIT - 10);
const FLOW = /^[a-z][a-z0-9-]{2,63}$/, CODE = /^[A-Z][A-Z0-9_]{2,80}$/, APPROVAL = /^[A-Za-z0-9._:#-]{3,80}$/;
/** The settlement codes the 2026-11-18 incident class leaves on a still-pending execution. */
export const HISTORICAL_SETTLEMENT_CODES = Object.freeze(['UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE', 'UNIVERSAL_DELIVERY_ORDER_NOT_BOUND',
  'UNIVERSAL_DELIVERY_DELAYED', 'UNIVERSAL_DESTINATION_PENDING', 'UNIVERSAL_REFUND_NOT_OBSERVED']);

export type HistoricalDisposition = 'ELIGIBLE' | 'QUEUED' | 'REPLAYED' | 'ALREADY_OBSERVING' | 'REFUSED' | 'RATE_LIMITED';
export type HistoricalCandidate = { readonly runId: string; readonly flow: string; readonly status: string; readonly errorCode: string | null;
  readonly attentionRequired: boolean; readonly disposition: HistoricalDisposition; readonly code: string | null };
export type HistoricalReconciliation = { readonly mode: 'DRY_RUN' | 'APPLY'; readonly flow: string; readonly codes: readonly string[];
  readonly candidates: readonly HistoricalCandidate[]; readonly queued: number; readonly remaining: number;
  readonly note: string };

export async function historicalReconciliation(host: { readonly db: Database; readonly tenantId: string }, input: {
  readonly flow: string; readonly codes?: readonly string[]; readonly limit: number; readonly now: Date;
  readonly apply?: { readonly approvalRef: string; readonly reason: string; readonly actor: string; readonly textRetentionDays?: number };
}): Promise<HistoricalReconciliation> {
  const codes = input.codes?.length ? [...new Set(input.codes)] : [...HISTORICAL_SETTLEMENT_CODES];
  if (!FLOW.test(input.flow) || !codes.every(code => CODE.test(code)) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
    throw new Error('HISTORICAL_RECONCILIATION_REQUEST_INVALID');
  const reason = input.apply ? freeText(input.apply.reason, 3, 200) : null;
  if (input.apply && (!APPROVAL.test(input.apply.approvalRef) || !reason)) throw new Error('HISTORICAL_RECONCILIATION_APPROVAL_REQUIRED');
  // Only public mainnet runs that still ask for observation: a terminal run is never reopened by this procedure.
  const { rows } = await host.db.query<{ run_id: string; flow: string; status: string; error_code: string | null; attention_required: boolean }>(
    `SELECT run_id, flow, status, error_code, attention_required FROM execution_runs
      WHERE tenant_id = $1 AND provenance = 'PUBLIC_MAINNET' AND needs_observation AND flow = $2 AND error_code = ANY($3::text[])
      ORDER BY updated_at, run_id LIMIT $4`, [host.tenantId, input.flow, codes, input.limit]);
  const candidates: HistoricalCandidate[] = [];
  let queued = 0, limited = false;
  for (const row of rows) {
    const base = { runId: row.run_id, flow: row.flow, status: row.status, errorCode: row.error_code, attentionRequired: row.attention_required };
    if (!RUN_ID.test(row.run_id)) { candidates.push({ ...base, disposition: 'REFUSED', code: 'SUPPORT_RUN_ID_INVALID' }); continue; }
    if (limited) { candidates.push({ ...base, disposition: 'RATE_LIMITED', code: 'SUPPORT_RECOVERY_RATE_LIMITED' }); continue; }
    const preview = await previewRecovery(host, row.run_id, ACTION, input.now);
    if (!preview) { candidates.push({ ...base, disposition: 'REFUSED', code: 'SUPPORT_RUN_NOT_FOUND' }); continue; }
    if (!preview.eligibility.eligible) {
      // A queued or running check already re-observes the run with the current verifier after deployment.
      const observing = preview.eligibility.code === 'SUPPORT_ALREADY_SCHEDULED';
      candidates.push({ ...base, disposition: observing ? 'ALREADY_OBSERVING' : 'REFUSED', code: preview.eligibility.code });
      continue;
    }
    if (!input.apply) { candidates.push({ ...base, disposition: 'ELIGIBLE', code: null }); continue; }
    if (queued >= HISTORICAL_BATCH_LIMIT) { candidates.push({ ...base, disposition: 'RATE_LIMITED', code: 'HISTORICAL_BATCH_LIMIT' }); continue; }
    const idempotencyKey = 'hist-' + createHash('sha256').update(input.apply.approvalRef + '\0' + row.run_id).digest('hex').slice(0, 40);
    try {
      const result = await executeRecovery(host, input.apply.actor, { runId: row.run_id, action: ACTION, stateToken: preview.stateToken, idempotencyKey,
        reason: reason! }, input.now, input.apply.textRetentionDays);
      if (!result.replayed) queued++;
      candidates.push({ ...base, disposition: result.replayed ? 'REPLAYED' : 'QUEUED', code: null });
    } catch (cause) {
      if (!(cause instanceof RecoveryRefusal)) throw cause;
      // Every refused recovery is audited, as interactive refusals are (closed code and run id only).
      await auditRecoveryRefusal(host.db, host.tenantId, input.apply.actor, cause.code, { action: ACTION, runId: row.run_id, idempotencyKey }, input.now);
      limited = cause.code === 'SUPPORT_RECOVERY_RATE_LIMITED';
      candidates.push({ ...base, disposition: limited ? 'RATE_LIMITED' : cause.code === 'SUPPORT_ALREADY_SCHEDULED' ? 'ALREADY_OBSERVING' : 'REFUSED', code: cause.code });
    }
  }
  const remaining = candidates.filter(c => c.disposition === 'ELIGIBLE' || c.disposition === 'RATE_LIMITED').length;
  return { mode: input.apply ? 'APPLY' : 'DRY_RUN', flow: input.flow, codes, candidates, queued, remaining,
    note: 'Read-only re-observation only: no transaction is prepared, signed, submitted or replayed, and no funds move. A delivery is recorded only '
      + 'from transaction-specific on-chain evidence. Rerun after the rate-limit window to continue; repeated runs are idempotent.' };
}
