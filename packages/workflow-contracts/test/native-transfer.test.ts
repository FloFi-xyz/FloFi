// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createNativeTransferNode, createTokenTransferNode, readNativeTransferNode, readTokenTransferNode, readTransferNode, TRANSFER_ACTION } from '../src/native-transfer.js';
import { validateArtifact } from '../src/schemas.js';

const fields = { chain: 'eip155:46630', amount: '1000000000000', recipient: 'CONNECTED_OWNER' as const };
describe('RH-DEMO-001 chain-neutral native transfer node', () => {
  it('binds the connected owner as session state, never an address', () => {
    const node = createNativeTransferNode('node-002', fields);
    expect(node).toMatchObject({ actionType: TRANSFER_ACTION, chainId: 'eip155:46630', requiredAuthorizationClass: 'MODE_A',
      adapterConstraints: { adapters: [{ id: 'evm.native-transfer', version: '1.0.0' }], protocols: ['native'] } });
    expect(JSON.stringify(node)).not.toMatch(/0x[0-9a-f]{40}/i);
    expect(readNativeTransferNode(node)).toEqual(fields);
    expect(() => validateArtifact('semantic-workflow', { schemaVersion: '1.0.0', workflowId: 'w', revision: 0, nodes: [node], resourceEdges: [] })).not.toThrow();
  });
  it('rejects malformed fields and any extra or altered declaration', () => {
    // BUILD-RH-002: an explicit lower-case recipient is a valid declaration (the profile decides whether it is allowed).
    for (const bad of [{ ...fields, amount: '0' }, { ...fields, amount: '01' }, { ...fields, chain: 'solana:x' }, { ...fields, recipient: '0x' + '0'.repeat(40) },
      { ...fields, recipient: '0x' + 'A'.repeat(40) }, { ...fields, recipient: 'someone' }])
      expect(() => createNativeTransferNode('n', bad as typeof fields)).toThrow('TRANSFER_FIELDS_INVALID');
    const node = createNativeTransferNode('n', fields);
    expect(() => readNativeTransferNode({ ...node, lockedParameters: [{ name: 'amount' } as never] })).toThrow('TRANSFER_DECLARATION_INVALID');
    expect(() => readNativeTransferNode({ ...node, requiredAuthorizationClass: 'NONE' })).toThrow('TRANSFER_DECLARATION_INVALID');
    expect(() => readNativeTransferNode({ ...node, inputs: [node.inputs[0]!] })).toThrow('TRANSFER_PORTS_INVALID');
  });
});
describe('BUILD-RH-002 transfer declarations', () => {
  const recipient = '0x' + '2'.repeat(40), chain = 'eip155:4663';
  it('declares a native transfer to an explicit recipient on the same chain', () => {
    const node = createNativeTransferNode('node-002', { chain, amount: '5', recipient });
    expect(node.inputs[1]).toEqual({ name: 'recipient', kind: 'ACCOUNT', value: { chainId: chain, address: recipient } });
    expect(readTransferNode(node)).toEqual({ kind: 'NATIVE', fields: { chain, amount: '5', recipient } });
  });
  it('declares an ERC-20 transfer bound to the token and, for an issuer-registered asset, its official id', () => {
    const officialId = '0x' + '0'.repeat(32) + 'cfece3244ea34bb29414dd9488b32d9f';
    const token = { address: '0x322f0929c4625ed5bad873c95208d54e1c003b2d', decimals: 18, officialId };
    const node = createTokenTransferNode('node-002', { chain, token, amount: '3000000000000000000', recipient });
    expect(node).toMatchObject({ adapterConstraints: { adapters: [{ id: 'evm.token-transfer', version: '1.0.0' }], protocols: ['erc20'] } });
    expect(node.inputs.map(input => input.name)).toEqual(['amount', 'recipient', 'asset-official-id']);
    expect(readTokenTransferNode(node)).toEqual({ chain, token, amount: '3000000000000000000', recipient });
    expect(readTransferNode(node).kind).toBe('TOKEN');
    expect(() => validateArtifact('semantic-workflow', { schemaVersion: '1.0.0', workflowId: 'w', revision: 0, nodes: [node], resourceEdges: [] })).not.toThrow();
    // Removing the official id changes the declaration; it can never be silently dropped.
    expect(() => readTokenTransferNode({ ...node, inputs: node.inputs.slice(0, 2) })).not.toThrow();
    expect(readTokenTransferNode({ ...node, inputs: node.inputs.slice(0, 2) }).token.officialId).toBeNull();
    expect(() => readTokenTransferNode({ ...node, inputs: [...node.inputs, { name: 'extra', kind: 'IDENTIFIER', value: 'x' }] })).toThrow('TRANSFER_DECLARATION_INVALID');
    expect(() => createTokenTransferNode('n', { chain, token: { ...token, address: '0xNOPE' }, amount: '1', recipient })).toThrow('TRANSFER_FIELDS_INVALID');
    expect(() => createTokenTransferNode('n', { chain, token: { ...token, officialId: '0x12' }, amount: '1', recipient })).toThrow('TRANSFER_FIELDS_INVALID');
  });
});
