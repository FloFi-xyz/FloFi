// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (owner requirement: FloFi Wallet + Circle): the step moves that let a FloFi Wallet owner-step group run
 * as ONE Circle-paid operation when its owner's ETH cannot pay it — and give it back to its owner steps when that preparation is withdrawn
 * unsigned. No new state, edge or migration: only transitions both the code (`state-machine.ts`) and the database trigger already allow.
 *
 *   to the group   every step of the group must be PENDING or READY (none loaded into its own flow yet): PENDING → DELEGATED, and a READY step
 *                  READY → BLOCKED → PENDING → DELEGATED (code GAS_MECHANISM_SWITCHED, never a stop of the run). A step that moved on meanwhile
 *                  (its own flow was loaded: AWAITING_OWNER) makes the switch fail: the caller withdraws the preparation before anything was asked
 *                  of the wallet, and the owner-step path continues alone.
 *   back           only for a group whose Circle preparation was never authorized: DELEGATED → BLOCKED → PENDING (its owner steps then run exactly
 *                  as before; the run's confirm pass readies the current one again).
 * The group's strategy itself is changed by the caller (only before authorization, as every Circle preparation does; the database freezes it once
 * the group is signed).
 */
import type { GroupRecord, WorkflowRunStore } from './pg-store.ts';

export const GAS_MECHANISM_SWITCHED = 'GAS_MECHANISM_SWITCHED';
type Store = Pick<WorkflowRunStore, 'steps' | 'stepTransition'>;
type Group = Pick<GroupRecord, 'stepFrom' | 'stepTo'>;

/** Whether every step of the group is still unloaded (PENDING or READY): only then may it become one Circle-paid operation. */
export async function ownerStepsUnloaded(store: Pick<WorkflowRunStore, 'steps'>, runId: string, g: Group): Promise<boolean> {
  const steps = (await store.steps(runId)).filter(s => s.stepIndex >= g.stepFrom && s.stepIndex <= g.stepTo);
  return steps.length === g.stepTo - g.stepFrom + 1 && steps.every(s => s.state === 'PENDING' || s.state === 'READY');
}
/** Moves the group's owner steps to the group (DELEGATED). False when one of them was loaded into its own flow meanwhile (nothing is then asked). */
export async function ownerStepsToGroup(store: Store, runId: string, g: Group): Promise<boolean> {
  for (let i = g.stepFrom; i <= g.stepTo; i++) {
    if (await store.stepTransition(runId, i, ['PENDING'], 'DELEGATED', {}, GAS_MECHANISM_SWITCHED)) continue;
    if (!await store.stepTransition(runId, i, ['READY'], 'BLOCKED', { code: GAS_MECHANISM_SWITCHED }, GAS_MECHANISM_SWITCHED)) return false;
    await store.stepTransition(runId, i, ['BLOCKED'], 'PENDING', { code: null }, GAS_MECHANISM_SWITCHED);
    if (!await store.stepTransition(runId, i, ['PENDING'], 'DELEGATED', {}, GAS_MECHANISM_SWITCHED)) return false;
  }
  return true;
}
/** Gives an unsigned Circle preparation's steps back to their owner-step flows (DELEGATED → BLOCKED → PENDING); a step in any other state stays. */
export async function groupStepsToOwner(store: Store, runId: string, g: Group): Promise<void> {
  for (let i = g.stepFrom; i <= g.stepTo; i++) {
    if (await store.stepTransition(runId, i, ['DELEGATED'], 'BLOCKED', { code: GAS_MECHANISM_SWITCHED }, GAS_MECHANISM_SWITCHED))
      await store.stepTransition(runId, i, ['BLOCKED'], 'PENDING', { code: null }, GAS_MECHANISM_SWITCHED);
  }
}
