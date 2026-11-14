// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001 (addendum): the ONE authoritative model of execution attention, used by Overview, System Health,
 * Workflows and Support & Recovery. It separates two dimensions that the raw `attention_required` flag conflated:
 *
 *   transaction outcome   what the flow's projection says happened (`analytics/classify.ts`): completed, failed, partial, unknown…
 *   attention lifecycle   whether an operational condition needs a person now, derived from durable evidence only:
 *
 *     ACTIVE               an unresolved condition exists now: unknown outcome, partial or unclassified execution, observation exhausted or
 *                          not scheduled, evidence archiving stopped, another stopped task, or a retry still pending.
 *                          Independent of the flag: an unflagged run with such a condition is active too.
 *     UNDER_INVESTIGATION  ACTIVE, and an operator explicitly recorded review of this incident (an acknowledgement, finding, decision or
 *                          escalation note in the audit trail within the notes window). Never inferred from someone opening a page.
 *     HISTORICAL           the run was flagged, no active condition is demonstrated now, and there is NOT enough incident-specific evidence to
 *                          call it resolved. This is not a resolution.
 *     VERIFIED_RESOLVED    the run was flagged (or a task once stopped), no active condition remains, the outcome is final and its status
 *                          recognised, and every task that ever stopped for this run has incident-specific resolution evidence: the stopped
 *                          observation was superseded by a reconciled, non-divergent verdict with an Evidence Bundle and every submitted
 *                          attempt reconciled (a completed re-run alone is not enough: a check completes whatever the verdict); the service
 *                          proved non-execution (deposit deadline); or the stopped archive's evidence is now in the evidence store. A terminal
 *                          status alone never qualifies; a divergent verdict is always ACTIVE.
 *
 * A run that was never flagged and has no active condition has no lifecycle (null). Nothing here writes: the flag, the error code, the
 * execution status and the evidence are shown as recorded. An owner "review required" code (a workflow edited after review) is reported
 * separately — it gates any future execution of that workflow and is neither an operational incident nor evidence of resolution.
 */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { attemptSubmitted, classifyRun, COMPLETED_STATUSES, FAILED_STATUSES, IN_PROGRESS_STATUSES, NOT_EXECUTED_STATUSES, NOT_STARTED_STATUSES, PARTIAL_STATUSES,
  UNCERTAIN_STATUSES, type ExecutionOutcome } from '../analytics/classify.ts';
import { environmentOf } from '../analytics/networks.ts';
import { retryableStopReason } from './codes.ts';
import { loadExecutions, type ExecutionSnapshot } from './executions.ts';
import { loadRunsFacts } from './recovery.ts';
import type { RunRecoveryFacts, WorkFact } from './registry.ts';

export type Lifecycle = 'ACTIVE' | 'UNDER_INVESTIGATION' | 'HISTORICAL' | 'VERIFIED_RESOLVED';
export const LIFECYCLE_LABELS: Readonly<Record<Lifecycle, string>> = { ACTIVE: 'Active', UNDER_INVESTIGATION: 'Under investigation',
  HISTORICAL: 'Historical attention', VERIFIED_RESOLVED: 'Verified resolved' };
export const LIFECYCLE_ORDER: readonly Lifecycle[] = ['ACTIVE', 'UNDER_INVESTIGATION', 'HISTORICAL', 'VERIFIED_RESOLVED'];
export const isOpen = (lifecycle: Lifecycle | null | undefined): boolean => lifecycle === 'ACTIVE' || lifecycle === 'UNDER_INVESTIGATION';

export type ConditionCode = 'OUTCOME_UNKNOWN' | 'OBSERVATION_EXHAUSTED' | 'OBSERVATION_NOT_SCHEDULED' | 'PARTIAL_EXECUTION' | 'UNCLASSIFIED_STATUS'
  | 'EVIDENCE_ARCHIVE_STOPPED' | 'TASK_STOPPED' | 'RETRY_PENDING' | 'FACTS_UNAVAILABLE' | 'RESULT_DIVERGED';
export const CONDITION_LABELS: Readonly<Record<ConditionCode, string>> = {
  OUTCOME_UNKNOWN: 'Transaction outcome unknown',
  OBSERVATION_EXHAUSTED: 'Transaction check stopped (observation exhausted)',
  OBSERVATION_NOT_SCHEDULED: 'Transaction check not scheduled',
  PARTIAL_EXECUTION: 'Partially completed',
  UNCLASSIFIED_STATUS: 'Status not recognised',
  EVIDENCE_ARCHIVE_STOPPED: 'Evidence archiving stopped',
  TASK_STOPPED: 'Background task stopped',
  RETRY_PENDING: 'A stopped task was queued again and has not finished',
  FACTS_UNAVAILABLE: 'Flagged, and its background-task facts could not be read (never assumed resolved)',
  RESULT_DIVERGED: 'The observed result differs from what was reviewed (divergent verdict)',
};
export type ResolutionBasis = 'TASK_COMPLETED_AFTER_STOP' | 'OUTCOME_RECONCILED_AFTER_STOP' | 'EVIDENCE_ARCHIVED_AFTER_STOP' | 'NOT_EXECUTED_PROVEN';
export const RESOLUTION_LABELS: Readonly<Record<ResolutionBasis, string>> = {
  TASK_COMPLETED_AFTER_STOP: 'a later run of the same task completed',
  OUTCOME_RECONCILED_AFTER_STOP: 'a reconciled verdict with an Evidence Bundle superseded the stopped check, and every submitted attempt is reconciled',
  EVIDENCE_ARCHIVED_AFTER_STOP: 'the Evidence Bundle is now in the evidence store',
  NOT_EXECUTED_PROVEN: 'the service proved non-execution: the protocol deposit deadline passed on a finalized block with a complete scan and no deposit',
};
/** What one stopped work kind's history shows now. */
export type StoppedStatus = 'UNRESOLVED' | 'RETRYING' | 'RESOLVED' | 'NOT_REQUIRED';
export type StoppedTaskView = { readonly kind: string; readonly count: number; readonly code: string | null; readonly lastStoppedAt: string | null;
  readonly status: StoppedStatus; readonly basis: ResolutionBasis | null };
/**
 * Explicit operator review recorded in the audit trail (the latest support note). With `at`, a note older than the latest stop of a task that is
 * still unresolved does not count: it was about an earlier occurrence.
 */
export type Investigation = 'ACKNOWLEDGED' | 'RESOLUTION_NOTED' | null;

export type RunAttention = {
  readonly runId: string; readonly flagged: boolean; readonly lifecycle: Lifecycle | null; readonly outcome: ExecutionOutcome;
  readonly conditions: readonly ConditionCode[]; readonly stopped: readonly StoppedTaskView[]; readonly resolution: readonly ResolutionBasis[];
  /** Still being observed normally (a check is queued or running, or the run changed in the last 15 minutes). Not an incident. */
  readonly awaitingObservation: boolean;
  /** The recorded error code asks the OWNER to review the workflow again (it was edited after review). Not an operational incident. */
  readonly ownerReviewPending: boolean;
  readonly investigation: Investigation;
  /** Mainnet or an unrecognised environment (never assumed to be a test network). */
  readonly realFunds: boolean;
  /** Why this lifecycle, in one or two plain sentences. */
  readonly explanation: string;
};

const MINUTE = 60_000;
export const NOT_SCHEDULED_AFTER_MS = 15 * MINUTE;
/** `<FLOW>_SEMANTIC_EDIT_REQUIRES_REVIEW`, `<FLOW>_WALLET_CHANGED_REVIEW_REQUIRED`: set by a flow's `invalidate` when the owner edits the workflow. */
export const OWNER_REVIEW_CODE = /^[A-Z][A-Z0-9_]*_(SEMANTIC_EDIT_REQUIRES_REVIEW|WALLET_CHANGED_REVIEW_REQUIRED)$/;
const FINAL_OUTCOMES = new Set<ExecutionOutcome>(['COMPLETED', 'FAILED', 'NOT_EXECUTED', 'NOT_STARTED']);
const CODE = /^[A-Z][A-Z0-9_]{2,80}/;
const codeOf = (text: string | null) => text && CODE.test(text) ? text.match(CODE)![0] : text ? 'UNCLASSIFIED_ERROR' : null;
const open = (task: WorkFact | undefined) => task?.state === 'READY' || task?.state === 'LEASED';

/** The attention lifecycle of one run. Pure: every input is a durable fact, and the same inputs always give the same answer. */
export function runAttention(run: ExecutionSnapshot, facts: RunRecoveryFacts | undefined, noted: Investigation, now: Date, notedAt: Date | null = null): RunAttention {
  const c = classifyRun(run), conditions: ConditionCode[] = [], add = (code: ConditionCode) => { if (!conditions.includes(code)) conditions.push(code); };
  const reconcile = facts?.latest.reconcile;
  const quiet = now.getTime() - run.updatedAt.getTime() > NOT_SCHEDULED_AFTER_MS;
  if (run.needsObservation && reconcile?.state === 'DEAD') add('OBSERVATION_EXHAUSTED');
  // The sweeper never re-arms a flagged run, so for one no open check means not scheduled at once.
  else if (run.needsObservation && !open(reconcile) && (quiet || run.attentionRequired)) add('OBSERVATION_NOT_SCHEDULED');
  if (!facts && run.attentionRequired) add('FACTS_UNAVAILABLE');
  if (c.outcome === 'UNCERTAIN') add('OUTCOME_UNKNOWN');
  if (c.outcome === 'PARTIAL') add('PARTIAL_EXECUTION');
  if (c.outcome === 'UNCLASSIFIED') add('UNCLASSIFIED_STATUS');
  // A divergent verdict (funds moved differently from the review) is final but never "nothing to do".
  if (run.status === 'DIVERGENT' || (!run.needsObservation && run.attempts.some(a => a.state === 'RECONCILIATION_REQUIRED'))) add('RESULT_DIVERGED');

  const reconciledVerdict = !run.needsObservation && run.hasEvidence && FINAL_OUTCOMES.has(c.outcome) && !conditions.includes('RESULT_DIVERGED')
    && run.attempts.filter(attemptSubmitted).every(attempt => attempt.reconciled);
  // The router's deposit-deadline verdict: the only protocol-backed proof that nothing landed (status FAILED, no transaction hash anywhere).
  const provenNotExecuted = !run.needsObservation && (run.status === 'FAILED' || run.status === 'NOT_EXECUTED') && !!run.errorCode
    && /_SUBMISSION_EXPIRED_NOT_EXECUTED$/.test(run.errorCode) && !run.hasEvidence && run.attempts.every(attempt => !attempt.hash);
  const stopped: StoppedTaskView[] = (facts?.stoppedKinds ?? []).map(kind => {
    let status: StoppedStatus, basis: ResolutionBasis | null = null;
    if (kind.newestState === 'READY' || kind.newestState === 'LEASED') { status = 'RETRYING'; add('RETRY_PENDING'); }
    else if (kind.kind === 'reconcile') {
      if (run.needsObservation) status = 'UNRESOLVED'; // observation continues: a condition is added below
      // A check is DONE as soon as the run stops needing observation, whatever the verdict (a divergent one too), so a completed re-run alone is
      // not resolution evidence: it also needs a reconciled verdict with an Evidence Bundle, or the service's proof of non-execution.
      else if (kind.newestState === 'DONE' && reconciledVerdict) { status = 'RESOLVED'; basis = 'TASK_COMPLETED_AFTER_STOP'; }
      else if (provenNotExecuted) { status = 'RESOLVED'; basis = 'NOT_EXECUTED_PROVEN'; }
      // The reconcile handler completes (never stops) a check once the run no longer needs observation, so a check that stopped while the run
      // still needed it is superseded by any later reconciled verdict — unless it stopped for a permanent reason (invalid data, integrity).
      else if (reconciledVerdict && retryableStopReason(kind.lastError)) { status = 'RESOLVED'; basis = 'OUTCOME_RECONCILED_AFTER_STOP'; }
      else status = 'NOT_REQUIRED'; // no longer observed, but nothing proves the verdict this check was waiting for
    } else if (kind.kind === 'evidence.archive') {
      if (facts!.evidenceArchived) { status = 'RESOLVED'; basis = kind.newestState === 'DONE' ? 'TASK_COMPLETED_AFTER_STOP' : 'EVIDENCE_ARCHIVED_AFTER_STOP'; }
      else if (kind.newestState === 'DEAD') { status = 'UNRESOLVED'; add('EVIDENCE_ARCHIVE_STOPPED'); }
      else status = 'NOT_REQUIRED';
    } else if (kind.newestState === 'DONE') { status = 'RESOLVED'; basis = 'TASK_COMPLETED_AFTER_STOP'; }
    else { status = 'UNRESOLVED'; add('TASK_STOPPED'); }
    return { kind: kind.kind, count: kind.count, code: codeOf(kind.lastError), lastStoppedAt: kind.lastStoppedAt?.toISOString() ?? null, status, basis };
  });
  // Defensive: the newest archive task itself stopped, whatever the history query returned.
  if (run.hasEvidence && facts && !facts.evidenceArchived && facts.latest['evidence.archive']?.state === 'DEAD') add('EVIDENCE_ARCHIVE_STOPPED');
  // A run that once stopped (or is flagged) and is still observed is never historical or resolved; an uncertain status stays "outcome unknown"
  // while its check is retried (the classifier calls it in progress once the flag is cleared), and an unrecognised status is never final.
  const tracked = run.attentionRequired || stopped.length > 0;
  if (tracked && UNCERTAIN_STATUSES.has(run.status)) add('OUTCOME_UNKNOWN');
  if (tracked && !KNOWN_STATUS_SET.has(run.status)) add('UNCLASSIFIED_STATUS');
  if (tracked && run.needsObservation && !conditions.length) add('RETRY_PENDING');
  const latestStop = Math.max(0, ...stopped.filter(s => s.status === 'UNRESOLVED' || s.status === 'RETRYING').map(s => s.lastStoppedAt ? Date.parse(s.lastStoppedAt) : 0));
  const investigation: Investigation = noted && notedAt && notedAt.getTime() < latestStop ? null : noted;
  const resolution = [...new Set(stopped.flatMap(s => s.basis ? [s.basis] : []))];
  const environment = environmentOf(run.provenance), realFunds = environment === 'MAINNET' || environment === null;
  const ownerReviewPending = !!run.errorCode && OWNER_REVIEW_CODE.test(run.errorCode);
  const awaitingObservation = run.needsObservation && !conditions.includes('OBSERVATION_EXHAUSTED') && !conditions.includes('OBSERVATION_NOT_SCHEDULED');

  let lifecycle: Lifecycle | null, explanation: string;
  if (conditions.length) {
    lifecycle = investigation === 'ACKNOWLEDGED' ? 'UNDER_INVESTIGATION' : 'ACTIVE';
    explanation = `Active because: ${conditions.map(code => CONDITION_LABELS[code].toLowerCase()).join('; ')}.`
      + (lifecycle === 'UNDER_INVESTIGATION' ? ' An operator recorded that this incident is being reviewed.' : '')
      + (investigation === 'RESOLUTION_NOTED' ? ' A resolution note exists, but the durable state still shows the condition, so it stays active.' : '');
  } else if (tracked) {
    // A run whose stop was recovered through Support has its flag cleared; its stopped-task history keeps it in the lifecycle.
    const verified = stopped.length > 0 && stopped.every(s => s.status === 'RESOLVED') && FINAL_OUTCOMES.has(c.outcome) && KNOWN_STATUS_SET.has(run.status);
    lifecycle = verified ? 'VERIFIED_RESOLVED' : 'HISTORICAL';
    explanation = verified
      ? `${run.attentionRequired ? 'Flagged earlier' : 'A task stopped earlier'}; resolved with evidence: ${resolution.map(basis => RESOLUTION_LABELS[basis]).join('; ')}.`
        + (run.attentionRequired ? ' The original flag is kept.' : ' The flag was cleared by a registered recovery, which is audited.')
      : stopped.length === 0
        ? 'Flagged earlier, but no stopped task is recorded for this run, so the cause cannot be reconstructed. No active condition is demonstrated now; this is not a verified resolution.'
        : !FINAL_OUTCOMES.has(c.outcome) || !KNOWN_STATUS_SET.has(run.status)
          ? 'Flagged earlier. No active condition is demonstrated now, but the outcome is not final (or its status is not recognised), so the incident is not verified resolved.'
          : `Flagged earlier when ${stopped.filter(s => s.status !== 'RESOLVED').map(s => `“${s.kind}”`).join(', ') || 'a task'} stopped. The run no longer needs it, but no evidence specific to that stop proves it was addressed; this is not a verified resolution.`;
  } else { lifecycle = null; explanation = awaitingObservation ? 'Being observed normally; not an incident.' : 'Never flagged and no active condition.'; }
  if (ownerReviewPending) explanation += ' Separately, the owner edited the workflow after review; any further execution needs their new review (not an operational incident).';
  return { runId: run.runId, flagged: run.attentionRequired, lifecycle, outcome: c.outcome, conditions, stopped, resolution, awaitingObservation, ownerReviewPending,
    investigation, realFunds, explanation };
}

/** Support note kinds that mean an operator explicitly took up the incident (see `diagnostics.ts` NOTE_KINDS). */
export const INVESTIGATION_NOTE_KINDS: readonly string[] = ['ACKNOWLEDGEMENT', 'FINDING', 'DECISION', 'ESCALATION'];
export const NOTES_WINDOW_DAYS = 90;
export const investigationOf = (latestNoteKind: string | null | undefined): Investigation =>
  latestNoteKind === 'RESOLUTION' ? 'RESOLUTION_NOTED' : latestNoteKind && INVESTIGATION_NOTE_KINDS.includes(latestNoteKind) ? 'ACKNOWLEDGED' : null;

export type AttentionCounts = {
  readonly active: number; readonly underInvestigation: number; readonly historical: number; readonly resolved: number;
  readonly activeRealFunds: number; readonly observationExhausted: number; readonly notScheduled: number; readonly unknownOutcome: number;
  readonly partial: number; readonly unclassified: number; readonly evidence: number; readonly tasks: number; readonly ownerReviewPending: number;
};
export type AttentionEntry = { readonly run: ExecutionSnapshot; readonly facts: RunRecoveryFacts | undefined; readonly attention: RunAttention };
export type ExecutionAttention = {
  readonly entries: readonly AttentionEntry[]; readonly counts: AttentionCounts;
  /** Exact totals from the projection (not bounded): runs carrying the raw flag, runs still needing observation. */
  readonly flaggedTotal: number; readonly observingTotal: number; readonly oldestObservationSeconds: number | null;
  /** More candidate runs exist than were classified: the lifecycle counts are lower bounds. */
  readonly truncated: boolean;
  /** Whether investigation notes could be read (when not, nothing is shown as under investigation). */
  readonly notesOk: boolean;
};
export const ATTENTION_LIMIT = 500;
const UNRESOLVED_STATUSES = [...UNCERTAIN_STATUSES, ...PARTIAL_STATUSES];
const KNOWN_STATUSES: readonly string[] = [...new Set([...COMPLETED_STATUSES, ...FAILED_STATUSES, ...PARTIAL_STATUSES, ...UNCERTAIN_STATUSES, ...NOT_EXECUTED_STATUSES,
  ...NOT_STARTED_STATUSES, ...IN_PROGRESS_STATUSES])];
const KNOWN_STATUS_SET: ReadonlySet<string> = new Set(KNOWN_STATUSES);

export function countAttention(list: readonly RunAttention[]): AttentionCounts {
  const n = (test: (a: RunAttention) => boolean) => list.filter(test).length, has = (a: RunAttention, code: ConditionCode) => isOpen(a.lifecycle) && a.conditions.includes(code);
  return { active: n(a => a.lifecycle === 'ACTIVE'), underInvestigation: n(a => a.lifecycle === 'UNDER_INVESTIGATION'), historical: n(a => a.lifecycle === 'HISTORICAL'),
    resolved: n(a => a.lifecycle === 'VERIFIED_RESOLVED'), activeRealFunds: n(a => isOpen(a.lifecycle) && a.realFunds),
    observationExhausted: n(a => has(a, 'OBSERVATION_EXHAUSTED')), notScheduled: n(a => has(a, 'OBSERVATION_NOT_SCHEDULED')), unknownOutcome: n(a => has(a, 'OUTCOME_UNKNOWN')),
    partial: n(a => has(a, 'PARTIAL_EXECUTION')), unclassified: n(a => has(a, 'UNCLASSIFIED_STATUS')),
    evidence: n(a => has(a, 'EVIDENCE_ARCHIVE_STOPPED')), tasks: n(a => has(a, 'TASK_STOPPED') || has(a, 'RETRY_PENDING')),
    ownerReviewPending: n(a => a.ownerReviewPending && a.lifecycle !== null) };
}

/** The latest support-note kind per incident id, within the notes window (kinds only — no note text is read). */
export type LatestNote = { readonly kind: string; readonly at: Date };
export async function latestNoteKinds(db: Database, tenantId: string, incidentIds: readonly string[], now: Date): Promise<Map<string, LatestNote>> {
  if (!incidentIds.length) return new Map();
  const { rows } = await db.query<{ id: string; kind: string | null; at: Date }>(`SELECT DISTINCT ON (detail->>'incidentId') detail->>'incidentId' AS id,
      detail->>'noteKind' AS kind, at FROM admin_audit_events WHERE tenant_id = $1 AND kind = 'SUPPORT_NOTE' AND outcome = 'OK' AND at >= $2 AND detail->>'incidentId' = ANY($3::text[])
      ORDER BY detail->>'incidentId', at DESC, event_id DESC`, [tenantId, new Date(now.getTime() - NOTES_WINDOW_DAYS * 86_400_000), [...new Set(incidentIds)]]);
  return new Map(rows.flatMap(row => row.kind ? [[row.id, { kind: row.kind, at: row.at }] as const] : []));
}

/**
 * Every run that can carry an attention lifecycle — flagged, with a stopped task, still observed, or with an unresolved (unknown/partial) or
 * unrecognised status — classified with `runAttention`. One tenant-scoped scan, bounded to ATTENTION_LIMIT candidates (likely-active first); the exact
 * flagged/observing totals come from the projection itself. Read-only.
 */
export async function loadExecutionAttention(db: Database, tenantId: string, now: Date): Promise<ExecutionAttention> {
  const [candidates, totals] = await Promise.all([
    // Likely-active candidates first (still observed, unresolved or unrecognised status), then flagged or once-stopped runs, newest first.
    db.query<{ run_id: string }>(`SELECT r.run_id FROM execution_runs r WHERE r.tenant_id = $1
        AND (r.attention_required OR r.needs_observation OR r.status = ANY($2::text[]) OR r.status <> ALL($3::text[])
          OR EXISTS (SELECT 1 FROM work_items w WHERE w.tenant_id = r.tenant_id AND w.run_id = r.run_id AND w.state = 'DEAD'))
      ORDER BY (r.needs_observation OR r.status = ANY($2::text[]) OR r.status <> ALL($3::text[])) DESC, r.updated_at DESC, r.run_id
      LIMIT ${ATTENTION_LIMIT + 1}`, [tenantId, UNRESOLVED_STATUSES, KNOWN_STATUSES]),
    db.query<{ flagged: number; observing: number; oldest: Date | null }>(`SELECT count(*) FILTER (WHERE attention_required)::int AS flagged,
        count(*) FILTER (WHERE needs_observation)::int AS observing, min(updated_at) FILTER (WHERE needs_observation) AS oldest
      FROM execution_runs WHERE tenant_id = $1 AND (needs_observation OR attention_required)`, [tenantId]),
  ]);
  const ids = candidates.rows.slice(0, ATTENTION_LIMIT).map(row => row.run_id);
  const [runs, facts] = await Promise.all([loadExecutions(db, tenantId, ids), loadRunsFacts(db, tenantId, ids, now)]);
  let notes = new Map<string, LatestNote>(), notesOk = true;
  try { notes = await latestNoteKinds(db, tenantId, ids.map(id => `run:${id}`), now); } catch { notesOk = false; }
  const entries = runs.map(run => { const note = notes.get(`run:${run.runId}`);
    return { run, facts: facts.get(run.runId), attention: runAttention(run, facts.get(run.runId), investigationOf(note?.kind), now, note?.at ?? null) }; })
    .sort((a, b) => b.run.updatedAt.getTime() - a.run.updatedAt.getTime() || (a.run.runId < b.run.runId ? -1 : 1));
  const t = totals.rows[0];
  return { entries, counts: countAttention(entries.map(e => e.attention)), flaggedTotal: t?.flagged ?? 0, observingTotal: t?.observing ?? 0,
    oldestObservationSeconds: t?.oldest ? Math.max(0, Math.round((now.getTime() - t.oldest.getTime()) / 1000)) : null,
    truncated: candidates.rows.length > ATTENTION_LIMIT, notesOk };
}
