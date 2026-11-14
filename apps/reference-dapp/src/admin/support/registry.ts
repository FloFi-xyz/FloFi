// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: the explicit, typed registry of recovery actions an operator can run from the Admin, and the pure
 * eligibility rules that decide — from durable facts only — whether one applies to one specific execution.
 *
 * Only two actions are executable, and both only re-queue an existing, idempotent background task under the execution's ORIGINAL identity
 * (the same work kind, dedupe key and payload the flow's projector and the sweeper use):
 *
 *   execution.resume-observation       the `reconcile` task: a re-observation of an attempt that may have reached the network. The worker
 *                                      re-checks, under the run lease, that the run still needs observation (the flow's own predicate — for some
 *                                      swaps that includes a handed-off PREPARED attempt, looked up by nonce), then runs the flow's `observe`. It
 *                                      never signs or submits (`backend/app.ts`), so it cannot create a second transaction.
 *   execution.retry-evidence-archive   the `evidence.archive` task: copies an already-reconciled Evidence Bundle to the evidence store
 *                                      (content-addressed; the metadata insert is ON CONFLICT DO NOTHING). Moves no funds.
 *
 * Neither action can sign, submit, approve, change a workflow's parameters, or decide an outcome: the outcome is whatever the existing
 * worker later observes on chain. Everything else (delegated executions, automation evaluations, workflow-run advances, notifications,
 * transaction submission) is deliberately absent and can never be retried from the Admin. Configuration recovery (AI settings) stays on
 * its own page with its own versioned rollback; the registry only links to it.
 */
import { createHash } from 'node:crypto';
import { retryableStopReason } from './codes.ts';

export type WorkState = 'READY' | 'LEASED' | 'DONE' | 'DEAD';
export type WorkFact = { readonly id: string; readonly kind: string; readonly state: WorkState; readonly lastError: string | null; readonly deliveries: number;
  readonly createdAt: Date; readonly completedAt: Date | null };
export type RecoveryWorkKind = 'reconcile' | 'evidence.archive';
/** What the eligibility rules read about one execution run (all loaded in one statement, under the run's row lock when executing). */
export type RunRecoveryFacts = {
  readonly runId: string; readonly flow: string; readonly status: string; readonly needsObservation: boolean; readonly attentionRequired: boolean;
  readonly hasEvidence: boolean; readonly evidenceArchived: boolean; readonly logVersion: number;
  /** The newest work item of each recovery kind for this run (by id), if any is still retained. */
  readonly latest: Readonly<Partial<Record<RecoveryWorkKind, WorkFact>>>;
  /** Every work kind whose newest item for this run is DEAD (the reason `attention_required` was set). */
  readonly unresolvedDeadKinds: readonly string[];
  /** Successful operator recoveries of this run in the retry-limit window. */
  readonly recentRecoveries: number;
};

export type EligibilityState = 'RECOVERABLE_NOW' | 'REQUIRES_CONFIRMATION' | 'WAITING_EXTERNAL' | 'USER_ACTION' | 'ENGINEERING' | 'INVESTIGATION' | 'NONE';
export const ELIGIBILITY_LABELS: Readonly<Record<EligibilityState, string>> = {
  RECOVERABLE_NOW: 'Recoverable now', REQUIRES_CONFIRMATION: 'Recovery requires confirmation', WAITING_EXTERNAL: 'Waiting for external system',
  USER_ACTION: 'User action required', ENGINEERING: 'Engineering fix required', INVESTIGATION: 'Investigation required', NONE: 'No action needed',
};
export const ELIGIBILITY_ORDER: readonly EligibilityState[] = ['RECOVERABLE_NOW', 'REQUIRES_CONFIRMATION', 'WAITING_EXTERNAL', 'USER_ACTION', 'ENGINEERING', 'INVESTIGATION', 'NONE'];
export type Eligibility = { readonly eligible: true } | { readonly eligible: false; readonly state: EligibilityState; readonly code: string; readonly reason: string };

export type RecoveryActionId = 'execution.resume-observation' | 'execution.retry-evidence-archive';
export type RecoveryAction = {
  readonly id: RecoveryActionId;
  readonly name: string;
  readonly description: string;
  /** Incident kinds (see `incidents.ts`) this action can resolve. */
  readonly appliesTo: readonly string[];
  /** Admin permission required (OPERATOR); VIEWER is always read-only. */
  readonly permission: 'recover';
  readonly preconditions: readonly string[];
  readonly resource: string;
  readonly idempotency: string;
  readonly postcondition: string;
  readonly failureOutcomes: readonly string[];
  readonly auditKind: 'SUPPORT_RECOVERY';
  /** STANDARD: preview + confirm with a reason. HIGH would add a typed confirmation; no registered action needs it. */
  readonly confirmation: 'STANDARD' | 'HIGH';
  readonly fundsInvolved: string;
  readonly reversible: string;
  readonly risks: readonly string[];
  readonly workKind: RecoveryWorkKind;
  readonly check: (facts: RunRecoveryFacts) => Eligibility;
};

/** At most this many successful operator recoveries of one execution per window; after that the problem needs engineering. */
export const RETRY_LIMIT = 3;
export const RETRY_WINDOW_DAYS = 7;
const OPEN = new Set<WorkState>(['READY', 'LEASED']);
const refuse = (state: EligibilityState, code: string, reason: string): Eligibility => ({ eligible: false, state, code, reason });

function common(facts: RunRecoveryFacts, kind: RecoveryWorkKind): Eligibility | null {
  const latest = facts.latest[kind];
  if (latest && OPEN.has(latest.state)) return refuse('WAITING_EXTERNAL', 'SUPPORT_ALREADY_SCHEDULED', latest.state === 'LEASED'
    ? 'A worker is processing this task right now. Wait for it to finish.' : 'This task is already queued and waiting for a worker.');
  if (latest?.state === 'DEAD' && !retryableStopReason(latest.lastError)) return refuse('ENGINEERING', 'SUPPORT_STOP_REASON_NOT_RETRYABLE',
    'The task stopped for a reason that running it again cannot fix (see its code). This needs engineering.');
  if (facts.recentRecoveries >= RETRY_LIMIT) return refuse('ENGINEERING', 'SUPPORT_RETRY_LIMIT_REACHED',
    `This execution was already recovered ${facts.recentRecoveries} times in ${RETRY_WINDOW_DAYS} days. Escalate it to engineering instead of retrying again.`);
  return null;
}

export const RECOVERY_ACTIONS: Readonly<Record<RecoveryActionId, RecoveryAction>> = Object.freeze({
  'execution.resume-observation': {
    id: 'execution.resume-observation', name: 'Resume transaction check',
    description: 'Ask the background worker to check this execution’s transaction on chain again, exactly as it does after every submission.',
    appliesTo: ['OBSERVATION_STOPPED', 'OBSERVATION_NOT_SCHEDULED'], permission: 'recover',
    preconditions: ['The execution still needs observation (its result is not final).', 'No check is queued or running for it.',
      'Its last check did not stop for a permanent reason (integrity failure, invalid data, unknown task).', `Fewer than ${RETRY_LIMIT} operator recoveries in ${RETRY_WINDOW_DAYS} days.`],
    resource: 'One execution run (its existing `reconcile` background task)',
    idempotency: 'Uses the execution’s own task identity: at most one open check can exist (database unique index). A repeated request with the same idempotency key returns the first result.',
    postcondition: 'One check is queued for this execution and its “needs attention” flag is cleared unless another stopped task still holds it. The worker’s next observation decides the outcome.',
    failureOutcomes: ['Refused: the state changed since the preview.', 'Refused: a check is already queued or running.', 'Accepted, then the check stops again (its budget is exhausted) — the execution is flagged again.'],
    auditKind: 'SUPPORT_RECOVERY', confirmation: 'STANDARD',
    fundsInvolved: 'No funds move. The check only reads the network; it cannot sign, submit or replace a transaction.',
    reversible: 'Nothing to reverse: a check changes no on-chain state. If it cannot conclude, the execution is flagged for attention again.',
    risks: ['If the original cause persists (for example the network is disabled on the worker or its RPC is down), the check will stop again after its budget.'],
    workKind: 'reconcile',
    check(facts) {
      if (!facts.needsObservation) return refuse('NONE', 'SUPPORT_NOTHING_TO_RECOVER',
        'The execution record does not currently ask for a transaction check, so there is nothing for this action to resume.');
      const refused = common(facts, 'reconcile');
      if (refused) return refused;
      // Only the two registered incident conditions: the check stopped (DEAD), or none is queued and nothing flagged the run.
      const latest = facts.latest.reconcile;
      if (latest?.state !== 'DEAD' && facts.attentionRequired) return refuse('INVESTIGATION', 'SUPPORT_CONDITION_NOT_REGISTERED',
        'The run is flagged for attention, but its transaction check did not stop. No registered action applies; investigate it.');
      return { eligible: true };
    },
  },
  'execution.retry-evidence-archive': {
    id: 'execution.retry-evidence-archive', name: 'Retry evidence archiving',
    description: 'Ask the background worker to copy this execution’s finished Evidence Bundle to the evidence store again.',
    appliesTo: ['EVIDENCE_ARCHIVE_STOPPED'], permission: 'recover',
    preconditions: ['The execution has a reconciled Evidence Bundle that is not archived yet.', 'No archiving task is queued or running for it.',
      'Its last attempt did not stop for a permanent reason.', `Fewer than ${RETRY_LIMIT} operator recoveries in ${RETRY_WINDOW_DAYS} days.`],
    resource: 'One execution run (its existing `evidence.archive` background task)',
    idempotency: 'Content-addressed storage and an insert-if-absent metadata row: archiving the same bundle twice stores it once.',
    postcondition: 'One archiving task is queued; when it finishes, the evidence metadata row exists.',
    failureOutcomes: ['Refused: already archived, already queued, or the state changed since the preview.', 'Accepted, then archiving stops again (for example the store is not configured).'],
    auditKind: 'SUPPORT_RECOVERY', confirmation: 'STANDARD',
    fundsInvolved: 'No funds move. It copies a record of an execution that already finished.', reversible: 'Nothing to reverse: archiving is append-only and idempotent.',
    risks: ['If the evidence store is still unavailable or misconfigured, the task will stop again.'],
    workKind: 'evidence.archive',
    check(facts) {
      if (!facts.hasEvidence) return refuse('NONE', 'SUPPORT_NOTHING_TO_RECOVER', 'This execution has no Evidence Bundle to archive.');
      if (facts.evidenceArchived) return refuse('NONE', 'SUPPORT_NOTHING_TO_RECOVER', 'This execution’s evidence is already archived.');
      const refused = common(facts, 'evidence.archive');
      if (refused) return refused;
      // Only a stopped archiving task: without one, the sweeper re-queues archiving by itself.
      if (facts.latest['evidence.archive']?.state !== 'DEAD') return refuse('WAITING_EXTERNAL', 'SUPPORT_CONDITION_NOT_REGISTERED',
        'Archiving did not stop: the background sweeper queues it automatically.');
      return { eligible: true };
    },
  },
});
export const RECOVERY_ACTION_IDS = Object.keys(RECOVERY_ACTIONS) as RecoveryActionId[];
export const isRecoveryActionId = (value: unknown): value is RecoveryActionId => typeof value === 'string' && Object.hasOwn(RECOVERY_ACTIONS, value);

/** Recovery that happens elsewhere in the Admin, with that page's own controls, history and audit. Listed, never executed here. */
export type GuidedRecovery = { readonly id: string; readonly name: string; readonly href: string; readonly description: string };
export const GUIDED_RECOVERY = Object.freeze({
  copilotRestore: { id: 'config.copilot-restore', name: 'Restore a known-good AI configuration', href: '/admin/ai-settings#admin-history-heading',
    description: 'AI Settings keeps every saved version. Restoring one appends a new version (the history is never rewritten) and is audited there.' },
} satisfies Record<string, GuidedRecovery>);

/**
 * A fingerprint of every fact an action's eligibility depends on. The preview returns it and execution requires the same value under
 * the row lock, so anything that changed in between (a new snapshot, a worker settling a task) refuses the request as stale.
 */
export function stateToken(facts: RunRecoveryFacts, action: RecoveryActionId): string {
  const kind = RECOVERY_ACTIONS[action].workKind, latest = facts.latest[kind];
  return createHash('sha256').update(JSON.stringify([action, facts.runId, facts.status, facts.logVersion, facts.needsObservation, facts.attentionRequired,
    facts.hasEvidence, facts.evidenceArchived, latest ? [latest.id, latest.state, latest.deliveries] : null, [...facts.unresolvedDeadKinds].sort()])).digest('hex').slice(0, 32);
}

/**
 * Whether the run's attention flag may be cleared once `kind` has an open task again: only when that task's own stop set it (the queue's
 * dead-letter is the flag's only writer) and no other stopped task still holds it.
 */
export const attentionClearable = (facts: RunRecoveryFacts, kind: RecoveryWorkKind): boolean =>
  facts.attentionRequired && facts.latest[kind]?.state === 'DEAD' && facts.unresolvedDeadKinds.length > 0 && facts.unresolvedDeadKinds.every(other => other === kind);
