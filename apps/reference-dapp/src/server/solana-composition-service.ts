// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { createBaseSepoliaReviewContext, validateAuthoringWorkflow, validateSolanaCompositionWorkflow } from '@defi-workflow-engine/reference-linter';
import { projectCompositionConsumer, projectCompositionProducer } from '@defi-workflow-engine/action-registry';
import { assertSolanaCompositionReview, simulateSolanaComposition, solanaAddress, type OrcaDevnetReview, type SolanaRpc } from '@defi-workflow-engine/reference-compiler';
import { attentionBoundComposition, authorizeBoundComposition, bindBoundComposition, boundCompositionOpen, boundCompositionPhase, completeBoundComposition,
  createBoundCompositionRun, endBoundComposition, expireBoundComposition, failBoundCompositionProducer, logMissing, pauseBoundCompositionConsumer, startBoundCompositionConsumer,
  startBoundCompositionProducer, submittedBoundCompositionConsumer, submittedBoundCompositionProducer, utf8, validateBoundCompositionRun, BOUND_COMPOSITION_ID,
  type BoundCompositionPhase, type BoundCompositionProvenance, type BoundCompositionRun, type ExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { buildSolanaCompositionEvidence } from '@defi-workflow-engine/reference-reconciler';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import type { JupiterRecord, SolanaSwapService, SolanaSwapWalletDiagnostic } from './jupiter-service';
import type { OrcaLiquidityRecord, OrcaLiquidityService, OrcaLiquidityWalletDiagnostic } from './orca-liquidity-service';

/**
 * Solana Devnet Swap → Orca liquidity as one composed workflow, run on the two existing isolated services. Nothing here
 * signs, broadcasts or retries: each step's run keeps its own durable attempt, signature handoff, single broadcast and
 * observe-only recovery. This coordinator only
 *
 *  - validates the composed workflow and hands each service its deterministic single-step projection (never a client one);
 *  - refuses to start a swap whose position is already known to be impossible (preflight; risk reduction, not a guarantee);
 *  - starts the swap at most once per run, and refuses a new run while an earlier swap is done but its position is not;
 *  - binds the position to the verified, reconciled swap output, min(cap, received), with fresh pool state and a fresh Review;
 *  - follows the step runs after any restart (`sync`), and builds the composed evidence only when both steps reconciled.
 *
 * After the root authorization the position uses exactly the authorized workflow: a changed workflow is refused, never
 * re-centred. The owner may end a run whose position is not pending, keeping the swapped tokens.
 */
export type SolanaCompositionRecord = BoundCompositionRun & { evidence: ReturnType<typeof buildSolanaCompositionEvidence> | null; error: string | null };
export type SolanaCompositionView = { record: SolanaCompositionRecord; phase: BoundCompositionPhase; swap: JupiterRecord; liquidity: OrcaLiquidityRecord | null;
  /** The position step's projected workflow, once the swap output is bound. */ liquidityWorkflow: SemanticWorkflow | null };
export type SolanaCompositionDiagnostic = { step: 'SWAP'; diagnostic: SolanaSwapWalletDiagnostic } | { step: 'LIQUIDITY'; diagnostic: OrcaLiquidityWalletDiagnostic };
const X = 'SOLANA_COMPOSITION';
const fail = (code: string): never => { throw new Error(code); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createSolanaCompositionService(input: { rpc: SolanaRpc; storage: ExecutionStorage; swap: SolanaSwapService; liquidity: OrcaLiquidityService;
  provenance: BoundCompositionProvenance; executionEnabled: boolean; now?: () => number }) {
  const { log, leases } = input.storage, now = input.now ?? Date.now;
  const idCheck = (id: string) => { if (typeof id !== 'string' || !BOUND_COMPOSITION_ID.test(id)) throw new Error(`${X}_ID_INVALID`); return id; };
  const path = (id: string) => idCheck(id) + '.jsonl', index = (owner: string) => solanaAddress(owner) + '.solcomp-runs';
  const locked = <T,>(key: string, action: () => Promise<T>): Promise<T> => leases.hold(key, action);
  const validate = (bytes: Uint8Array) => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n') || bytes.length > 33_554_432) throw new Error(`${X}_STORE_CORRUPT`);
    let prior: SolanaCompositionRecord | null = null;
    for (const line of text.trimEnd().split('\n')) {
      const record = JSON.parse(line) as SolanaCompositionRecord;
      validateBoundCompositionRun(record);
      if (record.provenance !== input.provenance) throw new Error(`${X}_STORE_CORRUPT`);
      if (prior) {
        const prefix = (a: unknown[], b: unknown[]) => b.length >= a.length && same(b.slice(0, a.length), a);
        if (record.id !== prior.id || record.review.commitment !== prior.review.commitment || record.producerRunId !== prior.producerRunId ||
            !prefix(prior.journal.entries, record.journal.entries) || !prefix(prior.consumerRunIds, record.consumerRunIds) ||
            prior.authorization && record.authorization !== prior.authorization || prior.binding && !same(prior.binding, record.binding) ||
            prior.evidence && !same(prior.evidence, record.evidence)) throw new Error(`${X}_STORE_CORRUPT`);
      }
      prior = record;
    }
  };
  async function load(id: string): Promise<SolanaCompositionRecord> {
    const bytes = await log.read(path(id)); if (!bytes) throw logMissing(path(id)); validate(bytes);
    return JSON.parse(utf8(bytes).trimEnd().split('\n').at(-1)!) as SolanaCompositionRecord;
  }
  async function save(record: SolanaCompositionRecord): Promise<SolanaCompositionRecord> {
    const prior = utf8(await log.read(path(record.id)));
    if (prior && same(JSON.parse(prior.trimEnd().split('\n').at(-1)!), record)) return record;
    await log.extend(path(record.id), new TextEncoder().encode(prior + JSON.stringify(record) + '\n'), validate);
    return record;
  }
  async function ownerRuns(owner: string): Promise<string[]> {
    return utf8(await log.read(index(owner))).trimEnd().split('\n').filter(Boolean).map(id => idCheck(id));
  }
  async function appendOwnerRun(owner: string, id: string) {
    const prior = utf8(await log.read(index(owner)));
    await log.extend(index(owner), new TextEncoder().encode(prior + id + '\n'), bytes => {
      if (!new TextDecoder().decode(bytes).trimEnd().split('\n').every(line => BOUND_COMPOSITION_ID.test(line))) throw new Error(`${X}_STORE_CORRUPT`);
    });
  }
  /** Another run of this owner may still execute, or executed its swap and still owes its position (or needs attention). */
  async function openRun(owner: string, except: string | null): Promise<string | null> {
    for (const id of await ownerRuns(owner)) if (id !== except && boundCompositionOpen(await load(id))) return id;
    return null;
  }
  const projectedLiquidity = (record: SolanaCompositionRecord) => record.binding ? projectCompositionConsumer(record.review.workflow, record.binding.received) : null;
  const latestLiquidity = (record: SolanaCompositionRecord) => record.consumerRunIds.at(-1) ?? null;
  async function view(record: SolanaCompositionRecord): Promise<SolanaCompositionView> {
    const lp = latestLiquidity(record);
    return { record, phase: boundCompositionPhase(record), swap: await input.swap.load(record.producerRunId), liquidity: lp ? await input.liquidity.load(lp) : null,
      liquidityWorkflow: projectedLiquidity(record) };
  }
  /** The authorized composed workflow, exactly; the projections are always derived here, never accepted from a client. */
  function authorizedWorkflow(record: SolanaCompositionRecord, workflow: SemanticWorkflow) {
    if (!same(workflow, record.review.workflow)) fail(`${X}_SEMANTIC_REVISION_CHANGED`);
  }
  const signed = (attempt: { signature: string | null } | null) => Boolean(attempt?.signature);

  /** Follows the step runs: idempotent, observation only. Safe after any restart and from any process. */
  async function sync(start: SolanaCompositionRecord): Promise<SolanaCompositionRecord> {
    let record = start;
    const phase = () => boundCompositionPhase(record);
    if (phase() === 'AUTHORIZED') {
      const swap = await input.swap.load(record.producerRunId);
      if (swap.attempt) record = { ...record, ...startBoundCompositionProducer(record) };
    }
    if (phase() === 'PRODUCING') {
      const swap = await input.swap.load(record.producerRunId), attempt = swap.attempt;
      if (signed(attempt)) record = { ...record, ...submittedBoundCompositionProducer(record) };
      if (swap.verdict === 'RECONCILED' && swap.evidence) {
        const o = swap.observations.at(-1)!;
        record = { ...record, ...bindBoundComposition(record, { signature: attempt!.signature!, slot: o.slot, received: o.outputReceived ?? fail(`${X}_BINDING_INVALID`),
          evidenceHash: swap.evidence.bundleHash }) };
      } else if (attempt?.state === 'CANCELLED' || swap.verdict === 'NOT_EXECUTED') {
        record = { ...record, ...failBoundCompositionProducer(record, false) };
      } else if (swap.verdict === 'DIVERGENT') {
        record = attempt?.state === 'REVERTED' ? { ...record, ...failBoundCompositionProducer(record, true) } : { ...record, ...attentionBoundComposition(record, 'producer') };
      }
    }
    if (phase() === 'CONSUMING') {
      const lp = await input.liquidity.load(latestLiquidity(record)!), attempt = lp.attempt;
      if (signed(attempt)) record = { ...record, ...submittedBoundCompositionConsumer(record) };
      if (lp.verdict === 'RECONCILED' && lp.evidence) {
        const swap = await input.swap.load(record.producerRunId);
        record = { ...record, ...completeBoundComposition(record) };
        record = { ...record, evidence: buildSolanaCompositionEvidence({ id: record.id, review: record.review, journal: record.journal, provenance: record.provenance,
          binding: record.binding!, swap: { runId: swap.id, evidence: swap.evidence!, observation: swap.observations.at(-1)! },
          liquidity: { runId: lp.id, review: lp.review, evidence: lp.evidence, observation: lp.observations.at(-1)!, attempts: record.consumerRunIds.length } }) };
      } else if (attempt?.state === 'CANCELLED' || lp.verdict === 'NOT_EXECUTED' || lp.verdict === 'DIVERGENT' && attempt?.state === 'REVERTED') {
        record = { ...record, ...pauseBoundCompositionConsumer(record) };
      } else if (lp.verdict === 'DIVERGENT') {
        record = { ...record, ...attentionBoundComposition(record, 'consumer') };
      }
    }
    return record;
  }
  const settle = async (record: SolanaCompositionRecord, error: string | null = null) => view(await save({ ...await sync(record), error }));

  return {
    executionEnabled: input.executionEnabled,
    load,
    async status(id: string): Promise<SolanaCompositionView> { return view(await load(id)); },
    /** Read-only for both steps: the exact swap Review plus the position projection and preflight; the composed Review is frozen. */
    async simulate(workflowInput: unknown, ownerInput: string): Promise<SolanaCompositionView> {
      const workflow = validateAuthoringWorkflow(workflowInput, createBaseSepoliaReviewContext());
      validateSolanaCompositionWorkflow(workflow);
      const owner = solanaAddress(ownerInput);
      return locked('composition-owner-' + owner, async () => {
        if (await openRun(owner, null)) fail(`${X}_CONTINUE_EXISTING_RUN`);
        // One FloFi position per owner on this pool: a swap must never run toward a position that cannot be opened.
        if ((await input.liquidity.positions(owner)).some(p => ['OPEN_PENDING', 'ACTIVE', 'EMPTY'].includes(p.status))) fail(`${X}_PREFLIGHT_POSITION_ALREADY_OPEN`);
        const swap = await input.swap.simulate(projectCompositionProducer(workflow), owner);
        const review = await simulateSolanaComposition(workflow, owner, { runId: swap.id, review: swap.review as OrcaDevnetReview }, input.rpc, now());
        const id = 'solcomp-' + randomBytes(16).toString('hex');
        const record = await save({ ...createBoundCompositionRun(id, review, swap.id, input.provenance), evidence: null, error: null });
        await appendOwnerRun(owner, id);
        return view(record);
      });
    },
    /** Accepting the composed Review accepts its plan and the swap step's exact Review; nothing is signed. */
    async review(id: string, commitment: string, workflow: SemanticWorkflow): Promise<SolanaCompositionView> { return locked(idCheck(id), async () => {
      const record = await load(id);
      if (record.review.commitment !== commitment) fail(`${X}_AUTHORIZATION_REPLACED`);
      assertSolanaCompositionReview(record.review, workflow, record.review.owner, now());
      const swap = await input.swap.load(record.producerRunId);
      await input.swap.review(swap.id, swap.review.commitment, projectCompositionProducer(workflow));
      return view(await save({ ...record, ...authorizeBoundComposition(record, commitment), error: null }));
    }); },
    /** A semantic edit before the swap starts retires the run; after it starts, the run keeps following its steps. */
    async invalidate(id: string): Promise<SolanaCompositionView> { return locked(idCheck(id), async () => {
      const record = await load(id);
      if (!['SIMULATED', 'AUTHORIZED'].includes(boundCompositionPhase(record))) return view(record);
      const swap = await input.swap.load(record.producerRunId);
      if (swap.attempt) return settle(record);
      await input.swap.invalidate(swap.id);
      return view(await save({ ...record, ...expireBoundComposition(record), error: `${X}_SEMANTIC_EDIT_REQUIRES_REVIEW` }));
    }); },
    async beginSwap(id: string, ownerInput: string, workflow: SemanticWorkflow) { return locked(idCheck(id), async () => {
      if (!input.executionEnabled) fail(`${X}_EXECUTION_NOT_ENABLED`);
      let record = await sync(await load(id));
      if (boundCompositionPhase(record) !== 'AUTHORIZED') fail(boundCompositionPhase(record) === 'SIMULATED' ? `${X}_REVIEW_REQUIRED` : `${X}_EXISTING_ATTEMPT_OBSERVE_ONLY`);
      const owner = solanaAddress(ownerInput);
      assertSolanaCompositionReview(record.review, workflow, owner, now());
      return locked('composition-owner-' + owner, async () => {
        if (await openRun(owner, id)) fail(`${X}_CONTINUE_EXISTING_RUN`);
        // The swap run persists its attempt before the wallet is asked; it refuses any second attempt.
        const begin = await input.swap.begin(record.producerRunId, owner, projectCompositionProducer(workflow));
        record = await save({ ...record, ...startBoundCompositionProducer(record), error: null });
        return { view: await view(record), unsignedTransaction: begin.unsignedTransaction, walletChain: begin.walletChain };
      });
    }); },
    async submitSwap(id: string, signedTransaction: string): Promise<SolanaCompositionView> { return locked(idCheck(id), async () => {
      const record = await sync(await load(id));
      if (boundCompositionPhase(record) !== 'PRODUCING') fail(`${X}_WALLET_HANDOFF_NOT_AUTHORIZED`);
      const swap = await input.swap.submit(record.producerRunId, signedTransaction);
      // A refused handoff (changed, mis-signed or stale bytes) sent nothing; the run keeps the step's reason for the owner.
      return settle(record, swap.attempt?.state === 'CANCELLED' ? swap.error : null);
    }); },
    /** Position step: a fresh simulation with the verified bound amount and fresh pool state, as its own Review. */
    async prepareLiquidity(id: string, ownerInput: string, workflow: SemanticWorkflow, positionMint: string): Promise<SolanaCompositionView> { return locked(idCheck(id), async () => {
      let record = await sync(await load(id));
      const owner = solanaAddress(ownerInput);
      if (owner !== record.review.owner) fail(`${X}_WRONG_OWNER`);
      authorizedWorkflow(record, workflow);
      if (boundCompositionPhase(record) === 'CONSUMING') {
        const lp = await input.liquidity.load(latestLiquidity(record)!);
        // Only a preparation that was never begun can be replaced; anything begun is followed to its end.
        if (lp.attempt) fail(`${X}_EXISTING_ATTEMPT_OBSERVE_ONLY`);
        record = { ...record, ...pauseBoundCompositionConsumer(record) };
      }
      if (boundCompositionPhase(record) !== 'BOUND') fail(`${X}_STATE_INVALID`);
      const prepared = await input.liquidity.simulate(projectedLiquidity(record)!, owner, { operation: 'OPEN', positionMint });
      return view(await save({ ...record, ...startBoundCompositionConsumer(record, prepared.id), error: null }));
    }); },
    async reviewLiquidity(id: string, commitment: string, workflow: SemanticWorkflow): Promise<SolanaCompositionView> { return locked(idCheck(id), async () => {
      const record = await sync(await load(id));
      authorizedWorkflow(record, workflow);
      if (boundCompositionPhase(record) !== 'CONSUMING') fail(`${X}_STATE_INVALID`);
      await input.liquidity.review(latestLiquidity(record)!, commitment, projectedLiquidity(record)!);
      return view(await save(record));
    }); },
    async beginLiquidity(id: string, ownerInput: string, workflow: SemanticWorkflow) { return locked(idCheck(id), async () => {
      if (!input.executionEnabled) fail(`${X}_EXECUTION_NOT_ENABLED`);
      const record = await sync(await load(id));
      authorizedWorkflow(record, workflow);
      if (boundCompositionPhase(record) !== 'CONSUMING') fail(`${X}_STATE_INVALID`);
      const begin = await input.liquidity.begin(latestLiquidity(record)!, solanaAddress(ownerInput), projectedLiquidity(record)!);
      return { view: await view(await save(record)), unsignedTransaction: begin.unsignedTransaction, walletChain: begin.walletChain, signers: begin.signers };
    }); },
    async submitLiquidity(id: string, signedTransaction: string): Promise<SolanaCompositionView> { return locked(idCheck(id), async () => {
      const record = await sync(await load(id));
      if (boundCompositionPhase(record) !== 'CONSUMING') fail(`${X}_WALLET_HANDOFF_NOT_AUTHORIZED`);
      const lp = await input.liquidity.submit(latestLiquidity(record)!, signedTransaction);
      return settle(record, lp.attempt?.state === 'CANCELLED' ? lp.error : null);
    }); },
    /** The wallet returned no signed bytes for the current step: no transaction can exist for it. */
    async walletFailure(id: string, failure: SolanaCompositionDiagnostic): Promise<SolanaCompositionView> { return locked(idCheck(id), async () => {
      const record = await sync(await load(id)), phase = boundCompositionPhase(record);
      if (failure.step === 'SWAP' && phase === 'PRODUCING') await input.swap.walletFailure(record.producerRunId, failure.diagnostic);
      else if (failure.step === 'LIQUIDITY' && phase === 'CONSUMING') await input.liquidity.walletFailure(latestLiquidity(record)!, failure.diagnostic);
      else fail(`${X}_DIAGNOSTIC_NOT_PRE_SUBMISSION`);
      return settle(record, failure.diagnostic.code);
    }); },
    /** Observation only: follows the pending step run (never resubmits) and advances the composition from its result. */
    async observe(id: string): Promise<SolanaCompositionView> { return locked(idCheck(id), async () => {
      const record = await sync(await load(id)), phase = boundCompositionPhase(record);
      let error: string | null = record.error;
      if (phase === 'PRODUCING' || phase === 'ATTENTION' && !record.binding) error = (await input.swap.observe(record.producerRunId)).error;
      else if (phase === 'CONSUMING' || phase === 'ATTENTION') { const lp = latestLiquidity(record); if (lp) error = (await input.liquidity.observe(lp)).error; }
      return settle(record, error);
    }); },
    /** The owner keeps the swapped tokens; nothing is reversed or retried. */
    async end(id: string): Promise<SolanaCompositionView> { return locked(idCheck(id), async () => {
      let record = await sync(await load(id));
      if (boundCompositionPhase(record) === 'CONSUMING') {
        const lp = await input.liquidity.load(latestLiquidity(record)!);
        if (lp.attempt) fail(`${X}_EXISTING_ATTEMPT_OBSERVE_ONLY`);
        record = { ...record, ...pauseBoundCompositionConsumer(record) };
      }
      if (boundCompositionPhase(record) !== 'BOUND') fail(`${X}_STATE_INVALID`);
      return view(await save({ ...record, ...endBoundComposition(record), error: null }));
    }); },
    /** Restart recovery: every run in the store (bounded). */
    async runIds(): Promise<string[]> {
      const names = await log.list('solcomp-', 1_000);
      return names.filter(n => /^solcomp-[a-f0-9]{32}\.jsonl$/.test(n)).map(n => n.slice(0, -6)).slice(0, 512);
    },
  };
}
export type SolanaCompositionService = ReturnType<typeof createSolanaCompositionService>;
