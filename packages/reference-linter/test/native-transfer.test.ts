// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createNativeTransferNode, createTokenTransferNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createBaseSepoliaReviewContext, validateAuthoringWorkflow } from '../src/index.js';

const node = (chain = 'eip155:46630', amount = '1000000000000', id = 'node-002') => createNativeTransferNode(id, { chain, amount, recipient: 'CONNECTED_OWNER' });
const workflow = (...nodes: SemanticWorkflow['nodes']): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'rh', revision: 0, nodes, resourceEdges: [] });
describe('RH-DEMO-001 authoring validation', () => {
  it('accepts one isolated Robinhood Testnet self-transfer', () => {
    expect(validateAuthoringWorkflow(workflow(node()), createBaseSepoliaReviewContext()).nodes).toHaveLength(1);
  });
  it('refuses other networks, oversize values and composition', () => {
    const context = createBaseSepoliaReviewContext();
    expect(() => validateAuthoringWorkflow(workflow(node('eip155:84532')), context)).toThrow('TRANSFER_NETWORK_UNSUPPORTED');
    expect(() => validateAuthoringWorkflow(workflow(node('eip155:137')), context)).toThrow('TRANSFER_NETWORK_UNSUPPORTED');
    expect(() => validateAuthoringWorkflow(workflow(node('eip155:46630', '1000000000000001')), context)).toThrow('TRANSFER_AMOUNT_OUT_OF_RANGE');
    expect(() => validateAuthoringWorkflow(workflow(node(), node(undefined, undefined, 'node-003')), context)).toThrow('TRANSFER_ISOLATED_ONLY');
  });
});
describe('BUILD-RH-002 Robinhood Chain mainnet transfers', () => {
  const context = createBaseSepoliaReviewContext(), recipient = '0x' + '2'.repeat(40);
  const usdg = { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, officialId: null };
  const tsla = { address: '0x322f0929c4625ed5bad873c95208d54e1c003b2d', decimals: 18, officialId: '0x' + '0'.repeat(32) + 'cfece3244ea34bb29414dd9488b32d9f' };
  const token = (t: typeof usdg | typeof tsla, chain = 'eip155:4663', to: string = recipient) => createTokenTransferNode('node-002', { chain, token: t, amount: '1000', recipient: to });
  it('accepts native ETH, USDG and Stock Token transfers to the owner or an explicit recipient', () => {
    for (const n of [node('eip155:4663'), createNativeTransferNode('node-002', { chain: 'eip155:4663', amount: '1', recipient }), token(usdg), token(tsla), token(tsla, undefined, 'CONNECTED_OWNER')])
      expect(validateAuthoringWorkflow(workflow(n), context).nodes).toHaveLength(1);
  });
  it('keeps the testnet profiles native self-transfers only', () => {
    expect(() => validateAuthoringWorkflow(workflow(createNativeTransferNode('node-002', { chain: 'eip155:46630', amount: '1', recipient })), context)).toThrow('TRANSFER_RECIPIENT_UNSUPPORTED');
    expect(() => validateAuthoringWorkflow(workflow(token(usdg, 'eip155:46630', 'CONNECTED_OWNER')), context)).toThrow('TRANSFER_TOKEN_UNSUPPORTED');
  });
  it('refuses a token whose identity is not a pinned base asset or an official id', () => {
    expect(() => validateAuthoringWorkflow(workflow(token({ ...usdg, decimals: 18 })), context)).toThrow('TRANSFER_ASSET_IDENTITY_INVALID');
    expect(() => validateAuthoringWorkflow(workflow(token({ ...tsla, officialId: null })), context)).toThrow('TRANSFER_ASSET_IDENTITY_INVALID');
  });
});
