// SPDX-License-Identifier: AGPL-3.0-only
// Owner filter adapted from the Dashboard delivery; final truth reuses UX-005 projections.
import type { ExecutionLifecycle } from '../../domain/execution-lifecycle';
import type { ExecutionRecovery } from '../../domain/execution-recovery';
import { projectExecutionResult } from '../../domain/execution-result';
import { shellChainLabel } from '../../domain/product-shell';
import { canonicalRunLifecycle, recordedResultUnknown, settledWithEvidence, type CanonicalLifecycle } from '../../domain/canonical-execution-status';
import { landedAttempts, type LandedEvidence } from './landed-attempts';
import type { DashboardAttempt, DashboardRun, DashboardRunView, DashboardStatus } from './types';

export const dashboardRunId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const textValue = (value: unknown) => typeof value === 'string' ? value : '';
export const optionalText = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : null;
export const sameOwner = (left: string | null | undefined, right: string | null | undefined) => Boolean(left && right &&
  (/^0x[0-9a-f]{40}$/i.test(left) && /^0x[0-9a-f]{40}$/i.test(right) ? left.toLowerCase() === right.toLowerCase() : left === right));

/** The recorded attempts of a run read model (`v1/runs/:id`), reduced to public facts. */
export function toDashboardAttempts(value: unknown): DashboardAttempt[] {
  return Array.isArray(value) ? value.filter(object).filter(item => textValue(item.attemptId) && textValue(item.step) && textValue(item.state)).map(item => ({
    attemptId: textValue(item.attemptId), step: textValue(item.step), state: textValue(item.state), transactionHash: optionalText(item.transactionHash),
    reconciled: item.reconciled === true })) : [];
}
export function toDashboardRun(value: unknown, account: string): DashboardRun | null {
  if (!object(value) || !sameOwner(textValue(value.ownerAccount), account) || !dashboardRunId(value.runId) || !textValue(value.flow) || !textValue(value.status)) return null;
  return { runId: value.runId, workflowId: textValue(value.workflowId), flow: textValue(value.flow), status: textValue(value.status),
    provenance: textValue(value.provenance), ownerAccount: account, errorCode: optionalText(value.errorCode),
    needsObservation: value.needsObservation === true, attentionRequired: value.attentionRequired === true, hasEvidence: value.hasEvidence === true,
    createdAt: optionalText(value.createdAt), updatedAt: optionalText(value.updatedAt),
    // Issue #149: a read model that carries its attempts (a run detail) keeps them; a summary without them stays "not read".
    ...Array.isArray(value.attempts) ? { attempts: toDashboardAttempts(value.attempts) } : {} };
}

type Summary = { status: DashboardStatus; message: string };
const APPROVAL_ONLY = 'Only the token approval is confirmed onchain. An approval moves no funds by itself, and the main action has not completed.';
/**
 * Issue #149: the Dashboard status of a run whose recorded attempts were read is the canonical lifecycle's (the same evidence MCP's
 * execution status reads), so it never says "Not started" when an attempt was made or landed, and never calls a landed approval the
 * completed action. Where the summary already says the same thing, its wording is kept.
 */
function fromLifecycle(lifecycle: CanonicalLifecycle, landed: LandedEvidence, run: DashboardRun, summary: Summary): Summary {
  const keep = (status: DashboardStatus, message: string): Summary => summary.status === status ? summary : { status, message };
  switch (lifecycle.status) {
    case 'NOT_STARTED': case 'RECONCILED': case 'RECONCILED_WITH_ATTENTION': return summary;
    case 'AUTHORIZATION_PENDING': return { status: 'In progress', message: 'A wallet request is prepared and awaits your wallet confirmation. Nothing is sent without it.' };
    case 'REJECTED': return keep('Transaction not submitted', 'This request was recorded as not submitted. Earlier confirmed actions and costs remain recorded.');
    case 'SUBMITTED': case 'HASH_KNOWN': case 'SETTLEMENT_PENDING': return keep('In progress', 'The recorded execution is still awaiting its final outcome.');
    // A step landed and the workflow is not reconciled: between steps (an approval before the swap, a supply before the borrow) earlier
    // actions completed; a confirmed main action whose outcome is not reconciled yet is not completion either.
    case 'CONFIRMED_ONCHAIN':
      if (landed.approvalOnly) return { status: 'Partially completed', message: APPROVAL_ONLY };
      return ['CONFIRMED', 'COMPLETED', 'SETTLED'].includes(run.status)
        ? keep('Needs attention', 'A transaction is confirmed. Full workflow completion has not been established by this summary.')
        : keep('Partially completed', 'Earlier completed actions remain recorded.');
    case 'PARTIALLY_COMPLETED': return landed.approvalOnly ? { status: 'Partially completed', message: APPROVAL_ONLY } : keep('Partially completed', 'Earlier completed actions remain recorded.');
    case 'REVERTED': case 'FAILED': return keep('Needs attention', 'A failed action is recorded. Open the run to review any earlier completed actions.');
    case 'INCONCLUSIVE': return keep('Unresolved', 'A recorded request still needs verification. No transaction is repeated.');
    case 'INTERVENTION_REQUIRED': return summary.status === 'Unresolved' || summary.status === 'Needs attention' ? summary
      : { status: 'Needs attention', message: 'A recorded transaction needs review before anything else happens. Open the run.' };
  }
}
const titles: Record<string, string> = { 'aave-supply': 'Aave workflow', 'base-sepolia-swap': 'Swap', 'crosschain-router': 'Bridge', 'crosschain-universal': 'Bridge',
  'crosschain-router-testnet': 'Bridge', 'robinhood-transfer': 'Send', 'jupiter-swap': 'Swap', 'solana-devnet-swap': 'Swap',
  'orca-liquidity': 'Liquidity workflow', 'orca-liquidity-mainnet': 'Liquidity workflow', 'uniswap-liquidity': 'Liquidity workflow',
  'solana-transfer': 'Send', 'solana-devnet-transfer': 'Send', 'base-swap': 'Swap', 'arbitrum-swap': 'Swap', 'ethereum-swap': 'Swap',
  'base-mainnet-transfer': 'Send', 'arbitrum-mainnet-transfer': 'Send', 'ethereum-mainnet-transfer': 'Send', 'robinhood-mainnet-transfer': 'Send',
  'robinhood-swap': 'Swap', 'base-liquidity': 'Liquidity workflow', 'arbitrum-liquidity': 'Liquidity workflow', 'ethereum-liquidity': 'Liquidity workflow', 'robinhood-liquidity': 'Liquidity workflow',
  'base-aave': 'Aave workflow', 'arbitrum-aave': 'Aave workflow', 'ethereum-aave': 'Aave workflow', 'lending-composition': 'Lending workflow',
  'solana-devnet-composition': 'Swap + Liquidity workflow', 'pix-payment': 'Payment' };

export function projectDashboardRun(run: DashboardRun, progress: ExecutionLifecycle | null = null, title = titles[run.flow] ?? (run.flow.startsWith('crosschain-router-') ? 'Bridge' : 'Financial operation'), current = false): DashboardRunView {
  const result = projectExecutionResult(progress);
  // A recorded unknown wallet or submission result: something may have been sent (the canonical lifecycle's INCONCLUSIVE).
  const unproven = recordedResultUnknown(run.errorCode);
  let status: DashboardStatus = 'Unresolved', message = 'FloFi has not established the final workflow outcome.', notSubmittedChip = 'Wallet confirmation was declined';
  if (progress) {
    status = progress.state === 'active' ? 'In progress' : progress.state === 'idle' ? 'Not started'
      : progress.state === 'complete' ? progress.planUnavailable ? 'Needs attention' : progress.evidence?.attention.length ? 'Completed with attention' : 'Completed'
      : progress.state === 'uncertain' ? 'Unresolved' : result?.label === 'Execution partially completed' ? 'Partially completed'
      : result?.label === 'Transaction not submitted' ? 'Transaction not submitted' : result?.label === 'Execution failed' ? 'Failed' : 'Needs attention';
    message = result?.message ?? progress.message;
  // A flow's settled end state (a composition's COMPLETED, Pix's PAYMENT_SETTLED) counts only with recorded evidence, as in the canonical lifecycle.
  } else if (settledWithEvidence(run) && !run.needsObservation) {
    status = run.attentionRequired || run.errorCode ? 'Completed with attention' : 'Completed';
    message = 'The run records a reconciled outcome.';
  // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: the same groups as the canonical lifecycle (domain/canonical-execution-status.ts) for statuses flows emit.
  } else if (['CANCELLED', 'REJECTED', 'NOT_SUBMITTED', 'NOT_EXECUTED', 'EXPIRED'].includes(run.status) && !run.needsObservation) {
    status = 'Transaction not submitted'; message = 'This request was recorded as not submitted. Earlier confirmed actions and costs remain recorded.';
    // Only a wallet decline or a cancellation is "declined": a request FloFi refused before the wallet (NOT_SUBMITTED) or one that expired
    // without executing is said as such.
    if (run.status === 'NOT_SUBMITTED') notSubmittedChip = 'The request was not submitted';
    // NOT_EXECUTED is also a composition leg never signed (a decline), so only EXPIRED says "expired".
    else if (run.status === 'NOT_EXECUTED') {
      notSubmittedChip = 'The request was not executed';
      message = 'This request was not executed. Earlier confirmed actions and costs remain recorded.';
    } else if (run.status === 'EXPIRED') {
      notSubmittedChip = 'The request expired without executing';
      message = 'This request expired without executing. Earlier confirmed actions and costs remain recorded.';
    }
  } else if (run.status === 'SUBMITTING') {
    status = 'Unresolved'; message = 'A recorded request still needs verification. No transaction is repeated.';
  } else if (['PARTIAL', 'PARTIALLY_COMPLETED'].includes(run.status)) {
    status = 'Partially completed'; message = 'Earlier completed actions remain recorded.';
  } else if (['FAILED', 'REVERTED', 'REFUNDED'].includes(run.status) && !run.needsObservation) {
    // A summary alone cannot establish whether earlier actions completed.
    status = 'Needs attention'; message = 'A failed action is recorded. Open the run to review any earlier completed actions.';
  } else if (['DRAFT', 'PREPARED', 'SIMULATED', 'AUTHORIZED', 'REVIEWED', 'QUOTED'].includes(run.status)) {
    status = run.needsObservation || unproven ? 'Unresolved' : 'Not started';
    message = run.needsObservation || unproven ? 'A recorded request still needs verification. No transaction is repeated.' : 'Simulated or reviewed only: no wallet request was made, so nothing was sent.';
  } else if (['RESERVED', 'SUBMITTING', 'PENDING', 'HASH', 'SOURCE_SUBMITTED', 'SOURCE_CONFIRMED', 'IN_FLIGHT', 'DESTINATION_OBSERVED', 'SIGNED', 'POSTING', 'POSTED', 'OPEN', 'SETTLING', 'FULFILLED', 'PARTIALLY_FILLED', 'PAYMENT_PENDING', 'PAYMENT_SETTLED'].includes(run.status)) {
    status = 'In progress'; message = 'The recorded execution is still awaiting its final outcome.';
  } else if (run.status === 'CONFIRMED') {
    status = 'Needs attention'; message = 'A transaction is confirmed. Full workflow completion has not been established by this summary.';
  }
  // Issue #149: the run's recorded attempts, when read, decide what was sent and what landed (never the summary status alone).
  const landed = landedAttempts(run.attempts);
  if (run.attempts?.length) {
    const lifecycle = canonicalRunLifecycle(run), summary = { status, message };
    if (!progress) ({ status, message } = fromLifecycle(lifecycle, landed, run, summary));
    // A saved run's projected progress keeps its own truth, except where the attempts prove more: never "Not started" once something was
    // asked or landed, and a run whose only landed request is an approval is not still "in progress" when nothing else is pending.
    else if (status === 'Not started' && lifecycle.status !== 'NOT_STARTED') ({ status, message } = fromLifecycle(lifecycle, landed, run, summary));
    else if (status === 'In progress' && landed.approvalOnly && lifecycle.status === 'CONFIRMED_ONCHAIN') { status = 'Partially completed'; message = APPROVAL_ONLY; }
  } else if (run.attemptsUnavailable && status === 'Not started') {
    // The summary looks not started, but the attempts that would prove it could not be read: fail closed, never "nothing was sent".
    status = 'Unresolved'; message = 'The recorded requests of this run could not be read, so FloFi does not claim that nothing was sent. Refresh history to check again.';
  }
  const attention: string[] = [];
  if (status === 'Unresolved') attention.push('Execution status unresolved');
  else if (status === 'Partially completed' || status === 'Failed') attention.push('Review the incomplete action');
  else if (status === 'Transaction not submitted') attention.push(progress ? 'Wallet confirmation was declined' : notSubmittedChip);
  else if (status === 'Needs attention') attention.push(message);
  if (run.needsObservation) attention.push('Awaiting an execution status check');
  // BUILD-FLOFI-CHAT-E2E-FIX-002: a run that never made a wallet request has nothing to attend to on chain: its recorded issue (an expired quote,
  // a refused simulation) explains why it did not start, and is never presented as a pending execution that needs attention.
  if (status === 'Not started') { if (run.errorCode || run.attentionRequired) message = 'The simulation or Review recorded an issue before any wallet request, so nothing was sent.'; }
  else {
    if (run.attentionRequired && !attention.length) attention.push('This execution record needs attention');
    if (run.errorCode && !attention.length) attention.push('A recorded issue needs review');
  }
  attention.push(...(progress?.evidence?.attention ?? []));
  return { run, title, status, message, attention: [...new Set(attention)],
    landed: status === 'Completed' || status === 'Completed with attention' ? null : landed.label,
    networks: progress ? [...new Set(progress.steps.flatMap(step => step.operations.map(operation => operation.chain)).filter(Boolean))].map(shellChainLabel) : [],
    completed: progress?.planUnavailable ? null : progress?.completed ?? null, total: progress?.planUnavailable ? null : progress?.steps.length ?? null,
    recovered: Object.values(progress?.stepEvidence ?? {}).some(step => step.recovered),
    reconciled: progress ? Object.values(progress.stepEvidence ?? {}).some(step => step.reconciled) : run.status === 'RECONCILED', current, progress };
}

export function currentDashboardRun(title: string, progress: ExecutionLifecycle, recovery?: Pick<ExecutionRecovery, 'contextIssue' | 'action'>): DashboardRunView | null {
  const owner = progress.evidence?.wallet;
  if (!progress.started || !dashboardRunId(progress.runKey) || !owner) return null;
  const run: DashboardRun = { runId: progress.runKey, workflowId: '', flow: 'current', status: progress.state,
    provenance: progress.local ? 'LOCAL' : '', ownerAccount: owner, errorCode: null, needsObservation: false,
    attentionRequired: false, hasEvidence: Boolean(progress.evidence && (progress.evidence.details.some(item => item.label === 'Evidence bundle') ||
      Object.values(progress.evidence.operations).some(op => op.identifiers.length > 0 || op.values.length > 0))), createdAt: null, updatedAt: null };
  const view = projectDashboardRun(run, progress, title, true);
  if (recovery?.contextIssue) view.attention.push(recovery.contextIssue);
  if (recovery?.action && progress.state !== 'complete') view.attention.push('Check execution status in Execute');
  return view;
}

export function dashboardRunIndex(account: string | null, runs: readonly DashboardRun[], current: DashboardRunView | null): DashboardRunView[] {
  if (!account) return [];
  const ownedCurrent = current && sameOwner(current.run.ownerAccount, account) ? current : null;
  return [...(ownedCurrent ? [ownedCurrent] : []), ...runs.filter(run => sameOwner(run.ownerAccount, account) && run.runId !== ownedCurrent?.run.runId).map(run => projectDashboardRun(run))];
}
