// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001 (P0): the durable diagnostic record of nonce-conflict investigations (`execution_nonce_conflicts`,
 * migration 0027). One row per (tenant, run, attempt). It is a diagnostic cache, not financial evidence: the run's own durable log stays the
 * only record of the attempt's state, and nothing here is read by a flow's state machine. Every query is tenant-scoped.
 *
 * Tracking: an investigation whose evidence fingerprint equals the stored one increments `stable_observations`; any change resets it. A report
 * that could not read the chain (INSUFFICIENT_CHAIN_EVIDENCE) never replaces a stored report that could: it only records the failed check,
 * so an RPC outage can neither erase evidence nor reset the stability count.
 */
import type { Queryable } from '@defi-workflow-engine/cloud-runtime';
import { NONCE_CONFLICT_CLASSIFICATIONS, type AlternateCandidate, type NonceConflictClassification, type NonceConflictReport, type NonceConflictSubject,
  type PeerAttempt } from './nonce-conflict.ts';

export type NonceConflictRow = {
  readonly runId: string; readonly attemptId: string; readonly flow: string; readonly chainId: string; readonly nonce: string;
  readonly conflictingTransactionHash: string | null; readonly classification: NonceConflictClassification; readonly report: NonceConflictReport;
  readonly stableObservations: number; readonly investigations: number; readonly firstObservedAt: Date; readonly lastCheckedAt: Date; readonly lastChangedAt: Date;
  readonly lastVerifiedAt: Date | null; readonly lastCheckCode: string | null; readonly escalatedAt: Date | null;
};
type Row = { run_id: string; attempt_id: string; flow: string; chain_id: string; nonce: string; conflicting_transaction_hash: string | null; classification: string;
  report: NonceConflictReport; stable_observations: number; investigations: number; first_observed_at: Date; last_checked_at: Date; last_changed_at: Date;
  last_verified_at: Date | null; last_check_code: string | null; escalated_at: Date | null };
const COLUMNS = `run_id, attempt_id, flow, chain_id, nonce, conflicting_transaction_hash, classification, report, stable_observations, investigations,
  first_observed_at, last_checked_at, last_changed_at, last_verified_at, last_check_code, escalated_at`;
const rowOf = (row: Row): NonceConflictRow => ({ runId: row.run_id, attemptId: row.attempt_id, flow: row.flow, chainId: row.chain_id, nonce: row.nonce,
  conflictingTransactionHash: row.conflicting_transaction_hash, classification: (NONCE_CONFLICT_CLASSIFICATIONS as readonly string[]).includes(row.classification)
    ? row.classification as NonceConflictClassification : 'INSUFFICIENT_CHAIN_EVIDENCE', report: row.report, stableObservations: row.stable_observations,
  investigations: row.investigations, firstObservedAt: row.first_observed_at, lastCheckedAt: row.last_checked_at, lastChangedAt: row.last_changed_at,
  lastVerifiedAt: row.last_verified_at, lastCheckCode: row.last_check_code, escalatedAt: row.escalated_at });

/** Other FloFi attempts of the same tenant and sender that recorded the same nonce (bounded). Exact matches only; never another tenant. */
export async function peerAttempts(db: Queryable, tenantId: string, subject: Pick<NonceConflictSubject, 'runId' | 'sender' | 'nonce'>): Promise<PeerAttempt[]> {
  const { rows } = await db.query<{ run_id: string; flow: string; step: string; state: string; transaction_hash: string | null }>(`SELECT a.run_id, r.flow, a.step, a.state,
      a.transaction_hash FROM execution_attempts a JOIN execution_runs r ON r.tenant_id = a.tenant_id AND r.run_id = a.run_id
    WHERE a.tenant_id = $1 AND r.owner_account = $2 AND a.nonce = $3 AND a.run_id <> $4 ORDER BY a.created_at, a.attempt_id LIMIT 20`,
  [tenantId, subject.sender, subject.nonce, subject.runId]);
  return rows.map(row => ({ runId: row.run_id, flow: row.flow, step: row.step, state: row.state, transactionHash: row.transaction_hash }));
}

/** FloFi attempts of the same tenant and sender that recorded one of these transactions (alternate-nonce candidates), any nonce. */
export async function peersByTransaction(db: Queryable, tenantId: string, subject: Pick<NonceConflictSubject, 'runId' | 'sender'>, hashes: readonly string[]): Promise<PeerAttempt[]> {
  const list = [...new Set(hashes.filter(h => /^0x[0-9a-f]{64}$/.test(h)))].slice(0, 40);
  if (!list.length) return [];
  const { rows } = await db.query<{ run_id: string; flow: string; step: string; state: string; transaction_hash: string | null }>(`SELECT a.run_id, r.flow, a.step, a.state,
      a.transaction_hash FROM execution_attempts a JOIN execution_runs r ON r.tenant_id = a.tenant_id AND r.run_id = a.run_id
    WHERE a.tenant_id = $1 AND r.owner_account = $2 AND a.transaction_hash = ANY($3::text[]) AND a.run_id <> $4 LIMIT 40`, [tenantId, subject.sender, list, subject.runId]);
  return rows.map(row => ({ runId: row.run_id, flow: row.flow, step: row.step, state: row.state, transactionHash: row.transaction_hash }));
}

export async function loadNonceConflict(db: Queryable, tenantId: string, runId: string, attemptId: string): Promise<NonceConflictRow | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM execution_nonce_conflicts WHERE tenant_id = $1 AND run_id = $2 AND attempt_id = $3`, [tenantId, runId, attemptId]);
  return rows[0] ? rowOf(rows[0]) : null;
}
export async function listNonceConflicts(db: Queryable, tenantId: string, runId: string): Promise<NonceConflictRow[]> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM execution_nonce_conflicts WHERE tenant_id = $1 AND run_id = $2 ORDER BY first_observed_at, attempt_id LIMIT 20`,
    [tenantId, runId]);
  return rows.map(rowOf);
}

/** Where the previous investigation of this attempt stopped scanning, and what it found (final blocks never change). */
export function previousScan(row: NonceConflictRow | null): { nextBlock: number; candidates: readonly AlternateCandidate[]; truncated: boolean } | null {
  const scan = row?.report.alternateNonce;
  return scan && scan.scannedThrough !== null && Number.isSafeInteger(scan.scannedThrough)
    ? { nextBlock: scan.scannedThrough + 1, candidates: scan.candidates, truncated: scan.truncated === true } : null;
}

/**
 * Records one investigation. Returns the tracking state after it. A row for a different run in another tenant can never be touched: the key is
 * (tenant, run, attempt) and the run must exist in this tenant (foreign key).
 */
export async function recordNonceConflict(db: Queryable, tenantId: string, subject: NonceConflictSubject, report: NonceConflictReport, at: Date): Promise<NonceConflictRow> {
  const failed = report.classification === 'INSUFFICIENT_CHAIN_EVIDENCE', code = report.reasons[0] ?? null;
  const { rows } = await db.query<Row>(`INSERT INTO execution_nonce_conflicts AS c (tenant_id, run_id, attempt_id, flow, chain_id, nonce, conflicting_transaction_hash,
      classification, evidence_fingerprint, report, stable_observations, investigations, first_observed_at, last_checked_at, last_changed_at, last_verified_at, last_check_code)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 0, 1, $11, $11, $11, CASE WHEN $12 THEN NULL ELSE $11::timestamptz END, CASE WHEN $12 THEN $13 ELSE NULL END)
    ON CONFLICT (tenant_id, run_id, attempt_id) DO UPDATE SET
      investigations = c.investigations + 1, last_checked_at = EXCLUDED.last_checked_at, last_check_code = EXCLUDED.last_check_code,
      -- A failed read keeps the last report that could read the chain (and its stability count); it never erases evidence.
      classification = CASE WHEN $12 AND c.classification <> 'INSUFFICIENT_CHAIN_EVIDENCE' THEN c.classification ELSE EXCLUDED.classification END,
      report = CASE WHEN $12 AND c.classification <> 'INSUFFICIENT_CHAIN_EVIDENCE' THEN c.report ELSE EXCLUDED.report END,
      conflicting_transaction_hash = CASE WHEN $12 AND c.classification <> 'INSUFFICIENT_CHAIN_EVIDENCE' THEN c.conflicting_transaction_hash ELSE EXCLUDED.conflicting_transaction_hash END,
      evidence_fingerprint = CASE WHEN $12 AND c.classification <> 'INSUFFICIENT_CHAIN_EVIDENCE' THEN c.evidence_fingerprint ELSE EXCLUDED.evidence_fingerprint END,
      stable_observations = CASE WHEN $12 AND c.classification <> 'INSUFFICIENT_CHAIN_EVIDENCE' THEN c.stable_observations
        WHEN c.evidence_fingerprint = EXCLUDED.evidence_fingerprint THEN c.stable_observations + 1 ELSE 0 END,
      last_changed_at = CASE WHEN c.evidence_fingerprint = EXCLUDED.evidence_fingerprint OR ($12 AND c.classification <> 'INSUFFICIENT_CHAIN_EVIDENCE') THEN c.last_changed_at
        ELSE EXCLUDED.last_checked_at END,
      last_verified_at = CASE WHEN $12 THEN c.last_verified_at ELSE EXCLUDED.last_checked_at END,
      -- New evidence re-opens an escalated conflict for automatic observation.
      escalated_at = CASE WHEN c.evidence_fingerprint = EXCLUDED.evidence_fingerprint OR $12 THEN c.escalated_at ELSE NULL END
    RETURNING ${COLUMNS.split(',').map(c => 'c.' + c.trim()).join(', ')}`,
  [tenantId, subject.runId, subject.attemptId, subject.flow, subject.chainId, subject.nonce, report.conflictingTransactionHash, report.classification,
    report.evidenceFingerprint, JSON.stringify(report), at, failed, code]);
  return rowOf(rows[0]!);
}

export async function markNonceConflictEscalated(db: Queryable, tenantId: string, runId: string, attemptId: string, at: Date): Promise<void> {
  await db.query(`UPDATE execution_nonce_conflicts SET escalated_at = $4 WHERE tenant_id = $1 AND run_id = $2 AND attempt_id = $3 AND escalated_at IS NULL`,
    [tenantId, runId, attemptId, at]);
}
