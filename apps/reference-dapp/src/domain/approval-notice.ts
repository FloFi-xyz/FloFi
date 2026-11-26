// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001 (incident 9): what the proposal notice on `/approve` (and its embedded MCP frame) says once
 * the proposal is loaded. Before, it kept "Ready for your review." through submission, reconciliation and completion. It now follows the shown
 * execution and, for a workflow run, the run's own durable state. Presentation only: it starts, sends or decides nothing.
 */
export type ApprovalNoticePhase = 'review' | 'active' | 'complete' | 'attention' | 'ended';
export type ApprovalNoticeExecution = 'active' | 'complete' | 'attention' | null | undefined;
const WAITING = new Set(['WAITING_FOR_RECONCILIATION', 'NONE']);

type CodedList = readonly { readonly code?: string | null }[] | undefined;
export function approvalNoticePhase(execution: ApprovalNoticeExecution, run: { readonly state?: string; readonly nextAction?: string; readonly code?: string | null;
  readonly steps?: CodedList; readonly groups?: CodedList } | null | undefined): ApprovalNoticePhase {
  // A batch handed to the wallet whose answer never arrived may have executed: never "Ended" or "Nothing more" (flofi-workflow/security reviews).
  const unknown = (list: CodedList) => (list ?? []).some(item => item?.code === 'WALLET_BATCH_OUTCOME_UNKNOWN');
  if (run && (run.code === 'WALLET_BATCH_OUTCOME_UNKNOWN' || unknown(run.steps) || unknown(run.groups))) return 'attention';
  if (run?.state === 'COMPLETED') return 'complete';
  if (run?.state === 'FAILED' || run?.state === 'CANCELLED' || run?.state === 'EXPIRED') return 'ended';
  if (run?.state === 'HALTED' || run?.state === 'ATTENTION') return 'attention';
  if (run?.state === 'RUNNING' && WAITING.has(run.nextAction ?? '')) return 'active';
  return execution === 'active' ? 'active' : execution === 'complete' ? 'complete' : execution === 'attention' ? 'attention' : 'review';
}
/** The notice's two parts (lead, sentence) per phase: catalog messages, translated where they are shown. */
export const APPROVAL_NOTICE: Readonly<Record<ApprovalNoticePhase, readonly [string, string]>> = Object.freeze({
  review: ['Ready for your review.', 'FloFi prepares a fresh simulation for this wallet. Check it, then authorize in your wallet.'],
  active: ['In progress.', 'Follow the status below. FloFi keeps checking the network on its own and never sends a request twice.'],
  complete: ['Completed.', 'The result below is what FloFi reconciled on chain. You can return to your conversation.'],
  attention: ['Needs your attention.', 'Check the status below before taking another action. Something may already have been sent.'],
  ended: ['Ended.', 'Nothing more will be requested from your wallet for this proposal.'],
});
