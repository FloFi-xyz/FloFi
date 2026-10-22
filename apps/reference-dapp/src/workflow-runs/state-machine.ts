// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: the workflow run state machines (mirrored by the database triggers of migration 0015).
 *
 * Run: PENDING → RUNNING → COMPLETED, with
 *   HALTED     at least one step reconciled and a later step cannot proceed: partial completion, funds rest in the owner's own wallet; the
 *              owner may resume (a step that is still possible) or end the run
 *   FAILED     nothing irreversible happened (or the first step's submission reconciled as a failure)
 *   ATTENTION  a submitted step's outcome is unknown: observation only, never a retry or a second submission
 *   CANCELLED  ended by its owner or requester before anything was submitted (or, after HALTED, by its owner)
 *   EXPIRED    never started within its window
 * Step: PENDING → READY → AWAITING_OWNER → RECONCILED (owner-signed), or PENDING → DELEGATED → RECONCILED (delegated), with FAILED
 *   (reconciled failure), UNCERTAIN (submitted, outcome unknown), SKIPPED (never ran) and BLOCKED (stopped before submission).
 *
 * Terminal states never change. A step may begin only when every earlier step is RECONCILED.
 */
export const RUN_STATES = ['PENDING', 'RUNNING', 'COMPLETED', 'HALTED', 'FAILED', 'ATTENTION', 'CANCELLED', 'EXPIRED'] as const;
export type RunState = (typeof RUN_STATES)[number];
export const STEP_STATES = ['PENDING', 'READY', 'AWAITING_OWNER', 'DELEGATED', 'RECONCILED', 'FAILED', 'UNCERTAIN', 'SKIPPED', 'BLOCKED'] as const;
export type StepState = (typeof STEP_STATES)[number];
export const RUN_MODES = ['CONFIRM_EACH_STEP', 'DELEGATED'] as const;
export type RunMode = (typeof RUN_MODES)[number];

const RUN: Readonly<Record<RunState, readonly RunState[]>> = Object.freeze({
  PENDING: ['RUNNING', 'FAILED', 'CANCELLED', 'EXPIRED'],
  RUNNING: ['RUNNING', 'COMPLETED', 'HALTED', 'FAILED', 'ATTENTION', 'CANCELLED'],
  ATTENTION: ['RUNNING', 'COMPLETED', 'HALTED', 'FAILED'],
  HALTED: ['RUNNING', 'CANCELLED'],
  COMPLETED: [], FAILED: [], CANCELLED: [], EXPIRED: [],
});
const STEP: Readonly<Record<StepState, readonly StepState[]>> = Object.freeze({
  PENDING: ['READY', 'DELEGATED', 'SKIPPED', 'BLOCKED'],
  READY: ['AWAITING_OWNER', 'SKIPPED', 'BLOCKED'],
  AWAITING_OWNER: ['RECONCILED', 'FAILED', 'UNCERTAIN', 'SKIPPED', 'BLOCKED'],
  DELEGATED: ['RECONCILED', 'FAILED', 'UNCERTAIN', 'BLOCKED', 'SKIPPED'],
  UNCERTAIN: ['RECONCILED', 'FAILED'],
  BLOCKED: ['PENDING', 'READY', 'SKIPPED'],
  RECONCILED: [], FAILED: [], SKIPPED: [],
});
export const canMoveRun = (from: RunState, to: RunState): boolean => from === to ? from === 'RUNNING' : RUN[from].includes(to);
export const canMoveStep = (from: StepState, to: StepState): boolean => STEP[from].includes(to);
export const TERMINAL_RUN: readonly RunState[] = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);
export const TERMINAL_STEP: readonly StepState[] = Object.freeze(['RECONCILED', 'FAILED', 'SKIPPED']);
/** Steps that may have reached a chain: a run with one of these can never be cancelled, and nothing about that step is retried. */
export const MAYBE_SUBMITTED: readonly StepState[] = Object.freeze(['AWAITING_OWNER', 'DELEGATED', 'UNCERTAIN', 'RECONCILED', 'FAILED']);

/** Confirm-mode window: how long after its claim a run may still start steps (a bridge may take hours; an owner may come back the next day). */
export const CONFIRM_RUN_SECONDS = 7 * 86_400;
/** Delegated one-shot authorization validity: the whole workflow must start within it (the executor re-checks expiry before every step). */
export const DELEGATED_AUTHORIZATION_SECONDS = 24 * 3_600;
/** How often the advance work item re-observes an open run (the flows' own reconciliation is the source of truth). */
export const ADVANCE_RETRY_MS = 20_000;
export const WORKFLOW_RUN_ADVANCE_KIND = 'workflow-run.advance';
