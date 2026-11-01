// SPDX-License-Identifier: AGPL-3.0-only
// Owner filter adapted from the Dashboard delivery; final truth reuses UX-005 projections.
import type { ExecutionLifecycle } from '../../domain/execution-lifecycle';
import type { ExecutionRecovery } from '../../domain/execution-recovery';
import { projectExecutionResult } from '../../domain/execution-result';
import { shellChainLabel } from '../../domain/product-shell';
import { recordedResultUnknown, settledWithEvidence } from '../../domain/canonical-execution-status';
import type { DashboardRun, DashboardRunView, DashboardStatus } from './types';

export const dashboardRunId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const textValue = (value: unknown) => typeof value === 'string' ? value : '';
export const optionalText = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : null;
export const sameOwner = (left: string | null | undefined, right: string | null | undefined) => Boolean(left && right &&
  (/^0x[0-9a-f]{40}$/i.test(left) && /^0x[0-9a-f]{40}$/i.test(right) ? left.toLowerCase() === right.toLowerCase() : left === right));

export function toDashboardRun(value: unknown, account: string): DashboardRun | null {
  if (!object(value) || !sameOwner(textValue(value.ownerAccount), account) || !dashboardRunId(value.runId) || !textValue(value.flow) || !textValue(value.status)) return null;
  return { runId: value.runId, workflowId: textValue(value.workflowId), flow: textValue(value.flow), status: textValue(value.status),
    provenance: textValue(value.provenance), ownerAccount: account, errorCode: optionalText(value.errorCode),
    needsObservation: value.needsObservation === true, attentionRequired: value.attentionRequired === true, hasEvidence: value.hasEvidence === true,
    createdAt: optionalText(value.createdAt), updatedAt: optionalText(value.updatedAt) };
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
  let status: DashboardStatus = 'Unresolved', message = 'FloFi has not established the final workflow outcome.';
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
  const attention: string[] = [];
  if (status === 'Unresolved') attention.push('Execution status unresolved');
  else if (status === 'Partially completed' || status === 'Failed') attention.push('Review the incomplete action');
  else if (status === 'Transaction not submitted') attention.push('Wallet confirmation was declined');
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
