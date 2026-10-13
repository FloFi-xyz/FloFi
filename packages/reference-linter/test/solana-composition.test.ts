// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createConcentratedLiquidityNode, createExactInputSwapNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { baseAssetRegistry, bindCompositionConsumer, ORCA_WHIRLPOOLS_DEVNET, ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY as lp, referenceRegistry, SOLANA_DEVNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { createReviewContext, validateAuthoringWorkflow, validateSolanaCompositionWorkflow } from '../src/index.js';

type Node = SemanticWorkflow['nodes'][number];
const chain = ORCA_WHIRLPOOLS_DEVNET.chain;
const context = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id, assets: baseAssetRegistry });
const token = (t: { mint: string; decimals: number }) => ({ chainId: chain, address: t.mint, decimals: t.decimals });
const swap = (patch: { amount?: string; slippageBps?: number; protocols?: string[]; maximumAmount?: string } = {}): Node => createExactInputSwapNode('node-002', { chain, input: token(SOLANA_DEVNET_TOKENS.SOL),
  output: token(SOLANA_DEVNET_TOKENS.devUSDC), amount: patch.amount ?? '100000000', slippageBps: patch.slippageBps ?? 50, protocols: patch.protocols ?? [ORCA_WHIRLPOOLS_DEVNET.protocol],
  maximumAmount: patch.maximumAmount ?? SOLANA_DEVNET_TOKENS.SOL.maximumAmount }) as Node;
const pool = (patch: { amount0Max?: string; amount1Max?: string; tickLower?: number; slippageBps?: number } = {}): Node => createConcentratedLiquidityNode('node-003', { chain,
  token0: token(lp.token0), token1: token(lp.token1), amount0Max: patch.amount0Max ?? '50000000', amount1Max: patch.amount1Max ?? '2500000', amount0Min: '0', amount1Min: '0',
  tickLower: patch.tickLower ?? -39104, tickUpper: -36992, feeTier: lp.feeTier, slippageBps: patch.slippageBps ?? 100, protocols: [lp.protocol], recipient: null,
  positionAsset: { chainId: chain, address: lp.programs.whirlpool, decimals: 0 } }) as Node;
const composed = (producer = swap(), position = pool()): SemanticWorkflow => {
  const consumer = bindCompositionConsumer(position, producer);
  return { schemaVersion: '1.0.0', workflowId: 'w', revision: 2, nodes: [producer, consumer],
    resourceEdges: [{ fromNodeId: producer.nodeId, outputId: 'amount-out', toNodeId: consumer.nodeId, inputName: consumer.inputs.at(-1)!.name }] };
};

describe('Solana Devnet Swap → Orca liquidity composition (authoring validation)', () => {
  it('accepts the linked pair and validates each step with its unchanged isolated validator', () => {
    expect(validateAuthoringWorkflow(composed(), context).nodes).toHaveLength(2);
    expect(validateSolanaCompositionWorkflow(composed())).toMatchObject({ source: { token: 1, nodeId: 'node-002' } });
  });
  it.each([
    ['swap slippage above the Devnet bound', composed(swap({ slippageBps: 301 })), 'SOLANA_SLIPPAGE_OUT_OF_RANGE'],
    ['swap amount above the Devnet cap', composed(swap({ amount: '10000000001', maximumAmount: '20000000000' })), 'AMOUNT_OUT_OF_RANGE'],
    ['an unaligned position range', composed(swap(), pool({ tickLower: -39100 })), 'SOLANA_LIQUIDITY_RANGE_INVALID'],
    ['a position maximum above the Devnet cap', composed(swap(), pool({ amount0Max: '10000000001' })), 'AMOUNT_OUT_OF_RANGE'],
    ['a zero cap on the bound token', composed(swap(), pool({ amount1Max: '0' })), 'SOLANA_COMPOSITION_CAP_REQUIRED'],
  ])('rejects %s', (_name, workflow, code) => expect(() => validateAuthoringWorkflow(workflow, context)).toThrow(code));
  it('rejects a dependency-only link with the composition code, and leaves unlinked steps to the isolated validators', () => {
    const plain = { ...pool(), dependencies: ['node-002'] };
    expect(() => validateAuthoringWorkflow({ ...composed(), nodes: [swap(), plain], resourceEdges: [] }, context)).toThrow('COMPOSITION_GRAPH_INVALID');
    expect(() => validateAuthoringWorkflow({ ...composed(), nodes: [swap(), pool()], resourceEdges: [] }, context)).toThrow(/ISOLATED_ONLY/);
    const third = { ...pool(), nodeId: 'node-004' };
    expect(() => validateAuthoringWorkflow({ ...composed(), nodes: [...composed().nodes, third] }, context)).toThrow(/ISOLATED_ONLY/);
  });
  it('never lets an isolated validator accept the bound position on its own', () => {
    const bound = composed().nodes[1]!;
    expect(() => validateAuthoringWorkflow({ schemaVersion: '1.0.0', workflowId: 'w', revision: 1, nodes: [bound], resourceEdges: [] }, context)).toThrow();
  });
});
