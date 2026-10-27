// SPDX-License-Identifier: AGPL-3.0-only
/** Opt-in PUBLIC MAINNET READS. No wallet, signature, database, authorization, simulation or send port. */
import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createUniversalBridgeNode, UNIVERSAL_NETWORKS, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createUniversalDiscovery } from './universal-router/discovery';
import { createUniversalHttp } from './universal-router/http';
import { parseDiscoveryRequest } from './universal-router/requests';
import { readBuildEstimate } from './build-estimate';
import { estimateMatchesNode } from '../domain/build-estimate';

const enabled = process.env.FLOFI_BRIDGE_QUOTE_LIVE === 'READ_ONLY';
const rows: unknown[] = [];
const keys = Object.keys(UNIVERSAL_NETWORKS) as (keyof typeof UNIVERSAL_NETWORKS)[];
const stable = { base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'arbitrum-one': '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', robinhood: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };
const discovery = createUniversalDiscovery({ http: createUniversalHttp() });
describe.skipIf(!enabled)('PUBLIC_READ_ONLY Bridge estimate: 20 directions × four actual stable/native combinations', () => {
  afterAll(() => {
    if (process.env.FLOFI_BRIDGE_QUOTE_REPORT) writeFileSync(process.env.FLOFI_BRIDGE_QUOTE_REPORT, JSON.stringify({
      format: 'flofi.bridge-build-estimate-observation.v1', generatedAt: new Date().toISOString(), evidence: 'PUBLIC_READ_ONLY',
      certification: 'NOT_FINANCIALLY_CERTIFIED', hosted: false, rows }, null, 2) + '\n');
  });
  for (const source of keys) for (const destination of keys.filter(k => k !== source)) for (const inputNative of [false, true]) for (const outputNative of [false, true])
    it(`${source} → ${destination}, ${inputNative ? 'native' : 'stable'} → ${outputNative ? 'native' : 'stable'}`, async () => {
      const src = UNIVERSAL_NETWORKS[source], dst = UNIVERSAL_NETWORKS[destination];
      const amount = inputNative ? source === 'solana' ? '150000000' : '10000000000000000' : '25000000';
      const node = createUniversalBridgeNode('bridge', { sourceChain: src.chain, destinationChain: dst.chain,
        inputAsset: inputNative ? { kind: 'NATIVE', decimals: src.native.decimals } : { kind: 'TOKEN', address: stable[source], decimals: 6 },
        outputAsset: outputNative ? { kind: 'NATIVE', decimals: dst.native.decimals } : { kind: 'TOKEN', address: stable[destination], decimals: 6 },
        amount, slippageBps: 100, providers: ['relay', 'lifi', 'mayan', 'across'], selection: 'BEST_MINIMUM_OUTPUT',
        recipient: src.ecosystem === dst.ecosystem ? 'CONNECTED_OWNER' : 'CONNECTED_DESTINATION_WALLET' });
      const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'public-read-only-probe', revision: 1, nodes: [node], resourceEdges: [] };
      const result = await readBuildEstimate({ workflow, nodeId: node.nodeId }, {}, { prices: null, discover: async input => {
        const r = parseDiscoveryRequest(input); return { ok: true, value: await discovery.discover(r, r.providers) };
      } });
      rows.push({ source, destination, inputNative, outputNative, amount, slippageBps: 100, result,
        simulation: 'NOT_RUN', review: 'NOT_AUTHORIZED', execution: 'NOT_RUN' });
      if (result.ok) expect(estimateMatchesNode(result.estimate, workflow, node.nodeId)).toBe(true);
      else expect(result.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      await new Promise(resolve => setTimeout(resolve, 300));
    }, 60_000);
});
