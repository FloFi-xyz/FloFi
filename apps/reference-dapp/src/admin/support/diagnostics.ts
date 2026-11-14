// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: support lookups and the execution diagnostic timeline.
 *
 * Search accepts only closed identifier shapes (transaction hash, wallet address, execution or workflow id, workflow-run id, delegated
 * execution id, incident id, background task id) — never free text — and returns at most SEARCH_LIMIT matches over existing indexes.
 * A wallet lookup links a person's wallet to their executions, so it needs the OPERATOR role. Every search is audited with the identifier
 * TYPE and a short keyed fingerprint of the value (enough to confirm later whether a given value was searched; the value itself is not
 * stored), and is rate-limited per administrator. Lookups are POSTs, so the value never appears in a URL, a request log or the browser
 * history. Results never show a full wallet address.
 *
 * The timeline reports what the durable journal and attempts show, marking each milestone OBSERVED (a recorded fact), INFERRED (implied by a
 * later recorded fact), UNKNOWN (the record cannot establish it — e.g. a submission whose result is unknown), UNAVAILABLE (this flow does not
 * record it) or NOT_REACHED. Nothing is invented and an unknown outcome is never shown as a failure.
 */
import { createHmac } from 'node:crypto';
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { recordAudit, type AdminRole } from '../store.ts';
import { classifyRun } from '../analytics/classify.ts';
import { submissionOf, type ExecutionSnapshot } from './incidents.ts';

export const SEARCH_LIMIT = 25, SEARCH_RATE_WINDOW_MS = 600_000, SEARCH_RATE_LIMIT = 120;
export type SearchKind = 'TRANSACTION_HASH' | 'WALLET' | 'WORKFLOW_RUN' | 'DELEGATED_EXECUTION' | 'INCIDENT' | 'WORK_ITEM' | 'EXECUTION_OR_WORKFLOW';
export const SEARCH_KIND_LABELS: Readonly<Record<SearchKind, string>> = { TRANSACTION_HASH: 'Transaction hash', WALLET: 'Wallet address', WORKFLOW_RUN: 'Multi-step workflow run',
  DELEGATED_EXECUTION: 'Delegated execution', INCIDENT: 'Incident', WORK_ITEM: 'Background task', EXECUTION_OR_WORKFLOW: 'Execution or workflow id' };
const INCIDENT_ID = /^(run|work|wfr|dex|platform|copilot):(?!0[xX])[A-Za-z0-9._-]{1,128}$/;

/** The identifier shape a query has, or null (rejected: support search never runs free-text queries). */
export function searchKind(raw: string): { readonly kind: SearchKind; readonly value: string } | null {
  const q = raw.trim();
  if (!q || q.length > 140) return null;
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) return { kind: 'TRANSACTION_HASH', value: q.toLowerCase() };
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return { kind: 'WALLET', value: q.toLowerCase() };
  if (/^[1-9A-HJ-NP-Za-km-z]{45,90}$/.test(q)) return { kind: 'TRANSACTION_HASH', value: q }; // a Solana transaction signature
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q) && !/^\d+$/.test(q)) return { kind: 'WALLET', value: q };
  if (/^wfr_[a-z2-7]{26}$/.test(q)) return { kind: 'WORKFLOW_RUN', value: q };
  if (/^dex_[a-z2-7]{26}$/.test(q)) return { kind: 'DELEGATED_EXECUTION', value: q };
  if (INCIDENT_ID.test(q)) return { kind: 'INCIDENT', value: q };
  if (/^[1-9][0-9]{0,17}$/.test(q)) return { kind: 'WORK_ITEM', value: q };
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(q)) return { kind: 'EXECUTION_OR_WORKFLOW', value: q };
  return null;
}
/**
 * A keyed fingerprint (HMAC-SHA-256 under the deployment's admin key, 16 hex): it confirms whether a known value was searched, but cannot be
 * reversed by hashing candidate addresses without the key.
 */
export const fingerprint = (key: Buffer, value: string) => createHmac('sha256', key).update(`support-search.${value}`).digest('hex').slice(0, 16);
export const shortAccount = (account: string) => account.length > 12 ? `${account.slice(0, 6)}…${account.slice(-4)}` : account;

export type SearchHit = { readonly type: 'run' | 'workflow-run' | 'delegated' | 'work' | 'incident'; readonly id: string; readonly incidentId: string; readonly label: string;
  readonly status: string; readonly at: string | null };
export type SearchResult = { readonly ok: true; readonly kind: SearchKind; readonly hits: readonly SearchHit[]; readonly truncated: boolean }
  | { readonly ok: false; readonly code: string };

type Host = { readonly db: Database; readonly tenantId: string };
type Row = { id: string; label: string; status: string; at: Date | null };

/** One audited, bounded, permission-checked support lookup. */
export async function supportSearch(host: Host, actor: { readonly principalId: string; readonly role: AdminRole }, raw: string, now: Date, key: Buffer): Promise<SearchResult> {
  const { db, tenantId } = host, parsed = searchKind(raw);
  const audit = (outcome: 'OK' | 'REFUSED', code: string | null, type: string, results: number | null) => recordAudit(db, tenantId, { actor: actor.principalId,
    kind: 'SUPPORT_SEARCH', outcome, code, detail: { type, fingerprint: parsed ? fingerprint(key, parsed.value) : null, results } }).catch(() => undefined);
  // The rate limit comes first, so even refused lookups cannot flood the audit trail.
  let recent: number;
  try {
    recent = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_audit_events WHERE tenant_id = $1 AND kind = 'SUPPORT_SEARCH' AND actor = $2 AND at >= $3`,
      [tenantId, actor.principalId, new Date(now.getTime() - SEARCH_RATE_WINDOW_MS)])).rows[0]?.n ?? 0;
  } catch { return { ok: false, code: 'SUPPORT_SEARCH_UNAVAILABLE' }; }
  if (recent >= SEARCH_RATE_LIMIT) return { ok: false, code: 'SUPPORT_SEARCH_RATE_LIMITED' };
  if (!parsed) { await audit('REFUSED', 'SUPPORT_SEARCH_INVALID', 'UNRECOGNISED', null); return { ok: false, code: 'SUPPORT_SEARCH_INVALID' }; }
  if (parsed.kind === 'WALLET' && actor.role !== 'OPERATOR') {
    await audit('REFUSED', 'SUPPORT_SEARCH_WALLET_NOT_PERMITTED', parsed.kind, null);
    return { ok: false, code: 'SUPPORT_SEARCH_WALLET_NOT_PERMITTED' };
  }
  const n = SEARCH_LIMIT + 1, v = parsed.value;
  const runs = (rows: Row[]): SearchHit[] => rows.map(row => ({ type: 'run', id: row.id, incidentId: `run:${row.id}`, label: row.label, status: row.status, at: row.at?.toISOString() ?? null }));
  // The lookup and its audit row commit together: if the audit cannot be written, nothing is returned (fail closed).
  const lookup = async (q: Queryable): Promise<SearchHit[]> => {
    let hits: SearchHit[];
    switch (parsed.kind) {
      case 'TRANSACTION_HASH':
        hits = runs((await q.query<Row>(`SELECT DISTINCT ON (r.run_id) r.run_id AS id, r.flow AS label, r.status, r.updated_at AS at FROM execution_attempts a
          JOIN execution_runs r ON r.tenant_id = a.tenant_id AND r.run_id = a.run_id WHERE a.tenant_id = $1 AND a.transaction_hash = $2 ORDER BY r.run_id LIMIT ${n}`, [tenantId, v])).rows);
        break;
      case 'WALLET': {
        const [own, flows, delegated] = await Promise.all([
          q.query<Row>(`SELECT run_id AS id, flow AS label, status, updated_at AS at FROM execution_runs WHERE tenant_id = $1 AND owner_account = $2
            ORDER BY updated_at DESC, run_id DESC LIMIT ${n}`, [tenantId, v]),
          q.query<Row>(`SELECT run_id AS id, 'workflow-run' AS label, state AS status, updated_at AS at FROM workflow_runs WHERE tenant_id = $1 AND owner_account = $2
            ORDER BY created_at DESC LIMIT ${n}`, [tenantId, v]),
          q.query<Row>(`SELECT execution_id AS id, 'delegated-execution' AS label, state AS status, updated_at AS at FROM delegated_executions
            WHERE tenant_id = $1 AND owner_account = $2 ORDER BY created_at DESC LIMIT ${n}`, [tenantId, v]),
        ]);
        hits = [...runs(own.rows),
          ...flows.rows.map(row => ({ type: 'workflow-run' as const, id: row.id, incidentId: `wfr:${row.id}`, label: row.label, status: row.status, at: row.at?.toISOString() ?? null })),
          ...delegated.rows.map(row => ({ type: 'delegated' as const, id: row.id, incidentId: `dex:${row.id}`, label: row.label, status: row.status, at: row.at?.toISOString() ?? null }))]
          .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
        break;
      }
      case 'WORKFLOW_RUN':
        hits = (await q.query<Row>(`SELECT run_id AS id, 'workflow-run' AS label, state AS status, updated_at AS at FROM workflow_runs WHERE tenant_id = $1 AND run_id = $2`, [tenantId, v]))
          .rows.map(row => ({ type: 'workflow-run', id: row.id, incidentId: `wfr:${row.id}`, label: row.label, status: row.status, at: row.at?.toISOString() ?? null }));
        break;
      case 'DELEGATED_EXECUTION':
        hits = (await q.query<Row>(`SELECT execution_id AS id, 'delegated-execution' AS label, state AS status, updated_at AS at FROM delegated_executions
          WHERE tenant_id = $1 AND execution_id = $2`, [tenantId, v])).rows.map(row => ({ type: 'delegated', id: row.id, incidentId: `dex:${row.id}`, label: row.label,
          status: row.status, at: row.at?.toISOString() ?? null }));
        break;
      case 'INCIDENT':
        hits = [{ type: 'incident', id: v, incidentId: v, label: 'Incident', status: '—', at: null }];
        break;
      case 'WORK_ITEM':
        hits = (await q.query<Row>(`SELECT id::text AS id, kind AS label, state AS status, coalesce(completed_at, updated_at) AS at FROM work_items WHERE tenant_id = $1 AND id = $2::bigint`,
          [tenantId, v])).rows.map(row => ({ type: 'work', id: row.id, incidentId: `work:${row.id}`, label: row.label, status: row.status, at: row.at?.toISOString() ?? null }));
        break;
      default: {
        const [byRun, byWorkflow] = await Promise.all([
          q.query<Row>(`SELECT run_id AS id, flow AS label, status, updated_at AS at FROM execution_runs WHERE tenant_id = $1 AND run_id = $2`, [tenantId, v]),
          q.query<Row>(`SELECT run_id AS id, flow AS label, status, updated_at AS at FROM execution_runs WHERE tenant_id = $1 AND workflow_id = $2
            ORDER BY created_at DESC LIMIT ${n}`, [tenantId, v]),
        ]);
        const seen = new Set<string>();
        hits = runs([...byRun.rows, ...byWorkflow.rows].filter(row => !seen.has(row.id) && seen.add(row.id)));
      }
    }
    return hits;
  };
  let all: SearchHit[];
  try {
    all = await db.transaction(async tx => {
      const found = await lookup(tx);
      await recordAudit(tx, tenantId, { actor: actor.principalId, kind: 'SUPPORT_SEARCH', outcome: 'OK', code: null,
        detail: { type: parsed.kind, fingerprint: fingerprint(key, parsed.value), results: Math.min(found.length, SEARCH_LIMIT) } });
      return found;
    });
  } catch { await audit('REFUSED', 'SUPPORT_SEARCH_UNAVAILABLE', parsed.kind, null); return { ok: false, code: 'SUPPORT_SEARCH_UNAVAILABLE' }; }
  return { ok: true, kind: parsed.kind, hits: all.slice(0, SEARCH_LIMIT), truncated: all.length > SEARCH_LIMIT };
}

export type Evidence = 'OBSERVED' | 'INFERRED' | 'UNKNOWN' | 'UNAVAILABLE' | 'NOT_REACHED';
export const EVIDENCE_LABELS: Readonly<Record<Evidence, string>> = { OBSERVED: 'Observed', INFERRED: 'Inferred', UNKNOWN: 'Unknown', UNAVAILABLE: 'Not recorded', NOT_REACHED: 'Not reached' };
export type Milestone = { readonly key: string; readonly label: string; readonly evidence: Evidence; readonly at: string | null; readonly detail: string };
export type JournalRow = { readonly sequence: number; readonly level: string; readonly entityId: string; readonly attemptId: string | null; readonly fromState: string | null;
  readonly toState: string; readonly recordedAt: Date };
export type AttemptRow = { readonly attemptId: string; readonly step: string; readonly state: string; readonly transactionHash: string | null; readonly reconciled: boolean;
  readonly createdAt: Date; readonly updatedAt: Date };

const iso = (date: Date | null | undefined) => date ? date.toISOString() : null;
const POST_BROADCAST = new Set(['PENDING', 'CONFIRMED', 'REVERTED', 'PARTIALLY_FILLED', 'SETTLED', 'REFUND_PENDING', 'REFUNDED']);
const FINAL_RESULT = new Set(['CONFIRMED', 'REVERTED', 'SETTLED', 'REFUNDED', 'NOT_FOUND']);
const MAYBE_SUBMITTED = new Set(['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'UNKNOWN', 'NOT_FOUND', 'RECONCILIATION_REQUIRED']);
const NEVER_SENT = new Set(['PREPARED', 'CANCELLED', 'EXPIRED']);

/** The eight support milestones of one execution, from its journal and attempts only. Pure. */
export function buildTimeline(run: ExecutionSnapshot, journal: readonly JournalRow[], attempts: readonly AttemptRow[]): Milestone[] {
  const workflow = (state: string) => journal.find(entry => entry.level === 'workflow' && entry.toState === state);
  const attemptEntry = (states: ReadonlySet<string>) => journal.find(entry => entry.level === 'attempt' && states.has(entry.toState));
  const hashed = attempts.find(a => a.transactionHash), c = classifyRun(run), submission = submissionOf(run);
  const broadcastSeen = attempts.findLast(a => POST_BROADCAST.has(a.state)) ?? null;
  const maybe = attempts.find(a => MAYBE_SUBMITTED.has(a.state) && !a.transactionHash) ?? null;
  // The result is observed only when every attempt that may have reached the network has a final result (a multi-step run with a confirmed
  // approval and an unknown swap is not "confirmed"), and the flow no longer asks to observe it.
  const unresolved = attempts.filter(a => !FINAL_RESULT.has(a.state) && !NEVER_SENT.has(a.state));
  const finalAttempt = !run.needsObservation && !unresolved.length ? attempts.findLast(a => FINAL_RESULT.has(a.state)) ?? null : null;
  const submitted = submission === 'YES', possiblySubmitted = submission !== 'NO';
  const authorized = workflow('AUTHORIZED');
  const anyAttemptPastPrepared = attempts.some(a => a.state !== 'PREPARED' && a.state !== 'CANCELLED');
  const laterThan = (n: number) => [!!workflow('REVIEWED') || !!workflow('SIMULATED'), !!workflow('SIMULATED'), !!authorized || anyAttemptPastPrepared, possiblySubmitted].slice(n).some(Boolean);
  const step = (key: string, label: string, entry: JournalRow | undefined, laterIndex: number, missing: string): Milestone => entry
    ? { key, label, evidence: 'OBSERVED', at: iso(entry.recordedAt), detail: `Journal: ${entry.fromState ?? '—'} → ${entry.toState}` }
    : laterThan(laterIndex) ? { key, label, evidence: 'INFERRED', at: null, detail: 'Not in the journal, but a later recorded step implies it.' }
    : { key, label, evidence: journal.length ? 'NOT_REACHED' : 'UNAVAILABLE', at: null, detail: journal.length ? missing : 'This flow keeps no journal for this step.' };
  const milestones: Milestone[] = [
    { key: 'created', label: 'Workflow created', evidence: 'OBSERVED', at: iso(run.createdAt), detail: `Execution record ${run.runId} (${run.flow}).` },
    step('validated', 'Workflow validated', workflow('REVIEWED'), 1, 'No validation is recorded.'),
    step('simulated', 'Simulation or quote', workflow('SIMULATED'), 2, 'No simulation or quote is recorded.'),
    authorized ? { key: 'authorized', label: 'Owner authorization', evidence: 'OBSERVED', at: iso(authorized.recordedAt), detail: 'The owner authorized the reviewed workflow.' }
      : anyAttemptPastPrepared || possiblySubmitted ? { key: 'authorized', label: 'Owner authorization', evidence: 'INFERRED', at: null,
        detail: 'The owner’s wallet was asked to sign (an attempt moved past PREPARED, or the flow is observing a handed-off transaction).' }
      : { key: 'authorized', label: 'Owner authorization', evidence: 'NOT_REACHED', at: null, detail: 'The owner was not asked to sign.' },
    hashed ? { key: 'submitted', label: 'Transaction submitted', evidence: 'OBSERVED', at: iso(attemptEntry(new Set(['SUBMITTING']))?.recordedAt ?? hashed.createdAt),
      detail: `Transaction ${hashed.transactionHash} (${hashed.step}).` }
      : submitted ? { key: 'submitted', label: 'Transaction submitted', evidence: 'INFERRED', at: null,
        detail: 'No hash is recorded here, but the record shows a later stage (evidence, a post-broadcast state or a started composition step).' }
      : maybe ? { key: 'submitted', label: 'Transaction submitted', evidence: 'UNKNOWN', at: iso(maybe.updatedAt),
        detail: `The wallet may have broadcast it (${maybe.state}), but no transaction hash is recorded.` }
      : possiblySubmitted ? { key: 'submitted', label: 'Transaction submitted', evidence: 'UNKNOWN', at: null,
        detail: 'The flow is still observing whether a handed-off transaction reached the network.' }
      : { key: 'submitted', label: 'Transaction submitted', evidence: 'NOT_REACHED', at: null, detail: 'No transaction was submitted.' },
    broadcastSeen ? { key: 'observed', label: 'Transaction seen on the network', evidence: 'OBSERVED', at: iso(broadcastSeen.updatedAt), detail: `${broadcastSeen.step}: ${broadcastSeen.state}` }
      : possiblySubmitted ? { key: 'observed', label: 'Transaction seen on the network', evidence: 'UNKNOWN', at: null, detail: 'Not observed yet.' }
      : { key: 'observed', label: 'Transaction seen on the network', evidence: 'NOT_REACHED', at: null, detail: '—' },
    finalAttempt ? { key: 'result', label: 'Confirmed, reverted or not found', evidence: 'OBSERVED', at: iso(finalAttempt.updatedAt),
      detail: `${finalAttempt.step}: ${finalAttempt.state}${finalAttempt.reconciled ? ' (reconciled)' : ''}` }
      : possiblySubmitted || unresolved.length ? { key: 'result', label: 'Confirmed, reverted or not found', evidence: 'UNKNOWN', at: null,
        detail: unresolved.length ? `Outcome unknown: ${unresolved.map(a => `${a.step} ${a.state}`).join(', ')}.` : 'Outcome unknown: no final transaction result is recorded.' }
      : { key: 'result', label: 'Confirmed, reverted or not found', evidence: 'NOT_REACHED', at: null, detail: '—' },
    run.needsObservation || c.outcome === 'UNCERTAIN' || c.outcome === 'UNCLASSIFIED' || c.outcome === 'IN_PROGRESS'
      ? { key: 'final', label: 'Final state recorded', evidence: c.outcome === 'IN_PROGRESS' && !possiblySubmitted ? 'NOT_REACHED' : 'UNKNOWN', at: null,
        detail: `Not final: status ${run.status}${run.needsObservation ? ', still being observed' : ''}.` }
      : { key: 'final', label: 'Final state recorded', evidence: 'OBSERVED', at: iso(run.updatedAt), detail: `Status ${run.status}${run.hasEvidence ? ' with an evidence bundle' : ''}.` },
  ];
  return milestones;
}

export async function loadTimelineFacts(host: Host, runId: string): Promise<{ journal: JournalRow[]; attempts: AttemptRow[]; journalTruncated: boolean; attemptsTruncated: boolean }> {
  const [journal, attempts] = await Promise.all([
    host.db.query<{ sequence: number; level: string; entity_id: string; attempt_id: string | null; from_state: string | null; to_state: string; recorded_at: Date }>(
      `SELECT sequence, level, entity_id, attempt_id, from_state, to_state, recorded_at FROM journal_entries WHERE tenant_id = $1 AND run_id = $2 ORDER BY sequence LIMIT 501`,
      [host.tenantId, runId]),
    host.db.query<{ attempt_id: string; step: string; state: string; transaction_hash: string | null; reconciled: boolean; created_at: Date; updated_at: Date }>(
      `SELECT attempt_id, step, state, transaction_hash, reconciled, created_at, updated_at FROM execution_attempts WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at, attempt_id LIMIT 51`,
      [host.tenantId, runId]),
  ]);
  return { journal: journal.rows.slice(0, 500).map(row => ({ sequence: row.sequence, level: row.level, entityId: row.entity_id, attemptId: row.attempt_id, fromState: row.from_state,
    toState: row.to_state, recordedAt: row.recorded_at })), journalTruncated: journal.rows.length > 500,
  attemptsTruncated: attempts.rows.length > 50, attempts: attempts.rows.slice(0, 50).map(row => ({ attemptId: row.attempt_id, step: row.step, state: row.state, transactionHash: row.transaction_hash, reconciled: row.reconciled,
    createdAt: row.created_at, updatedAt: row.updated_at })) };
}

export type TaskRow = { readonly id: string; readonly kind: string; readonly state: string; readonly deliveries: number; readonly lastError: string | null;
  readonly createdAt: string; readonly completedAt: string | null; readonly availableAt: string };
/** The run's newest background tasks (at most 20; a 21st row only signals truncation). */
export async function runTasks(host: Host, runId: string): Promise<{ tasks: TaskRow[]; truncated: boolean }> {
  const { rows } = await host.db.query<{ id: string; kind: string; state: string; deliveries: number; last_error: string | null; created_at: Date; completed_at: Date | null; available_at: Date }>(
    `SELECT id::text AS id, kind, state, deliveries, last_error, created_at, completed_at, available_at FROM work_items WHERE tenant_id = $1 AND run_id = $2
      ORDER BY created_at DESC, id DESC LIMIT 21`, [host.tenantId, runId]);
  return { truncated: rows.length > 20, tasks: rows.slice(0, 20).map(row => ({ id: row.id, kind: row.kind, state: row.state, deliveries: row.deliveries, lastError: row.last_error, createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null, availableAt: row.available_at.toISOString() })) };
}

export const NOTE_KINDS = ['ACKNOWLEDGEMENT', 'FINDING', 'DECISION', 'ESCALATION', 'RESOLUTION'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_KIND_LABELS: Readonly<Record<NoteKind, string>> = { ACKNOWLEDGEMENT: 'Acknowledged — under investigation', FINDING: 'Investigation finding', DECISION: 'Recovery decision', ESCALATION: 'Escalation', RESOLUTION: 'Resolution' };
export const NOTE_MAX = 500;
export const isIncidentId = (value: unknown): value is string => typeof value === 'string' && INCIDENT_ID.test(value);
/** A note's text: plain, bounded, no control characters and no markup (it is rendered as text, never as HTML). Null when invalid. */
/**
 * Operator free text (reasons, notes): trimmed, whitespace collapsed, well-formed Unicode, and no control, format (bidi overrides, zero-width),
 * line/paragraph-separator characters or markup. Null when invalid.
 */
export function freeText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string' || !value.isWellFormed()) return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length >= min && text.length <= max && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u.test(text) && !identifierShaped(text) ? text : null;
}
/**
 * Audit text is append-only and visible to every administrator, so it should not carry personal identifiers. Best-effort screening (not a
 * guarantee): wallet addresses and transaction hashes (0x… or long base58), e-mail addresses, standalone runs of 8+ digits (phone, document or
 * card numbers) and @handles are refused. Record ids (prefixed, hex) and dates remain allowed.
 */
export function identifierShaped(text: string): boolean {
  if (/0x[0-9a-fA-F]{40,}/.test(text) || /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/.test(text) || /(^|\s)@[A-Za-z0-9_]{2,}/.test(text)
    || /(?<![A-Za-z0-9-])\d(?:[ .]?\d){7,}(?![A-Za-z0-9-])/.test(text)) return true;
  return (text.match(/[1-9A-HJ-NP-Za-km-z]{32,}/g) ?? []).some(run => !/^[0-9a-f]+$/.test(run));
}
export const noteText = (value: unknown): string | null => freeText(value, 3, NOTE_MAX);
export type Note = { readonly eventId: string; readonly at: string; readonly actor: string; readonly incidentId: string; readonly kind: NoteKind; readonly text: string };
/** Notes (append-only audit events), newest first, for some incidents or for all (bounded, 90 days). */
export async function listNotes(host: Host, now: Date, incidentIds: readonly string[] | null = null): Promise<Note[]> {
  const { rows } = await host.db.query<{ event_id: string; at: Date; actor: string; detail: { incidentId?: unknown; noteKind?: unknown; text?: unknown } | null }>(
    `SELECT event_id::text, at, actor, detail FROM admin_audit_events WHERE tenant_id = $1 AND kind = 'SUPPORT_NOTE' AND outcome = 'OK' AND at >= $2
      AND ($3::text[] IS NULL OR detail->>'incidentId' = ANY($3::text[])) ORDER BY at DESC, event_id DESC LIMIT 500`,
    [host.tenantId, new Date(now.getTime() - 90 * 86_400_000), incidentIds ? [...incidentIds] : null]);
  return rows.flatMap(row => {
    const d = row.detail ?? {};
    return typeof d.incidentId === 'string' && typeof d.text === 'string' && NOTE_KINDS.includes(d.noteKind as NoteKind)
      ? [{ eventId: row.event_id, at: row.at.toISOString(), actor: row.actor, incidentId: d.incidentId, kind: d.noteKind as NoteKind, text: d.text }] : [];
  });
}
export type IncidentStatus = 'NEW' | 'INVESTIGATING' | 'ESCALATED' | 'RESOLUTION_NOTED';
export const STATUS_LABELS: Readonly<Record<IncidentStatus, string>> = { NEW: 'New', INVESTIGATING: 'Investigating', ESCALATED: 'Escalated', RESOLUTION_NOTED: 'Resolution noted' };
/** An incident's workflow status, from its notes only (the condition itself stays open while the durable state shows it). */
export function incidentStatus(notes: readonly Note[]): IncidentStatus {
  const latest = notes[0];
  if (!latest) return 'NEW';
  return latest.kind === 'ESCALATION' ? 'ESCALATED' : latest.kind === 'RESOLUTION' ? 'RESOLUTION_NOTED' : 'INVESTIGATING';
}
