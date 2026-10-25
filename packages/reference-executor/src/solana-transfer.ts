// SPDX-License-Identifier: AGPL-3.0-only
import { createJournal, appendJournalState } from './journal.js';
import { solanaSwapArtifactHash, solanaSwapHash, solanaTransferProfile, type SignedSolanaTransaction, type SolanaTransferReview, type SolanaWalletGuard } from '@defi-workflow-engine/reference-compiler';
import { assertSignedSolanaAttempt } from './jupiter.js';
import { hashJournalBytes, type ExecutionJournal } from '@defi-workflow-engine/workflow-contracts';

/**
 * BUILD-SOLANA-TRANSFER-UX-001: one owner-signed Solana transfer per run, with the same lifecycle as the Solana swap runs. The economic intent
 * (PREPARED) is durable before the wallet is asked to sign; the signature — the transaction's identity — is durable before broadcast; an
 * unknown submission is resolved only by observing that signature. A reviewed blockhash past its last valid block height without the
 * signature on chain is definitive proof the transfer can never land, so no second transfer is ever needed to recover.
 */
export type SolanaTransferAttemptState = 'PREPARED' | 'CANCELLED' | 'SUBMITTING' | 'SUBMISSION_RESULT_UNKNOWN' | 'PENDING' | 'CONFIRMED' |
  'REVERTED' | 'EXPIRED' | 'NOT_FOUND' | 'RECONCILIATION_REQUIRED';
/** `walletGuard`: the verified Lighthouse assertions the owner's wallet appended before signing (absent when it signed the reviewed bytes). */
export type SolanaTransferAttempt = { state: SolanaTransferAttemptState; preparedAtBlockHeight: number; messageHash: string;
  signature: string | null; transaction: string | null; reconciled: boolean; walletGuard?: SolanaWalletGuard };
export type SolanaTransferProvenance = 'PUBLIC_MAINNET' | 'PUBLIC_DEVNET' | 'MOCKED';
export type SolanaTransferRun = { format: 'gryloo.solana-transfer-run.v1'; id: string; review: SolanaTransferReview; provenance: SolanaTransferProvenance;
  authorization: string | null; attempt: SolanaTransferAttempt | null; journal: ExecutionJournal;
  verdict: 'PENDING' | 'RECONCILED' | 'DIVERGENT' | 'INCONCLUSIVE' | 'NOT_EXECUTED'; ownerInitiated: boolean };
export const SOLANA_TRANSFER_TERMINAL_STATES: readonly SolanaTransferAttemptState[] = ['CANCELLED', 'CONFIRMED', 'REVERTED', 'EXPIRED', 'NOT_FOUND', 'RECONCILIATION_REQUIRED'];
const fail = (code: string): never => { throw new Error(`SOLANA_TRANSFER_${code}`); };
const profileOf = (review: SolanaTransferReview) => solanaTransferProfile(review.chain) ?? fail('NETWORK_UNSUPPORTED');
const names = (review: SolanaTransferReview) => { const prefix = profileOf(review).idPrefix; return { segment: `${prefix}-segment`, step: `${prefix}-transfer` }; };
export const solanaTransferRunId = (review: Pick<SolanaTransferReview, 'chain'>) => new RegExp(`^${(solanaTransferProfile(review.chain) ?? fail('NETWORK_UNSUPPORTED')).idPrefix}-[a-f0-9]{32}$`);

export function createSolanaTransferRun(id: string, review: SolanaTransferReview, provenance: SolanaTransferProvenance): SolanaTransferRun {
  const { segment, step } = names(review);
  if (!solanaTransferRunId(review).test(id)) fail('ID_INVALID');
  let journal = createJournal({ journalId: id, workflowId: review.workflow.workflowId,
    executionPlanHash: solanaSwapArtifactHash('execution-plan', review.plan), manifestHash: solanaSwapArtifactHash('strategy-manifest', review.manifest) });
  const append = (level: 'workflow' | 'segment' | 'step', entityId: string, toState: 'DRAFT' | 'PLANNED' | 'REVIEWED' | 'SIMULATED', stepId: string | null) => {
    journal = appendJournalState(journal, { level, entityId, segmentId: level === 'workflow' ? null : segment, stepId, executionAttemptId: null,
      toState, recordedAt: new Date().toISOString() }).journal;
  };
  append('workflow', review.workflow.workflowId, 'DRAFT', null);
  append('segment', segment, 'PLANNED', null);
  append('step', step, 'PLANNED', step);
  append('workflow', review.workflow.workflowId, 'REVIEWED', null);
  append('workflow', review.workflow.workflowId, 'SIMULATED', null);
  return { format: 'gryloo.solana-transfer-run.v1', id, review, provenance, authorization: null, attempt: null, journal, verdict: 'PENDING', ownerInitiated: false };
}
export function solanaTransferTransition(run: SolanaTransferRun, state: SolanaTransferAttemptState, patch: Partial<SolanaTransferAttempt> = {}): SolanaTransferRun {
  const attempt = run.attempt ?? fail('ATTEMPT_MISSING');
  if (attempt.signature && patch.signature && patch.signature !== attempt.signature) fail('SIGNATURE_DIVERGENT');
  if (attempt.state === state) return { ...run, attempt: { ...attempt, ...patch } };
  const { segment, step } = names(run.review);
  const journal = appendJournalState(run.journal, { level: 'attempt', entityId: `${run.id}.transfer`, segmentId: segment, stepId: step,
    executionAttemptId: `${run.id}.transfer`, toState: state, recordedAt: new Date().toISOString() }).journal;
  return { ...run, journal, attempt: { ...attempt, ...patch, state } };
}
/** Durable economic intent, persisted by the coordinator BEFORE the wallet is asked to sign. */
export function prepareSolanaTransferAttempt(run: SolanaTransferRun, blockHeight: number): SolanaTransferRun {
  if (run.verdict !== 'PENDING') fail('RUN_TERMINAL');
  if (run.attempt) fail('EXISTING_ATTEMPT_OBSERVE_ONLY');
  if (run.authorization !== run.review.commitment) fail('REVIEW_REQUIRED');
  if (!Number.isSafeInteger(blockHeight) || blockHeight >= run.review.lastValidBlockHeight) fail('REVIEW_EXPIRED');
  const attempt: SolanaTransferAttempt = { state: 'PREPARED', preparedAtBlockHeight: blockHeight, messageHash: run.review.messageHash, signature: null, transaction: null, reconciled: false };
  const { segment, step } = names(run.review);
  const journal = appendJournalState(run.journal, { level: 'attempt', entityId: `${run.id}.transfer`, segmentId: segment, stepId: step,
    executionAttemptId: `${run.id}.transfer`, toState: 'PREPARED', recordedAt: new Date().toISOString() }).journal;
  return { ...run, journal, attempt, ownerInitiated: true };
}
/** The owner-signed bytes and signature become durable before any broadcast. */
export function recordSolanaTransferSignature(run: SolanaTransferRun, signed: SignedSolanaTransaction): SolanaTransferRun {
  if (run.attempt?.state !== 'PREPARED') fail('ATTEMPT_NOT_PREPARED');
  return solanaTransferTransition(run, 'SUBMITTING', { signature: signed.signature, transaction: signed.transaction, ...signed.walletGuard ? { walletGuard: signed.walletGuard } : {} });
}
/** Absence is conclusive only after finalized block height has passed the reviewed blockhash validity. */
export function solanaTransferObservationDecision(found: boolean, finalizedBlockHeight: number, lastValidBlockHeight: number): 'FOUND' | 'WAIT' | 'EXPIRED' {
  if (found) return 'FOUND';
  if (!Number.isSafeInteger(finalizedBlockHeight)) fail('RPC_INVALID');
  return finalizedBlockHeight > lastValidBlockHeight ? 'EXPIRED' : 'WAIT';
}
/** Whether this run's attempt still needs observation (an unresolved attempt never blocks another run's attempt). */
export function solanaTransferAttemptResolved(run: SolanaTransferRun): boolean {
  return !run.attempt || ['CANCELLED', 'CONFIRMED', 'REVERTED', 'EXPIRED', 'NOT_FOUND'].includes(run.attempt.state);
}
export function validateSolanaTransferRun(run: SolanaTransferRun): void {
  const corrupt = 'STORE_CORRUPT';
  if (!run?.review?.chain || run.format !== 'gryloo.solana-transfer-run.v1' || run.review.format !== 'gryloo.solana-transfer-review.v1') fail(corrupt);
  const profile = solanaTransferProfile(run.review.chain) ?? fail(corrupt);
  if (!solanaTransferRunId(run.review).test(run.id) || !['MOCKED', profile.provenance].includes(run.provenance)) fail(corrupt);
  const { commitment, ...review } = run.review;
  if (solanaSwapHash(review) !== commitment || solanaSwapArtifactHash('execution-plan', run.review.plan) !== run.journal.executionPlanHash ||
      solanaSwapArtifactHash('strategy-manifest', run.review.manifest) !== run.journal.manifestHash || run.journal.journalId !== run.id ||
      run.journal.workflowId !== run.review.workflow.workflowId || run.authorization !== null && run.authorization !== commitment ||
      typeof run.ownerInitiated !== 'boolean' || run.ownerInitiated !== Boolean(run.attempt) ||
      !['PENDING', 'RECONCILED', 'DIVERGENT', 'INCONCLUSIVE', 'NOT_EXECUTED'].includes(run.verdict)) fail(corrupt);
  hashJournalBytes(new TextEncoder().encode(JSON.stringify(run.journal)));
  const attempt = run.attempt;
  if (!attempt) { if (run.verdict !== 'PENDING') fail(corrupt); return; }
  const entry = [...run.journal.entries].reverse().find(e => e.entityId === `${run.id}.transfer`);
  const signed = !['PREPARED', 'CANCELLED'].includes(attempt.state);
  if (entry?.toState !== attempt.state || attempt.messageHash !== run.review.messageHash || !Number.isSafeInteger(attempt.preparedAtBlockHeight) ||
      signed !== Boolean(attempt.signature && attempt.transaction) || attempt.signature !== null && !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(attempt.signature) ||
      typeof attempt.reconciled !== 'boolean' || attempt.reconciled !== (attempt.state === 'CONFIRMED') ||
      run.verdict === 'RECONCILED' && !attempt.reconciled) fail(corrupt);
  assertSignedSolanaAttempt(run.review.message, attempt, {}, corrupt);
}
