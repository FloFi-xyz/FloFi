// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001 (P1): the operator procedures for Support & Recovery privacy — retention, legal holds and
 * data-subject requests. Operator CLI only (`backend/admin-cli.ts`, database access): there is no HTTP endpoint and no "delete all history"
 * control. Every procedure is tenant-scoped, audited with closed codes and counts (never a text body, wallet or fingerprint), and refuses to
 * delete anything a legal hold covers (the database enforces holds too).
 *
 *   Retention   `retention-report` (read-only dry run) → `retention-activate` (records the approval reference) → `retention-apply`. Without an
 *               ACTIVE activation, apply refuses: deploying this code purges nothing. Only rows created by this build or later are in scope; the
 *               legacy inline text in `admin_audit_events` stays as written (append-only) — see the build report.
 *   Requests    `privacy-request` (RECEIVED; a wallet subject is stored only as a keyed fingerprint) → `privacy-decide` (APPROVED / REJECTED with
 *               the approval reference) → `privacy-access` | `privacy-erase` | `privacy-complete` (COMPLETED with counts).
 *   Holds       `legal-hold` / `legal-hold-release`, each with an approval reference. A hold is released, never deleted.
 *
 * Financial execution evidence (runs, logs, attempts, journal, Evidence Bundles) and the audit skeleton are never deleted here: they have
 * their own retention purposes, decided separately.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { typedId } from '../platform/ids.ts';
import { recordAudit } from './store.ts';
import { candidateFingerprints, periodEnd, supportPrivacyConfig } from './support/privacy.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type RetentionPolicy = 'SUPPORT_TEXT' | 'LOOKUP_KEYS';
export const RETENTION_POLICIES: readonly RetentionPolicy[] = ['SUPPORT_TEXT', 'LOOKUP_KEYS'];
const APPROVAL_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,119}$/, CODE = /^[A-Z][A-Z0-9_]{2,60}$/, RUN = /^(?!0[xX])[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EVM = /^0x[0-9a-f]{40}$/, SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const need = (ok: boolean, code: string) => { if (!ok) throw new Error(code); };
const DAY_MS = 86_400_000;
/**
 * Placing a hold, applying retention and erasing take this per-tenant transaction lock, so a hold committed while a deletion runs cannot be
 * missed by it (under READ COMMITTED the deletion would otherwise not see an uncommitted hold).
 */
const serialize = (tx: Queryable, tenantId: string) => tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`flofi.privacy:${tenantId}`]);
/** Retention governs by the APPROVED period (the activation), counted from when the text was written. `expires_at` is the schedule shown. */
const DUE_TEXT = `t.created_at <= $2::timestamptz - make_interval(days => $3)`;

type Activation = { activationId: string; retentionDays: number; approvalRef: string; createdAt: string };
async function activeActivation(db: Queryable, tenantId: string, policy: RetentionPolicy): Promise<Activation | null> {
  const { rows } = await db.query<{ activation_id: string; retention_days: number; approval_ref: string; created_at: Date }>(`SELECT activation_id, retention_days, approval_ref,
    created_at FROM privacy_retention_activations WHERE tenant_id = $1 AND policy = $2 AND state = 'ACTIVE'`, [tenantId, policy]);
  const row = rows[0];
  return row ? { activationId: row.activation_id, retentionDays: row.retention_days, approvalRef: row.approval_ref, createdAt: row.created_at.toISOString() } : null;
}
const HELD_TEXT = `EXISTS (SELECT 1 FROM privacy_legal_holds h WHERE h.tenant_id = t.tenant_id AND h.released_at IS NULL
  AND (h.scope = 'TENANT' OR (h.scope = 'RUN' AND h.scope_value = t.run_id)))`;
const HELD_KEY = `EXISTS (SELECT 1 FROM privacy_legal_holds h WHERE h.tenant_id = k.tenant_id AND h.released_at IS NULL
  AND (h.scope = 'TENANT' OR (h.scope = 'LOOKUP_PERIOD' AND h.scope_value = k.period)))`;

/** Keys whose quarter ended more than `days` ago, not destroyed yet; split by legal hold. */
async function dueKeys(db: Queryable, tenantId: string, days: number, now: Date) {
  const { rows } = await db.query<{ period: string; kek_id: string; held: boolean }>(`SELECT k.period, k.kek_id, ${HELD_KEY} AS held FROM admin_lookup_keys k
    WHERE k.tenant_id = $1 AND k.destroyed_at IS NULL ORDER BY k.period`, [tenantId]);
  const due = rows.filter(row => periodEnd(row.period).getTime() + days * DAY_MS <= now.getTime());
  return { due: due.filter(row => !row.held), held: due.filter(row => row.held) };
}

/** Read-only dry run: what each policy would remove now, what holds keep, and what this build cannot remove. Deletes nothing. */
export async function retentionReport(db: Queryable, tenantId: string, env: Env, now: Date): Promise<Record<string, unknown>> {
  const config = supportPrivacyConfig(env);
  const [textActivation, keyActivation] = await Promise.all([activeActivation(db, tenantId, 'SUPPORT_TEXT'), activeActivation(db, tenantId, 'LOOKUP_KEYS')]);
  const textDays = textActivation?.retentionDays ?? config.textRetentionDays, keyDays = keyActivation?.retentionDays ?? config.lookupRetentionDays;
  const [texts, keys, legacy, holds] = await Promise.all([
    db.query<{ due: number; held: number; total: number }>(`SELECT count(*) FILTER (WHERE ${DUE_TEXT} AND NOT ${HELD_TEXT})::int AS due,
        count(*) FILTER (WHERE ${DUE_TEXT} AND ${HELD_TEXT})::int AS held, count(*)::int AS total
      FROM admin_support_texts t WHERE t.tenant_id = $1`, [tenantId, now, textDays]),
    dueKeys(db, tenantId, keyDays, now),
    db.query<{ notes: number; reasons: number; searches_v1: number }>(`SELECT count(*) FILTER (WHERE kind = 'SUPPORT_NOTE' AND detail ? 'text')::int AS notes,
        count(*) FILTER (WHERE kind = 'SUPPORT_RECOVERY' AND detail ? 'reason')::int AS reasons,
        count(*) FILTER (WHERE kind = 'SUPPORT_SEARCH' AND detail ? 'fingerprint' AND NOT detail ? 'fpv')::int AS searches_v1
      FROM admin_audit_events WHERE tenant_id = $1 AND kind IN ('SUPPORT_NOTE', 'SUPPORT_RECOVERY', 'SUPPORT_SEARCH')`, [tenantId]),
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM privacy_legal_holds WHERE tenant_id = $1 AND released_at IS NULL`, [tenantId]),
  ]);
  const t = texts.rows[0]!, l = legacy.rows[0]!;
  return { dryRun: true, at: now.toISOString(), activeLegalHolds: holds.rows[0]!.n,
    policies: {
      SUPPORT_TEXT: { active: textActivation, retentionDays: textDays, basis: textActivation ? 'APPROVED_ACTIVATION' : 'PROPOSED_NOT_ACTIVE', stored: t.total, wouldDelete: t.due, keptByLegalHold: t.held },
      LOOKUP_KEYS: { active: keyActivation, retentionDays: keyDays, basis: keyActivation ? 'APPROVED_ACTIVATION' : 'PROPOSED_NOT_ACTIVE',
        wouldDestroy: keys.due.map(k => `${k.period}:${k.kek_id}`), keptByLegalHold: keys.held.map(k => `${k.period}:${k.kek_id}`) },
    },
    // Written before this build, inline in the append-only audit table: not removable by these policies (a future, separately approved phase).
    notInScope: { legacyInlineNoteTexts: l.notes, legacyInlineRecoveryReasons: l.reasons, legacyV1SearchFingerprints: l.searches_v1 } };
}

export async function activateRetention(db: Database, tenantId: string, policy: RetentionPolicy, days: number, approvalRef: string): Promise<Record<string, unknown>> {
  need(RETENTION_POLICIES.includes(policy), 'RETENTION_POLICY_INVALID');
  need(Number.isSafeInteger(days) && days >= 30 && days <= 3650, 'RETENTION_DAYS_INVALID');
  need(APPROVAL_REF.test(approvalRef), 'APPROVAL_REF_INVALID');
  return db.transaction(async tx => {
    const activationId = typedId('rta');
    try {
      await tx.query(`INSERT INTO privacy_retention_activations (tenant_id, activation_id, policy, retention_days, approval_ref, state) VALUES ($1, $2, $3, $4, $5, 'ACTIVE')`,
        [tenantId, activationId, policy, days, approvalRef]);
    } catch (error) {
      if ((error as { code?: unknown }).code === '23505') throw new Error('RETENTION_ALREADY_ACTIVE', { cause: error });
      throw error;
    }
    await recordAudit(tx, tenantId, { actor: 'cli', kind: 'PRIVACY_RETENTION_ACTIVATED', outcome: 'OK', target: activationId, detail: { policy, retentionDays: days, approvalRef } });
    return { activationId, policy, retentionDays: days };
  });
}
export async function revokeRetention(db: Database, tenantId: string, policy: RetentionPolicy): Promise<Record<string, unknown>> {
  return db.transaction(async tx => {
    const { rows } = await tx.query<{ activation_id: string }>(`UPDATE privacy_retention_activations SET state = 'REVOKED', revoked_at = now()
      WHERE tenant_id = $1 AND policy = $2 AND state = 'ACTIVE' RETURNING activation_id`, [tenantId, policy]);
    if (!rows[0]) throw new Error('RETENTION_NOT_ACTIVE');
    await recordAudit(tx, tenantId, { actor: 'cli', kind: 'PRIVACY_RETENTION_REVOKED', outcome: 'OK', target: rows[0].activation_id, detail: { policy } });
    return { revoked: rows[0].activation_id };
  });
}

/**
 * Enforces one ACTIVE policy (refuses otherwise). Texts: deletes rows older than the APPROVED period (the activation's, whatever the period
 * configured when they were written), never under a hold, at most `limit` per run. Keys: destroys (never deletes) past quarters' keys. One audit event with the counts.
 */
export async function applyRetention(db: Database, tenantId: string, policy: RetentionPolicy, now: Date, limit = 5_000): Promise<Record<string, unknown>> {
  need(RETENTION_POLICIES.includes(policy), 'RETENTION_POLICY_INVALID');
  return db.transaction(async tx => {
    await serialize(tx, tenantId);
    const activation = await activeActivation(tx, tenantId, policy);
    if (!activation) throw new Error('RETENTION_NOT_ACTIVATED');
    let removed: number, kept: number;
    if (policy === 'SUPPORT_TEXT') {
      const deleted = await tx.query(`DELETE FROM admin_support_texts WHERE tenant_id = $1 AND text_id IN (SELECT t.text_id FROM admin_support_texts t
          WHERE t.tenant_id = $1 AND ${DUE_TEXT} AND NOT ${HELD_TEXT} ORDER BY t.created_at LIMIT $4)`, [tenantId, now, activation.retentionDays, limit]);
      const held = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_support_texts t WHERE t.tenant_id = $1 AND ${DUE_TEXT} AND ${HELD_TEXT}`,
        [tenantId, now, activation.retentionDays]);
      removed = deleted.rowCount; kept = held.rows[0]!.n;
    } else {
      const keys = await dueKeys(tx, tenantId, activation.retentionDays, now);
      for (const key of keys.due) await tx.query(`UPDATE admin_lookup_keys SET wrapped_key = NULL, destroyed_at = $4, destroy_reason = 'RETENTION_EXPIRED'
        WHERE tenant_id = $1 AND period = $2 AND kek_id = $3 AND destroyed_at IS NULL`, [tenantId, key.period, key.kek_id, now]);
      removed = keys.due.length; kept = keys.held.length;
    }
    await recordAudit(tx, tenantId, { actor: 'cli', kind: 'PRIVACY_RETENTION_APPLIED', outcome: 'OK', target: activation.activationId,
      detail: { policy, removed, keptByLegalHold: kept, retentionDays: activation.retentionDays } });
    return { policy, activationId: activation.activationId, removed, keptByLegalHold: kept };
  });
}

// --- Legal holds -----------------------------------------------------------------------------------------------------------------------
export async function placeLegalHold(db: Database, tenantId: string, input: { scope: string; value: string | null; reasonCode: string; approvalRef: string }): Promise<Record<string, unknown>> {
  need(['TENANT', 'RUN', 'LOOKUP_PERIOD'].includes(input.scope), 'LEGAL_HOLD_SCOPE_INVALID');
  need(input.scope === 'TENANT' ? input.value === null : input.scope === 'RUN' ? RUN.test(input.value ?? '') : /^[0-9]{4}-Q[1-4]$/.test(input.value ?? ''), 'LEGAL_HOLD_VALUE_INVALID');
  need(CODE.test(input.reasonCode), 'LEGAL_HOLD_REASON_INVALID');
  need(APPROVAL_REF.test(input.approvalRef), 'APPROVAL_REF_INVALID');
  return db.transaction(async tx => {
    await serialize(tx, tenantId);
    const holdId = typedId('lgh');
    await tx.query(`INSERT INTO privacy_legal_holds (tenant_id, hold_id, scope, scope_value, reason_code, approval_ref) VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, holdId, input.scope, input.value, input.reasonCode, input.approvalRef]);
    await recordAudit(tx, tenantId, { actor: 'cli', kind: 'PRIVACY_LEGAL_HOLD_PLACED', outcome: 'OK', target: holdId, detail: { scope: input.scope, reasonCode: input.reasonCode,
      approvalRef: input.approvalRef } });
    return { holdId };
  });
}
export async function releaseLegalHold(db: Database, tenantId: string, holdId: string, approvalRef: string): Promise<Record<string, unknown>> {
  need(/^lgh_[a-z2-7]{26}$/.test(holdId), 'LEGAL_HOLD_INVALID');
  need(APPROVAL_REF.test(approvalRef), 'APPROVAL_REF_INVALID');
  return db.transaction(async tx => {
    const { rowCount } = await tx.query(`UPDATE privacy_legal_holds SET released_at = now(), release_approval_ref = $3 WHERE tenant_id = $1 AND hold_id = $2 AND released_at IS NULL`,
      [tenantId, holdId, approvalRef]);
    if (rowCount !== 1) throw new Error('LEGAL_HOLD_NOT_ACTIVE');
    await recordAudit(tx, tenantId, { actor: 'cli', kind: 'PRIVACY_LEGAL_HOLD_RELEASED', outcome: 'OK', target: holdId, detail: { approvalRef } });
    return { released: holdId };
  });
}

// --- Data-subject requests -------------------------------------------------------------------------------------------------------------
export type RequestKind = 'ACCESS' | 'CORRECTION' | 'ERASURE' | 'OBJECTION' | 'RESTRICTION';
export const REQUEST_KINDS: readonly RequestKind[] = ['ACCESS', 'CORRECTION', 'ERASURE', 'OBJECTION', 'RESTRICTION'];
/** A wallet subject is never stored: only this keyed fingerprint (its own subkey of the admin secret). */
export function walletSubject(adminKey: Buffer, wallet: string): { ref: string; account: string } {
  const account = wallet.trim(), normalized = /^0x/i.test(account) ? account.toLowerCase() : account;
  need(EVM.test(normalized) || SOLANA.test(normalized), 'WALLET_ADDRESS_INVALID');
  const key = Buffer.from(hkdfSync('sha256', adminKey, 'flofi', 'flofi/privacy-request-subject/v1', 32));
  return { ref: createHmac('sha256', key).update(normalized).digest('hex').slice(0, 32), account: normalized };
}
type RequestRow = { request_id: string; kind: RequestKind; subject_kind: 'WALLET' | 'ADMIN_PRINCIPAL'; subject_ref: string; state: string };
async function loadRequest(db: Queryable, tenantId: string, requestId: string): Promise<RequestRow> {
  need(/^dsr_[a-z2-7]{26}$/.test(requestId), 'PRIVACY_REQUEST_INVALID');
  const { rows } = await db.query<RequestRow>(`SELECT request_id, kind, subject_kind, subject_ref, state FROM privacy_requests WHERE tenant_id = $1 AND request_id = $2 FOR UPDATE`,
    [tenantId, requestId]);
  if (!rows[0]) throw new Error('PRIVACY_REQUEST_NOT_FOUND');
  return rows[0];
}
export async function openPrivacyRequest(db: Database, tenantId: string, kind: RequestKind, subject: { kind: 'WALLET' | 'ADMIN_PRINCIPAL'; ref: string }): Promise<Record<string, unknown>> {
  need(REQUEST_KINDS.includes(kind), 'PRIVACY_REQUEST_KIND_INVALID');
  need(subject.kind === 'WALLET' ? /^[0-9a-f]{32}$/.test(subject.ref) : /^adm_[a-z2-7]{26}$/.test(subject.ref), 'PRIVACY_SUBJECT_INVALID');
  return db.transaction(async tx => {
    const requestId = typedId('dsr');
    await tx.query(`INSERT INTO privacy_requests (tenant_id, request_id, kind, subject_kind, subject_ref, state) VALUES ($1, $2, $3, $4, $5, 'RECEIVED')`,
      [tenantId, requestId, kind, subject.kind, subject.ref]);
    await recordAudit(tx, tenantId, { actor: 'cli', kind: 'PRIVACY_REQUEST_RECEIVED', outcome: 'OK', target: requestId, detail: { requestKind: kind, subjectKind: subject.kind } });
    return { requestId, state: 'RECEIVED' };
  });
}
export async function decidePrivacyRequest(db: Database, tenantId: string, requestId: string, decision: 'APPROVED' | 'REJECTED', decisionCode: string,
  approvalRef: string): Promise<Record<string, unknown>> {
  need(decision === 'APPROVED' || decision === 'REJECTED', 'PRIVACY_DECISION_INVALID');
  need(CODE.test(decisionCode), 'PRIVACY_DECISION_CODE_INVALID');
  need(APPROVAL_REF.test(approvalRef), 'APPROVAL_REF_INVALID');
  return db.transaction(async tx => {
    const request = await loadRequest(tx, tenantId, requestId);
    if (request.state !== 'RECEIVED') throw new Error('PRIVACY_REQUEST_STATE_INVALID');
    await tx.query(`UPDATE privacy_requests SET state = $3, decision_code = $4, approval_ref = $5, decided_at = now() WHERE tenant_id = $1 AND request_id = $2`,
      [tenantId, requestId, decision, decisionCode, approvalRef]);
    await recordAudit(tx, tenantId, { actor: 'cli', kind: 'PRIVACY_REQUEST_DECIDED', outcome: 'OK', target: requestId, detail: { decision, decisionCode, approvalRef } });
    return { requestId, state: decision };
  });
}
async function complete(tx: Queryable, tenantId: string, requestId: string, result: Record<string, string | number | boolean>): Promise<void> {
  await tx.query(`UPDATE privacy_requests SET state = 'COMPLETED', completed_at = now(), result = $3::jsonb WHERE tenant_id = $1 AND request_id = $2`,
    [tenantId, requestId, JSON.stringify(result)]);
  await recordAudit(tx, tenantId, { actor: 'cli', kind: 'PRIVACY_REQUEST_COMPLETED', outcome: 'OK', target: requestId, detail: result });
}
/** The subject's resolved scope: the wallet (re-supplied by the operator, verified against the stored fingerprint) or an admin principal. */
function subjectOf(request: RequestRow, adminKey: Buffer | null, wallet: string | null): { account: string | null; principal: string | null } {
  if (request.subject_kind === 'ADMIN_PRINCIPAL') return { account: null, principal: request.subject_ref };
  need(adminKey !== null && wallet !== null, 'PRIVACY_WALLET_REQUIRED');
  const subject = walletSubject(adminKey!, wallet!);
  need(subject.ref === request.subject_ref, 'PRIVACY_SUBJECT_MISMATCH');
  return { account: subject.account, principal: null };
}
type TextRow = { text_id: string; purpose: string; run_id: string | null; created_at: Date; expires_at: Date; body: string; held: boolean };
const TEXT_LIMIT = 5000;
/**
 * The texts about a subject: notes and reasons on their execution runs (including runs they purged, through the purge audit), on their
 * multi-step workflow runs and delegated executions, or written by them as an administrator. Platform and AI notes are about no one.
 */
const SUBJECT_TEXT = `t.tenant_id = $1 AND (($2::text IS NOT NULL AND (
      t.run_id IN (SELECT run_id FROM execution_runs WHERE tenant_id = $1 AND owner_account = $2)
      OR t.run_id IN (SELECT run_id FROM execution_purge_audit WHERE tenant_id = $1 AND owner_account = $2)
      OR t.incident_id IN (SELECT 'wfr:' || run_id FROM workflow_runs WHERE tenant_id = $1 AND owner_account = $2)
      OR t.incident_id IN (SELECT 'dex:' || execution_id FROM delegated_executions WHERE tenant_id = $1 AND owner_account = $2)))
    OR ($3::text IS NOT NULL AND t.created_by = $3))`;
const subjectTexts = (tx: Queryable, tenantId: string, s: { account: string | null; principal: string | null }) => tx.query<TextRow>(`SELECT t.text_id, t.purpose, t.run_id,
    t.created_at, t.expires_at, t.body, ${HELD_TEXT} AS held FROM admin_support_texts t WHERE ${SUBJECT_TEXT} ORDER BY t.created_at LIMIT ${TEXT_LIMIT + 1}`,
[tenantId, s.account, s.principal]);

/**
 * ACCESS: what the Support & Recovery records hold about the subject, for the operator to compile the reply. Read-only apart from completing the
 * request. Lookups are matched by recomputing the wallet's fingerprints under every quarter key that still exists (and the legacy v1 key).
 */
export async function privacyAccess(db: Database, tenantId: string, requestId: string, adminKey: Buffer | null, wallet: string | null,
  includeText: boolean): Promise<Record<string, unknown>> {
  return db.transaction(async tx => {
    const request = await loadRequest(tx, tenantId, requestId);
    need(request.kind === 'ACCESS' && request.state === 'APPROVED', 'PRIVACY_REQUEST_STATE_INVALID');
    const s = subjectOf(request, adminKey, wallet);
    const [runs, texts] = await Promise.all([
      s.account ? tx.query<{ flow: string; n: number }>(`SELECT flow, count(*)::int AS n FROM execution_runs WHERE tenant_id = $1 AND owner_account = $2 GROUP BY flow ORDER BY flow`,
        [tenantId, s.account]) : Promise.resolve({ rows: [] as { flow: string; n: number }[] }),
      subjectTexts(tx, tenantId, s)]);
    let lookups: { event_id: string; at: Date; actor: string; type: string }[] = [], unlinkablePeriods: string[] = [];
    if (s.account && adminKey) {
      const prints = await candidateFingerprints(tx, tenantId, adminKey, s.account);
      unlinkablePeriods = prints.unavailablePeriods;
      lookups = (await tx.query<{ event_id: string; at: Date; actor: string; type: string }>(`SELECT event_id::text, at, actor, detail->>'type' AS type FROM admin_audit_events
        WHERE tenant_id = $1 AND kind = 'SUPPORT_SEARCH' AND ((NOT detail ? 'fpv' AND detail->>'fingerprint' = $2)
          OR (detail->>'fpv' = '2' AND (detail->>'period') || ':' || (detail->>'kid') || '=' || (detail->>'fingerprint') = ANY($3::text[])))
        ORDER BY at LIMIT 1000`, [tenantId, prints.v1, [...prints.v2].map(([period, print]) => `${period}=${print}`)])).rows;
    }
    const principalEvents = s.principal ? (await tx.query<{ kind: string; n: number }>(`SELECT kind, count(*)::int AS n FROM admin_audit_events WHERE tenant_id = $1 AND actor = $2
      GROUP BY kind ORDER BY kind`, [tenantId, s.principal])).rows : [];
    const truncated = texts.rows.length > TEXT_LIMIT;
    await complete(tx, tenantId, requestId, { runs: runs.rows.reduce((n, r) => n + r.n, 0), supportTexts: Math.min(texts.rows.length, TEXT_LIMIT), textsTruncated: truncated,
      lookups: lookups.length, unlinkablePeriods: unlinkablePeriods.length });
    return { requestId, subjectKind: request.subject_kind, textsTruncated: truncated,
      executionRuns: runs.rows, supportTexts: texts.rows.slice(0, TEXT_LIMIT).map(t => ({ textRef: t.text_id, purpose: t.purpose, runId: t.run_id, createdAt: t.created_at.toISOString(),
        expiresAt: t.expires_at.toISOString(), ...includeText ? { body: t.body } : {} })),
      supportLookups: lookups.map(l => ({ eventId: l.event_id, at: l.at.toISOString(), administrator: l.actor, identifierType: l.type })),
      administratorAuditEvents: principalEvents,
      limits: ['Lookups audited in quarters whose key was destroyed (or wrapped under a rotated admin secret) can no longer be matched: ' + (unlinkablePeriods.join(', ') || 'none'),
        'Texts written before this build are inline in the append-only audit table and are reported by the owner procedure in the build report.',
        'Requests opened before an admin-secret rotation can no longer be matched to their wallet; v1 lookups stop matching after a rotation.'] };
  });
}

/**
 * ERASURE: deletes the subject's Support texts (reasons and notes about their executions, or written by them as an administrator) that no legal
 * hold covers. The audit skeleton, the execution records and lookup fingerprints are kept, and the result says so.
 */
export async function privacyErase(db: Database, tenantId: string, requestId: string, adminKey: Buffer | null, wallet: string | null): Promise<Record<string, unknown>> {
  return db.transaction(async tx => {
    await serialize(tx, tenantId);
    const request = await loadRequest(tx, tenantId, requestId);
    need(request.kind === 'ERASURE' && request.state === 'APPROVED', 'PRIVACY_REQUEST_STATE_INVALID');
    const s = subjectOf(request, adminKey, wallet), params = [tenantId, s.account, s.principal];
    // One statement over every matching text (no row cap), never one a hold covers.
    const deleted = (await tx.query(`DELETE FROM admin_support_texts t WHERE ${SUBJECT_TEXT} AND NOT ${HELD_TEXT}`, params)).rowCount;
    const held = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_support_texts t WHERE ${SUBJECT_TEXT}`, params)).rows[0]!.n;
    const result = { supportTextsErased: deleted, keptByLegalHold: held, auditSkeletonRetained: true, executionRecordsNotInScope: true,
      lookupFingerprintsRetainedUntilQuarterKeyDestroyed: true };
    await recordAudit(tx, tenantId, { actor: 'cli', kind: 'PRIVACY_ERASURE_APPLIED', outcome: 'OK', target: requestId, detail: { erased: deleted, keptByLegalHold: result.keptByLegalHold } });
    await complete(tx, tenantId, requestId, result);
    return { requestId, ...result };
  });
}
/** CORRECTION / OBJECTION / RESTRICTION (handled by a correcting note, a hold or a decision recorded elsewhere): closes the request with a code. */
export async function completePrivacyRequest(db: Database, tenantId: string, requestId: string, outcomeCode: string): Promise<Record<string, unknown>> {
  need(CODE.test(outcomeCode), 'PRIVACY_OUTCOME_CODE_INVALID');
  return db.transaction(async tx => {
    const request = await loadRequest(tx, tenantId, requestId);
    need(request.state === 'APPROVED' && ['CORRECTION', 'OBJECTION', 'RESTRICTION'].includes(request.kind), 'PRIVACY_REQUEST_STATE_INVALID');
    await complete(tx, tenantId, requestId, { outcome: outcomeCode });
    return { requestId, state: 'COMPLETED', outcome: outcomeCode };
  });
}
