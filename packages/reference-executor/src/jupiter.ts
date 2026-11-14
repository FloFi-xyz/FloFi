// SPDX-License-Identifier: AGPL-3.0-only
import { createJournal, appendJournalState } from './journal.js';
import { assertKoraRelayedAttempt, assertRecordedSolanaWalletGuard, fromBase64, parseTransaction, requireSolanaSwapRuntime, solanaSwapArtifactHash, solanaSwapHash,
  type KoraGasTerms, type LookupTables, type SignedSolanaTransaction, type SolanaSwapReview, type SolanaWalletGuard } from '@defi-workflow-engine/reference-compiler';
import { hashJournalBytes, type ExecutionJournal } from '@defi-workflow-engine/workflow-contracts';

/**
 * One owner-signed Solana transaction per run, shared by every runtime of the canonical swap (Jupiter mainnet-beta,
 * Orca Whirlpools Devnet). The signature is the transaction identity and is durable BEFORE broadcast. A reviewed
 * blockhash past its last valid block height without the signature on chain is definitive proof it can never land.
 */
export type SolanaSwapAttemptState = 'PREPARED' | 'CANCELLED' | 'SUBMITTING' | 'SUBMISSION_RESULT_UNKNOWN' | 'PENDING' | 'CONFIRMED' |
  'REVERTED' | 'EXPIRED' | 'NOT_FOUND' | 'RECONCILIATION_REQUIRED';
/**
 * ADR-0010 §4, a Kora transaction's identity: the owner's signature (slot 1) is known and claimed first, the transaction id (Kora's slot-0
 * signature) only once Kora signed. `signedTransaction`: the fully signed bytes Kora returned, verified (null until then). The owner-signed bytes
 * stay in the attempt's `transaction`, durable BEFORE Kora is called; a lost answer is recovered by the owner's signature, never re-created.
 */
export type SolanaKoraAttempt = { ownerSignature: string; signedTransaction: string | null };
/**
 * `walletGuard`: the verified Lighthouse assertions the owner's wallet appended before signing (absent when it signed the reviewed bytes).
 * `kora`: present exactly for a Kora Review (`review.gas`); `signature` is then the transaction id, null until Kora answered.
 */
export type SolanaSwapAttempt = { state: SolanaSwapAttemptState; preparedAtBlockHeight: number; messageHash: string;
  signature: string | null; transaction: string | null; reconciled: boolean; walletGuard?: SolanaWalletGuard; kora?: SolanaKoraAttempt };
export type SolanaSwapProvenance = 'PUBLIC_MAINNET' | 'PUBLIC_DEVNET' | 'MOCKED';
export type SolanaSwapRun = { format: 'gryloo.jupiter-run.v1' | 'gryloo.orca-devnet-run.v1'; id: string; review: SolanaSwapReview; provenance: SolanaSwapProvenance;
  authorization: string | null; attempt: SolanaSwapAttempt | null; journal: ExecutionJournal;
  verdict: 'PENDING' | 'RECONCILED' | 'DIVERGENT' | 'INCONCLUSIVE' | 'NOT_EXECUTED'; ownerInitiated: boolean };
export const SOLANA_SWAP_TERMINAL_STATES: readonly SolanaSwapAttemptState[] = ['CANCELLED', 'CONFIRMED', 'REVERTED', 'EXPIRED', 'NOT_FOUND', 'RECONCILIATION_REQUIRED'];
const fail = (code: string): never => { throw new Error(code); };
const runtimeOf = (review: SolanaSwapReview) => requireSolanaSwapRuntime(review.chain);
/** Errors carry the runtime's prefix: JUPITER_* on mainnet-beta, DEVNET_SWAP_* on Devnet. */
const code = (run: Pick<SolanaSwapRun, 'review'>, suffix: string) => `${runtimeOf(run.review).codePrefix}_${suffix}`;
const names = (review: SolanaSwapReview) => { const prefix = runtimeOf(review).idPrefix; return { segment: `${prefix}-segment`, step: `${prefix}-swap` }; };
const formatOf = (review: SolanaSwapReview): SolanaSwapRun['format'] => review.format === 'gryloo.orca-devnet-review.v1' ? 'gryloo.orca-devnet-run.v1' : 'gryloo.jupiter-run.v1';

export function createSolanaSwapRun(id: string, review: SolanaSwapReview, provenance: SolanaSwapProvenance): SolanaSwapRun {
  const { segment, step } = names(review);
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
  return { format: formatOf(review), id, review, provenance, authorization: null, attempt: null, journal, verdict: 'PENDING', ownerInitiated: false };
}
export function solanaSwapTransition(run: SolanaSwapRun, state: SolanaSwapAttemptState, patch: Partial<SolanaSwapAttempt> = {}): SolanaSwapRun {
  const attempt = run.attempt ?? fail(code(run, 'ATTEMPT_MISSING'));
  if (attempt.signature && patch.signature && patch.signature !== attempt.signature) fail(code(run, 'SIGNATURE_DIVERGENT'));
  if (attempt.state === state) return { ...run, attempt: { ...attempt, ...patch } };
  const { segment, step } = names(run.review);
  const journal = appendJournalState(run.journal, { level: 'attempt', entityId: `${run.id}.swap`, segmentId: segment, stepId: step,
    executionAttemptId: `${run.id}.swap`, toState: state, recordedAt: new Date().toISOString() }).journal;
  return { ...run, journal, attempt: { ...attempt, ...patch, state } };
}
/** Durable economic intent, persisted by the coordinator BEFORE the wallet is asked to sign. */
export function prepareSolanaSwapAttempt(run: SolanaSwapRun, blockHeight: number): SolanaSwapRun {
  if (run.verdict !== 'PENDING') fail(code(run, 'RUN_TERMINAL'));
  if (run.attempt) fail(code(run, 'EXISTING_ATTEMPT_OBSERVE_ONLY'));
  if (run.authorization !== run.review.commitment) fail(code(run, 'REVIEW_REQUIRED'));
  if (!Number.isSafeInteger(blockHeight) || blockHeight >= run.review.lastValidBlockHeight) fail(code(run, 'QUOTE_STALE'));
  const attempt: SolanaSwapAttempt = { state: 'PREPARED', preparedAtBlockHeight: blockHeight, messageHash: run.review.messageHash,
    signature: null, transaction: null, reconciled: false };
  const { segment, step } = names(run.review);
  const journal = appendJournalState(run.journal, { level: 'attempt', entityId: `${run.id}.swap`, segmentId: segment, stepId: step,
    executionAttemptId: `${run.id}.swap`, toState: 'PREPARED', recordedAt: new Date().toISOString() }).journal;
  return { ...run, journal, attempt, ownerInitiated: true };
}
/**
 * The owner-signed bytes and signature become durable before any broadcast. ADR-0010: for a Kora Review the verified `signature` is the owner's
 * (slot 1): it is recorded as the Kora identity, and the transaction id stays unknown until Kora signs (`recordSolanaSwapRelay`).
 */
export function recordSolanaSwapSignature(run: SolanaSwapRun, signed: SignedSolanaTransaction): SolanaSwapRun {
  if (run.attempt?.state !== 'PREPARED') fail(code(run, 'ATTEMPT_NOT_PREPARED'));
  const guard = signed.walletGuard ? { walletGuard: signed.walletGuard } : {};
  if (run.review.gas) return solanaSwapTransition(run, 'SUBMITTING', { signature: null, transaction: signed.transaction, ...guard,
    kora: { ownerSignature: signed.signature, signedTransaction: null } });
  return solanaSwapTransition(run, 'SUBMITTING', { signature: signed.signature, transaction: signed.transaction, ...guard });
}
/**
 * ADR-0010: Kora's verified answer (or the transaction recovered from the chain by the owner's signature) becomes durable: the transaction id and
 * the fully signed bytes. Only once, only for the owner-signed bytes already recorded; the attempt's state is unchanged.
 */
export function recordSolanaSwapRelay(run: SolanaSwapRun, relayed: { signature: string; transaction: string }): SolanaSwapRun {
  const attempt = run.attempt, gas = run.review.gas;
  if (!gas || !attempt?.kora || !attempt.transaction || !['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN'].includes(attempt.state)) return fail(code(run, 'ATTEMPT_NOT_RELAYABLE'));
  if (attempt.signature) return attempt.signature === relayed.signature && attempt.kora.signedTransaction === relayed.transaction ? run : fail(code(run, 'SIGNATURE_DIVERGENT'));
  assertKoraRelayedAttempt(attempt.transaction, attempt.kora.ownerSignature, relayed.transaction, relayed.signature, gas.feePayer);
  return { ...run, attempt: { ...attempt, signature: relayed.signature, kora: { ...attempt.kora, signedTransaction: relayed.transaction } } };
}
/**
 * The attempt's identity fields for its Review: a native attempt has no `kora` and `signature` is the owner's; a Kora attempt records the owner's
 * signature with the owner-signed bytes, and its transaction id exactly when Kora's verified fully signed bytes are recorded. Shared by the swap and
 * transfer validators.
 */
export function assertSolanaAttemptIdentity(gas: KoraGasTerms | undefined, attempt: { state: string; signature: string | null; transaction: string | null; kora?: SolanaKoraAttempt },
  corrupt: string): void {
  const signed = !['PREPARED', 'CANCELLED'].includes(attempt.state);
  if (attempt.signature !== null && !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(attempt.signature)) fail(corrupt);
  if (!gas) { if (attempt.kora !== undefined || signed !== Boolean(attempt.signature && attempt.transaction)) fail(corrupt); return; }
  const kora = attempt.kora;
  if (signed !== Boolean(kora && attempt.transaction)) fail(corrupt);
  if (!kora) { if (attempt.signature || attempt.transaction) fail(corrupt); return; }
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(kora.ownerSignature) || Boolean(attempt.signature) !== Boolean(kora.signedTransaction)) fail(corrupt);
  // Only these states may still wait for the transaction id (Kora's answer lost, or refused before it signed).
  if (!attempt.signature && !['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'NOT_FOUND'].includes(attempt.state)) fail(corrupt);
  if (attempt.signature) try { assertKoraRelayedAttempt(attempt.transaction!, kora.ownerSignature, kora.signedTransaction!, attempt.signature, gas.feePayer); } catch { fail(corrupt); }
}
/**
 * Journaled signed bytes are the reviewed message, or a wallet guard that still verifies against it and is exactly the recorded one.
 * Shared by every owner-signed Solana run (swaps, transfers, liquidity).
 */
export function assertSignedSolanaAttempt(reviewedMessage: string, attempt: { transaction: string | null; walletGuard?: SolanaWalletGuard }, tables: LookupTables, corrupt: string): void {
  if (!attempt.transaction) { if (attempt.walletGuard !== undefined) fail(corrupt); return; }
  try { assertRecordedSolanaWalletGuard(fromBase64(reviewedMessage), parseTransaction(fromBase64(attempt.transaction, 2048)).message, attempt.walletGuard, tables); }
  catch { fail(corrupt); }
}
export type SolanaSwapObservationDecision = 'FOUND' | 'WAIT' | 'EXPIRED';
/** Absence is conclusive only after finalized block height has passed the reviewed blockhash validity. */
export function solanaSwapObservationDecision(found: boolean, finalizedBlockHeight: number, lastValidBlockHeight: number): SolanaSwapObservationDecision {
  if (found) return 'FOUND';
  if (!Number.isSafeInteger(finalizedBlockHeight)) fail('SOLANA_RPC_INVALID');
  return finalizedBlockHeight > lastValidBlockHeight ? 'EXPIRED' : 'WAIT';
}
/** Whether this run's attempt still needs observation (an unresolved attempt never blocks another run's attempt). */
export function solanaSwapAttemptResolved(run: SolanaSwapRun): boolean {
  return !run.attempt || SOLANA_SWAP_TERMINAL_STATES.includes(run.attempt.state) && run.attempt.state !== 'RECONCILIATION_REQUIRED' || run.verdict !== 'PENDING';
}
export function validateSolanaSwapRun(run: SolanaSwapRun): void {
  const runtime = run?.review?.chain ? requireSolanaSwapRuntime(run.review.chain) : fail('SOLANA_SWAP_STORE_CORRUPT');
  const corrupt = `${runtime.codePrefix}_STORE_CORRUPT`;
  if (run.format !== formatOf(run.review) || !new RegExp(`^${runtime.idPrefix}-[a-f0-9]{32}$`).test(run.id) ||
      !['MOCKED', runtime.provenance].includes(run.provenance)) fail(corrupt);
  const { commitment, ...review } = run.review;
  if (solanaSwapHash(review) !== commitment || solanaSwapArtifactHash('execution-plan', run.review.plan) !== run.journal.executionPlanHash ||
      solanaSwapArtifactHash('strategy-manifest', run.review.manifest) !== run.journal.manifestHash || run.journal.journalId !== run.id ||
      run.journal.workflowId !== run.review.workflow.workflowId || run.authorization !== null && run.authorization !== commitment ||
      typeof run.ownerInitiated !== 'boolean' || run.ownerInitiated !== Boolean(run.attempt) ||
      !['PENDING', 'RECONCILED', 'DIVERGENT', 'INCONCLUSIVE', 'NOT_EXECUTED'].includes(run.verdict)) fail(corrupt);
  hashJournalBytes(new TextEncoder().encode(JSON.stringify(run.journal)));
  const attempt = run.attempt;
  if (!attempt) { if (run.verdict !== 'PENDING') fail(corrupt); return; }
  const entry = [...run.journal.entries].reverse().find(e => e.entityId === `${run.id}.swap`);
  if (entry?.toState !== attempt.state || attempt.messageHash !== run.review.messageHash || !Number.isSafeInteger(attempt.preparedAtBlockHeight) ||
      typeof attempt.reconciled !== 'boolean' || attempt.reconciled !== (attempt.state === 'CONFIRMED') ||
      run.verdict === 'RECONCILED' && !attempt.reconciled) fail(corrupt);
  assertSolanaAttemptIdentity(run.review.gas, attempt, corrupt);
  assertSignedSolanaAttempt(run.review.message, attempt, run.review.lookupTables, corrupt);
}

// BUILD-014 names for the same shared lifecycle.
export type JupiterAttemptState = SolanaSwapAttemptState;
export type JupiterAttempt = SolanaSwapAttempt;
export type JupiterRun = SolanaSwapRun;
export type JupiterObservationDecision = SolanaSwapObservationDecision;
export const JUPITER_TERMINAL_STATES = SOLANA_SWAP_TERMINAL_STATES;
export const createJupiterRun = createSolanaSwapRun;
export const jupiterTransition = solanaSwapTransition;
export const prepareJupiterAttempt = prepareSolanaSwapAttempt;
export const recordJupiterSignature = recordSolanaSwapSignature;
export const jupiterObservationDecision = solanaSwapObservationDecision;
export const jupiterAttemptResolved = solanaSwapAttemptResolved;
export const validateJupiterRun = validateSolanaSwapRun;
