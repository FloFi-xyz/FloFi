// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: preview, atomic execution and verification of the registered recovery actions (`registry.ts`).
 *
 *   preview    reads the run's recovery facts and returns the action's eligibility, its declared effects and a `stateToken` fingerprint.
 *   execute    one short READ COMMITTED transaction: a per-tenant advisory lock (recoveries are serialized), replay a completed request with
 *              the same idempotency key, the rate limit, then lock the run's projection row (FOR UPDATE — the row the worker's dead-letter and
 *              the projector write) and re-read every fact in a fresh statement,
 *              require the preview's `stateToken`, re-check eligibility and the retry limit, queue the task under the run's original
 *              identity (ON CONFLICT on the open-task unique index: never two open tasks), clear the attention flag only when no other
 *              stopped task holds it, and append the audit record carrying the operation id. Nothing is written unless all of it commits.
 *   verify     re-reads the task and the run: queued/running → pending verification; finished with the expected postcondition → resolved;
 *              stopped again → failed; anything else → inconclusive. "Accepted" is never reported as "resolved".
 *
 * Every refusal is audited (bounded per window, like refused sign-ins). The operator's reason is stored, bounded and control-character free;
 * no address, key, transcript or payload is recorded.
 */
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { typedId } from '../../platform/ids.ts';
import { recordAudit } from '../store.ts';
import { attentionClearable, RECOVERY_ACTIONS, RETRY_WINDOW_DAYS, stateToken, type Eligibility, type RecoveryActionId, type RecoveryWorkKind,
  type RunRecoveryFacts, type WorkFact, type WorkState } from './registry.ts';

export const RECOVERY_AUDIT_KIND = 'SUPPORT_RECOVERY';
export const RECOVERY_RATE_WINDOW_MS = 600_000, RECOVERY_RATE_LIMIT = 30, REFUSAL_AUDIT_MAX = 200, IDEMPOTENCY_WINDOW_MS = 86_400_000;
/** A run id as stored; never a wallet- or hash-shaped `0x…` string (those would put an address into the audit trail). */
export const RUN_ID = /^(?!0[xX])[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,64}$/, STATE_TOKEN = /^[0-9a-f]{32}$/;

export class RecoveryRefusal extends Error {
  constructor(readonly code: string, readonly status: number, readonly reason: string | null = null) { super(code); }
}
type Host = { readonly db: Database; readonly tenantId: string };
type FactsRow = { run_id: string; flow: string; status: string; needs_observation: boolean; attention_required: boolean; has_evidence: boolean; log_version: string;
  evidence_archived: boolean; latest: { id: string; kind: string; state: WorkState; last_error: string | null; deliveries: number; created_at: string; completed_at: string | null }[] | null };

const workFact = (row: NonNullable<FactsRow['latest']>[number]): WorkFact => ({ id: row.id, kind: row.kind, state: row.state, lastError: row.last_error,
  deliveries: row.deliveries, createdAt: new Date(row.created_at), completedAt: row.completed_at ? new Date(row.completed_at) : null });

const FACTS_SELECT = `SELECT r.run_id, r.flow, r.status, r.needs_observation, r.attention_required, r.has_evidence, r.log_version::text AS log_version,
    EXISTS (SELECT 1 FROM evidence_objects e WHERE e.tenant_id = r.tenant_id AND e.run_id = r.run_id) AS evidence_archived,
    (SELECT json_agg(json_build_object('id', x.id::text, 'kind', x.kind, 'state', x.state, 'last_error', x.last_error, 'deliveries', x.deliveries,
        'created_at', x.created_at, 'completed_at', x.completed_at))
      FROM (SELECT DISTINCT ON (w.kind, w.dedupe_key) w.id, w.kind, w.state, w.last_error, w.deliveries, w.created_at, w.completed_at FROM work_items w
        WHERE w.tenant_id = r.tenant_id AND w.run_id = r.run_id ORDER BY w.kind, w.dedupe_key, w.id DESC) x) AS latest
  FROM execution_runs r`;
const RECENT_RECOVERIES = `SELECT detail->>'runId' AS run_id, count(*)::int AS n FROM admin_audit_events WHERE tenant_id = $1 AND kind = $2 AND outcome = 'OK'
    AND at >= $3::timestamptz - make_interval(days => $4) AND detail->>'runId' = ANY($5::text[]) GROUP BY 1`;
/**
 * `latest` holds the newest task per (kind, dedupe key) of the run. A stopped task is unresolved unless a later run of the SAME task (same kind and
 * dedupe key) superseded it; the recovery kinds use the run's own dedupe key, so their newest task per kind is the one an action re-queues.
 */
function factsOf(row: FactsRow, recentRecoveries: number): RunRecoveryFacts {
  const latest = (row.latest ?? []).map(workFact), newest = new Map<string, WorkFact>();
  for (const item of latest) if (item.kind === 'reconcile' || item.kind === 'evidence.archive') {
    const known = newest.get(item.kind);
    if (!known || BigInt(item.id) > BigInt(known.id)) newest.set(item.kind, item);
  }
  return { runId: row.run_id, flow: row.flow, status: row.status, needsObservation: row.needs_observation, attentionRequired: row.attention_required,
    hasEvidence: row.has_evidence, evidenceArchived: row.evidence_archived, logVersion: Number(row.log_version), latest: Object.fromEntries(newest),
    unresolvedDeadKinds: [...new Set(latest.filter(item => item.state === 'DEAD').map(item => item.kind))], recentRecoveries };
}

/** The recovery facts of many runs at once (incident lists), keyed by run id. Bounded by the caller's id list. */
export async function loadRunsFacts(db: Queryable, tenantId: string, runIds: readonly string[], now: Date): Promise<Map<string, RunRecoveryFacts>> {
  const ids = [...new Set(runIds.filter(id => RUN_ID.test(id)))].slice(0, 1000);
  if (!ids.length) return new Map();
  const [{ rows }, recent] = await Promise.all([db.query<FactsRow>(`${FACTS_SELECT} WHERE r.tenant_id = $1 AND r.run_id = ANY($2::text[])`, [tenantId, ids]),
    db.query<{ run_id: string; n: number }>(RECENT_RECOVERIES, [tenantId, RECOVERY_AUDIT_KIND, now, RETRY_WINDOW_DAYS, ids])]);
  const counts = new Map(recent.rows.map(row => [row.run_id, row.n]));
  return new Map(rows.map(row => [row.run_id, factsOf(row, counts.get(row.run_id) ?? 0)]));
}

/**
 * The run's recovery facts, or null when no such run exists in this tenant. With `lock`, the projection row is locked FIRST, in its own statement,
 * and the facts are read by a later statement: under READ COMMITTED that statement takes a fresh snapshot, so it sees every transaction that
 * committed while this one waited for the lock (the queue's dead-letter must hold this row to commit). The row stays locked until the end.
 */
export async function loadRunFacts(db: Queryable, tenantId: string, runId: string, now: Date, lock = false): Promise<RunRecoveryFacts | null> {
  if (!RUN_ID.test(runId)) return null;
  if (lock && !(await db.query(`SELECT 1 FROM execution_runs WHERE tenant_id = $1 AND run_id = $2 FOR UPDATE`, [tenantId, runId])).rows.length) return null;
  const { rows } = await db.query<FactsRow>(`${FACTS_SELECT} WHERE r.tenant_id = $1 AND r.run_id = $2`, [tenantId, runId]);
  const row = rows[0];
  if (!row) return null;
  const recent = await db.query<{ run_id: string; n: number }>(RECENT_RECOVERIES, [tenantId, RECOVERY_AUDIT_KIND, now, RETRY_WINDOW_DAYS, [runId]]);
  return factsOf(row, recent.rows[0]?.n ?? 0);
}

export type RecoveryPreview = {
  readonly action: RecoveryActionId; readonly runId: string; readonly eligibility: Eligibility; readonly stateToken: string;
  readonly current: { readonly status: string; readonly needsObservation: boolean; readonly attentionRequired: boolean; readonly lastTask: WorkFact | null;
    readonly attentionWouldClear: boolean };
};
export async function previewRecovery(host: Host, runId: string, action: RecoveryActionId, now: Date): Promise<RecoveryPreview | null> {
  const facts = await loadRunFacts(host.db, host.tenantId, runId, now);
  if (!facts) return null;
  const definition = RECOVERY_ACTIONS[action];
  return { action, runId, eligibility: definition.check(facts), stateToken: stateToken(facts, action),
    current: { status: facts.status, needsObservation: facts.needsObservation, attentionRequired: facts.attentionRequired, lastTask: facts.latest[definition.workKind] ?? null,
      attentionWouldClear: attentionClearable(facts, definition.workKind) } };
}

export type VerificationStatus = 'PENDING_VERIFICATION' | 'RESOLVED' | 'STOPPED_AGAIN' | 'INCONCLUSIVE';
export type Verification = { readonly status: VerificationStatus; readonly detail: string; readonly taskState: WorkState | 'NOT_RETAINED'; readonly runStatus: string | null;
  readonly code: string | null };
export type RecoveryResult = { readonly operationId: string; readonly action: RecoveryActionId; readonly runId: string; readonly replayed: boolean;
  readonly workItemId: string; readonly attentionCleared: boolean; readonly verification: Verification };
export type RecoveryRequest = { readonly runId: string; readonly action: RecoveryActionId; readonly stateToken: string; readonly idempotencyKey: string; readonly reason: string };

type Replay = { detail: { operationId: string; action: string; runId: string; workItemId: string; attentionCleared: boolean } };
/**
 * Runs one registered recovery action atomically. Throws `RecoveryRefusal` for anything that is not executed (the caller audits it).
 */
export async function executeRecovery(host: Host, actor: string, request: RecoveryRequest, now: Date): Promise<RecoveryResult> {
  const definition = RECOVERY_ACTIONS[request.action], kind = definition.workKind;
  const committed = await host.db.transaction(async tx => {
    // One recovery at a time per tenant (they are rare and short): idempotency keys and the rate limit are then checked consistently.
    // Lock order is always this advisory lock, then the run row — the queue and projectors never take the advisory lock, so no cycle.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`flofi.support.recovery:${host.tenantId}`]);
    const prior = await tx.query<Replay>(`SELECT detail FROM admin_audit_events WHERE tenant_id = $1 AND kind = $2 AND outcome = 'OK'
        AND at >= $3::timestamptz - make_interval(secs => $4::double precision / 1000) AND detail->>'idempotencyKey' = $5 LIMIT 1`,
    [host.tenantId, RECOVERY_AUDIT_KIND, now, IDEMPOTENCY_WINDOW_MS, request.idempotencyKey]);
    if (prior.rows[0]) {
      const detail = prior.rows[0].detail;
      if (detail.runId !== request.runId || detail.action !== request.action) throw new RecoveryRefusal('SUPPORT_IDEMPOTENCY_KEY_REUSED', 409);
      return { operationId: detail.operationId, workItemId: detail.workItemId, attentionCleared: detail.attentionCleared === true, replayed: true };
    }
    const recent = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_audit_events WHERE tenant_id = $1 AND kind = $2 AND outcome = 'OK' AND at >= $3`,
      [host.tenantId, RECOVERY_AUDIT_KIND, new Date(now.getTime() - RECOVERY_RATE_WINDOW_MS)]);
    if ((recent.rows[0]?.n ?? 0) >= RECOVERY_RATE_LIMIT) throw new RecoveryRefusal('SUPPORT_RECOVERY_RATE_LIMITED', 429);
    const facts = await loadRunFacts(tx, host.tenantId, request.runId, now, true);
    if (!facts) throw new RecoveryRefusal('SUPPORT_RUN_NOT_FOUND', 404);
    if (stateToken(facts, request.action) !== request.stateToken) throw new RecoveryRefusal('SUPPORT_PREVIEW_STALE', 409,
      'The execution changed since the preview. Review the new state before trying again.');
    const eligibility = definition.check(facts);
    if (!eligibility.eligible) throw new RecoveryRefusal(eligibility.code, 409, eligibility.reason);
    // The task exactly as the flow's projector and the sweeper create it: same kind, dedupe key and payload.
    const queued = await tx.query<{ id: string }>(`INSERT INTO work_items (tenant_id, kind, dedupe_key, run_id, payload, state, available_at)
        VALUES ($1, $2, $3 || ':' || $4, $4, jsonb_build_object('namespace', $3::text, 'runId', $4::text), 'READY', now())
        ON CONFLICT (tenant_id, kind, dedupe_key) WHERE state IN ('READY', 'LEASED') DO NOTHING RETURNING id::text AS id`,
    [host.tenantId, kind, facts.flow, facts.runId]);
    if (!queued.rows[0]) throw new RecoveryRefusal('SUPPORT_ALREADY_SCHEDULED', 409, 'A task for this execution was queued by FloFi itself in the meantime.');
    const clear = attentionClearable(facts, kind);
    if (clear) await tx.query(`UPDATE execution_runs SET attention_required = false WHERE tenant_id = $1 AND run_id = $2 AND attention_required`, [host.tenantId, facts.runId]);
    const operationId = typedId('rop'), last = facts.latest[kind];
    await recordAudit(tx, host.tenantId, { actor, kind: RECOVERY_AUDIT_KIND, outcome: 'OK', code: null, target: `run:${facts.runId}`.slice(0, 120),
      detail: { operationId, action: request.action, runId: facts.runId, flow: facts.flow, idempotencyKey: request.idempotencyKey, workItemId: queued.rows[0].id,
        workKind: kind, attentionCleared: clear, eligibility: 'ELIGIBLE', precondition: last ? `${last.state}:${last.lastError ?? 'NONE'}`.slice(0, 120) : 'NO_TASK',
        runStatus: facts.status, reason: request.reason } });
    return { operationId, workItemId: queued.rows[0].id, attentionCleared: clear, replayed: false };
  });
  // Committed: a failing read-back never turns this into a failure report (the task is queued and audited).
  const verification: Verification = await verifyRecovery(host, { runId: request.runId, action: request.action, workItemId: committed.workItemId })
    .catch(() => ({ status: 'INCONCLUSIVE', taskState: 'NOT_RETAINED', runStatus: null, code: 'SUPPORT_VERIFICATION_UNAVAILABLE',
      detail: 'The recovery was recorded, but its state could not be read back just now. Check it again in a moment.' }));
  return { ...committed, action: request.action, runId: request.runId, verification };
}

type VerifyRow = { item_state: WorkState | null; last_error: string | null; status: string | null; needs_observation: boolean | null; evidence_archived: boolean | null };
/** Re-reads the queued task and the run: the authoritative state of the recovery's postcondition. */
export async function verifyRecovery(host: Host, input: { readonly runId: string; readonly action: RecoveryActionId; readonly workItemId: string }): Promise<Verification> {
  const { rows } = await host.db.query<VerifyRow>(`SELECT
      (SELECT w.state FROM work_items w WHERE w.tenant_id = $1 AND w.id = $3::bigint AND w.run_id = $2) AS item_state,
      (SELECT w.last_error FROM work_items w WHERE w.tenant_id = $1 AND w.id = $3::bigint AND w.run_id = $2) AS last_error,
      r.status, r.needs_observation, EXISTS (SELECT 1 FROM evidence_objects e WHERE e.tenant_id = $1 AND e.run_id = $2) AS evidence_archived
    FROM (SELECT 1) one LEFT JOIN execution_runs r ON r.tenant_id = $1 AND r.run_id = $2`, [host.tenantId, input.runId, input.workItemId]);
  return verification(RECOVERY_ACTIONS[input.action].workKind, rows[0]!);
}

export function verification(kind: RecoveryWorkKind, row: VerifyRow): Verification {
  const runStatus = row.status, taskState = row.item_state ?? 'NOT_RETAINED';
  const base = { taskState, runStatus, code: null } as const;
  if (taskState === 'READY') return { ...base, status: 'PENDING_VERIFICATION', detail: 'Queued. No worker has picked it up yet, so the problem is not resolved yet.' };
  if (taskState === 'LEASED') return { ...base, status: 'PENDING_VERIFICATION', detail: 'A worker is processing it now. The result is not known yet.' };
  if (taskState === 'DEAD') return { ...base, status: 'STOPPED_AGAIN', code: row.last_error, detail: 'The task stopped again without a final result. The execution is flagged for attention again.' };
  if (kind === 'reconcile') {
    if (row.needs_observation === false) return { ...base, status: 'RESOLVED', detail: `The check finished: the execution no longer needs observation (status ${runStatus}).` };
    return { ...base, status: 'INCONCLUSIVE', detail: taskState === 'DONE' ? 'The task finished, but the execution still needs observation.'
      : 'The task is no longer retained and the execution still needs observation.' };
  }
  if (row.evidence_archived) return { ...base, status: 'RESOLVED', detail: 'The evidence is archived.' };
  return { ...base, status: 'INCONCLUSIVE', detail: taskState === 'DONE' ? 'The task finished, but no archived evidence is recorded (the bundle may no longer qualify).'
    : 'The task is no longer retained and no archived evidence is recorded.' };
}

/** Audits a refused or failed recovery request, bounded per window so a flood of refusals cannot flood the audit trail (it is still refused). */
export async function auditRecoveryRefusal(db: Database, tenantId: string, actor: string, code: string, detail: Readonly<Record<string, string | number | boolean | null>>,
  now: Date, outcome: 'REFUSED' | 'FAILED' = 'REFUSED'): Promise<void> {
  try {
    // Counted per administrator, so one session cannot use up the record of another's refusals.
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_audit_events WHERE tenant_id = $1 AND kind = $2 AND outcome <> 'OK' AND at >= $3
      AND actor = $4`, [tenantId, RECOVERY_AUDIT_KIND, new Date(now.getTime() - RECOVERY_RATE_WINDOW_MS), actor]);
    if ((rows[0]?.n ?? 0) >= REFUSAL_AUDIT_MAX) return;
    const runId = typeof detail.runId === 'string' ? detail.runId : null;
    await recordAudit(db, tenantId, { actor, kind: RECOVERY_AUDIT_KIND, outcome, code, target: runId ? `run:${runId}`.slice(0, 120) : null, detail });
  } catch { /* An unavailable audit store never turns a refusal into an acceptance. */ }
}

export type HistoryEntry = { readonly eventId: string; readonly at: string; readonly actor: string; readonly outcome: 'OK' | 'REFUSED' | 'FAILED'; readonly code: string | null;
  readonly operationId: string | null; readonly action: string | null; readonly runId: string | null; readonly reason: string | null; readonly attentionCleared: boolean;
  readonly verification: Verification | null };
type HistoryRow = { event_id: string; at: Date; actor: string; outcome: HistoryEntry['outcome']; code: string | null; detail: Record<string, unknown> | null };
const str = (value: unknown) => typeof value === 'string' ? value : null;
/** Recovery attempts, newest first (bounded), each successful one with its current verification. Optionally for one run. */
export async function recoveryHistory(host: Host, now: Date, options: { readonly runId?: string; readonly days?: number; readonly limit?: number } = {}): Promise<HistoryEntry[]> {
  const days = Math.min(90, Math.max(1, options.days ?? 30)), limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const { rows } = await host.db.query<HistoryRow>(`SELECT event_id::text, at, actor, outcome, code, detail FROM admin_audit_events
    WHERE tenant_id = $1 AND kind = $2 AND at >= $3 AND ($4::text IS NULL OR detail->>'runId' = $4) ORDER BY at DESC, event_id DESC LIMIT $5`,
  [host.tenantId, RECOVERY_AUDIT_KIND, new Date(now.getTime() - days * 86_400_000), options.runId ?? null, limit]);
  const ok = rows.filter(row => row.outcome === 'OK' && str(row.detail?.workItemId) && str(row.detail?.runId));
  const facts = ok.length ? (await host.db.query<VerifyRow & { event_id: string }>(`SELECT x.event_id, w.state AS item_state, w.last_error, r.status, r.needs_observation,
        EXISTS (SELECT 1 FROM evidence_objects e WHERE e.tenant_id = $1 AND e.run_id = x.run_id) AS evidence_archived
      FROM unnest($2::text[], $3::text[], $4::bigint[]) AS x(event_id, run_id, item_id)
      LEFT JOIN work_items w ON w.tenant_id = $1 AND w.id = x.item_id AND w.run_id = x.run_id
      LEFT JOIN execution_runs r ON r.tenant_id = $1 AND r.run_id = x.run_id`,
  [host.tenantId, ok.map(row => row.event_id), ok.map(row => str(row.detail!.runId)!), ok.map(row => str(row.detail!.workItemId)!)])).rows : [];
  const byEvent = new Map(facts.map(row => [row.event_id, row]));
  return rows.map(row => {
    const detail = row.detail ?? {}, action = str(detail.action), fact = byEvent.get(row.event_id);
    const kind: RecoveryWorkKind | null = action && Object.hasOwn(RECOVERY_ACTIONS, action) ? RECOVERY_ACTIONS[action as RecoveryActionId].workKind : null;
    return { eventId: row.event_id, at: row.at.toISOString(), actor: row.actor, outcome: row.outcome, code: row.code, operationId: str(detail.operationId), action,
      runId: str(detail.runId), reason: str(detail.reason), attentionCleared: detail.attentionCleared === true,
      verification: row.outcome === 'OK' && fact && kind ? verification(kind, fact) : null };
  });
}

export type HistorySummary = { readonly resolved: number; readonly pending: number; readonly stoppedAgain: number; readonly inconclusive: number; readonly refused: number;
  readonly total: number };
/** Counts over EVERY recovery attempt of the window (not a page of them): each successful one verified against the current task and run. */
export async function recoverySummary(host: Host, now: Date, days = 30): Promise<HistorySummary> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const [ok, refused] = await Promise.all([
    host.db.query<VerifyRow & { action: string | null }>(`SELECT a.detail->>'action' AS action, w.state AS item_state, w.last_error, r.status, r.needs_observation,
        EXISTS (SELECT 1 FROM evidence_objects e WHERE e.tenant_id = a.tenant_id AND e.run_id = a.detail->>'runId') AS evidence_archived
      FROM admin_audit_events a
      LEFT JOIN work_items w ON w.tenant_id = a.tenant_id AND w.id = (a.detail->>'workItemId')::bigint AND w.run_id = a.detail->>'runId'
      LEFT JOIN execution_runs r ON r.tenant_id = a.tenant_id AND r.run_id = a.detail->>'runId'
      WHERE a.tenant_id = $1 AND a.kind = $2 AND a.outcome = 'OK' AND a.at >= $3 AND a.detail->>'workItemId' ~ '^[0-9]{1,18}$' LIMIT 10000`,
    [host.tenantId, RECOVERY_AUDIT_KIND, since]),
    host.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_audit_events WHERE tenant_id = $1 AND kind = $2 AND outcome <> 'OK' AND at >= $3`,
      [host.tenantId, RECOVERY_AUDIT_KIND, since]),
  ]);
  const statuses = ok.rows.map(row => row.action && Object.hasOwn(RECOVERY_ACTIONS, row.action)
    ? verification(RECOVERY_ACTIONS[row.action as RecoveryActionId].workKind, row).status : 'INCONCLUSIVE');
  const count = (status: VerificationStatus) => statuses.filter(s => s === status).length;
  return { resolved: count('RESOLVED'), pending: count('PENDING_VERIFICATION'), stoppedAgain: count('STOPPED_AGAIN'), inconclusive: count('INCONCLUSIVE'),
    refused: refused.rows[0]?.n ?? 0, total: statuses.length + (refused.rows[0]?.n ?? 0) };
}
