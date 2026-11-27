// SPDX-License-Identifier: Apache-2.0
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02): the Solana mainnet Batch Payment capability row and its registry profile. The
 * EVM Batch Payment rows are unchanged; Solana Devnet has no batch row; only the verified transfer assets (SOL, USDC, USDT) are batch assets.
 */
import { describe, expect, it } from 'vitest';
import { createBatchPaymentNode, createSolanaBatchPaymentNode, type SolanaBatchPaymentFields } from '@defi-workflow-engine/workflow-contracts';
import { executionCapabilityRegistry, resolveNodeCapability, resolveWorkflowCapability } from '../src/execution-capabilities.js';
import { SOLANA_BATCH_PAYMENT, solanaBatchPaymentAsset, solanaBatchPaymentComputeCap } from '../src/solana-batch-payment.js';
import { SOLANA_DEVNET_TRANSFER, SOLANA_MAINNET_TRANSFER } from '../src/solana-transfer.js';
import { SOLANA_MAINNET_TOKENS } from '../src/jupiter-solana.js';

const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const R1 = '7cVfgArCheMR6Cs4t6vz5rfnqd56vZq4ndaBrY5xkxXy', R2 = 'GdnSyH3YtwcxFvQrVVJMm1JhTS4QVX7MFsX56uJLUfiZ';
const fields = (chain = MAINNET): SolanaBatchPaymentFields => ({ chain, asset: { kind: 'SPL_TOKEN', mint: SOLANA_MAINNET_TOKENS.USDC.mint, decimals: 6, program: 'spl-token' },
  payments: [{ recipient: R1, amount: '1000000' }, { recipient: R2, amount: '2000000' }] });

describe('KAN-20 Solana Batch Payment capability', () => {
  it('has exactly one MAINNET row on Solana mainnet-beta, owner wallet only, with no evidence ceiling', () => {
    const rows = executionCapabilityRegistry.filter(row => row.actionType === 'asset.transfer.batch' && row.adapterId === 'solana.batch-payment');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chainId: MAINNET, environment: 'MAINNET', adapterVersion: '1.0.0', executionKind: 'DIRECT_TRANSACTION', evidenceMaturity: null,
      requirements: ['INJECTED_WALLET', 'QUOTE_PROVIDER', 'REVIEWED_ARTIFACTS'], authorizationModes: ['A'] });
    expect(Object.values(rows[0]!.capabilities).every(Boolean)).toBe(true);
    // The EVM rows keep their four mainnets and their adapter.
    expect(executionCapabilityRegistry.filter(row => row.actionType === 'asset.transfer.batch' && row.adapterId === 'evm.batch-payment').map(row => row.chainId))
      .toEqual(['eip155:4663', 'eip155:8453', 'eip155:42161', 'eip155:1']);
  });

  it('resolves the Solana mainnet batch node and refuses Devnet', () => {
    const node = createSolanaBatchPaymentNode('node-002', fields());
    const resolved = resolveNodeCapability(node, { environment: 'MAINNET' });
    expect(resolved).toMatchObject({ adapterId: 'solana.batch-payment', blockers: [], evidenceCeiling: null });
    expect(resolved.profile?.chainId).toBe(MAINNET);
    const workflow = resolveWorkflowCapability({ nodes: [node] }, { environment: 'MAINNET', runtime: { walletConnected: true, walletChainId: MAINNET, artifacts: 'CURRENT' } });
    expect(workflow).toMatchObject({ executionSupported: true, executionReady: true, blockers: [] });
    // Devnet: the node is authorable as a shape, but no capability row exists for it.
    const devnet = createSolanaBatchPaymentNode('node-002', fields(DEVNET));
    expect(resolveNodeCapability(devnet, { environment: 'PUBLIC_TESTNET' }).blockers[0]?.code).toBe('CHAIN_NOT_SUPPORTED');
    expect(resolveNodeCapability(devnet, { environment: 'MAINNET' }).blockers[0]?.code).toBe('CHAIN_NOT_SUPPORTED');
    // The EVM batch node resolves through its own adapter, unchanged.
    const evm = createBatchPaymentNode('node-002', { chain: 'eip155:8453', asset: { kind: 'NATIVE' }, payments: [{ recipient: '0x' + 'a'.repeat(40), amount: '1' },
      { recipient: '0x' + 'b'.repeat(40), amount: '1' }] });
    expect(resolveNodeCapability(evm, { environment: 'MAINNET' }).adapterId).toBe('evm.batch-payment');
  });

  it('scales the compute probe ceiling with the payments, never above the runtime maximum', () => {
    expect(SOLANA_BATCH_PAYMENT).toMatchObject({ adapterId: 'solana.batch-payment', chain: MAINNET, minimumRecipients: 2, maximumRecipients: 8, maximumTransactionComputeUnits: 1_400_000,
      perPaymentComputeUnits: 200_000, maximumTransactionBytes: 1_232, walletGuardReserveBytes: 96, maximumAccounts: 64, maximumInstructionTrace: 64,
      walletGuardInstructionReserve: 8, reviewTtlSeconds: 50 });
    expect(Object.isFrozen(SOLANA_BATCH_PAYMENT)).toBe(true);
    expect([2, 3, 4, 5, 6, 7, 8].map(solanaBatchPaymentComputeCap)).toEqual([400_000, 600_000, 800_000, 1_000_000, 1_200_000, 1_400_000, 1_400_000]);
  });

  it('advertises only the verified mainnet transfer assets: SOL, USDC, USDT; never a Devnet or other mint', () => {
    expect(solanaBatchPaymentAsset(null)).toMatchObject({ symbol: 'SOL', decimals: 9, program: 'native' });
    expect(solanaBatchPaymentAsset(SOLANA_MAINNET_TOKENS.USDC.mint)).toMatchObject({ symbol: 'USDC', decimals: 6, program: 'spl-token' });
    expect(solanaBatchPaymentAsset(SOLANA_MAINNET_TOKENS.USDT.mint)).toMatchObject({ symbol: 'USDT', decimals: 6, program: 'spl-token' });
    expect(SOLANA_MAINNET_TRANSFER.assets.map(a => solanaBatchPaymentAsset(a.mint)?.symbol)).toEqual(['SOL', 'USDC', 'USDT']);
    for (const asset of SOLANA_DEVNET_TRANSFER.assets.filter(a => a.mint)) expect(solanaBatchPaymentAsset(asset.mint)).toBeNull();
    expect(solanaBatchPaymentAsset('So11111111111111111111111111111111111111112')).toBeNull();
    expect(solanaBatchPaymentAsset(SOLANA_MAINNET_TOKENS.USDC.mint.toLowerCase())).toBeNull();
  });
});
