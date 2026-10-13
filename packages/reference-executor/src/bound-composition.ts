// SPDX-License-Identifier: AGPL-3.0-only
import { solanaSwapArtifactHash, solanaSwapHash, SOLANA_COMPOSITION_FORMAT, SOLANA_COMPOSITION_LIQUIDITY_ATTEMPTS,
  type SolanaCompositionReview } from '@defi-workflow-engine/reference-compiler';
import { hashJournalBytes, type ExecutionJournal, type JournalEntry } from '@defi-workflow-engine/workflow-contracts';
import { appendJournalState, createJournal } from './journal.js';

/**
 * A bound composition run: one composed Review over two existing isolated step runs. The step runs (the Orca swap run and
 * one or more Orca liquidity runs) keep their own journals, signatures, broadcast and observation rules unchanged. This
 * record only coordinates them, in the frozen v1 journal state machine:
 *
 *  - the producer (swap) step runs at most once per composition run. Once it has a signature it is never repeated, and a
 *    new run cannot begin while a run whose swap completed is still waiting for its position;
 *  - the binding records the verified, reconciled swap output and the bound maximum min(cap, received) before any
 *    liquidity preparation exists;
 *  - the consumer (liquidity) step may be prepared again after an unsigned, expired or reverted attempt, at most
 *    SOLANA_COMPOSITION_LIQUIDITY_ATTEMPTS times; each preparation is its own fresh Review and wallet signature;
 *  - the owner may end a run whose swap completed and whose position step is not pending, keeping the swapped tokens.
 */
export type BoundCompositionProvenance = 'PUBLIC_DEVNET' | 'MOCKED';
export type BoundCompositionBinding = { producerRunId: string; signature: string; slot: number | null; received: string; cap: string; bound: string; token: 0 | 1;
  /** Hash of the swap run's reconciled Evidence Bundle. */ evidenceHash: string; boundAt: string };
export type BoundCompositionRun = { format: 'gryloo.bound-composition-run.v1'; id: string; provenance: BoundCompositionProvenance; review: SolanaCompositionReview;
  authorization: string | null; producerRunId: string; binding: BoundCompositionBinding | null; consumerRunIds: string[]; journal: ExecutionJournal };
export type BoundCompositionPhase = 'SIMULATED' | 'AUTHORIZED' | 'PRODUCING' | 'BOUND' | 'CONSUMING' | 'COMPLETED' | 'PARTIAL' | 'NOT_EXECUTED' | 'FAILED' | 'ATTENTION' | 'EXPIRED';
export const BOUND_COMPOSITION_ID = /^solcomp-[a-f0-9]{32}$/;
const PRODUCER_ID = /^orca-[a-f0-9]{32}$/, CONSUMER_ID = /^orcalp-[a-f0-9]{32}$/;
export const BOUND_COMPOSITION_STEPS = Object.freeze({ segment: 'solana-composition-segment', producer: 'solana-composition-swap', consumer: 'solana-composition-liquidity' });
const S = BOUND_COMPOSITION_STEPS;
const fail = (code: string): never => { throw new Error(code); };
const now = () => new Date().toISOString();

type Level = 'workflow' | 'segment' | 'step';
function latest(journal: ExecutionJournal, level: Level, entityId: string): JournalEntry['toState'] | null {
  return [...journal.entries].reverse().find(entry => entry.level === level && entry.entityId === entityId)?.toState ?? null;
}
function append(run: Pick<BoundCompositionRun, 'journal' | 'review'>, level: Level, entityId: string, toState: JournalEntry['toState']): ExecutionJournal {
  return appendJournalState(run.journal, { level, entityId, segmentId: level === 'workflow' ? null : S.segment, stepId: level === 'step' ? entityId : null,
    executionAttemptId: null, toState, recordedAt: now() }).journal;
}
const wf = (run: Pick<BoundCompositionRun, 'review'>) => run.review.workflow.workflowId;
function moves(run: BoundCompositionRun, ...changes: [Level, string, JournalEntry['toState']][]): ExecutionJournal {
  let next = run;
  for (const [level, entity, state] of changes) next = { ...next, journal: append(next, level, entity === 'workflow' ? wf(run) : entity, state) };
  return next.journal;
}

/** The phase is derived from the journal: there is no second state to drift from it. */
export function boundCompositionPhase(run: Pick<BoundCompositionRun, 'journal' | 'review'>): BoundCompositionPhase {
  const w = latest(run.journal, 'workflow', wf(run)), swap = latest(run.journal, 'step', S.producer), lp = latest(run.journal, 'step', S.consumer);
  if (w === 'COMPLETED') return 'COMPLETED';
  if (w === 'PARTIALLY_COMPLETED') return 'PARTIAL';
  if (w === 'RECOVERY_REQUIRED') return 'ATTENTION';
  if (w === 'EXPIRED' || w === 'CANCELLED') return 'EXPIRED';
  if (w === 'FAILED') return run.journal.entries.some(e => e.level === 'step' && e.entityId === S.producer && e.toState === 'RECONCILING') ? 'FAILED' : 'NOT_EXECUTED';
  if (w === 'SIMULATED') return 'SIMULATED';
  if (w === 'AUTHORIZED') return 'AUTHORIZED';
  if (swap !== 'COMPLETED') return 'PRODUCING';
  return lp === 'EXECUTING' || lp === 'RECONCILING' ? 'CONSUMING' : 'BOUND';
}
const expect = (run: BoundCompositionRun, ...phases: BoundCompositionPhase[]) => { if (!phases.includes(boundCompositionPhase(run))) fail('SOLANA_COMPOSITION_STATE_INVALID'); };

export function createBoundCompositionRun(id: string, review: SolanaCompositionReview, producerRunId: string, provenance: BoundCompositionProvenance): BoundCompositionRun {
  if (!BOUND_COMPOSITION_ID.test(id) || !PRODUCER_ID.test(producerRunId) || review.swap.runId !== producerRunId) fail('SOLANA_COMPOSITION_ID_INVALID');
  const base = { review, journal: createJournal({ journalId: id, workflowId: review.workflow.workflowId,
    executionPlanHash: solanaSwapArtifactHash('execution-plan', review.plan), manifestHash: solanaSwapArtifactHash('strategy-manifest', review.manifest) }) };
  let journal = base.journal;
  for (const [level, entity, state] of [['workflow', review.workflow.workflowId, 'DRAFT'], ['segment', S.segment, 'PLANNED'], ['step', S.producer, 'PLANNED'],
    ['step', S.consumer, 'PLANNED'], ['workflow', review.workflow.workflowId, 'REVIEWED'], ['workflow', review.workflow.workflowId, 'SIMULATED']] as const)
    journal = append({ ...base, journal }, level, entity, state);
  return { format: 'gryloo.bound-composition-run.v1', id, provenance, review, authorization: null, producerRunId, binding: null, consumerRunIds: [], journal };
}
/** The owner accepted the composed Review (the plan); each transaction still needs its own Review state and signature. */
export function authorizeBoundComposition(run: BoundCompositionRun, commitment: string): BoundCompositionRun {
  if (commitment !== run.review.commitment) fail('SOLANA_COMPOSITION_AUTHORIZATION_REPLACED');
  if (boundCompositionPhase(run) === 'AUTHORIZED' && run.authorization === commitment) return run;
  expect(run, 'SIMULATED');
  return { ...run, authorization: commitment, journal: moves(run, ['workflow', 'workflow', 'AUTHORIZED'], ['segment', S.segment, 'READY'], ['step', S.producer, 'READY']) };
}
/** The swap step's attempt exists (persisted by its own run before the wallet is asked). From here it can never start again. */
export function startBoundCompositionProducer(run: BoundCompositionRun): BoundCompositionRun {
  expect(run, 'AUTHORIZED');
  if (run.authorization !== run.review.commitment) fail('SOLANA_COMPOSITION_REVIEW_REQUIRED');
  return { ...run, journal: moves(run, ['workflow', 'workflow', 'EXECUTING'], ['segment', S.segment, 'EXECUTING'], ['step', S.producer, 'EXECUTING']) };
}
/** A signed swap exists (it may land): only observation follows. */
export function submittedBoundCompositionProducer(run: BoundCompositionRun): BoundCompositionRun {
  if (latest(run.journal, 'step', S.producer) === 'RECONCILING') return run;
  expect(run, 'PRODUCING');
  return { ...run, journal: moves(run, ['step', S.producer, 'RECONCILING']) };
}
/** The swap provably did not execute (never signed, or expired unsent) or reverted: the run ends; the position never starts. */
export function failBoundCompositionProducer(run: BoundCompositionRun, reverted: boolean): BoundCompositionRun {
  expect(run, 'PRODUCING');
  const swap = latest(run.journal, 'step', S.producer);
  if (reverted && swap !== 'RECONCILING') fail('SOLANA_COMPOSITION_STATE_INVALID');
  return { ...run, journal: moves(run, ['step', S.producer, 'FAILED'], ['segment', S.segment, 'FAILED'], ['workflow', 'workflow', 'FAILED']) };
}
/** Divergent or unprovable swap reconciliation: observation only, never a second swap or a position. */
export function attentionBoundComposition(run: BoundCompositionRun, step: 'producer' | 'consumer'): BoundCompositionRun {
  const entity = step === 'producer' ? S.producer : S.consumer;
  if (latest(run.journal, 'workflow', wf(run)) === 'RECOVERY_REQUIRED') return run;
  if (latest(run.journal, 'step', entity) !== 'RECONCILING') fail('SOLANA_COMPOSITION_STATE_INVALID');
  return { ...run, journal: moves(run, ['step', entity, 'RECOVERY_REQUIRED'], ['segment', S.segment, 'RECOVERY_REQUIRED'], ['workflow', 'workflow', 'RECOVERY_REQUIRED']) };
}
/** Records the verified swap output and the bound maximum min(cap, received). Only a reconciled swap reaches this. */
export function bindBoundComposition(run: BoundCompositionRun, input: Omit<BoundCompositionBinding, 'cap' | 'bound' | 'token' | 'producerRunId' | 'boundAt'>): BoundCompositionRun {
  expect(run, 'PRODUCING');
  if (latest(run.journal, 'step', S.producer) !== 'RECONCILING') fail('SOLANA_COMPOSITION_STATE_INVALID');
  if (!/^[1-9][0-9]{0,77}$/.test(input.received) || !/^0x[0-9a-f]{64}$/.test(input.evidenceHash) || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(input.signature))
    fail('SOLANA_COMPOSITION_BINDING_INVALID');
  const cap = BigInt(run.review.liquidity.cap), received = BigInt(input.received);
  const binding: BoundCompositionBinding = { ...input, producerRunId: run.producerRunId, cap: cap.toString(), bound: (received < cap ? received : cap).toString(),
    token: run.review.liquidity.boundToken, boundAt: now() };
  return { ...run, binding, journal: moves(run, ['step', S.producer, 'COMPLETED'], ['step', S.consumer, 'READY']) };
}
/** A new, separately reviewed liquidity preparation. Never while another one may still land. */
export function startBoundCompositionConsumer(run: BoundCompositionRun, consumerRunId: string): BoundCompositionRun {
  expect(run, 'BOUND');
  if (!run.binding || !CONSUMER_ID.test(consumerRunId) || run.consumerRunIds.includes(consumerRunId)) fail('SOLANA_COMPOSITION_ID_INVALID');
  if (run.consumerRunIds.length >= SOLANA_COMPOSITION_LIQUIDITY_ATTEMPTS) fail('SOLANA_COMPOSITION_LIQUIDITY_ATTEMPTS_EXHAUSTED');
  const lp = latest(run.journal, 'step', S.consumer);
  return { ...run, consumerRunIds: [...run.consumerRunIds, consumerRunId], journal: moves(run, ...(lp === 'PAUSED' ? [['step', S.consumer, 'READY']] as [Level, string, JournalEntry['toState']][] : []),
    ['step', S.consumer, 'EXECUTING']) };
}
export function submittedBoundCompositionConsumer(run: BoundCompositionRun): BoundCompositionRun {
  if (latest(run.journal, 'step', S.consumer) === 'RECONCILING') return run;
  expect(run, 'CONSUMING');
  return { ...run, journal: moves(run, ['step', S.consumer, 'RECONCILING']) };
}
/** The latest liquidity preparation ended without a position (unsigned, expired, reverted): the swap stays done; prepare again or end. */
export function pauseBoundCompositionConsumer(run: BoundCompositionRun): BoundCompositionRun {
  expect(run, 'CONSUMING');
  const lp = latest(run.journal, 'step', S.consumer);
  return { ...run, journal: moves(run, ...(lp === 'RECONCILING' ? [['step', S.consumer, 'RECOVERY_REQUIRED']] as [Level, string, JournalEntry['toState']][] : []),
    ['step', S.consumer, 'PAUSED']) };
}
export function completeBoundComposition(run: BoundCompositionRun): BoundCompositionRun {
  expect(run, 'CONSUMING');
  if (latest(run.journal, 'step', S.consumer) !== 'RECONCILING') fail('SOLANA_COMPOSITION_STATE_INVALID');
  return { ...run, journal: moves(run, ['step', S.consumer, 'COMPLETED'], ['segment', S.segment, 'RECONCILING'], ['segment', S.segment, 'COMPLETED'],
    ['workflow', 'workflow', 'RECONCILING'], ['workflow', 'workflow', 'COMPLETED']) };
}
/** The owner keeps the swapped tokens and ends the run; nothing is reversed. */
export function endBoundComposition(run: BoundCompositionRun): BoundCompositionRun {
  expect(run, 'BOUND');
  return { ...run, journal: moves(run, ['step', S.consumer, 'CANCELLED'], ['segment', S.segment, 'RECONCILING'], ['segment', S.segment, 'PARTIALLY_COMPLETED'],
    ['workflow', 'workflow', 'PARTIALLY_COMPLETED']) };
}
/** A composed Review that was never authorized, or whose swap never started, can expire. */
export function expireBoundComposition(run: BoundCompositionRun): BoundCompositionRun {
  expect(run, 'SIMULATED', 'AUTHORIZED');
  return { ...run, journal: moves(run, ['workflow', 'workflow', 'EXPIRED']) };
}
/** The run is holding the owner's composition slot: its swap may execute, or did, and its position is not finished or ended. */
export function boundCompositionOpen(run: BoundCompositionRun): boolean {
  return ['PRODUCING', 'BOUND', 'CONSUMING', 'ATTENTION'].includes(boundCompositionPhase(run));
}

export function validateBoundCompositionRun(run: BoundCompositionRun): void {
  const corrupt = 'SOLANA_COMPOSITION_STORE_CORRUPT';
  if (!run || run.format !== 'gryloo.bound-composition-run.v1' || !BOUND_COMPOSITION_ID.test(run.id) || !['MOCKED', 'PUBLIC_DEVNET'].includes(run.provenance) ||
      run.review?.format !== SOLANA_COMPOSITION_FORMAT || !PRODUCER_ID.test(run.producerRunId) || run.review.swap.runId !== run.producerRunId ||
      !Array.isArray(run.consumerRunIds) || run.consumerRunIds.length > SOLANA_COMPOSITION_LIQUIDITY_ATTEMPTS || run.consumerRunIds.some(id => !CONSUMER_ID.test(id)) ||
      new Set(run.consumerRunIds).size !== run.consumerRunIds.length) fail(corrupt);
  const { commitment, ...review } = run.review;
  if (solanaSwapHash(review) !== commitment || run.authorization !== null && run.authorization !== commitment || run.journal.journalId !== run.id ||
      run.journal.workflowId !== run.review.workflow.workflowId || solanaSwapArtifactHash('execution-plan', run.review.plan) !== run.journal.executionPlanHash ||
      solanaSwapArtifactHash('strategy-manifest', run.review.manifest) !== run.journal.manifestHash) fail(corrupt);
  hashJournalBytes(new TextEncoder().encode(JSON.stringify(run.journal)));
  const phase = boundCompositionPhase(run), swap = latest(run.journal, 'step', S.producer);
  if (phase === 'SIMULATED' ? run.authorization !== null : phase !== 'EXPIRED' && run.authorization !== commitment) fail(corrupt);
  const b = run.binding;
  if ((swap === 'COMPLETED') !== Boolean(b)) fail(corrupt);
  if (b && (b.producerRunId !== run.producerRunId || b.token !== run.review.liquidity.boundToken || b.cap !== run.review.liquidity.cap ||
      BigInt(b.bound) !== (BigInt(b.received) < BigInt(b.cap) ? BigInt(b.received) : BigInt(b.cap)))) fail(corrupt);
  if (run.consumerRunIds.length && !b) fail(corrupt);
}
/**
 * Background observation is due only for a step whose signed transaction may still land. An unsigned prepared step is
 * never observed by a worker: the owner may still be confirming it in the wallet.
 */
export function boundCompositionNeedsObservation(run: Pick<BoundCompositionRun, 'journal' | 'review'>): boolean {
  const phase = boundCompositionPhase(run);
  return phase === 'PRODUCING' && latest(run.journal, 'step', S.producer) === 'RECONCILING' ||
    phase === 'CONSUMING' && latest(run.journal, 'step', S.consumer) === 'RECONCILING';
}
