// SPDX-License-Identifier: AGPL-3.0-only
import { compositionCap, readBoundComposition, ORCA_WHIRLPOOLS_DEVNET as swapProfile, ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY as profile,
  SOLANA_DEVNET_SWAP_LIQUIDITY } from '@defi-workflow-engine/action-registry';
import { readConcentratedLiquidity, type ArtifactSet, type AuthorizationPolicy, type ExecutionPlan, type SemanticWorkflow, type SimulationBundle,
  type StrategyManifest } from '@defi-workflow-engine/workflow-contracts';
import { orcaLiquidityForMaxima, orcaLiquidityTickArray, orcaPriceFromSqrtPrice, orcaSqrtPriceAtTick, orcaTickAtSqrtPrice, readOrcaLiquidityPool,
  type OrcaComposition, type OrcaRangeState } from './orca-liquidity.js';
import type { OrcaDevnetReview } from './orca-whirlpool.js';
import { readSolanaAccounts, solanaSwapArtifactHash, solanaSwapHash, verifySolanaCluster, type SolanaRpc } from './solana-swap.js';

/**
 * Solana Devnet Swap → Orca liquidity, composed from the two existing isolated runtimes. This module never builds or signs
 * a transaction: the swap step is the existing Orca swap Review (exact message), and the liquidity step is only a read-only
 * projection here. After the swap reconciles, the liquidity transaction is simulated against fresh pool state with the
 * verified received amount, and reviewed again by the owner before any wallet request.
 *
 * The preflight reduces the risk of swapping into a position that cannot be opened (pool, tick arrays, balances, a
 * non-zero position). It does not guarantee that the later liquidity transaction succeeds.
 */
export const SOLANA_COMPOSITION_FORMAT = 'gryloo.solana-composition-review.v1';
/** Upper estimate of the SOL an Open needs besides the deposit: the temporary wrapped-SOL deposit (refunded in the same
 * transaction), the position, position-mint and position-token deposits (refunded on close) and two signatures. */
export const SOLANA_COMPOSITION_OPEN_OVERHEAD_LAMPORTS = 10_000_000n;
/** Position preparations allowed in one composition run (an expired, unsigned or reverted one may be prepared again); each is separately reviewed and signed. */
export const SOLANA_COMPOSITION_LIQUIDITY_ATTEMPTS = 8;
const fail = (code: string): never => { throw new Error(code); };
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const min = (a: bigint, b: bigint) => a < b ? a : b;
const slipUp = (v: bigint, bps: number) => (v * BigInt(10_000 + bps) + 9_999n) / 10_000n;
const P = profile.programs, POOL = profile.pool;

export type CompositionProjection = { boundMaximum: string; state: OrcaRangeState; liquidity: string; amount0: string; amount1: string;
  /** Token maxima the liquidity instruction would carry (slippage-bounded, never above the maxima). */ tokenMax0: string; tokenMax1: string };
export type CompositionPreflight = { code: string; ok: boolean; blocking: boolean };
export type SolanaCompositionReview = {
  format: typeof SOLANA_COMPOSITION_FORMAT; bindingId: string; chain: string; cluster: 'devnet'; owner: string; workflow: SemanticWorkflow;
  swap: { nodeId: string; runId: string; commitment: string; messageHash: string; input: { symbol: string; mint: string; decimals: number };
    output: { symbol: string; mint: string; decimals: number }; amount: string; expectedOutput: string; minimumOutput: string; slippageBps: number;
    postSqrtPrice: string; expiresAt: string };
  liquidity: { nodeId: string; boundToken: 0 | 1; cap: string; capIsFullOutput: boolean; otherMaximum: string; tickLower: number; tickUpper: number;
    lowerPrice: string; upperPrice: string; slippageBps: number;
    pool: { address: string; sqrtPrice: string; tickCurrentIndex: number; price: string; slot: number; postSwapPrice: string };
    expected: CompositionProjection; adverse: CompositionProjection; preflight: CompositionPreflight[] };
  artifactSet: ArtifactSet; simulation: SimulationBundle; policy: AuthorizationPolicy; manifest: StrategyManifest; plan: ExecutionPlan;
  observedAt: string; expiresAt: string; commitment: string };

function project(pool: { tickCurrentIndex: number; sqrtPrice: bigint }, tickLower: number, tickUpper: number, token: 0 | 1, bound: bigint, other: bigint,
  slippageBps: number): CompositionProjection {
  const [max0, max1] = token === 0 ? [bound, other] : [other, bound];
  const c: OrcaComposition = orcaLiquidityForMaxima(pool, tickLower, tickUpper, max0, max1);
  return { boundMaximum: bound.toString(), state: c.state, liquidity: c.liquidity.toString(), amount0: c.amount0.toString(), amount1: c.amount1.toString(),
    tokenMax0: min(max0, slipUp(c.amount0, slippageBps)).toString(), tokenMax1: min(max1, slipUp(c.amount1, slippageBps)).toString() };
}

/**
 * Read-only: verify the cluster and the liquidity pool, check the position's tick arrays and the owner's post-swap
 * balances, project the position at the swap's simulated post-trade price for the expected and the minimum swap output,
 * and freeze the composed v1 artifact chain around the existing swap Review. Blocking preflight failures throw.
 */
export async function simulateSolanaComposition(workflow: SemanticWorkflow, owner: string, swap: { runId: string; review: OrcaDevnetReview }, rpc: SolanaRpc,
  now = Date.now()): Promise<SolanaCompositionReview> {
  const composed = readBoundComposition(workflow);
  if (composed.binding.id !== SOLANA_DEVNET_SWAP_LIQUIDITY.id) fail('COMPOSITION_UNSUPPORTED');
  const s = swap.review;
  if (s.format !== 'gryloo.orca-devnet-review.v1' || s.owner !== owner || s.workflow.nodes.length !== 1 || JSON.stringify(s.workflow.nodes[0]) !== JSON.stringify(composed.producer))
    fail('SOLANA_COMPOSITION_SWAP_REVIEW_MISMATCH');
  const fields = readConcentratedLiquidity(composed.isolatedConsumer as never), token = composed.source.token;
  if (s.output.mint !== (token === 0 ? fields.token0.address : fields.token1.address)) fail('SOLANA_COMPOSITION_SWAP_REVIEW_MISMATCH');
  const cap = BigInt(compositionCap(workflow)), other = BigInt(token === 0 ? fields.amount1Max : fields.amount0Max), slippageBps = fields.slippageBps!;
  await verifySolanaCluster(rpc, profile.genesisHash);
  const pool = await readOrcaLiquidityPool(rpc);
  const arrays = [orcaLiquidityTickArray(POOL.address, fields.tickLower), orcaLiquidityTickArray(POOL.address, fields.tickUpper)];
  const { accounts } = await readSolanaAccounts(rpc, arrays);
  const preflight: CompositionPreflight[] = [];
  const check = (code: string, ok: boolean, blocking = true) => { preflight.push({ code, ok, blocking }); };
  check('POOL_VERIFIED', true);
  check('TICK_ARRAYS_INITIALIZED', accounts.every(a => a !== null && a.owner === P.whirlpool && hex(a.data.slice(0, 8)) === profile.tickArrayDiscriminator));
  const post = BigInt(s.simulatedTrade.postSqrtPrice), postPool = { sqrtPrice: post, tickCurrentIndex: orcaTickAtSqrtPrice(post) };
  const expectedOut = BigInt(s.quote.outAmount), minimumOut = BigInt(s.quote.otherAmountThreshold);
  const expected = project(postPool, fields.tickLower, fields.tickUpper, token, min(cap, expectedOut), other, slippageBps);
  const adverse = project(postPool, fields.tickLower, fields.tickUpper, token, min(cap, minimumOut), other, slippageBps);
  check('POSITION_NON_ZERO', BigInt(expected.liquidity) > 0n && BigInt(adverse.liquidity) > 0n);
  check('SWAP_OUTPUT_DEPOSITED', BigInt(token === 0 ? expected.amount0 : expected.amount1) > 0n, false);
  // Owner balances after the simulated swap: native lamports and the devUSDC (token B) account.
  const after = s.simulationResult.post, lamports = BigInt(after.ownerLamports);
  const devUsdc = BigInt((s.output.mint === POOL.tokenMintB ? after.output : after.input) ?? '0');
  check('SOL_SUFFICIENT', lamports >= BigInt(expected.tokenMax0) + SOLANA_COMPOSITION_OPEN_OVERHEAD_LAMPORTS);
  check('DEVUSDC_SUFFICIENT', devUsdc >= BigInt(expected.tokenMax1));
  const blocked = preflight.find(c => c.blocking && !c.ok);
  if (blocked) fail(`SOLANA_COMPOSITION_PREFLIGHT_${blocked.code}`);
  const price = (sqrt: bigint) => orcaPriceFromSqrtPrice(sqrt, profile.token0.decimals, profile.token1.decimals);
  const liquidity: SolanaCompositionReview['liquidity'] = { nodeId: composed.consumer.nodeId, boundToken: token, cap: cap.toString(),
    capIsFullOutput: cap.toString() === (token === 0 ? profile.token0.maximumAmount : profile.token1.maximumAmount), otherMaximum: other.toString(),
    tickLower: fields.tickLower, tickUpper: fields.tickUpper, lowerPrice: price(orcaSqrtPriceAtTick(fields.tickLower)), upperPrice: price(orcaSqrtPriceAtTick(fields.tickUpper)),
    slippageBps, pool: { address: pool.address, sqrtPrice: pool.sqrtPrice, tickCurrentIndex: pool.tickCurrentIndex, price: price(BigInt(pool.sqrtPrice)), slot: pool.slot,
      postSwapPrice: price(post) }, expected, adverse, preflight };
  const swapPart: SolanaCompositionReview['swap'] = { nodeId: composed.producer.nodeId, runId: swap.runId, commitment: s.commitment, messageHash: s.messageHash,
    input: { ...s.input }, output: { ...s.output }, amount: s.amount, expectedOutput: s.quote.outAmount, minimumOutput: s.quote.otherAmountThreshold,
    slippageBps: s.slippageBps, postSqrtPrice: s.simulatedTrade.postSqrtPrice, expiresAt: s.expiresAt };
  const observedAt = new Date(now).toISOString(), expiresAt = s.expiresAt;
  const artifacts = buildSolanaCompositionArtifacts({ workflow, owner, swap: swapPart, swapReview: s, liquidity, observedAt, expiresAt });
  const review: Omit<SolanaCompositionReview, 'commitment'> = { format: SOLANA_COMPOSITION_FORMAT, bindingId: composed.binding.id, chain: profile.chain, cluster: 'devnet',
    owner, workflow, swap: swapPart, liquidity, ...artifacts, observedAt, expiresAt };
  return { ...review, commitment: solanaSwapHash(review) };
}

/** The frozen v1 chain for the composed plan. The liquidity step's exact payload is committed later by its own Review. */
export function buildSolanaCompositionArtifacts(input: { workflow: SemanticWorkflow; owner: string; swap: SolanaCompositionReview['swap']; swapReview: OrcaDevnetReview;
  liquidity: SolanaCompositionReview['liquidity']; observedAt: string; expiresAt: string }) {
  const { workflow, swap, liquidity: lp } = input, chain = profile.chain, prefix = 'solana-composition';
  const semanticHash = solanaSwapArtifactHash('semantic-workflow', workflow);
  const asset = (t: { mint: string; decimals: number }) => ({ chainId: chain, address: t.mint, decimals: t.decimals });
  const token0 = asset(profile.token0), token1 = asset(profile.token1), bound = lp.boundToken === 0 ? token0 : token1, unbound = lp.boundToken === 0 ? token1 : token0;
  const swapAdapter = { id: swapProfile.adapterId, version: '1.0.0' }, lpAdapter = { id: profile.adapterId, version: '1.0.0' };
  const contract = { chainId: chain, address: P.whirlpool, version: 'orca-whirlpools-devnet' };
  const liquidityPlan = { boundToken: lp.boundToken, cap: lp.cap, otherMaximum: lp.otherMaximum, tickLower: lp.tickLower, tickUpper: lp.tickUpper, slippageBps: lp.slippageBps,
    pool: lp.pool.address, rule: 'min(cap, reconciled swap output)' };
  const artifactSet: ArtifactSet = { schemaVersion: '1.0.0', artifactSetId: `${prefix}-artifacts`, semanticWorkflowHash: semanticHash, artifacts: [
    { artifactId: `${prefix}-swap-review`, nodeId: swap.nodeId, artifactHash: solanaSwapHash({ commitment: swap.commitment, messageHash: swap.messageHash }) },
    { artifactId: `${prefix}-liquidity-projection`, nodeId: lp.nodeId, artifactHash: solanaSwapHash(lp) }] };
  const artifactHash = solanaSwapArtifactHash('artifact-set', artifactSet);
  const nft = { chainId: chain, address: P.whirlpool, decimals: 0 }, one = { asset: nft, amount: '1' };
  const expectedBound = { asset: bound, amount: lp.expected.boundMaximum };
  const simulation: SimulationBundle = { schemaVersion: '1.0.0', simulationId: `${prefix}-simulation`, semanticWorkflowRevision: workflow.revision, semanticWorkflowHash: semanticHash,
    artifactSetHash: artifactHash, adapters: [swapAdapter, lpAdapter], contracts: [contract],
    outputs: [{ nodeId: swap.nodeId, outputId: 'amount-out', expected: { asset: bound, amount: swap.expectedOutput }, minimum: { asset: bound, amount: swap.minimumOutput },
      adverse: { asset: bound, amount: swap.minimumOutput } }, { nodeId: lp.nodeId, outputId: 'position-nft', expected: one, minimum: one, adverse: one }],
    propagatedOutputs: [{ fromNodeId: swap.nodeId, outputId: 'amount-out', toNodeId: lp.nodeId, inputName: `amount${lp.boundToken}-source`, quantity: expectedBound }],
    failurePaths: [{ failedNodeId: swap.nodeId, blockedNodeIds: [lp.nodeId], residualAssets: [] }, { failedNodeId: lp.nodeId, blockedNodeIds: [], residualAssets: [expectedBound] }],
    uncertainty: [{ code: 'NON_ATOMIC_COMPOSITION', description: 'The swap and the position are separate transactions. If the position is not opened, the swapped tokens stay in your wallet; the swap is never repeated.' },
      { code: 'LIQUIDITY_PROJECTED', description: 'Position amounts are projected from the simulated swap and the current pool. The exact position transaction is simulated with the reconciled swap output and fresh pool state, and reviewed again before signing.' }],
    unsupportedAssumptions: [], freshness: { observedAt: input.swapReview.quote.fetchedAt, expiresAt: input.expiresAt, maximumAgeSeconds: swapProfile.reviewTtlSeconds } };
  const simulationHash = solanaSwapArtifactHash('simulation-bundle', simulation), owner = { chainId: chain, address: input.owner };
  // The swap input token may also be the position's other token: its limit is cumulative across both steps.
  const otherFromSwap = swap.input.mint === unbound.address ? BigInt(swap.amount) : 0n, other = BigInt(lp.otherMaximum);
  const swapInput = asset(swap.input);
  const spendLimits = [
    ...otherFromSwap ? [] : [{ asset: swapInput, maximumAmount: swap.amount, maximumPerStepAmount: swap.amount, maximumCumulativeAmount: swap.amount }],
    { asset: unbound, maximumAmount: (otherFromSwap + other).toString(), maximumPerStepAmount: (otherFromSwap > other ? otherFromSwap : other).toString(),
      maximumCumulativeAmount: (otherFromSwap + other).toString() },
    { asset: bound, maximumAmount: lp.cap, maximumPerStepAmount: lp.cap, maximumCumulativeAmount: lp.cap }];
  const swapGas = input.swapReview.manifest.gasBudgets.find(b => 'nativeId' in b.asset && b.asset.nativeId === 'SOL')?.maximumAmount ?? fail('SOLANA_COMPOSITION_SWAP_REVIEW_MISMATCH');
  const lpGas = BigInt(profile.baseFeeLamports) * 2n + SOLANA_COMPOSITION_OPEN_OVERHEAD_LAMPORTS;
  const gasBudgets = [{ asset: { chainId: chain, nativeId: 'SOL', decimals: 9 }, maximumAmount: (BigInt(swapGas) + lpGas).toString() }];
  const recovery = { failurePolicy: 'ABORT' as const, residualAssetRecipient: owner, maximumAttemptsPerStep: SOLANA_COMPOSITION_LIQUIDITY_ATTEMPTS, requiresHumanReview: true as const };
  const providers = { kind: 'FIXED' as const, providerId: SOLANA_DEVNET_SWAP_LIQUIDITY.id };
  const maximumSlippageBps = Math.max(swap.slippageBps, lp.slippageBps), nonce = String(input.swapReview.lastValidBlockHeight);
  const policy: AuthorizationPolicy = { schemaVersion: '1.0.0', policyId: `${prefix}-policy`, semanticWorkflowHash: semanticHash, artifactSetHash: artifactHash, simulationHash,
    requiredAuthorizationClass: 'MODE_A', allowlists: { owners: [owner], accounts: [owner], recipients: [owner], chains: [chain], adapters: [swapAdapter, lpAdapter],
      protocols: [profile.protocol], contracts: [contract], functions: ['swap-v2', 'open-position-with-token-extensions', 'increase-liquidity-v2']
        .map(functionId => ({ chainId: chain, contract: P.whirlpool, functionId })) },
    budgetReservation: { rule: 'RESERVE_BEFORE_SUBMISSION', concurrentConsumption: 'CUMULATIVE_ACROSS_BRANCHES', implementation: 'NOT_IMPLEMENTED' },
    spendLimits, maximumSlippageBps, gasBudgets, feeBudgets: [], oracleRules: [], accountRiskRules: [], checkpointRules: [], providers,
    nonce, deadline: input.expiresAt, revocationEpoch: workflow.revision, recovery, enforcement: 'NOT_ENFORCED' };
  const policyHash = solanaSwapArtifactHash('authorization-policy', policy);
  const manifest: StrategyManifest = { schemaVersion: '1.0.0', manifestId: `${prefix}-manifest`, semanticWorkflowRevision: workflow.revision, semanticWorkflowHash: semanticHash,
    artifactSetHash: artifactHash, simulationHash, policyHash, authorizationMode: 'MODE_A', owner, executor: null, expiresAt: input.expiresAt, nonce,
    revocationEpoch: workflow.revision, spendLimits, maximumSlippageBps, gasBudgets, feeBudgets: [], providers, recovery, enforcement: 'NOT_ENFORCED' };
  const manifestHash = solanaSwapArtifactHash('strategy-manifest', manifest);
  const plan: ExecutionPlan = { schemaVersion: '1.0.0', executionPlanId: `${prefix}-plan`, semanticWorkflowHash: semanticHash, manifestHash,
    segments: [{ segmentId: `${prefix}-segment`, chainId: chain, dependencies: [], steps: [
      { stepId: `${prefix}-swap`, nodeId: swap.nodeId, chainId: chain, adapter: swapAdapter, dependencies: [], requiredAuthorizationClass: 'MODE_A',
        executionKind: 'DIRECT_TRANSACTION', payloadHash: swap.messageHash },
      // The position's exact message exists only after the swap reconciles; this commits to its bound plan, and its own Review commits to the bytes.
      { stepId: `${prefix}-liquidity`, nodeId: lp.nodeId, chainId: chain, adapter: lpAdapter, dependencies: [`${prefix}-swap`], requiredAuthorizationClass: 'MODE_A',
        executionKind: 'DIRECT_TRANSACTION', payloadHash: solanaSwapHash(liquidityPlan) }] }],
    checkpointIds: [], enforcement: 'NOT_ENFORCED' };
  solanaSwapArtifactHash('execution-plan', plan);
  return { artifactSet, simulation, policy, manifest, plan };
}

/**
 * Root authorization guard, before the swap begins: commitment, composed semantic revision, owner and freshness. The swap
 * step keeps its own guard (exact message, blockhash validity); the position step has its own later Review.
 */
export function assertSolanaCompositionReview(review: SolanaCompositionReview, workflow: SemanticWorkflow, owner: string, now = Date.now()): void {
  const { commitment, ...content } = review;
  if (review.format !== SOLANA_COMPOSITION_FORMAT || review.chain !== profile.chain || solanaSwapHash(content) !== commitment) fail('SOLANA_COMPOSITION_AUTHORIZATION_INVALID');
  if (solanaSwapArtifactHash('semantic-workflow', workflow) !== review.manifest.semanticWorkflowHash) fail('SOLANA_COMPOSITION_SEMANTIC_REVISION_CHANGED');
  if (owner !== review.owner) fail('SOLANA_COMPOSITION_WRONG_OWNER');
  if (now >= Date.parse(review.expiresAt) || now < Date.parse(review.observedAt)) fail('SOLANA_COMPOSITION_REVIEW_STALE');
  const composed = readBoundComposition(workflow);
  if (composed.producer.nodeId !== review.swap.nodeId || composed.consumer.nodeId !== review.liquidity.nodeId) fail('SOLANA_COMPOSITION_SEMANTIC_REVISION_CHANGED');
}
