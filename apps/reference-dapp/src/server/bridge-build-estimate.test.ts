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
