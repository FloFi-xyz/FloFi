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
 *
 *   asked first    /approve's user-funded start does not load such a group's first step into its own flow at once (`ownerStepCircleFirst`): the
 *                  owner's browser first asks whether Circle pays it (`prepareUserFundedGroup`); CIRCLE_NOT_NEEDED (the owner's ETH pays) or any
 *                  other answer that is not a Circle preparation, and the step is loaded exactly as before.
 */
import type { GroupRecord, RunRecord, WorkflowRunStore } from './pg-store.ts';

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
/**
 * Whether the run's CURRENT group is a FloFi Wallet owner-step group whose fee Circle may pay (this deployment's Circle chains), none of whose
 * steps was loaded yet and whose first step is due: /approve's user-funded start then leaves that step READY (not loaded), so the owner's browser
 * can ask first. False for any other wallet, chain, group or state: the step is loaded at once, exactly as before. `wallet` is what the owner's
 * browser reported; it only decides WHEN the step is loaded (every Circle artifact is still verified on the server and in FloFi Wallet's gate).
 */
export async function ownerStepCircleFirst(store: Pick<WorkflowRunStore, 'groups' | 'steps'>, run: Pick<RunRecord, 'runId' | 'mode' | 'state' | 'currentStep'>,
  wallet: 'INJECTED' | 'FLOFI_WALLET' | undefined, circleChains: readonly string[]): Promise<boolean> {
  if (wallet !== 'FLOFI_WALLET' || run.mode !== 'USER_FUNDED' || !['RUNNING', 'ATTENTION'].includes(run.state)) return false;
  const g = (await store.groups(run.runId)).find(x => x.stepFrom <= run.currentStep && run.currentStep <= x.stepTo);
  if (!g || g.strategy !== 'EVM_OWNER_STEP' || g.state !== 'PLANNED' || g.prepared !== null || g.stepFrom !== run.currentStep || !circleChains.includes(g.chain)) return false;
  return ownerStepsUnloaded(store, run.runId, g);
}
/** Gives an unsigned Circle preparation's steps back to their owner-step flows (DELEGATED → BLOCKED → PENDING); a step in any other state stays. */
export async function groupStepsToOwner(store: Store, runId: string, g: Group): Promise<void> {
  for (let i = g.stepFrom; i <= g.stepTo; i++) {
    if (await store.stepTransition(runId, i, ['DELEGATED'], 'BLOCKED', { code: GAS_MECHANISM_SWITCHED }, GAS_MECHANISM_SWITCHED))
      await store.stepTransition(runId, i, ['BLOCKED'], 'PENDING', { code: null }, GAS_MECHANISM_SWITCHED);
  }
}
