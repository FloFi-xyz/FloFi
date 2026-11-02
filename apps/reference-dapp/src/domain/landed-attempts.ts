// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #149 (financial truth): what actually landed onchain for one run, read from its recorded attempts only (never a provider answer,
 * a hash alone or the run's summary status). An attempt landed when it is CONFIRMED or reconciled. An approval is never the action it
 * enables: a run whose only landed attempts are approvals has not executed its swap, supply, borrow, liquidity or bridge action.
 * Display only (the Dashboard and the Automations History): no execution, delegation or automation decision reads it.
 */
export type AttemptFacts = { readonly step: string; readonly state: string; readonly transactionHash?: string | null; readonly reconciled?: boolean };
export type LandedEvidence = {
  /** The landed-attempt indicator, or null when nothing landed. */
  readonly label: string | null;
  /** Only approvals landed: the main action was not completed. */
  readonly approvalOnly: boolean;
  readonly landed: number;
};

/** Approval steps as flows record them: APPROVAL (swaps, bridges, Aave), POOL_APPROVAL/ROUTER_APPROVAL (lending), APPROVE_TOKEN0/1 (Uniswap). */
export const isApprovalStep = (step: string) => /APPROV/i.test(step);
export const attemptLanded = (attempt: AttemptFacts) => attempt.state === 'CONFIRMED' || attempt.reconciled === true;
const DECLINED = new Set(['REFUSED', 'CANCELLED', 'REJECTED', 'NOT_SUBMITTED', 'NOT_EXECUTED', 'EXPIRED']);
const IN_FLIGHT = new Set(['PENDING', 'HASH', 'SUBMITTED', 'RESERVED', 'SIGNED', 'POSTING', 'POSTED', 'OPEN', 'SOURCE_SUBMITTED']);

/** The indicator for a run whose approval landed but whose main action did not, by the main action's latest recorded state. */
function approvalOnlyLabel(action: AttemptFacts | undefined): string {
  if (!action) return 'Approval confirmed · main action not sent';
  if (action.state === 'PREPARED') return 'Approval confirmed · main action awaiting wallet confirmation';
  if (DECLINED.has(action.state)) return 'Approval confirmed · main action not submitted';
  if (IN_FLIGHT.has(action.state)) return 'Approval confirmed · main action pending confirmation';
  if (action.state === 'REVERTED' || action.state === 'FAILED') return 'Approval confirmed · main action failed';
  // SUBMITTING, SUBMISSION_RESULT_UNKNOWN, RECONCILIATION_REQUIRED or a state FloFi cannot classify: never "not sent".
  return 'Approval confirmed · main action unresolved';
}

export function landedAttempts(attempts: readonly AttemptFacts[] | null | undefined): LandedEvidence {
  const all = (attempts ?? []).filter(a => a && typeof a.step === 'string' && typeof a.state === 'string');
  const actions = all.filter(a => !isApprovalStep(a.step));
  const landedApprovals = all.filter(a => isApprovalStep(a.step) && attemptLanded(a)).length, landedActions = actions.filter(attemptLanded).length;
  if (!landedApprovals && !landedActions) return { label: null, approvalOnly: false, landed: 0 };
  if (!landedActions) return { label: approvalOnlyLabel(actions.at(-1)), approvalOnly: true, landed: landedApprovals };
  const last = all.at(-1)!;
  return { label: attemptLanded(last) ? 'Confirmed onchain · workflow outcome not reconciled yet' : 'Earlier actions confirmed onchain · a later action is not complete',
    approvalOnly: false, landed: landedApprovals + landedActions };
}

/**
 * Summary statuses whose meaning the run's attempts can change: a not-started-looking, declined, failed or confirmed status (or a
 * composition's working phase) after an approval or an earlier step landed. The Dashboard reads these runs' attempts before projecting them.
 */
const ATTEMPT_DEPENDENT = new Set(['DRAFT', 'PREPARED', 'SIMULATED', 'AUTHORIZED', 'REVIEWED', 'QUOTED', 'CANCELLED', 'REJECTED', 'NOT_SUBMITTED', 'NOT_EXECUTED',
  'EXPIRED', 'CONFIRMED', 'COMPLETED', 'SETTLED', 'FAILED', 'REVERTED', 'PARTIAL', 'PARTIALLY_COMPLETED', 'EXECUTING', 'PAUSED', 'PRODUCING', 'BOUND', 'CONSUMING',
  'RECOVERY_REQUIRED']);
export const attemptDependentStatus = (status: string) => ATTEMPT_DEPENDENT.has(status);
/** The Portuguese of every approval-only label (shared by the PT catalog and Channel Core, which may not import the i18n layer). */
export const LANDED_LABELS_PT: Readonly<Record<string, string>> = {
  'Approval confirmed · main action not sent': 'Aprovação confirmada · ação principal não enviada',
  'Approval confirmed · main action awaiting wallet confirmation': 'Aprovação confirmada · ação principal aguardando confirmação na carteira',
  'Approval confirmed · main action not submitted': 'Aprovação confirmada · ação principal não submetida',
  'Approval confirmed · main action pending confirmation': 'Aprovação confirmada · ação principal aguardando confirmação',
  'Approval confirmed · main action failed': 'Aprovação confirmada · a ação principal falhou',
  'Approval confirmed · main action unresolved': 'Aprovação confirmada · estado da ação principal não resolvido',
};
