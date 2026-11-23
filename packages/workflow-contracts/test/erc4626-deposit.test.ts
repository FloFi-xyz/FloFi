// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createErc4626DepositNode, ERC4626_DEPOSIT_ACTION, ERC4626_DEPOSIT_ADAPTER, readErc4626DepositNode, type Erc4626DepositFields } from '../src/erc4626-deposit.js';
import { validateArtifact } from '../src/schemas.js';

const fields: Erc4626DepositFields = { chain: 'eip155:1', vault: '0x' + '1'.repeat(40), underlying: '0x' + '2'.repeat(40), assetDecimals: 6,
  shareDecimals: 18, amount: '1000000', minimumShares: '990000000000000000', certificationDigest: '0x' + 'c'.repeat(64) };

describe('BUILD-FLOFI-STUDIO-UNIVERSAL-002 bounded ERC-4626 deposit declaration', () => {
  it('declares an exact-asset deposit with a minimum share output, the certification digest and the connected owner as receiver', () => {
    const node = createErc4626DepositNode('deposit', fields);
    expect(node).toMatchObject({ actionType: ERC4626_DEPOSIT_ACTION, chainId: 'eip155:1', requiredAuthorizationClass: 'MODE_A', failurePolicy: 'ABORT',
      adapterConstraints: { adapters: [ERC4626_DEPOSIT_ADAPTER], protocols: ['erc4626'] }, editableBounds: [],
      userConstraints: [{ kind: 'MAXIMUM_INPUT' }, { kind: 'MINIMUM_OUTPUT' }],
      expectedOutputs: [{ outputId: 'shares', minimumAmount: fields.minimumShares, asset: { address: fields.vault, decimals: 18 } }] });
    expect(node.inputs.find(input => input.name === 'receiver')).toEqual({ name: 'receiver', kind: 'IDENTIFIER', value: 'CONNECTED_OWNER' });
    expect(node.lockedParameters).toEqual(node.inputs);
    expect(readErc4626DepositNode(node)).toEqual(fields);
    expect(() => validateArtifact('semantic-workflow', { schemaVersion: '1.0.0', workflowId: 'w', revision: 0, nodes: [node], resourceEdges: [] })).not.toThrow();
  });

  it('refuses malformed fields before any declaration exists', () => {
    for (const bad of [{ chain: 'solana:x' }, { chain: 'eip155:01' }, { vault: '0x' + 'A'.repeat(40) }, { underlying: fields.vault },
      { vault: '0x' + '0'.repeat(40) }, { assetDecimals: 37 }, { shareDecimals: -1 }, { amount: '0' }, { amount: '01' },
      { minimumShares: (1n << 256n).toString() }, { certificationDigest: '0x' + 'c'.repeat(63) }])
      expect(() => createErc4626DepositNode('n', { ...fields, ...bad })).toThrow('VAULT_DEPOSIT_FIELDS_INVALID');
  });

  it('refuses any altered declaration, including a widened bound, another receiver or a dropped certification', () => {
    const node = createErc4626DepositNode('n', fields);
    const replace = (name: string, value: unknown) => node.inputs.map(input => input.name === name ? { ...input, value } as typeof input : input);
    expect(() => readErc4626DepositNode({ ...node, userConstraints: [node.userConstraints[0]!] })).toThrow('VAULT_DEPOSIT_DECLARATION_INVALID');
    expect(() => readErc4626DepositNode({ ...node, inputs: replace('receiver', '0x' + '3'.repeat(40)) })).toThrow('VAULT_DEPOSIT_DECLARATION_INVALID');
    expect(() => readErc4626DepositNode({ ...node, lockedParameters: node.lockedParameters.slice(1) })).toThrow('VAULT_DEPOSIT_DECLARATION_INVALID');
    expect(() => readErc4626DepositNode({ ...node, requiredAuthorizationClass: 'NONE' })).toThrow('VAULT_DEPOSIT_DECLARATION_INVALID');
    expect(() => readErc4626DepositNode({ ...node, inputs: node.inputs.filter(input => input.name !== 'certification') })).toThrow('VAULT_DEPOSIT_DECLARATION_INVALID');
    expect(() => readErc4626DepositNode({ ...node, editableBounds: [{ parameter: 'assets' } as never] })).toThrow('VAULT_DEPOSIT_DECLARATION_INVALID');
  });
});
