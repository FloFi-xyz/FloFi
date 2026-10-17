// SPDX-License-Identifier: AGPL-3.0-only
/** Six verified route profiles on the shared MOCKED Router; no network, public signing or execution. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ETHEREUM_ROUTER_DEPLOYMENTS } from '@defi-workflow-engine/action-registry';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { createRouterBridgeNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createRouterHarness } from '../../e2e/router-harness';
import { createTestWallet } from '../../../../packages/reference-reconciler/test/test-wallet';
import { assertSafeOutput, projectSimulation } from '../mcp/simulation';
import { createRouterService } from './router-service';
import { routerNetworkMode, routerNetworkRuntime } from './router-runtime';

describe('Ethereum paths on the existing Cross-chain Router', () => {
  it.each(Object.entries(ETHEREUM_ROUTER_DEPLOYMENTS))('%s simulates, approves, deposits, fills and independently reconciles after restart', async (key, profile) => {
    const path = await mkdtemp(join(tmpdir(), 'flofi-ethereum-router-'));
    try {
      const owner = createTestWallet().address, h = createRouterHarness({ profile, owner });
      const restart = () => createRouterService({ storage: createFileExecutionStorage(path, 'ROUTER_BUSY'), sourceRpc: h.baseRpc, destinationRpc: h.arbitrumRpc,
        providers: h.providers, provenance: 'MOCKED', executionEnabled: true, now: h.clock, mockedCodePins: h.codePins, profile });
      const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'ethereum-route', revision: 0, resourceEdges: [], nodes: [createRouterBridgeNode('bridge', {
        sourceChain: profile.source.chain, destinationChain: profile.destination.chain, inputToken: profile.source.token, outputToken: profile.destination.token,
        amount: '10000000', recipient: 'CONNECTED_OWNER', slippageBps: 50, providers: ['across'] })] };
      const s = restart(), run = await s.simulate(workflow, owner);
      const preview = projectSimulation(`crosschain-router-${key as keyof typeof ETHEREUM_ROUTER_DEPLOYMENTS}`, run);
      expect(preview).toMatchObject({ kind: 'CROSS_CHAIN_ROUTE', provenance: 'MOCKED', facts: { quote: { inputToken: { chainId: profile.source.chain } } } });
      assertSafeOutput(preview);
      await s.review(run.id, run.review.commitment, workflow);
      let current = run;
      for (let step = 0; step < 2; step++) {
        const begun = await s.begin(run.id, owner, workflow);
        expect(begun.transaction.chainId).toBe(profile.source.chainHex);
        await s.handoff(run.id); await s.report(run.id, { kind: 'HASH', hash: h.wallet.send(begun.transaction) });
        for (let round = 0; round < 20; round++) {
          h.advance(5); current = await restart().observe(run.id);
          if (current.attempts.at(-1)?.step === 'APPROVAL' && current.attempts.at(-1)?.state === 'CONFIRMED' || current.phase === 'RECONCILED') break;
        }
        if (current.phase === 'RECONCILED') break;
      }
      expect(current.phase).toBe('RECONCILED');
      expect(current.evidence?.bundle.environment).toBe('MOCKED');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('requires Ethereum and Router deployment opt-ins, independently from all testnet and other-network gates', () => {
    for (const key of Object.keys(ETHEREUM_ROUTER_DEPLOYMENTS) as (keyof typeof ETHEREUM_ROUTER_DEPLOYMENTS)[]) {
      expect(routerNetworkMode(key, {})).toBe('off');
      expect(routerNetworkMode(key, { GRYLOO_ROUTER: 'live' })).toBe('off');
      expect(routerNetworkMode(key, { GRYLOO_ETHEREUM_MAINNET: 'live' })).toBe('off');
      const env = { GRYLOO_ROUTER: 'live', GRYLOO_ETHEREUM_MAINNET: 'live' };
      expect(routerNetworkMode(key, env)).toBe('live');
      expect(routerNetworkRuntime(key, 'live', env).executionEnabled).toBe(false);
      expect(routerNetworkRuntime(key, 'live', { ...env, GRYLOO_ETHEREUM_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED', GRYLOO_ROUTER_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' }).executionEnabled).toBe(true);
    }
  });
});
