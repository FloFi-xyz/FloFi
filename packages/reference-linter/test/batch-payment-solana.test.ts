// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02): authoring validation of the Solana mainnet Batch Payment, dispatched beside the
 * unchanged EVM validator. Mainnet only; SOL, USDC, USDT with their exact registry identity; one isolated node.
 */
import { describe, expect, it } from 'vitest';
import { createBatchPaymentNode, createSolanaBatchPaymentNode, type SemanticWorkflow, type SolanaBatchPaymentFields } from '@defi-workflow-engine/workflow-contracts';
import { SOLANA_DEVNET_TOKENS, SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext, validateAuthoringWorkflow, validateBatchPaymentWorkflow, validateSolanaBatchPaymentWorkflow } from '../src/index.js';

const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const R1 = '7cVfgArCheMR6Cs4t6vz5rfnqd56vZq4ndaBrY5xkxXy', R2 = 'GdnSyH3YtwcxFvQrVVJMm1JhTS4QVX7MFsX56uJLUfiZ', R3 = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const payments = [{ recipient: R1, amount: '1000000' }, { recipient: R2, amount: '2000000' }, { recipient: R3, amount: '3000000' }];
const spl = (mint: string, decimals = 6, program: 'spl-token' | 'token-2022' = 'spl-token', chain = MAINNET): SolanaBatchPaymentFields =>
  ({ chain, asset: { kind: 'SPL_TOKEN', mint, decimals, program }, payments });
const sol = (chain = MAINNET): SolanaBatchPaymentFields => ({ chain, asset: { kind: 'NATIVE' }, payments });
const workflow = (...nodes: SemanticWorkflow['nodes']): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'batch', revision: 1, nodes, resourceEdges: [] });
const node = (fields: SolanaBatchPaymentFields, id = 'node-002') => createSolanaBatchPaymentNode(id, fields);
const context = createBaseSepoliaReviewContext();

describe('KAN-20 Solana Batch Payment authoring validation', () => {
  it('accepts SOL, USDC and USDT on Solana mainnet-beta through the authoring entry point', () => {
    for (const fields of [sol(), spl(SOLANA_MAINNET_TOKENS.USDC.mint), spl(SOLANA_MAINNET_TOKENS.USDT.mint)]) {
      expect(validateAuthoringWorkflow(workflow(node(fields)), context).nodes).toHaveLength(1);
      expect(validateSolanaBatchPaymentWorkflow(workflow(node(fields)))).toEqual(fields);
    }
  });

  it('refuses Devnet, an unknown or Token-2022 mint, and a registry token with another identity', () => {
    expect(() => validateAuthoringWorkflow(workflow(node(sol(DEVNET))), context)).toThrow('BATCH_PAYMENT_NETWORK_UNSUPPORTED');
    expect(() => validateAuthoringWorkflow(workflow(node(spl(SOLANA_DEVNET_TOKENS.devUSDC.mint, SOLANA_DEVNET_TOKENS.devUSDC.decimals, 'spl-token', DEVNET))), context))
      .toThrow('BATCH_PAYMENT_NETWORK_UNSUPPORTED');
    // A Devnet mint on mainnet and well-formed but unlisted mints (classic or Token-2022) are never advertised batch assets.
    for (const mint of [SOLANA_DEVNET_TOKENS.devUSDC.mint, '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T'])
      for (const program of ['spl-token', 'token-2022'] as const)
        expect(() => validateAuthoringWorkflow(workflow(node(spl(mint, 6, program))), context), mint + program).toThrow('BATCH_PAYMENT_ASSET_UNSUPPORTED');
    expect(() => validateAuthoringWorkflow(workflow(node(spl(SOLANA_MAINNET_TOKENS.USDC.mint, 9))), context)).toThrow('BATCH_PAYMENT_ASSET_IDENTITY_INVALID');
    expect(() => validateAuthoringWorkflow(workflow(node(spl(SOLANA_MAINNET_TOKENS.USDT.mint, 6, 'token-2022'))), context)).toThrow('BATCH_PAYMENT_ASSET_IDENTITY_INVALID');
  });

  it('keeps the batch isolated: a second financial node, an edge or a dependent refuses it', () => {
    const a = node(sol()), b = node(sol(), 'node-003');
    expect(() => validateAuthoringWorkflow(workflow(a, b), context)).toThrow('BATCH_PAYMENT_ISOLATED_ONLY');
    expect(() => validateSolanaBatchPaymentWorkflow({ ...workflow(a), resourceEdges: [{ edgeId: 'e', fromNodeId: 'node-002', fromOutputId: 'x', toNodeId: 'node-009', toInputName: 'y' } as never] }))
      .toThrow('BATCH_PAYMENT_ISOLATED_ONLY');
    expect(() => validateSolanaBatchPaymentWorkflow(workflow(a, { ...b, actionType: 'asset.transfer' }))).toThrow('BATCH_PAYMENT_ISOLATED_ONLY');
  });

  it('dispatches the EVM batch to its unchanged validator and never mixes the families', () => {
    const evm = createBatchPaymentNode('node-002', { chain: 'eip155:8453', asset: { kind: 'TOKEN', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, officialId: null },
      payments: [{ recipient: '0x' + 'a'.repeat(40), amount: '1' }, { recipient: '0x' + 'b'.repeat(40), amount: '2' }] });
    expect(validateAuthoringWorkflow(workflow(evm), context).nodes).toEqual([evm]);
    expect(validateBatchPaymentWorkflow(workflow(evm)).chain).toBe('eip155:8453');
    expect(() => validateAuthoringWorkflow(workflow({ ...evm, chainId: 'eip155:84532' }), context)).toThrow(/^BATCH_PAYMENT_/);
    // The EVM validator never accepts a Solana node, and the Solana validator never accepts an EVM node.
    expect(() => validateBatchPaymentWorkflow(workflow(node(sol())))).toThrow(/^BATCH_PAYMENT_/);
    expect(() => validateSolanaBatchPaymentWorkflow(workflow(evm))).toThrow('BATCH_PAYMENT_DECLARATION_INVALID');
    // An EVM adapter on a Solana node goes to the EVM validator and fails closed.
    const swapped = { ...node(sol()), requiredCapabilities: ['evm.batch-payment'], adapterConstraints: { adapters: [{ id: 'evm.batch-payment', version: '1.0.0' }], protocols: ['native'] } };
    expect(() => validateAuthoringWorkflow(workflow(swapped), context)).toThrow(/^BATCH_PAYMENT_/);
  });
});
