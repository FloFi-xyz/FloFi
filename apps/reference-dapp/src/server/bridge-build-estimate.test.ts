// SPDX-License-Identifier: AGPL-3.0-only
/** MOCKED discovery seams. These prove binding and refusal presentation, never public liquidity or execution. */
import { describe, expect, it, vi } from 'vitest';
import { createUniversalBridgeNode, hashArtifactBytes, UNIVERSAL_NETWORKS, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { readBuildEstimate } from './build-estimate';
import { parseDiscoveryRequest } from './universal-router/requests';
import type { DiscoveryResult, DiscoveryStatus } from './universal-router/discovery';
import { bridgeEstimateRequest } from '../domain/bridge-estimate';
import { estimateMatchesNode } from '../domain/build-estimate';
import { universalBridgeOfWorkflow } from '../domain/universal-bridge-authoring';
import { createRouterNode } from '../domain/router-authoring';

const now = () => new Date('2026-10-27T01:00:00Z');
const keys = Object.keys(UNIVERSAL_NETWORKS) as (keyof typeof UNIVERSAL_NETWORKS)[];
const token = (key: typeof keys[number]) => ({ kind: 'TOKEN' as const, address: key === 'solana' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : '0x' + '12'.repeat(20), decimals: 6 });
export function mockedBridge(source: typeof keys[number], destination: typeof source, inputNative = false, outputNative = false): SemanticWorkflow {
  const node = createUniversalBridgeNode('bridge', { sourceChain: UNIVERSAL_NETWORKS[source].chain, destinationChain: UNIVERSAL_NETWORKS[destination].chain,
    inputAsset: inputNative ? { kind: 'NATIVE', decimals: UNIVERSAL_NETWORKS[source].native.decimals } : token(source),
    outputAsset: outputNative ? { kind: 'NATIVE', decimals: UNIVERSAL_NETWORKS[destination].native.decimals } : token(destination),
    amount: '1000000', slippageBps: 100, providers: ['relay', 'lifi', 'mayan', 'across'], selection: 'BEST_MINIMUM_OUTPUT',
    recipient: UNIVERSAL_NETWORKS[source].ecosystem === UNIVERSAL_NETWORKS[destination].ecosystem ? 'CONNECTED_OWNER' : 'CONNECTED_DESTINATION_WALLET' });
  return { schemaVersion: '1.0.0', workflowId: 'composition-test', revision: 7, nodes: [node], resourceEdges: [] };
}
function discovery(workflow: SemanticWorkflow, status: DiscoveryStatus = 'LIVE_QUOTE'): DiscoveryResult {
  const r = parseDiscoveryRequest(bridgeEstimateRequest(workflow.nodes[0]!)!);
  return { format: 'flofi.universal-discovery.v1', sourceChain: r.source.chain, destinationChain: r.destination.chain,
    inputToken: r.inputToken, outputToken: r.outputToken, amount: r.amount, observedAt: now().toISOString(), quoteSubjects: 'PUBLIC_QUOTE_SUBJECT', recommended: null, status,
    candidates: r.providers.map(provider => ({ provider, bridge: provider, status, executableBy: null, expectedOutput: status === 'LIVE_QUOTE' ? '1234567' : null,
      minimumOutput: status === 'LIVE_QUOTE' ? '1222222' : null, estimatedDurationSeconds: 30, fees: [], reason: status === 'LIVE_QUOTE' ? 'TRANSACTION_BUILDER_NOT_VERIFIED' : status, quoteId: null })) };
}
describe('shared Bridge Build estimate (MOCKED)', () => {
  for (const source of keys) for (const destination of keys.filter(k => k !== source)) for (const inputNative of [false, true]) for (const outputNative of [false, true])
    it(`${source} → ${destination}, ${inputNative ? 'native' : 'token'} → ${outputNative ? 'native' : 'token'}: actual IR, exact units, quote-only`, async () => {
      const workflow = mockedBridge(source, destination, inputNative, outputNative), original = JSON.stringify(workflow);
      const discover = vi.fn(async () => ({ ok: true as const, value: discovery(workflow) }));
      const result = await readBuildEstimate({ workflow, nodeId: 'bridge' }, {}, { discover, now });
      expect(result).toMatchObject({ ok: true, estimate: { slippageBps: 100, bridge: { execution: 'QUOTE_ONLY' } } });
      if (!result.ok) throw Error('QUOTE_EXPECTED');
      expect(estimateMatchesNode(result.estimate, workflow, 'bridge')).toBe(true);
      expect(result.estimate.workflowHash).toBe(hashArtifactBytes('semantic-workflow', new TextEncoder().encode(original)));
      expect(discover.mock.calls).toHaveLength(1); expect(JSON.stringify(workflow)).toBe(original);
      expect(result).not.toHaveProperty('review'); expect(result).not.toHaveProperty('transaction');
    });
  it.each(['BELOW_MINIMUM', 'INSUFFICIENT_LIQUIDITY', 'TEMPORARILY_UNAVAILABLE', 'NO_ROUTE', 'INTERNAL_ERROR'] as const)('preserves %s without inventing output', async status => {
    const workflow = mockedBridge('base', 'solana');
    const result = await readBuildEstimate({ workflow, nodeId: 'bridge' }, {}, { now, discover: async () => ({ ok: true, value: discovery(workflow, status) }) });
    expect(result).toMatchObject({ ok: false, code: `BRIDGE_${status}`, discovery: { status } }); expect(result).not.toHaveProperty('estimate');
  });
  it('selects a bridge by nodeId inside a composition, binds all dependencies and refuses ambiguity', async () => {
    const first = mockedBridge('base', 'solana'), second = mockedBridge('solana', 'base').nodes[0]!;
    const workflow: SemanticWorkflow = { ...first, nodes: [first.nodes[0]!, { ...second, nodeId: 'other', dependencies: ['bridge'] }] };
    expect(universalBridgeOfWorkflow(workflow)).toBeNull(); expect(universalBridgeOfWorkflow(workflow, 'other')?.source).toBe('solana');
    const result = await readBuildEstimate({ workflow, nodeId: 'other' }, {}, { now, discover: async () => ({ ok: true, value: discovery({ ...workflow, nodes: [workflow.nodes[1]!] }) }) });
    expect(result).toMatchObject({ ok: true, estimate: { nodeId: 'other' } }); expect(workflow.nodes[1]!.dependencies).toEqual(['bridge']);
    if (result.ok) expect(result.estimate.workflowHash).toBe(hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow))));
  });
  it.each(['amount', 'destinationChain', 'inputToken', 'outputToken', 'observedAt'] as const)('rejects mismatched backend %s even on HTTP 200', async field => {
    const workflow = mockedBridge('base', 'solana'), value = discovery(workflow);
    const bad = { ...value, [field]: field.endsWith('Token') ? { ...value.inputToken, decimals: 7 } : 'wrong' };
    expect(await readBuildEstimate({ workflow, nodeId: 'bridge' }, {}, { now, discover: async () => ({ ok: true, value: bad }) }))
      .toMatchObject({ ok: false, code: 'ESTIMATE_RESPONSE_MISMATCH' });
  });
});

/**
 * P0 (owner test 2026-11-12, Arbitrum One USDC → Base USDC, 2 USDC): a certified Router Bridge card is executable (simulation and Review still
 * required) only for the Across routes its own flow builds and verifies, and only when that pair's Router flow allows owner execution here.
 * MOCKED discovery and capability seams: no provider, chain or wallet is contacted.
 */
describe('certified Router Bridge estimate executability (MOCKED)', () => {
  const routerWorkflow = (): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'router-p0', revision: 1, resourceEdges: [],
    nodes: [createRouterNode('bridge', { source: 'Arbitrum', destination: 'Base', token: 'USDC', amount: '2', recipient: '', slippage: '50', routing: 'AUTO' })] });
  const quoted = (workflow: SemanticWorkflow, routes: readonly { provider: 'lifi' | 'across'; bridge: string; minimum: string }[]): DiscoveryResult => {
    const r = parseDiscoveryRequest(bridgeEstimateRequest(workflow.nodes[0]!)!);
    expect(r.providers).toEqual(['lifi', 'across']);
    return { format: 'flofi.universal-discovery.v1', sourceChain: r.source.chain, destinationChain: r.destination.chain, inputToken: r.inputToken, outputToken: r.outputToken,
      amount: r.amount, observedAt: now().toISOString(), quoteSubjects: 'PUBLIC_QUOTE_SUBJECT', recommended: null, status: 'LIVE_QUOTE',
      candidates: routes.map(route => ({ provider: route.provider, bridge: route.bridge, status: 'LIVE_QUOTE' as const, executableBy: null, expectedOutput: '1996276', minimumOutput: route.minimum,
        estimatedDurationSeconds: 4, fees: [], quoteId: null,
        reason: route.provider === 'across' ? 'ACROSS_REQUIRES_CERTIFIED_ROUTER_VALIDATION' : route.bridge === 'across' ? 'LIFI_REQUIRES_CERTIFIED_ROUTER_VALIDATION' : 'LIFI_BRIDGE_VERIFIER_NOT_IMPLEMENTED' })) };
  };
  const routes = [{ provider: 'lifi' as const, bridge: 'stargateV2', minimum: '1990000' }, { provider: 'lifi' as const, bridge: 'across', minimum: '1980000' },
    { provider: 'across' as const, bridge: 'across', minimum: '1985000' }];

  it('is executable through the Router flow when it allows owner execution, choosing only a Router-verified Across route', async () => {
    const workflow = routerWorkflow(), routerExecution = vi.fn(async () => true);
    const result = await readBuildEstimate({ workflow, nodeId: 'bridge' }, {}, { now, routerExecution, discover: async () => ({ ok: true, value: quoted(workflow, routes) }) });
    expect(routerExecution).toHaveBeenCalledWith('arbitrum-to-base');
    // AUTO asks LI.FI first, Across direct only as its fallback: the card shows the route the Router's Simulate asks first.
    expect(result).toMatchObject({ ok: true, estimate: { provider: 'lifi', expected: '1.996276', minimum: '1.98', bridge: { execution: 'SIMULATION_AND_REVIEW_REQUIRED', selected: 1 } } });
    // The browser's own economic check accepts it (the card shows the amount), only for this Router node's Across route.
    expect(result.ok && estimateMatchesNode(result.estimate, workflow, 'bridge')).toBe(true);
  });
  it('follows the node\'s own routing: Across direct only selects the Across answer', async () => {
    const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'router-p0', revision: 1, resourceEdges: [],
      nodes: [createRouterNode('bridge', { source: 'Arbitrum', destination: 'Base', token: 'USDC', amount: '2', recipient: '', slippage: '50', routing: 'ACROSS' })] };
    const r = parseDiscoveryRequest(bridgeEstimateRequest(workflow.nodes[0]!)!);
    const value = { ...quoted(routerWorkflow(), routes), candidates: quoted(routerWorkflow(), routes).candidates.filter(c => c.provider === 'across') };
    expect(r.providers).toEqual(['across']);
    const result = await readBuildEstimate({ workflow, nodeId: 'bridge' }, {}, { now, routerExecution: async () => true, discover: async () => ({ ok: true, value }) });
    expect(result).toMatchObject({ ok: true, estimate: { provider: 'across', minimum: '1.985', bridge: { execution: 'SIMULATION_AND_REVIEW_REQUIRED', selected: 0 } } });
    expect(result.ok && estimateMatchesNode(result.estimate, workflow, 'bridge')).toBe(true);
  });
  it('the browser refuses an executable label on a quote-only route or on a universal card (a forged or stale estimate shows no amount)', async () => {
    const workflow = routerWorkflow();
    const result = await readBuildEstimate({ workflow, nodeId: 'bridge' }, {}, { now, routerExecution: async () => true, discover: async () => ({ ok: true, value: quoted(workflow, routes) }) });
    if (!result.ok || !result.estimate.bridge) throw new Error('expected an estimate');
    const stargate = { ...result.estimate, provider: 'lifi', bridge: { ...result.estimate.bridge, selected: 0 }, minimum: '1.99' };
    expect(estimateMatchesNode(stargate, workflow, 'bridge')).toBe(false);
    const universal = mockedBridge('arbitrum-one', 'base');
    const quotedUniversal = await readBuildEstimate({ workflow: universal, nodeId: 'bridge' }, {}, { now, discover: async () => ({ ok: true, value: discovery(universal) }) });
    if (!quotedUniversal.ok || !quotedUniversal.estimate.bridge) throw new Error('expected an estimate');
    const relabelled = { ...quotedUniversal.estimate, bridge: { ...quotedUniversal.estimate.bridge, execution: 'SIMULATION_AND_REVIEW_REQUIRED' as const } };
    expect(estimateMatchesNode(quotedUniversal.estimate, universal, 'bridge')).toBe(true);
    expect(estimateMatchesNode(relabelled, universal, 'bridge')).toBe(false);
  });
  it('stays quote-only when the Router flow does not allow owner execution on this deployment (fails closed)', async () => {
    for (const answer of [async () => false, async () => { throw new Error('ROUTER_INFO_UNAVAILABLE'); }]) {
      const workflow = routerWorkflow();
      const result = await readBuildEstimate({ workflow, nodeId: 'bridge' }, {}, { now, routerExecution: answer, discover: async () => ({ ok: true, value: quoted(workflow, routes) }) });
      expect(result).toMatchObject({ ok: true, estimate: { bridge: { execution: 'QUOTE_ONLY' } } });
    }
  });
  it('never labels a non-Across LI.FI tool executable, and never asks the Router when no Across route was quoted', async () => {
    const workflow = routerWorkflow(), routerExecution = vi.fn(async () => true);
    const result = await readBuildEstimate({ workflow, nodeId: 'bridge' }, {}, { now, routerExecution,
      discover: async () => ({ ok: true, value: quoted(workflow, [{ provider: 'lifi', bridge: 'stargateV2', minimum: '1990000' }]) }) });
    expect(result).toMatchObject({ ok: true, estimate: { provider: 'lifi', bridge: { execution: 'QUOTE_ONLY' } } });
    expect(routerExecution).not.toHaveBeenCalled();
  });
  it('never applies to a universal bridge card: its Across answer stays quote-only even where the Router could execute the pair', async () => {
    const workflow = mockedBridge('arbitrum-one', 'base'), routerExecution = vi.fn(async () => true);
    const value = discovery(workflow);
    const result = await readBuildEstimate({ workflow, nodeId: 'bridge' }, {}, { now, routerExecution,
      discover: async () => ({ ok: true, value: { ...value, candidates: value.candidates.map(c => ({ ...c, bridge: c.provider })) } }) });
    expect(result).toMatchObject({ ok: true, estimate: { bridge: { execution: 'QUOTE_ONLY' } } });
    expect(routerExecution).not.toHaveBeenCalled();
  });
});
