// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001 (P0): what Support shows for a nonce-conflict investigation. Pure: built from the stored diagnostic
 * row only. It never calls the outcome resolved: a finished investigation with an inconclusive result is shown as inconclusive, and the
 * transaction outcome is always the run's own (UNKNOWN while the flow keeps observing). Explorer links are navigation aids, never evidence.
 * Nothing here shows a wallet address: the report stores no sender, and the consuming transaction's target (which can be the owner's own
 * address for a self-send) is never rendered.
 */
import type { NonceConflictRow } from '../../server/nonce-conflict-store.ts';
import type { Comparison, NonceConflictClassification, SafeNextAction } from '../../server/nonce-conflict.ts';
import { externalNonceEvidencePending } from './lifecycle.ts';

const NETWORKS: Readonly<Record<string, { name: string; explorer: string }>> = {
  '1': { name: 'Ethereum mainnet', explorer: 'https://etherscan.io/tx/' }, '8453': { name: 'Base mainnet', explorer: 'https://basescan.org/tx/' },
  '42161': { name: 'Arbitrum One', explorer: 'https://arbiscan.io/tx/' },
};
export const CLASSIFICATION_LABELS: Readonly<Record<NonceConflictClassification, string>> = {
  MATCHING_TRANSACTION_CONFIRMED: 'The transaction at this nonce matches the reviewed call',
  CONFLICTING_TRANSACTION_IDENTIFIED: 'A different transaction used the reserved nonce',
  DELEGATED_EXECUTION_UNDETERMINED: 'Delegated or batched execution — not determinable',
  POSSIBLE_ALTERNATE_NONCE: 'The reviewed effect appears in another transaction (another nonce)',
  INSUFFICIENT_CHAIN_EVIDENCE: 'Not enough chain evidence yet',
};
const CLASSIFICATION_MEANING: Readonly<Record<NonceConflictClassification, string>> = {
  MATCHING_TRANSACTION_CONFIRMED: 'The flow’s own reconciliation settles a matching transaction; this investigation does not.',
  CONFLICTING_TRANSACTION_IDENTIFIED: 'A finalized transaction used this nonce and its effects differ from the reviewed call. The outcome of the reviewed execution remains open.',
  DELEGATED_EXECUTION_UNDETERMINED: 'The consuming transaction runs through a delegated account or batch, or carries the reviewed effect inside a different outer call. '
    + 'The reviewed call may have executed inside it; it cannot be attributed from the outer transaction.',
  POSSIBLE_ALTERNATE_NONCE: 'An event with the reviewed effect was found in another of the sender’s transactions. It may be the reviewed call sent with another nonce, or '
    + 'an unrelated transaction with the same effect; it is not attributed to this execution.',
  INSUFFICIENT_CHAIN_EVIDENCE: 'The investigation needs a usable RPC response and a finalized, canonical receipt for the consuming transaction.',
};
const NEXT_ACTION: Readonly<Record<SafeNextAction, string>> = {
  WAIT_FOR_RPC: 'Wait: the worker retries the read. If it keeps failing, check the network’s RPC provider.',
  WAIT_FOR_FINALITY: 'Wait for the consuming transaction to become final; the worker checks again.',
  LET_FLOW_SETTLE: 'Wait for the flow’s own reconciliation to settle the matching transaction.',
  CONTINUE_SCAN: 'Wait: the worker is still scanning the sender’s later transactions for the reviewed effect.',
  OPERATOR_REVIEW_DELEGATED: 'Decode the consuming transaction’s inner calls on two independent sources and record a finding note. Do not ask the owner to sign again until the inner calls are known.',
  OPERATOR_REVIEW_ALTERNATE: 'Compare the candidate transaction with the reviewed call on two independent sources and record a finding note. It is not attributed automatically.',
  OPERATOR_REVIEW_CONFLICT: 'Compare the finalized receipt and the alternate nonce scan with the reviewed call. Record a finding and request another read-only check when new evidence is available.',
  OPERATOR_REVIEW_PROTOCOL_WINDOW: 'The flow’s protocol-specific checks (deposit scan, deadline) remain the only proof of non-execution; let them run and review their verdict.',
};
const REASONS: Readonly<Record<string, string>> = {
  NONCE_CONSUMPTION_IS_NOT_PROOF_OF_OUTCOME: 'A consumed nonce is not proof of execution or of non-execution.',
  LATER_BROADCAST_NOT_EXCLUDED: 'No reviewed effect was found up to the final block scanned, but a later broadcast with another nonce cannot be excluded.',
  ALTERNATE_NONCE_CANDIDATES_TRUNCATED: 'More approvals to the reviewed spender exist than were recorded; the check is incomplete.',
  ALTERNATE_NONCE_SCAN_INCOMPLETE: 'The scan of the sender’s later transactions has not reached the final block yet.',
  ALTERNATE_NONCE_PROTOCOL_SPECIFIC: 'For this step, evidence of the reviewed call under another nonce is protocol-specific and stays with the flow’s own scans.',
  REVIEWED_EFFECT_ABSENT_FROM_CONFLICT: 'The consuming transaction does not carry the reviewed approval (spender and amount).',
  REVIEWED_EFFECT_NOT_RECOGNISABLE_WITHOUT_PROTOCOL: 'The reviewed call’s effect cannot be recognised without the protocol’s own evidence.',
  REVIEWED_EFFECT_INSIDE_DIFFERENT_OUTER_TRANSACTION: 'The reviewed effect appears inside a different outer transaction.',
  DELEGATED_OR_BATCHED_EXECUTION_NOT_DECODED: 'The consuming transaction is delegated or batched; its inner calls are not decoded here.',
  REVIEWED_EFFECT_FOUND_IN_ANOTHER_TRANSACTION_NOT_ATTRIBUTED: 'A matching effect exists in another transaction but is not attributed to this execution.',
  SAME_SPENDER_APPROVAL_WITH_DIFFERENT_AMOUNT: 'An approval to the reviewed spender with a different amount was found in another transaction.',
  CANDIDATE_RECORDED_BY_ANOTHER_FLOFI_WORKFLOW: 'A candidate transaction is recorded, by exact hash, by another FloFi workflow (it is most likely that workflow’s own).',
  CONFLICT_RECORDED_BY_ANOTHER_FLOFI_WORKFLOW: 'The consuming transaction is recorded, by exact hash, by another FloFi workflow.',
  MATCH_SETTLED_ONLY_BY_FLOW_RECONCILIATION: 'Only the flow’s own reconciliation can settle the match.',
  OUTCOME_UNKNOWN_CHAIN_EVIDENCE_INCOMPLETE: 'The chain evidence is incomplete.',
  CONFLICT_HASH_NOT_RECORDED: 'The flow recorded no hash for the consuming transaction.',
  CONFLICT_TRANSACTION_NOT_FOUND: 'The consuming transaction was not found by the RPC provider (yet).',
  CONFLICT_NOT_FINAL: 'The consuming transaction is not final yet.',
  CONFLICT_NOT_CANONICAL: 'The consuming transaction’s block is not canonical.',
  CONFLICT_NOT_MINED: 'The consuming transaction is not mined.',
  CONFLICT_IDENTITY_MISMATCH: 'The RPC returned a transaction that does not match the recorded sender, nonce or hash.',
  RPC_UNAVAILABLE: 'The RPC provider did not answer.', RPC_RESPONSE_INVALID: 'The RPC provider returned an invalid response.',
  RPC_CHAIN_MISMATCH: 'The worker’s RPC client does not serve this execution’s network.',
};
const COMPARISON: Readonly<Record<Comparison, string>> = { SAME: 'Same', DIFFERENT: 'Different', UNKNOWN: 'Not established', NOT_APPLICABLE: 'Not applicable' };
const STRUCTURE: Readonly<Record<string, string>> = { DIRECT: 'Direct transaction from the sender', EIP7702_SET_CODE: 'EIP-7702 set-code transaction (delegated)',
  DELEGATED_SELF_CALL: 'Call to the sender’s own delegated code (batched)', DELEGATED_ACCOUNT: 'Sender has an EIP-7702 delegation', CONTRACT_CREATION: 'Contract creation',
  UNKNOWN: 'Not established' };
const EFFECT: Readonly<Record<string, string>> = { OBSERVED: 'Observed in the consuming transaction', ABSENT: 'Absent from the consuming transaction',
  NOT_DETERMINABLE: 'Not determinable without the protocol’s evidence' };

export type NonceConflictView = {
  readonly attemptId: string; readonly step: string; readonly network: string; readonly nonce: string; readonly classification: string; readonly meaning: string;
  /** Always the run's: this view never concludes an outcome. */ readonly outcome: string; readonly status: string;
  readonly conflictingTransaction: { readonly hash: string; readonly proven: boolean; readonly explorer: string | null; readonly block: number | null; readonly final: boolean } | null;
  readonly evidenceSource: string; readonly relatedWorkflows: readonly { readonly runId: string; readonly flow: string; readonly basis: string }[];
  readonly comparison: readonly { readonly field: string; readonly value: string }[]; readonly structure: string; readonly effect: string;
  readonly alternate: string; readonly proofComplete: boolean; readonly lastVerifiedAt: string | null; readonly lastCheckedAt: string; readonly firstObservedAt: string;
  readonly stableObservations: number; readonly investigations: number; readonly escalatedAt: string | null; readonly lastCheckCode: string | null;
  readonly whyUnknown: readonly string[]; readonly nextAction: string; readonly laterAttempts: string;
};

/** What the run itself says now (the stored row alone cannot know whether a check is queued, stopped, or the flow has since settled). */
export type RunCheckContext = { readonly needsObservation: boolean; readonly reconcile: { readonly state: string; readonly createdAt: Date } | null };
function statusOf(row: NonceConflictRow, context: RunCheckContext | null): string {
  const check = context?.reconcile, open = check?.state === 'READY' || check?.state === 'LEASED';
  if (context && !context.needsObservation) return 'Investigation record kept for reference — the run is no longer observed';
  if (row.escalatedAt && open && check!.createdAt > row.escalatedAt) return 'Re-inspection queued — outcome still unknown';
  if (row.escalatedAt) return 'Investigation complete and unchanged — escalated for operator review (outcome still unknown)';
  if (context && check?.state === 'DEAD') return 'Automatic checks stopped — see Recovery (outcome still unknown)';
  if (open && externalNonceEvidencePending(row.lastCheckCode)) return 'Awaiting external evidence — check queued or running';
  return row.report.retryable || row.classification === 'INSUFFICIENT_CHAIN_EVIDENCE' ? 'Evidence gathering incomplete' : 'Investigation complete — outcome still unknown';
}
export function nonceConflictView(row: NonceConflictRow, context: RunCheckContext | null = null): NonceConflictView {
  const r = row.report, network = NETWORKS[row.chainId], conflict = r.conflict;
  const proven = row.classification !== 'INSUFFICIENT_CHAIN_EVIDENCE' && !!conflict && conflict.final;
  const alt = r.alternateNonce;
  const stopped = context?.reconcile?.state === 'DEAD';
  const nextAction = stopped && row.lastCheckCode === 'RPC_UNAVAILABLE' ? 'Restore access to finalized receipts and historical logs before resuming a read-only check.'
    : stopped && ['WAIT_FOR_FINALITY', 'WAIT_FOR_RPC', 'CONTINUE_SCAN', 'LET_FLOW_SETTLE', 'OPERATOR_REVIEW_PROTOCOL_WINDOW'].includes(r.safeNextAction)
      ? 'Review the missing evidence. Use Recovery to preview a read-only check when the evidence is available.' : NEXT_ACTION[r.safeNextAction];
  const alternate = alt.truncated ? 'Truncated — more same-spender approvals than recorded (incomplete)' : alt.status === 'NOT_EVALUATED'
    ? row.classification === 'INSUFFICIENT_CHAIN_EVIDENCE' ? 'Scan unavailable because the chain evidence is incomplete' : 'Protocol-specific evidence required for this step'
    : `${alt.status === 'CANDIDATE_FOUND' ? `${alt.candidates.length} candidate transaction(s) found` : alt.status === 'NONE_IN_SCANNED_RANGE' ? 'None found' : 'Scan in progress'}`
      + (alt.scannedFrom !== null && alt.scannedThrough !== null ? ` — blocks ${alt.scannedFrom}–${alt.scannedThrough}${alt.complete ? ' (reached the final block)' : ''}` : '');
  return {
    attemptId: row.attemptId, step: r.step, network: network?.name ?? `EVM chain ${row.chainId}`, nonce: row.nonce,
    classification: CLASSIFICATION_LABELS[row.classification], meaning: CLASSIFICATION_MEANING[row.classification],
    outcome: context && !context.needsObservation ? 'The flow no longer observes this run — its outcome is in the Summary (this investigation never decides it)'
      : 'Unknown — this investigation never decides the transaction outcome',
    status: statusOf(row, context),
    conflictingTransaction: row.conflictingTransactionHash ? { hash: row.conflictingTransactionHash, proven, explorer: network ? network.explorer + row.conflictingTransactionHash : null,
      block: conflict?.blockNumber ?? null, final: conflict?.final ?? false } : null,
    evidenceSource: `The worker’s read-only RPC reads of ${network?.name ?? `chain ${row.chainId}`} (transaction, receipt, canonical block, account code and event logs`
      + `${conflict ? ` at final block ${alt.finalHead ?? conflict.blockNumber}` : ''}), and FloFi’s own attempt records in this tenant.`,
    relatedWorkflows: r.relatedWorkflows.filter(w => w.linkage !== 'SAME_NONCE_OTHER_HASH').map(w => ({ runId: w.runId, flow: w.flow,
      basis: w.linkage === 'SAME_TRANSACTION_HASH' ? `Recorded the consuming transaction by exact hash (${w.step} ${w.state})` : `Recorded a candidate transaction by exact hash (${w.step} ${w.state})` })),
    comparison: [['Sender', r.comparison.sender], ['Network', r.comparison.chain], ['Target contract', r.comparison.target], ['Function selector', r.comparison.selector],
      ['Calldata', r.comparison.calldata], ['Value', r.comparison.value], ['Approval spender', r.comparison.approvalSpender], ['Approval amount', r.comparison.approvalAmount]]
      .map(([field, value]) => ({ field: field!, value: COMPARISON[value as Comparison] })),
    structure: STRUCTURE[r.executionStructure] ?? r.executionStructure, effect: EFFECT[r.reviewedEffectInConflict] ?? r.reviewedEffectInConflict, alternate,
    proofComplete: r.proofComplete, lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null, lastCheckedAt: row.lastCheckedAt.toISOString(),
    firstObservedAt: row.firstObservedAt.toISOString(), stableObservations: row.stableObservations, investigations: row.investigations,
    escalatedAt: row.escalatedAt?.toISOString() ?? null, lastCheckCode: row.lastCheckCode,
    whyUnknown: r.reasons.map(code => REASONS[code] ?? code), nextAction,
    laterAttempts: r.laterAttempts.length ? r.laterAttempts.map(a => `${a.step} ${a.state}${a.hashRecorded ? ' (hash recorded)' : ''}`).join(', ')
      : 'None — FloFi never asked the wallet for a later step of this execution.',
  };
}
