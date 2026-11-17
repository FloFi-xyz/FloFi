// SPDX-License-Identifier: AGPL-3.0-only
/** Result presentation only. Completion and uncertainty come from the existing lifecycle. */
import type { ExecutionLifecycle } from './execution-lifecycle';
import { shellChainLabel } from './product-shell';
import { walletNonceMessage } from './wallet-nonce';

export type ExecutionResult = {
  label: string;
  message: string;
  tone: 'ready' | 'attention';
  completed: number;
  total: number;
  countLabel: string;
  networks: string[];
};

/** EXEC-01: a Review that expired before the next wallet request, after confirmed steps (kept) or before any (nothing sent). */
export const REVIEW_EXPIRED_CONTINUE = 'Your Review expired before FloFi asked your wallet for the next request, so nothing more was sent. The confirmed steps stay recorded and are not repeated. Simulate again to refresh the Review of the same run, then authorize it to continue.';
export const REVIEW_EXPIRED_NOTHING_SENT = 'Your Review expired before FloFi asked your wallet, so nothing was sent. Simulate again to refresh the Review, then authorize it to continue.';
export function projectExecutionResult(progress: ExecutionLifecycle | null | undefined): ExecutionResult | null {
  if (!progress?.started || progress.state === 'idle' || progress.state === 'active') return null;
  const completed = progress.completed, total = progress.steps.length;
  const countLabel = progress.planUnavailable ? 'Recorded actions confirmed' : 'Steps confirmed';
  const networks = [...new Set(progress.steps.flatMap(step => step.operations.map(operation => operation.chain)).filter(Boolean))].map(shellChainLabel);
  if (progress.state === 'complete') return {
    label: progress.planUnavailable ? 'Recorded requests confirmed' : progress.evidence?.attention.length ? 'Execution completed with attention' : 'Execution completed',
    message: progress.planUnavailable ? 'The saved requests are confirmed. Original workflow details remain unavailable.' : progress.evidence?.attention.length ? 'All workflow steps are confirmed. A recorded allowance still needs attention.' : 'All workflow steps are confirmed in the current execution record.',
    tone: progress.evidence?.attention.length ? 'attention' : 'ready', completed, total, countLabel, networks,
  };
  if (progress.state === 'uncertain') return {
    label: 'Execution status unresolved',
    message: 'FloFi has not yet confirmed the final state. Confirmed actions remain recorded.',
    tone: 'attention', completed, total, countLabel, networks,
  };
  const operations = progress.steps.flatMap(step => step.operations);
  const failed = operations.filter(operation => operation.state === 'failed');
  const incomplete = operations.filter(operation => ['failed', 'cancelled', 'not-submitted'].includes(operation.state));
  const declined = incomplete.length > 0 && incomplete.every(operation => !operation.hash && (operation.label === 'Wallet request declined' || progress.evidence?.operations[operation.id]?.failure === 'declined'));
  const definitiveFailure = failed.some(operation => operation.label !== 'Wallet request declined');
  const confirmedApproval = operations.some(operation => operation.approval && operation.state === 'confirmed');
  const confirmedActions = operations.some(operation => !operation.approval && operation.state === 'confirmed');
  // Every incomplete request ended before submission (recorded as not submitted): nothing of this run reached the network.
  const nothingSent = !(completed > 0 || confirmedActions || confirmedApproval) && incomplete.length > 0 && incomplete.every(operation => !operation.hash && operation.state === 'not-submitted');
  const approvalOnly = confirmedApproval && !confirmedActions && incomplete.length > 0 && incomplete.every(operation => !operation.hash && ['not-submitted', 'failed', 'cancelled'].includes(operation.state));
  // BUILD-P0-MAINNET-EXECUTION-RELIABILITY: a request FloFi stopped before the wallet because the wallet's transaction number disagreed says so.
  const nonceReason = incomplete.map(operation => operation.state === 'not-submitted' && !operation.hash && operation.reason ? walletNonceMessage(operation.reason) : null).find(Boolean) ?? null;
  // BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (EXEC-01): a request stopped because its Review expired before the wallet was asked says exactly
  // that, and how to continue — never "declined" or "cancelled", which would describe something the owner did.
  const expiredReview = incomplete.some(operation => operation.state === 'not-submitted' && !operation.hash && /_(?:REVIEW_EXPIRED|WALLET_HANDOFF_NOT_AUTHORIZED)$/.test(operation.reason ?? ''));
  return {
    label: completed > 0 || confirmedActions || confirmedApproval ? 'Execution partially completed' : declined || nothingSent ? 'Transaction not submitted' : definitiveFailure ? 'Execution failed' : 'Execution needs attention',
    message: expiredReview ? (completed > 0 || confirmedActions || confirmedApproval ? REVIEW_EXPIRED_CONTINUE : REVIEW_EXPIRED_NOTHING_SENT)
      : approvalOnly ? 'An earlier approval is confirmed. The remaining request did not complete. Network costs and token allowance may remain.'
      : declined ? 'Wallet confirmation was declined. Earlier confirmed requests remain recorded.' : definitiveFailure ? 'A recorded action failed. Earlier confirmed actions remain recorded.'
      : nothingSent ? nonceReason ?? 'No transaction from this run was sent, so nothing reached the network. The step result explains why.' : 'The run has an incomplete action. Any confirmed actions remain recorded.',
    tone: 'attention', completed, total, countLabel, networks,
  };
}

const IN_FLIGHT = ['wallet', 'signed', 'preparing', 'submitting', 'submitted', 'pending', 'uncertain', 'posted', 'settling', 'partial'];
/**
 * UX-004: a final outcome the owner can start over from (confirmed, declined, cancelled, failed or not submitted). An unresolved or still
 * observable run is never final: its recovery stays in place and "Create new workflow" is not offered.
 */
export function isFinalExecutionResult(progress: ExecutionLifecycle | null | undefined): boolean {
  return Boolean(progress?.started && (progress.state === 'complete' || progress.state === 'attention') &&
    !progress.steps.some(step => step.operations.some(operation => IN_FLIGHT.includes(operation.state))));
}

/**
 * BUILD-FIX-UX-001: a final run in which no transaction was submitted and nothing was confirmed — every request it made was declined in
 * the wallet before submission (or recorded as not submitted). Starting over cannot repeat anything, so a fresh simulation is safe.
 */
export function nothingSubmitted(progress: ExecutionLifecycle | null | undefined): boolean {
  if (!progress || !isFinalExecutionResult(progress) || progress.state !== 'attention') return false;
  const touched = progress.steps.flatMap(step => step.operations).filter(operation => operation.state !== 'waiting');
  return touched.length > 0 && touched.every(operation => !operation.hash && (operation.state === 'not-submitted' ||
    operation.state === 'failed' && (operation.label === 'Wallet request declined' || progress.evidence?.operations[operation.id]?.failure === 'declined')));
}

/**
 * BUILD-FIX-UX-001: the run the current workflow shows. A final run (confirmed, declined, failed or not submitted) stays attached to the
 * workflow it executed; once the owner creates or edits another workflow it no longer describes the Canvas, so it is not that workflow's
 * execution state. Its record is unchanged (Dashboard history, durable journal). An unresolved run always stays attached.
 */
export function currentExecution(progress: ExecutionLifecycle | null | undefined): ExecutionLifecycle | null {
  if (!progress?.started) return null;
  // BUILD-P0-MAINNET-EXECUTION-RELIABILITY (Incident F): a run of another workflow identity never describes an explicitly created new Canvas, even
  // while it is unresolved; it keeps being observed and stays in the Dashboard and History.
  if (progress.detached) return null;
  return progress.matchesWorkflow === false && !progress.planUnavailable && isFinalExecutionResult(progress) ? null : progress;
}

/**
 * BUILD-P0-MAINNET-EXECUTION-RELIABILITY (Incident D): a final run whose remaining wallet request was refused before submission (recorded as not
 * submitted: no hash, a pre-wallet refusal), with at most confirmed token approvals before it (a landed unwrap is excluded: its in-place re-quote needs the reconciled
 * unwrap, which this projection cannot see, and a fresh run would quote from WETH the owner no longer holds). Nothing of the
 * refused request reached the network, so the SAME workflow can be prepared and reviewed again in place — a bridge whose approval landed is
 * re-quoted on its own run, otherwise a fresh simulation starts — without rebuilding the Canvas. Confirmed requests stay recorded and are never
 * sent again. An unresolved, uncertain or submitted request never qualifies.
 */
export function refreshableAfterNothingSent(progress: ExecutionLifecycle | null | undefined): boolean {
  if (!progress || !isFinalExecutionResult(progress) || progress.state !== 'attention') return false;
  const touched = progress.steps.flatMap(step => step.operations).filter(operation => operation.state !== 'waiting');
  const refused = touched.filter(operation => operation.state === 'not-submitted' && !operation.hash);
  return refused.length > 0 && touched.every(operation => operation.state === 'not-submitted' && !operation.hash
    || operation.state === 'confirmed' && operation.approval);
}
