// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: the workflow run state machines (mirrored by the database triggers of migration 0015).
 *
 * Run: PENDING → RUNNING → COMPLETED, with
 *   HALTED     a step cannot proceed and the owner decides: resume (a step that is still possible) or end the run. Usually a partial
 *              completion (at least one step reconciled; its funds rest in the owner's own wallet). Also a USER_FUNDED run whose due group
 *              was refused for good before anything was sent, even its first: stopped before anything was sent, resumable (the stopped
 *              steps then run through their own owner-signed flows) — not FAILED, which would end it
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
/** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: USER_FUNDED — execution groups authorized by the owner's own wallet, which pays every fee (0023). */
export const RUN_MODES = ['CONFIRM_EACH_STEP', 'DELEGATED', 'USER_FUNDED'] as const;
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

/** Ending only skips unsubmitted work; reconciled steps and their evidence remain final. */
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: whether a user-funded group may be in flight — anything submitted, a wallet batch the wallet already sent,
 * or a prepared wallet batch the owner's wallet may still be confirming (inside its validity). A user operation or Solana signatures FloFi has
 * not relayed are not: ending the run skips them. The ONE rule for the store's cancellation and the owner's "End workflow".
 */
export function groupInFlight(g: { readonly state: string; readonly strategy: string; readonly validUntil: Date | string | null }, now: Date): boolean {
  if (g.state === 'SUBMITTED' || g.state === 'UNCERTAIN') return true;
  if (g.strategy !== 'EVM_WALLET_BATCH') return false;
  return g.state === 'AUTHORIZED' || (g.state === 'PREPARED' && g.validUntil !== null && new Date(g.validUntil) > now);
}
/** The code an ended run's wallet batch group and its steps carry when the batch's outcome cannot be known (`walletBatchUnanswered`). */
export const WALLET_BATCH_OUTCOME_UNKNOWN = 'WALLET_BATCH_OUTCOME_UNKNOWN';
/**
 * Whether a wallet batch group was handed to the owner's wallet (a prepared artifact, or earlier preparations kept for reconciliation) while no
 * answer was ever recorded for it: the wallet may have executed it before its on-chain deadline and the answer been lost on the way. FloFi
 * cannot know, so such a group is never described as not run: ending the run, or blocking the group at the run's expiry (user-funded-pass.ts),
 * marks it (and its steps) WALLET_BATCH_OUTCOME_UNKNOWN, and a run stopped at it HALTS (its owner ends it) instead of FAILING, which would say
 * nothing irreversible happened.
 */
export function walletBatchUnanswered(g: { readonly strategy: string; readonly prepared: unknown; readonly authorization: unknown }): boolean {
  return g.strategy === 'EVM_WALLET_BATCH' && g.prepared !== null && g.prepared !== undefined && (g.authorization === null || g.authorization === undefined);
}
export function canEndWorkflow(run: { readonly state: string; readonly mode: string | null }, steps: readonly { readonly state: string }[],
  groups: readonly { readonly state: string; readonly strategy: string; readonly validUntil: Date | string | null }[] = [], now: Date = new Date()): boolean {
  // A user-funded run's DELEGATED steps are grouped steps; whether one may be in flight is decided by its group (`groupInFlight`).
  const inFlight = run.mode === 'USER_FUNDED' ? ['AWAITING_OWNER', 'UNCERTAIN'] : ['AWAITING_OWNER', 'UNCERTAIN', 'DELEGATED'];
  return run.mode !== 'DELEGATED' && ['PENDING', 'RUNNING', 'HALTED'].includes(run.state) && !steps.some(step => inFlight.includes(step.state))
    && !(run.mode === 'USER_FUNDED' && groups.some(g => groupInFlight(g, now)));
}
/**
 * How a HALTED run is described to its owner (the Editor and /approve share this one rule): `PARTIAL` once a step reconciled; else
 * `NOTHING_SENT` only when the run's own view proves nothing reached a chain (a first group refused for good when due halts the run before
 * anything ran: not a partial completion); else `STOPPED`, which claims neither progress nor that nothing was sent. Fails closed: a step
 * that may have been submitted, a group sent, reconciled or failed, or a wallet batch ever handed to the wallet (prepared, answered or
 * authorized) is never "nothing sent".
 */
export function haltedAs(run: { readonly halted?: 'PARTIAL' | 'NOTHING_SENT' | 'STOPPED' | null; readonly mode: string | null; readonly steps: readonly { readonly state: string }[];
  readonly groups?: readonly { readonly state: string; readonly strategy: string; readonly signed: boolean; readonly batchId: string | null; readonly planned: unknown }[] | null }):
  'PARTIAL' | 'NOTHING_SENT' | 'STOPPED' {
  // The server decides from its records (workflow-runs/service.ts runView); a view without that field falls back to this rule over the view.
  if (run.halted) return run.halted;
  if (run.steps.some(s => s.state === 'RECONCILED')) return 'PARTIAL';
  const maybeSent = run.steps.some(s => ['FAILED', 'UNCERTAIN', 'AWAITING_OWNER'].includes(s.state) || (s.state === 'DELEGATED' && run.mode !== 'USER_FUNDED'))
    || (run.groups ?? []).some(g => ['SUBMITTED', 'UNCERTAIN', 'RECONCILED', 'FAILED'].includes(g.state)
      || (g.strategy === 'EVM_WALLET_BATCH' && (g.signed || g.batchId !== null || g.planned !== null || ['PREPARED', 'AUTHORIZED'].includes(g.state))));
  return maybeSent ? 'STOPPED' : 'NOTHING_SENT';
}
