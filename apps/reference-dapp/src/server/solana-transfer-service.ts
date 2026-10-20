// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-SOLANA-TRANSFER-UX-001 coordinator for one owner-signed direct transfer on a Solana cluster (mainnet-beta with real funds, or Devnet).
 * It never holds a key, never signs and broadcasts only the owner's exact reviewed bytes, once:
 *   simulate → Review (owner acceptance) → begin (fresh checks, owner lease, durable PREPARED before the wallet is asked) →
 *   submit (exact bytes + owner signature verified, signature durable, then one broadcast) → observe (signature status, finality,
 *   independent reconciliation of the actual balance movements) → Evidence Bundle.
 * A refused or failed wallet request records that nothing was sent; an unknown submission is only ever observed by its signature, and a
 * blockhash past its last valid block height proves the transfer can never land — so recovery never creates a second transfer.
 */
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { validateAuthoringWorkflow, createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { assertSolanaTransferReview, describeSolanaWalletChange, readSolanaTransferFacts, simulateSolanaTransfer, solanaAddress, solanaTransferIntent,
  verifySignedSolanaTransfer, verifySolanaCluster, type SolanaRpc, type SolanaTransferProfile, type SolanaTransferReview, type SolanaWalletChange } from '@defi-workflow-engine/reference-compiler';
import { createSolanaTransferRun, prepareSolanaTransferAttempt, recordSolanaTransferSignature, solanaTransferAttemptResolved, solanaTransferObservationDecision,
  solanaTransferTransition, validateSolanaTransferRun, createFileExecutionStorage, logMissing, utf8, type ExecutionStorage, type SolanaTransferProvenance,
  type SolanaTransferRun } from '@defi-workflow-engine/reference-executor';
import { buildSolanaTransferEvidence, classifySolanaTransferEvidence, reconcileSolanaTransferAttempt, type SolanaTransferEvidenceClass,
  type SolanaTransferObservation } from '@defi-workflow-engine/reference-reconciler';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';

const X = 'SOLANA_TRANSFER';
/** `change`: what the wallet altered in a refused transaction (public keys, counts and hashes only; never its bytes or signatures). */
export type SolanaTransferWalletDiagnostic = { stage: 'CONNECT' | 'SIGN' | 'PREFLIGHT'; code: string; error: unknown; change?: SolanaWalletChange };
export type SolanaTransferRecord = SolanaTransferRun & { observations: SolanaTransferObservation[]; evidence: ReturnType<typeof buildSolanaTransferEvidence> | null;
  error: string | null; evidenceClass: SolanaTransferEvidenceClass; notSubmitted?: boolean; submissionError?: string; walletDiagnostic?: SolanaTransferWalletDiagnostic };
export type SolanaTransferBegin = { record: SolanaTransferRecord; unsignedTransaction: string; walletChain: string };
const code = (cause: unknown, fallback: string) => cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : fallback;

/** One coordinator per cluster profile; the profile selects the chain, cluster identity, run ids and the real-funds rule. */
export function createSolanaTransferService(input: { profile: SolanaTransferProfile; rpc: SolanaRpc; journalDir?: string; storage?: ExecutionStorage;
  provenance: SolanaTransferProvenance; executionEnabled: boolean; now?: () => number }) {
  const { profile } = input;
  if (input.provenance !== 'MOCKED' && input.provenance !== profile.provenance) throw new Error(`${X}_PROVENANCE_INVALID`);
  // Local mode keeps a journal directory; cloud mode supplies shared durable storage instead.
  if (!input.storage && (!input.journalDir || !isAbsolute(input.journalDir) || input.journalDir.includes('/.git/'))) throw new Error(`${X}_STORAGE_INVALID`);
  const { log, leases } = input.storage ?? createFileExecutionStorage(input.journalDir!, `${X}_BUSY`);
  const idPattern = new RegExp(`^${profile.idPrefix}-[a-f0-9]{32}$`);
  const idCheck = (id: string) => { if (typeof id !== 'string' || !idPattern.test(id)) throw new Error(`${X}_ID_INVALID`); return id; };
  const now = input.now ?? Date.now;
  const assertCluster = () => verifySolanaCluster(input.rpc, profile.genesisHash).catch((cause: unknown) => { throw new Error(`${X}_WRONG_CLUSTER`, { cause }); });
  const path = (id: string) => idCheck(id) + '.jsonl';
  const classify = (record: Pick<SolanaTransferRecord, 'provenance' | 'ownerInitiated' | 'observations'>) =>
    classifySolanaTransferEvidence({ provenance: record.provenance, ownerInitiated: record.ownerInitiated, observation: record.observations.at(-1) ?? null });
  /** Append-only history: every line is a valid run that never rewrites what an earlier line established. */
  const validate = (bytes: Uint8Array) => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n') || bytes.length > 16_777_216) throw new Error(`${X}_STORE_CORRUPT`);
    let prior: SolanaTransferRecord | null = null;
    for (const line of text.trimEnd().split('\n')) {
      const record = JSON.parse(line) as SolanaTransferRecord;
      validateSolanaTransferRun(record);
      if (record.provenance !== input.provenance || record.review.chain !== profile.chain || record.evidenceClass !== classify(record) ||
          record.notSubmitted && (record.attempt?.signature || record.attempt && record.attempt.state !== 'CANCELLED') ||
          record.evidence && record.verdict !== 'RECONCILED') throw new Error(`${X}_STORE_CORRUPT`);
      if (prior) {
        const prefix = (a: unknown[], b: unknown[]) => b.length >= a.length && JSON.stringify(b.slice(0, a.length)) === JSON.stringify(a);
        if (record.id !== prior.id || record.review.commitment !== prior.review.commitment || !prefix(prior.journal.entries, record.journal.entries) ||
            !prefix(prior.observations, record.observations) || prior.attempt && !record.attempt || prior.verdict !== 'PENDING' && record.verdict !== prior.verdict ||
            prior.attempt?.signature && prior.attempt.signature !== record.attempt?.signature || prior.attempt?.transaction && prior.attempt.transaction !== record.attempt?.transaction ||
            prior.evidence && JSON.stringify(prior.evidence) !== JSON.stringify(record.evidence)) throw new Error(`${X}_STORE_CORRUPT`);
      }
      prior = record;
    }
  };
  const load = async (id: string): Promise<SolanaTransferRecord> => {
    const bytes = await log.read(path(id)); if (!bytes) throw logMissing(path(id)); validate(bytes);
    return JSON.parse(utf8(bytes).trimEnd().split('\n').at(-1)!) as SolanaTransferRecord;
  };
  const save = async (record: SolanaTransferRecord) => {
    const next = { ...record, evidenceClass: classify(record) };
    const prior = utf8(await log.read(path(record.id)));
    await log.extend(path(record.id), new TextEncoder().encode(prior + JSON.stringify(next) + '\n'), validate);
    return next;
  };
  // Cross-process exclusive section: a PID lock directory locally, a fenced lease in shared storage.
  const locked = <T,>(key: string, action: () => Promise<T>): Promise<T> => leases.hold(key, action);
  const blockHeight = async (commitment: 'confirmed' | 'finalized') => {
    const height = await input.rpc('getBlockHeight', [{ commitment }]);
    if (!Number.isSafeInteger(height)) throw new Error('SOLANA_RPC_INVALID');
    return height as number;
  };
  /** One unresolved transfer per owner on this cluster, across runs, tabs and restarts. The lease history is append-only. */
  async function withOwnerLease<T>(owner: string, id: string, prepare: () => Promise<T>): Promise<T> {
    return locked('owner-' + owner, async () => {
      const lease = `${owner}.${profile.idPrefix}-lease`;
      const prior = utf8(await log.read(lease)), holder = prior.trimEnd().split('\n').filter(Boolean).at(-1);
      if (holder && holder !== id && !solanaTransferAttemptResolved(await load(holder))) throw new Error(`${X}_OWNER_ATTEMPT_IN_PROGRESS`);
      // A crash may have persisted the reservation before PREPARED. begin already refuses an existing attempt under the run lock.
      if (holder !== id) await log.extend(lease, new TextEncoder().encode(prior + id + '\n'), bytes => {
        if (!new TextDecoder().decode(bytes).trimEnd().split('\n').every(line => idPattern.test(line))) throw new Error(`${X}_STORE_CORRUPT`);
      });
      // Reserve and persist PREPARED in the same owner critical section. Another run must not see this holder with no attempt yet.
      return prepare();
    });
  }
  /**
   * Fresh chain facts just before the wallet is asked: the owner still holds the amount, the fee, any reviewed account deposit and its own
   * rent-exempt reserve; the token, both token accounts and every extension are still acceptable; a recipient account the Review saw is still
   * there (one created since needs no deposit — the idempotent creation is then a no-op). Nothing is signed when any of it changed.
   */
  async function assertStillExecutable(review: SolanaTransferReview): Promise<void> {
    const facts = await readSolanaTransferFacts(input.rpc, solanaTransferIntent(review.workflow, review.owner), review.token?.sourceAccount);
    const amount = BigInt(review.amount), owner = BigInt(facts.state.ownerLamports), reserve = BigInt(facts.state.rentExemptMinimum);
    const deposit = BigInt(review.maximumAccountCreationLamports);
    if (owner - (review.token ? 0n : amount) - BigInt(review.estimatedFeeLamports) - deposit < reserve) throw new Error(`${X}_INSUFFICIENT_SOL`);
    if (review.token && (!facts.token || BigInt(facts.token.sourceAmount) < amount)) throw new Error(`${X}_INSUFFICIENT_TOKEN_BALANCE`);
    if (review.token && facts.token && !review.token.createDestination && facts.token.createDestination) throw new Error(`${X}_DESTINATION_ACCOUNT_CLOSED_REVIEW_REQUIRED`);
    if (!review.token && !facts.state.recipientExists && amount < reserve) throw new Error(`${X}_AMOUNT_BELOW_RENT_EXEMPT`);
  }
  return {
    load,
    profile,
    executionEnabled: input.executionEnabled,
    /** Read-only: chain facts, the exact message and its simulation. Nothing is signed or sent. */
    async simulate(workflowInput: unknown, owner: string): Promise<SolanaTransferRecord> {
      const workflow = validateAuthoringWorkflow(workflowInput, createBaseSepoliaReviewContext());
      if (workflow.nodes.find(node => node.actionType === 'asset.transfer')?.chainId !== profile.chain) throw new Error(`${X}_NETWORK_UNSUPPORTED`);
      const review = await simulateSolanaTransfer(workflow, solanaAddress(owner), input.rpc, now());
      const id = `${profile.idPrefix}-` + randomBytes(16).toString('hex');
      return save({ ...createSolanaTransferRun(id, review, input.provenance), observations: [], evidence: null, error: null, evidenceClass: 'PUBLIC_READ_ONLY' });
    },
    async review(id: string, commitment: string, workflow: SemanticWorkflow): Promise<SolanaTransferRecord> { return locked(idCheck(id), async () => {
      const record = await load(id);
      if (record.attempt || record.review.commitment !== commitment) throw new Error(`${X}_AUTHORIZATION_REPLACED`);
      assertSolanaTransferReview(record.review, workflow, record.review.owner, await blockHeight('confirmed'), now());
      return save({ ...record, authorization: commitment, error: null });
    }); },
    async invalidate(id: string): Promise<SolanaTransferRecord> { return locked(idCheck(id), async () => {
      const record = await load(id);
      return record.authorization ? save({ ...record, authorization: null, error: `${X}_SEMANTIC_EDIT_REQUIRES_REVIEW` }) : record;
    }); },
    async begin(id: string, owner: string, workflow: SemanticWorkflow): Promise<SolanaTransferBegin> { return locked(idCheck(id), async () => {
      if (!input.executionEnabled) throw new Error(profile.realFunds ? `${X}_MAINNET_EXECUTION_NOT_ENABLED` : `${X}_EXECUTION_NOT_ENABLED`);
      const record = await load(id);
      if (record.authorization !== record.review.commitment) throw new Error(`${X}_REVIEW_REQUIRED`);
      if (record.attempt) throw new Error(`${X}_EXISTING_ATTEMPT_OBSERVE_ONLY`);
      await assertCluster();
      const height = await blockHeight('confirmed');
      assertSolanaTransferReview(record.review, workflow, solanaAddress(owner), height, now());
      await assertStillExecutable(record.review);
      return withOwnerLease(record.review.owner, id, async () => {
        const prepared = await save({ ...record, ...prepareSolanaTransferAttempt(record, height), error: null }); // Durable BEFORE the wallet is asked to sign.
        return { record: prepared, unsignedTransaction: record.review.unsignedTransaction, walletChain: profile.walletChain };
      });
    }); },
    /** The wallet never returned signed bytes: no transaction can exist. */
    async walletFailure(id: string, diagnostic: SolanaTransferWalletDiagnostic): Promise<SolanaTransferRecord> { return locked(idCheck(id), async () => {
      const record = await load(id);
      if (JSON.stringify(diagnostic).length > 16_384 || !new RegExp(`^${X}_[A-Z0-9_]{2,70}$`).test(diagnostic.code)) throw new Error(`${X}_DIAGNOSTIC_INVALID`);
      if (record.attempt && record.attempt.state !== 'PREPARED') throw new Error(`${X}_DIAGNOSTIC_NOT_PRE_SUBMISSION`);
      const cancelled = record.attempt ? solanaTransferTransition(record, 'CANCELLED') : record;
      return save({ ...record, ...cancelled, authorization: null, notSubmitted: Boolean(record.attempt), walletDiagnostic: diagnostic, error: diagnostic.code, submissionError: diagnostic.code });
    }); },
    /** Verify exact reviewed bytes and the owner signature, persist the signature, then broadcast once. */
    async submit(id: string, signedTransaction: string): Promise<SolanaTransferRecord> { return locked(idCheck(id), async () => {
      const record = await load(id);
      if (record.attempt?.state !== 'PREPARED' || record.authorization !== record.review.commitment) throw new Error(`${X}_WALLET_HANDOFF_NOT_AUTHORIZED`);
      let signed: { signature: string; transaction: string };
      try {
        signed = verifySignedSolanaTransfer(record.review, signedTransaction);
        await assertCluster();
        if (now() >= Date.parse(record.review.expiresAt) || await blockHeight('confirmed') >= record.review.lastValidBlockHeight) throw new Error(`${X}_REVIEW_EXPIRED`);
      } catch (cause) {
        const failure = code(cause, `${X}_TRANSACTION_CHANGED`);
        // FloFi never broadcasts modified, mis-signed or stale bytes; the refusal keeps a description of what the wallet changed (never the bytes).
        let change: SolanaWalletChange | undefined;
        if (failure === `${X}_TRANSACTION_CHANGED`) try { change = describeSolanaWalletChange(record.review.message, signedTransaction, {}); } catch { change = undefined; }
        return save({ ...record, ...solanaTransferTransition(record, 'CANCELLED'), authorization: null, notSubmitted: true, error: failure, submissionError: failure,
          walletDiagnostic: { stage: 'SIGN', code: failure, error: { message: failure }, ...change ? { change } : {} } });
      }
      const submitting = await save({ ...record, ...recordSolanaTransferSignature(record, signed), error: null });
      try {
        const result = await input.rpc('sendTransaction', [signed.transaction, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 10 }]);
        if (result !== signed.signature) throw new Error(`${X}_SUBMISSION_RESULT_MISMATCH`);
        return save({ ...submitting, ...solanaTransferTransition(submitting, 'PENDING') });
      } catch (cause) {
        // The signature is already durable. Observation by signature resolves this; there is never a second transfer.
        return save({ ...submitting, ...solanaTransferTransition(submitting, 'SUBMISSION_RESULT_UNKNOWN'), error: `${X}_SUBMISSION_UNKNOWN_OBSERVE_EXISTING`,
          submissionError: code(cause, `${X}_RPC_SUBMISSION_FAILED`) });
      }
    }); },
    async observe(id: string): Promise<SolanaTransferRecord> { return locked(idCheck(id), async () => {
      let record = await load(id);
      const attempt = record.attempt;
      if (!attempt || record.verdict !== 'PENDING') return record;
      if (attempt.state === 'PREPARED') {
        const diagnostic: SolanaTransferWalletDiagnostic = { stage: 'SIGN', code: `${X}_WALLET_NOT_SUBMITTED`, error: { message: 'No signed transaction was returned before recovery.' } };
        return save({ ...record, ...solanaTransferTransition(record, 'CANCELLED'), authorization: null, notSubmitted: true, walletDiagnostic: diagnostic, error: diagnostic.code });
      }
      if (attempt.state === 'CANCELLED') return record;
      // Height before status: if finalized height is past validity and the signature is still unknown, it can never land.
      const finalizedHeight = await blockHeight('finalized');
      const observation = await reconcileSolanaTransferAttempt(record.review, attempt, input.rpc);
      // An unavailable, malformed or wrong-cluster response proves nothing about whether a submitted transfer landed.
      if (!observation.found && !observation.absenceVerified) return save({ ...record, error: observation.reason });
      const decision = solanaTransferObservationDecision(observation.found, finalizedHeight, record.review.lastValidBlockHeight);
      if (decision === 'WAIT') return save({ ...record, error: observation.reason === 'TRANSACTION_NOT_OBSERVED' ? `${X}_TRANSACTION_NOT_OBSERVED` : observation.reason });
      if (decision === 'EXPIRED') {
        let next: SolanaTransferRun = record;
        if (attempt.state === 'SUBMITTING') next = solanaTransferTransition(next, 'SUBMISSION_RESULT_UNKNOWN');
        next = solanaTransferTransition(next, next.attempt!.state === 'PENDING' ? 'EXPIRED' : 'NOT_FOUND');
        return save({ ...record, ...next, verdict: 'NOT_EXECUTED', authorization: null, error: `${X}_TRANSACTION_EXPIRED_NOT_EXECUTED` });
      }
      if (['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN'].includes(attempt.state)) record = { ...record, ...solanaTransferTransition(record, 'PENDING') };
      if (observation.verdict === 'INCONCLUSIVE') return save({ ...record, error: observation.reason });
      const reverted = observation.reason === `${X}_TRANSFER_FAILED`, reconciled = observation.verdict === 'RECONCILED';
      const state = reconciled ? 'CONFIRMED' : reverted ? 'REVERTED' : 'RECONCILIATION_REQUIRED';
      const next = { ...record, ...solanaTransferTransition(record, state, { reconciled }), observations: [...record.observations, observation],
        verdict: reconciled ? 'RECONCILED' as const : 'DIVERGENT' as const, error: reconciled ? null : observation.reason };
      return save(reconciled ? { ...next, evidence: buildSolanaTransferEvidence({ id: next.id, review: next.review, journal: next.journal, provenance: next.provenance,
        ownerInitiated: next.ownerInitiated, observation }) } : next);
    }); },
  };
}
export type SolanaTransferService = ReturnType<typeof createSolanaTransferService>;
