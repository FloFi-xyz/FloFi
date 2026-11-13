// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ADR-0010 §4: a Relay Solana deposit is not built with Pimlico's Kora fee payer in this build. Where Kora is offered and the owner's SOL cannot
 * pay the deposit, it is refused explicitly (KORA_OPERATION_UNSUPPORTED); without Kora the native refusal is unchanged. MOCKED chains only.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { createUniversalBridgeNode, UNIVERSAL_NETWORKS, type SemanticWorkflow, type UniversalAssetRef } from '@defi-workflow-engine/workflow-contracts';
import { createRelayProvider } from './relay-provider.ts';
import { createUniversalRouterService } from './service.ts';
import { createEvmMockChain, createRelayMock, createSolanaMock, mockedUniversalDeployment, solanaTestWallet } from './universal.test-harness.ts';

const T0 = Date.parse('2026-11-13T12:00:00.000Z');
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const token = (address: string): UniversalAssetRef => ({ kind: 'TOKEN', address, decimals: 6 });
const workflow = (): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'wf-kora-relay', revision: 1, resourceEdges: [], nodes: [createUniversalBridgeNode('node-bridge', {
  slippageBps: 50, providers: ['relay'], selection: 'BEST_MINIMUM_OUTPUT', sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.base.chain,
  inputAsset: token(USDC_SOLANA), outputAsset: token(USDC_BASE), amount: '25000000', recipient: '0x2222222222222222222222222222222222222222' })] }) as SemanticWorkflow;

async function service(koraEnabled: boolean) {
  const D = mockedUniversalDeployment(), now = () => T0;
  const evm = Object.fromEntries(Object.keys(D.evm).map(chain => [chain, createEvmMockChain(D.evm[chain]!, { now, tokens: chain === 'eip155:8453' ? { [USDC_BASE]: 6 } : {} })]));
  const solana = createSolanaMock(D.solana, { mints: { [USDC_SOLANA]: 6 } });
  const relay = createRelayMock({ now, decimals: () => 6, rate: () => 10n ** 18n, symbol: () => 'USDC' });
  const wallet = solanaTestWallet();
  // The owner holds USDC but no SOL at all (its System account does not exist).
  solana.setToken(wallet.publicKey, USDC_SOLANA, 500_000_000n);
  const s = createUniversalRouterService({ storage: createFileExecutionStorage(await mkdtemp(join(tmpdir(), 'flofi-universal-kora-')), 'UNIVERSAL_BUSY'),
    evmRpcs: Object.fromEntries(Object.entries(evm).map(([c, m]) => [c, m.rpc])), solanaRpc: solana.rpc, providers: { relay: createRelayProvider({ http: relay.http }) },
    provenance: 'MOCKED', executionEnabled: true, now: () => new Date(T0), mockedDeployment: D, koraEnabled });
  return { s, wallet };
}

describe('Relay Solana deposit and Pimlico Kora', () => {
  it('refuses explicitly where Kora is offered: this step cannot pay its network fee in a token', async () => {
    const { s, wallet } = await service(true);
    await expect(s.simulate(workflow(), wallet.publicKey)).rejects.toThrow('KORA_OPERATION_UNSUPPORTED');
  });
  it('keeps the native refusal unchanged where Kora is not offered', async () => {
    const { s, wallet } = await service(false);
    await expect(s.simulate(workflow(), wallet.publicKey)).rejects.toThrow(/^UNIVERSAL_(OWNER_NOT_WALLET|INSUFFICIENT_SOL_FOR_FEES)$/);
  });
});
