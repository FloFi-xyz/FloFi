// SPDX-License-Identifier: AGPL-3.0-only
import { solanaSwapArtifactHash, solanaSwapHash, type OrcaLiquidityReview, type SolanaCompositionReview } from '@defi-workflow-engine/reference-compiler';
import { hashJournalBytes, type EvidenceBundle, type ExecutionJournal } from '@defi-workflow-engine/workflow-contracts';
import type { JupiterObservation, SolanaSwapEvidenceClass } from './jupiter.js';
import type { OrcaLiquidityEvidenceClass, OrcaLiquidityObservation } from './orca-liquidity.js';

/**
 * Composed evidence for a completed Solana Devnet Swap → Orca liquidity run. It does not observe the chain again: both
 * step runs were independently reconciled by their own reconcilers. It re-checks, from those reconciled facts alone, that
 * the run is one consistent plan: the binding is the reconciled swap output, the position was reviewed with exactly
 * min(cap, received) and the authorized parameters, and it deposited no more of the swap output than that bound. Any
 * difference fails closed; only a complete run has a composed bundle (a partial run keeps its swap evidence).
 */
type StepEvidence<C> = { bundle: EvidenceBundle; bundleHash: string; evidenceClass: C };
export type SolanaCompositionEvidenceInput = {
  id: string; review: SolanaCompositionReview; journal: ExecutionJournal; provenance: 'PUBLIC_DEVNET' | 'MOCKED';
  binding: { producerRunId: string; signature: string; received: string; cap: string; bound: string; token: 0 | 1; evidenceHash: string };
  swap: { runId: string; evidence: StepEvidence<SolanaSwapEvidenceClass>; observation: JupiterObservation };
  liquidity: { runId: string; review: OrcaLiquidityReview; evidence: StepEvidence<OrcaLiquidityEvidenceClass>; observation: OrcaLiquidityObservation; attempts: number };
};
const fail = (code: string): never => { throw new Error(code); };
export function buildSolanaCompositionEvidence(input: SolanaCompositionEvidenceInput) {
  const { review, binding, swap, liquidity } = input, lp = liquidity.review, effects = liquidity.observation.effects;
  const executed = input.provenance === 'MOCKED' ? 'MOCKED' : 'DEVNET_EXECUTED';
  if (swap.observation.verdict !== 'RECONCILED' || liquidity.observation.verdict !== 'RECONCILED' || !effects || swap.evidence.evidenceClass !== executed ||
      liquidity.evidence.evidenceClass !== executed) fail('SOLANA_COMPOSITION_EVIDENCE_NOT_RECONCILED');
  const t = binding.token, bound = BigInt(binding.bound), received = BigInt(binding.received), cap = BigInt(binding.cap);
  const deposited = BigInt(t === 0 ? effects!.depositedA : effects!.depositedB);
  const checks: [string, boolean][] = [
    ['SWAP_RUN', swap.runId === review.swap.runId && binding.producerRunId === swap.runId && swap.evidence.bundleHash === binding.evidenceHash],
    ['SWAP_SIGNATURE', swap.observation.signature === binding.signature],
    ['SWAP_OUTPUT', swap.observation.outputReceived === binding.received && received >= BigInt(review.swap.minimumOutput)],
    ['BOUND', cap === BigInt(review.liquidity.cap) && t === review.liquidity.boundToken && bound === (received < cap ? received : cap)],
    ['POSITION_REVIEW', lp.operation === 'OPEN' && lp.owner === review.owner && (t === 0 ? lp.intent.amount0Max : lp.intent.amount1Max) === binding.bound &&
      (t === 0 ? lp.intent.amount1Max : lp.intent.amount0Max) === review.liquidity.otherMaximum && lp.intent.tickLower === review.liquidity.tickLower &&
      lp.intent.tickUpper === review.liquidity.tickUpper && lp.intent.slippageBps === review.liquidity.slippageBps && lp.workflow.workflowId === review.workflow.workflowId],
    ['POSITION_DEPOSIT', deposited <= bound],
  ];
  const failed = checks.find(([, ok]) => !ok);
  if (failed) fail(`SOLANA_COMPOSITION_EVIDENCE_${failed[0]}_MISMATCH`);
  const chain = review.chain, token = t === 0 ? lp.token0 : lp.token1;
  const boundAsset = { chainId: chain, address: token.mint, decimals: token.decimals };
  const composition = { bindingId: review.bindingId, owner: review.owner, swapRunId: swap.runId, liquidityRunId: liquidity.runId, liquidityAttempts: liquidity.attempts,
    swapSignature: binding.signature, liquiditySignature: liquidity.observation.signature, received: binding.received, cap: binding.cap, bound: binding.bound,
    depositedFromSwapOutput: deposited.toString(), notDeposited: (received - deposited).toString(), boundToken: token.symbol, positionMint: lp.accounts.positionMint,
    tickLower: lp.range.tickLower, tickUpper: lp.range.tickUpper, checks: checks.map(([code]) => code), provenance: input.provenance, evidenceClass: executed };
  const head = hashJournalBytes(new TextEncoder().encode(JSON.stringify(input.journal))).at(-1) ?? fail('SOLANA_COMPOSITION_JOURNAL_EMPTY');
  const sol = { chainId: chain, nativeId: 'SOL', decimals: 9 };
  const fees = BigInt(swap.observation.feeLamports ?? '0') + BigInt(liquidity.observation.feeLamports ?? '0');
  const bundle: EvidenceBundle = { schemaVersion: '1.0.0', evidenceBundleId: input.id, version: 1, supersedes: null,
    semanticWorkflowHash: review.manifest.semanticWorkflowHash, artifactSetHash: review.manifest.artifactSetHash, simulationHash: review.manifest.simulationHash,
    policyHash: review.manifest.policyHash, manifestHash: solanaSwapArtifactHash('strategy-manifest', review.manifest), executionPlanHash: solanaSwapArtifactHash('execution-plan', review.plan),
    journalHeadHash: head, observedAt: new Date().toISOString(), environment: input.provenance === 'MOCKED' ? 'MOCKED' : 'TESTNET_EXECUTED', outcome: 'RECONCILED',
    receipts: [{ receiptId: 'solana-composition-swap', contentHash: swap.evidence.bundleHash }, { receiptId: 'solana-composition-liquidity', contentHash: liquidity.evidence.bundleHash }],
    differences: [],
    reconciliation: { balances: [], allowances: [], debt: [], positions: [{ asset: { chainId: chain, address: lp.program, decimals: 0 }, amount: '1' }],
      fees: [{ asset: sol, amount: fees.toString() }], residualAssets: received > deposited ? [{ asset: boundAsset, amount: (received - deposited).toString() }] : [],
      ownership: [{ chainId: chain, address: review.owner }],
      limitations: ['Composed from two independently reconciled step runs; each step bundle is referenced by hash.',
        'The swap and the position are separate transactions. The swap output not deposited stays in the owner wallet.',
        input.provenance === 'MOCKED' ? 'MOCKED loopback evidence. Not Solana Devnet execution.' : 'Solana Devnet with valueless test tokens (Gryloo evidence class DEVNET_EXECUTED). Not mainnet execution and not real funds.'] },
    evidence: [{ evidenceId: 'solana-composition-swap-bundle', kind: 'EXTERNAL_REFERENCE', contentHash: swap.evidence.bundleHash },
      { evidenceId: 'solana-composition-liquidity-bundle', kind: 'EXTERNAL_REFERENCE', contentHash: liquidity.evidence.bundleHash },
      { evidenceId: 'solana-composition-binding', kind: 'EXTERNAL_REFERENCE', contentHash: solanaSwapHash(composition) }] };
  return { bundle, bundleHash: solanaSwapArtifactHash('evidence-bundle', bundle), evidenceClass: executed, composition,
    artifacts: { workflow: review.workflow, artifactSet: review.artifactSet, simulation: review.simulation, policy: review.policy, manifest: review.manifest, plan: review.plan,
      journal: input.journal, review } };
}
