// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: one execution run as the support model reads it — the projection row, its attempts (hash presence and
 * reconciliation only, never the hash itself), whether the journal recorded an authorization, and the networks its indexed record names.
 * Shared by incident derivation, the attention lifecycle and diagnostics. Read-only; every read is tenant-scoped.
 */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import type { AttemptFact } from '../analytics/classify.ts';
import { NONCE_CONFLICT_CODE } from '../../server/nonce-conflict.ts';

type NonceCheck = { readonly checkedAt: string; readonly verifiedAt: string | null; readonly code: string | null };
export type ExecutionSnapshot = { readonly runId: string; readonly workflowId: string; readonly flow: string; readonly status: string; readonly provenance: string;
  readonly errorCode: string | null; readonly needsObservation: boolean; readonly attentionRequired: boolean; readonly hasEvidence: boolean; readonly createdAt: Date;
  readonly updatedAt: Date; readonly attempts: readonly AttemptFact[]; readonly journalAuthorized: boolean; readonly chains: readonly string[]; readonly nonceCheck?: NonceCheck };

export type RunRow = { run_id: string; workflow_id: string; flow: string; status: string; provenance: string; error_code: string | null; needs_observation: boolean;
  attention_required: boolean; has_evidence: boolean; created_at: Date; updated_at: Date; attempts: AttemptFact[]; journal_authorized: boolean; chains: string[] | null;
  nonce_check: NonceCheck | null };
export const EXECUTION_SELECT = `SELECT r.run_id, r.workflow_id, r.flow, r.status, r.provenance, r.error_code, r.needs_observation, r.attention_required, r.has_evidence,
    r.created_at, r.updated_at,
    coalesce((SELECT json_agg(json_build_object('step', a.step, 'state', a.state, 'hash', a.transaction_hash IS NOT NULL, 'reconciled', a.reconciled)
      ORDER BY a.created_at, a.attempt_id) FROM execution_attempts a WHERE a.tenant_id = r.tenant_id AND a.run_id = r.run_id), '[]'::json) AS attempts,
    EXISTS (SELECT 1 FROM journal_entries j WHERE j.tenant_id = r.tenant_id AND j.run_id = r.run_id AND j.to_state = 'AUTHORIZED') AS journal_authorized,
    (SELECT array_agg(DISTINCT x.chain) FROM admin_run_facts f, jsonb_to_recordset(f.actions) AS x(chain text)
      WHERE f.tenant_id = r.tenant_id AND f.run_id = r.run_id AND f.state = 'INDEXED' AND x.chain IS NOT NULL) AS chains,
    (SELECT json_build_object('checkedAt', c.last_checked_at, 'verifiedAt', c.last_verified_at, 'code', c.last_check_code)
      FROM execution_nonce_conflicts c JOIN execution_attempts a USING (tenant_id,run_id,attempt_id)
      WHERE r.needs_observation AND r.error_code ~ '${NONCE_CONFLICT_CODE.source}'
        AND c.tenant_id = r.tenant_id AND c.run_id = r.run_id AND a.state = 'SUBMISSION_RESULT_UNKNOWN'
      ORDER BY c.last_checked_at DESC,c.attempt_id LIMIT 1) AS nonce_check
  FROM execution_runs r`;
export const snapshotOf = (row: RunRow): ExecutionSnapshot => ({ runId: row.run_id, workflowId: row.workflow_id, flow: row.flow, status: row.status,
  provenance: row.provenance, errorCode: row.error_code, needsObservation: row.needs_observation, attentionRequired: row.attention_required, hasEvidence: row.has_evidence,
  createdAt: row.created_at, updatedAt: row.updated_at, attempts: row.attempts, journalAuthorized: row.journal_authorized, chains: row.chains ?? [],
  ...(row.nonce_check ? { nonceCheck: {
    checkedAt: new Date(row.nonce_check.checkedAt).toISOString(),
    verifiedAt: row.nonce_check.verifiedAt ? new Date(row.nonce_check.verifiedAt).toISOString() : null,
    code: row.nonce_check.code,
  } } : {}) });
export async function loadExecutions(db: Database, tenantId: string, runIds: readonly string[]): Promise<ExecutionSnapshot[]> {
  if (!runIds.length) return [];
  const { rows } = await db.query<RunRow>(`${EXECUTION_SELECT} WHERE r.tenant_id = $1 AND r.run_id = ANY($2::text[])`, [tenantId, [...new Set(runIds)].slice(0, 1000)]);
  return rows.map(snapshotOf);
}
