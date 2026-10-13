// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createConcentratedLiquidityNode, createExactInputSwapNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { bindCompositionConsumer, ORCA_WHIRLPOOLS_DEVNET, ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY as lp, projectCompositionProducer, SOLANA_DEVNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { assertSolanaCompositionReview, createMockedSolanaDevnetOrca, createMockedSolanaWallet, simulateOrcaDevnetSwap, simulateSolanaComposition, solanaSwapArtifactHash,
  solanaSwapHash } from '../src/index.js';

type Node = SemanticWorkflow['nodes'][number];
const chain = ORCA_WHIRLPOOLS_DEVNET.chain, NOW = Date.parse('2026-10-01T12:00:00.000Z');
const token = (t: { mint: string; decimals: number }) => ({ chainId: chain, address: t.mint, decimals: t.decimals });
const swapNode = (amount = '100000000'): Node => createExactInputSwapNode('node-002', { chain, input: token(SOLANA_DEVNET_TOKENS.SOL), output: token(SOLANA_DEVNET_TOKENS.devUSDC),
  amount, slippageBps: 50, protocols: [ORCA_WHIRLPOOLS_DEVNET.protocol], maximumAmount: SOLANA_DEVNET_TOKENS.SOL.maximumAmount }) as Node;
const poolNode = (patch: { amount0Max?: string; amount1Max?: string; tickLower?: number; tickUpper?: number } = {}): Node => createConcentratedLiquidityNode('node-003', { chain,
  token0: token(lp.token0), token1: token(lp.token1), amount0Max: patch.amount0Max ?? '50000000', amount1Max: patch.amount1Max ?? lp.token1.maximumAmount, amount0Min: '0',
  amount1Min: '0', tickLower: patch.tickLower ?? -39104, tickUpper: patch.tickUpper ?? -36992, feeTier: lp.feeTier, slippageBps: 100, protocols: [lp.protocol], recipient: null,
  positionAsset: { chainId: chain, address: lp.programs.whirlpool, decimals: 0 } }) as Node;
function composed(pool = poolNode(), swap = swapNode()): SemanticWorkflow {
  const consumer = bindCompositionConsumer(pool, swap);
  return { schemaVersion: '1.0.0', workflowId: 'w-composition', revision: 3, nodes: [swap, consumer],
    resourceEdges: [{ fromNodeId: swap.nodeId, outputId: 'amount-out', toNodeId: consumer.nodeId, inputName: consumer.inputs.at(-1)!.name }] };
}
async function simulate(workflow = composed(), lamports = 3_000_000_000n) {
  const env = createMockedSolanaDevnetOrca(), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, lamports, 0n);
  const swap = await simulateOrcaDevnetSwap(projectCompositionProducer(workflow), wallet.owner, env.rpc, NOW);
  return { env, wallet, swap, review: () => simulateSolanaComposition(workflow, wallet.owner, { runId: 'orca-' + '0'.repeat(32), review: swap }, env.rpc, NOW) };
}

describe('Solana Devnet Swap → Orca liquidity composed Review (MOCKED loopback, read-only)', () => {
  it('wraps the exact swap Review, projects the position at both swap outcomes and freezes a schema-valid two-step v1 chain', async () => {
    const s = await simulate(), review = await s.review();
    expect(s.env.state.sent).toEqual([]);
    expect(review).toMatchObject({ format: 'gryloo.solana-composition-review.v1', bindingId: 'solana-devnet.orca-swap.orca-liquidity', cluster: 'devnet', owner: s.wallet.owner,
      swap: { nodeId: 'node-002', commitment: s.swap.commitment, messageHash: s.swap.messageHash, expectedOutput: s.swap.quote.outAmount, minimumOutput: s.swap.quote.otherAmountThreshold },
      liquidity: { nodeId: 'node-003', boundToken: 1, cap: lp.token1.maximumAmount, capIsFullOutput: true, otherMaximum: '50000000', tickLower: -39104, tickUpper: -36992 } });
    // 100% of the swap output: the bound maximum is the swap output itself, never a pre-existing balance.
    expect(review.liquidity.expected.boundMaximum).toBe(s.swap.quote.outAmount);
    expect(review.liquidity.adverse.boundMaximum).toBe(s.swap.quote.otherAmountThreshold);
    expect(BigInt(review.liquidity.expected.amount1)).toBeLessThanOrEqual(BigInt(s.swap.quote.outAmount));
    expect(BigInt(review.liquidity.expected.tokenMax0)).toBeLessThanOrEqual(50_000_000n);
    expect(review.liquidity.preflight.every(check => check.ok)).toBe(true);
    expect(review.plan.segments[0]!.steps.map(step => [step.stepId, step.dependencies, step.nodeId])).toEqual([
      ['solana-composition-swap', [], 'node-002'], ['solana-composition-liquidity', ['solana-composition-swap'], 'node-003']]);
    expect(review.plan.segments[0]!.steps[0]).toMatchObject({ executionKind: 'DIRECT_TRANSACTION', payloadHash: s.swap.messageHash });
    expect(review.simulation.propagatedOutputs).toEqual([{ fromNodeId: 'node-002', outputId: 'amount-out', toNodeId: 'node-003', inputName: 'amount1-source',
      quantity: { asset: token(SOLANA_DEVNET_TOKENS.devUSDC), amount: s.swap.quote.outAmount } }]);
    expect(review.simulation.failurePaths.map(path => [path.failedNodeId, path.blockedNodeIds])).toEqual([['node-002', ['node-003']], ['node-003', []]]);
    // SOL is the swap input and the position's other token: its limit is cumulative across both steps.
    expect(review.manifest.spendLimits).toEqual([
      { asset: token(SOLANA_DEVNET_TOKENS.SOL), maximumAmount: '150000000', maximumPerStepAmount: '100000000', maximumCumulativeAmount: '150000000' },
      { asset: token(SOLANA_DEVNET_TOKENS.devUSDC), maximumAmount: lp.token1.maximumAmount, maximumPerStepAmount: lp.token1.maximumAmount, maximumCumulativeAmount: lp.token1.maximumAmount }]);
    expect(review.manifest).toMatchObject({ authorizationMode: 'MODE_A', executor: null, enforcement: 'NOT_ENFORCED', semanticWorkflowHash: solanaSwapArtifactHash('semantic-workflow', composed()) });
    expect(review.policy.allowlists.functions.map(f => f.functionId)).toEqual(['swap-v2', 'open-position-with-token-extensions', 'increase-liquidity-v2']);
    const { commitment, ...content } = review;
    expect(solanaSwapHash(content)).toBe(commitment);
  });
  it('respects a lower owner cap on the swap output token', async () => {
    const s = await simulate(composed(poolNode({ amount1Max: '1000000' }))), review = await s.review();
    expect(review.liquidity).toMatchObject({ cap: '1000000', capIsFullOutput: false });
    expect(review.liquidity.expected.boundMaximum).toBe('1000000');
    expect(review.manifest.spendLimits.at(-1)).toMatchObject({ maximumAmount: '1000000' });
  });
  it('guards the root authorization: commitment, composed revision, owner and freshness', async () => {
    const s = await simulate(), review = await s.review(), workflow = composed();
    expect(() => assertSolanaCompositionReview(review, workflow, s.wallet.owner, NOW)).not.toThrow();
    expect(() => assertSolanaCompositionReview({ ...review, liquidity: { ...review.liquidity, cap: '1' } }, workflow, s.wallet.owner, NOW)).toThrow('SOLANA_COMPOSITION_AUTHORIZATION_INVALID');
    expect(() => assertSolanaCompositionReview(review, { ...workflow, revision: 4 }, s.wallet.owner, NOW)).toThrow('SOLANA_COMPOSITION_SEMANTIC_REVISION_CHANGED');
    expect(() => assertSolanaCompositionReview(review, workflow, createMockedSolanaWallet().owner, NOW)).toThrow('SOLANA_COMPOSITION_WRONG_OWNER');
    expect(() => assertSolanaCompositionReview(review, workflow, s.wallet.owner, Date.parse(review.expiresAt))).toThrow('SOLANA_COMPOSITION_REVIEW_STALE');
  });
  it('blocks before the swap when the position could not be opened afterwards', async () => {
    const far = await simulate(composed(poolNode({ tickLower: -64000 })));
    await expect(far.review()).rejects.toThrow('SOLANA_COMPOSITION_PREFLIGHT_TICK_ARRAYS_INITIALIZED');
    const poor = await simulate(composed(), 120_000_000n);
    await expect(poor.review()).rejects.toThrow('SOLANA_COMPOSITION_PREFLIGHT_SOL_SUFFICIENT');
    // Above the price only SOL is deposited; with no SOL allowed, no position can exist.
    const empty = await simulate(composed(poolNode({ amount0Max: '0', tickLower: -37888 })));
    await expect(empty.review()).rejects.toThrow('SOLANA_COMPOSITION_PREFLIGHT_POSITION_NON_ZERO');
  });
  it('reports, without blocking, a range that would not deposit any of the swap output', async () => {
    const s = await simulate(composed(poolNode({ tickLower: -37888 }))), review = await s.review();
    expect(review.liquidity.expected.state).toBe('BELOW_RANGE');
    expect(review.liquidity.preflight.find(check => check.code === 'SWAP_OUTPUT_DEPOSITED')).toEqual({ code: 'SWAP_OUTPUT_DEPOSITED', ok: false, blocking: false });
  });
  it('rejects a swap Review that is not the composed swap step', async () => {
    const s = await simulate(), other = await simulate(composed(poolNode(), swapNode('200000000')));
    await expect(simulateSolanaComposition(composed(), s.wallet.owner, { runId: 'x', review: other.swap }, s.env.rpc, NOW)).rejects.toThrow('SOLANA_COMPOSITION_SWAP_REVIEW_MISMATCH');
  });
});
