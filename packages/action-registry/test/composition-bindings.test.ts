// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createConcentratedLiquidityNode, createExactInputSwapNode, hashArtifactBytes, readConcentratedLiquidity, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { bindCompositionConsumer, compositionBindingFor, compositionCap, isBoundComposition, JUPITER_SOLANA_MAINNET, ORCA_WHIRLPOOLS_DEVNET, ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY as lp,
  projectCompositionConsumer, projectCompositionProducer, readBoundComposition, resolveWorkflowCapability, SOLANA_DEVNET_SWAP_LIQUIDITY, SOLANA_DEVNET_TOKENS,
  SOLANA_MAINNET_TOKENS, unbindCompositionConsumer } from '../src/index.js';

type Node = SemanticWorkflow['nodes'][number];
const chain = ORCA_WHIRLPOOLS_DEVNET.chain;
const token = (t: { mint: string; decimals: number }, on = chain) => ({ chainId: on, address: t.mint, decimals: t.decimals });
const swap = (id = 'node-002', from = SOLANA_DEVNET_TOKENS.SOL, to = SOLANA_DEVNET_TOKENS.devUSDC): Node => createExactInputSwapNode(id, { chain, input: token(from),
  output: token(to), amount: '100000000', slippageBps: 50, protocols: [ORCA_WHIRLPOOLS_DEVNET.protocol], maximumAmount: from.maximumAmount }) as Node;
const pool = (id = 'node-003', amount1Max = '2500000'): Node => createConcentratedLiquidityNode(id, { chain, token0: token(lp.token0), token1: token(lp.token1),
  amount0Max: '50000000', amount1Max, amount0Min: '0', amount1Min: '0', tickLower: -39104, tickUpper: -36992, feeTier: lp.feeTier, slippageBps: 100,
  protocols: [lp.protocol], recipient: null, positionAsset: { chainId: chain, address: lp.programs.whirlpool, decimals: 0 } }) as Node;
const composed = (producer = swap(), consumer = bindCompositionConsumer(pool(), producer), extra: Node[] = [], edges?: SemanticWorkflow['resourceEdges']): SemanticWorkflow => ({
  schemaVersion: '1.0.0', workflowId: 'w-composed', revision: 4, nodes: [...extra, producer, consumer],
  resourceEdges: edges ?? [{ fromNodeId: producer.nodeId, outputId: 'amount-out', toNodeId: consumer.nodeId, inputName: consumer.inputs.at(-1)!.name }] });
const mock = (id: string, dependencies: string[] = []): Node => ({ nodeId: id, actionType: 'mock-read', actionSchemaVersion: '1.0.0', chainId: 'mock:local', requiredCapabilities: [],
  adapterConstraints: { adapters: [], protocols: [] }, inputs: [], expectedOutputs: [{ outputId: 'result', asset: { chainId: 'mock:local', nativeId: 'MOCK', decimals: 0 }, minimumAmount: '0' }],
  dependencies, userConstraints: [], failurePolicy: 'ABORT', requiredAuthorizationClass: 'NONE', lockedParameters: [], editableBounds: [] } as never);
const schemaValid = (w: SemanticWorkflow) => hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(w)));

describe('registered bound compositions', () => {
  it('binds the swap output to the matching pool token, in either swap direction', () => {
    expect(compositionBindingFor(swap(), pool())).toEqual({ binding: SOLANA_DEVNET_SWAP_LIQUIDITY, token: 1 });
    expect(compositionBindingFor(swap('node-002', SOLANA_DEVNET_TOKENS.devUSDC, SOLANA_DEVNET_TOKENS.SOL), pool())).toEqual({ binding: SOLANA_DEVNET_SWAP_LIQUIDITY, token: 0 });
    expect(compositionBindingFor(pool(), swap())).toBeNull();
    const mainnet = createExactInputSwapNode('node-002', { chain: JUPITER_SOLANA_MAINNET.chain, input: token(SOLANA_MAINNET_TOKENS.SOL, JUPITER_SOLANA_MAINNET.chain),
      output: token(SOLANA_MAINNET_TOKENS.USDC, JUPITER_SOLANA_MAINNET.chain), amount: '1000', slippageBps: 50, protocols: ['jupiter'], maximumAmount: '1000000000' }) as Node;
    expect(compositionBindingFor(mainnet, pool())).toBeNull();
  });
  it('reads the closed two-step shape and leaves both steps as their exact isolated nodes', () => {
    const w = composed(), read = readBoundComposition(w);
    expect(schemaValid(w)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(read).toMatchObject({ binding: SOLANA_DEVNET_SWAP_LIQUIDITY, source: { token: 1, nodeId: 'node-002', outputId: 'amount-out' } });
    expect(read.isolatedConsumer).toEqual(pool());
    expect(isBoundComposition(composed(swap(), undefined, [mock('node-001'), mock('node-004', ['node-001'])]))).toBe(true);
  });
  it('rejects every other shape: dependency-only links, extra steps, wrong bindings, edges and template links', () => {
    const producer = swap(), plain = { ...pool(), dependencies: ['node-002'] };
    const cases: [SemanticWorkflow, string][] = [
      [composed(producer, plain, [], []), 'COMPOSITION_GRAPH_INVALID'],
      [composed(producer, undefined, [swap('node-005')]), 'COMPOSITION_GRAPH_INVALID'],
      [composed(producer, undefined, [], []), 'COMPOSITION_GRAPH_INVALID'],
      [composed(producer, undefined, [], [{ fromNodeId: 'node-002', outputId: 'amount-out', toNodeId: 'node-003', inputName: 'amount0-source' }]), 'COMPOSITION_GRAPH_INVALID'],
      [composed(producer, { ...bindCompositionConsumer(pool(), producer), inputs: [...pool().inputs, { name: 'amount0-source', kind: 'OUTPUT_REFERENCE', value: { nodeId: 'node-002', outputId: 'amount-out' } }] }),
        'COMPOSITION_GRAPH_INVALID'],
      [composed(producer, undefined, [mock('node-001', ['node-002'])]), 'COMPOSITION_GRAPH_INVALID'],
      [{ ...composed(), nodes: [pool()] }, 'COMPOSITION_GRAPH_INVALID'],
    ];
    for (const [w, code] of cases) expect(() => readBoundComposition(w), JSON.stringify(w.resourceEdges)).toThrow(code);
    const uniswapLike = { ...pool(), adapterConstraints: { adapters: [], protocols: ['uniswap-v3'] } };
    expect(() => readBoundComposition(composed(producer, { ...uniswapLike, dependencies: ['node-002'] }))).toThrow('COMPOSITION_UNSUPPORTED');
  });
  it('projects the producer unchanged and caps the consumer at min(owner cap, reconciled output)', () => {
    const w = composed();
    expect(projectCompositionProducer(w)).toEqual({ schemaVersion: '1.0.0', workflowId: 'w-composed', revision: 4, nodes: [swap()], resourceEdges: [] });
    expect(compositionCap(w)).toBe('2500000');
    const below = projectCompositionConsumer(w, '2200000'), above = projectCompositionConsumer(w, '9000000');
    expect(readConcentratedLiquidity(below.nodes[0] as never).amount1Max).toBe('2200000');
    expect(below.nodes[0]).toEqual(pool('node-003', '2200000'));
    expect(above.nodes[0]).toEqual(pool());
    expect(readConcentratedLiquidity(above.nodes[0] as never).amount0Max).toBe('50000000');
    for (const amount of ['0', '-1', '1.5', '', 'abc']) expect(() => projectCompositionConsumer(w, amount)).toThrow('COMPOSITION_BOUND_AMOUNT_INVALID');
    expect(unbindCompositionConsumer(w.nodes[1]!)).toEqual(pool());
  });
});

describe('composition capability truth', () => {
  const request = { environment: 'PUBLIC_TESTNET' as const };
  it('presents only a registered bound composition as executable', () => {
    const ok = resolveWorkflowCapability(composed(), request);
    expect(ok.executionSupported).toBe(true);
    expect(ok.blockers.map(b => b.code)).not.toContain('COMPOSITION_UNSUPPORTED');
    const dependencyOnly = resolveWorkflowCapability(composed(swap(), { ...pool(), dependencies: ['node-002'] }, [], []), request);
    expect(dependencyOnly.executionSupported).toBe(false);
    expect(dependencyOnly.blockers).toContainEqual({ nodeId: 'node-003', dimension: 'EXECUTE', code: 'COMPOSITION_UNSUPPORTED' });
    const unconnected = resolveWorkflowCapability({ nodes: [swap(), pool()] }, request);
    expect(unconnected.executionSupported).toBe(false);
    expect(unconnected.blockers.map(b => b.code)).toContain('COMPOSITION_UNSUPPORTED');
  });
  it('leaves isolated Solana steps and their authoring templates unchanged', () => {
    for (const node of [swap(), pool()]) {
      const result = resolveWorkflowCapability({ nodes: [mock('node-001'), node] }, request);
      expect(result.executionSupported).toBe(true);
      expect(result.blockers.map(b => b.code)).not.toContain('COMPOSITION_UNSUPPORTED');
    }
  });
});
