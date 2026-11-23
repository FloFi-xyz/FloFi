// SPDX-License-Identifier: Apache-2.0
import { canonicalJson } from './canonical.js';
import type { SemanticWorkflow } from './semantic-workflow.js';

export const ERC4626_DEPOSIT_ACTION = 'vault.deposit';
export const ERC4626_DEPOSIT_ADAPTER = Object.freeze({ id: 'erc4626.bounded-deposit', version: '1.0.0' });

type Node = SemanticWorkflow['nodes'][number];
export type Erc4626DepositFields = {
  readonly chain: string;
  readonly vault: string;
  readonly underlying: string;
  readonly assetDecimals: number;
  readonly shareDecimals: number;
  readonly amount: string;
  readonly minimumShares: string;
  readonly certificationDigest: string;
};

const address = /^0x[0-9a-f]{40}$/;
const uint = (value: string): boolean => /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) < 1n << 256n;
const decimals = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 36;

/** Isolated exact-asset deposit with the connected signing owner as share recipient. */
export function createErc4626DepositNode(nodeId: string, fields: Erc4626DepositFields): Node {
  if (!/^eip155:[1-9][0-9]{0,18}$/.test(fields.chain) || !address.test(fields.vault) ||
    !address.test(fields.underlying) || fields.vault === fields.underlying ||
    [fields.vault, fields.underlying].includes('0x' + '0'.repeat(40)) ||
    !decimals(fields.assetDecimals) || !decimals(fields.shareDecimals) || !uint(fields.amount) ||
    !uint(fields.minimumShares) || !/^0x[0-9a-f]{64}$/.test(fields.certificationDigest)) {
    throw new Error('VAULT_DEPOSIT_FIELDS_INVALID');
  }
  const input = { asset: { chainId: fields.chain, address: fields.underlying, decimals: fields.assetDecimals }, amount: fields.amount };
  const output = { asset: { chainId: fields.chain, address: fields.vault, decimals: fields.shareDecimals }, amount: fields.minimumShares };
  const inputs: Node['inputs'] = [
    { name: 'assets', kind: 'QUANTITY', value: input },
    { name: 'minimum-shares', kind: 'QUANTITY', value: output },
    { name: 'certification', kind: 'IDENTIFIER', value: fields.certificationDigest },
    { name: 'receiver', kind: 'IDENTIFIER', value: 'CONNECTED_OWNER' },
  ];
  return { nodeId, actionType: ERC4626_DEPOSIT_ACTION, actionSchemaVersion: '1.0.0', chainId: fields.chain,
    requiredCapabilities: [ERC4626_DEPOSIT_ADAPTER.id],
    adapterConstraints: { adapters: [{ ...ERC4626_DEPOSIT_ADAPTER }], protocols: ['erc4626'] },
    inputs, expectedOutputs: [{ outputId: 'shares', asset: output.asset, minimumAmount: fields.minimumShares }],
    dependencies: [], userConstraints: [{ kind: 'MAXIMUM_INPUT', quantity: input }, { kind: 'MINIMUM_OUTPUT', quantity: output }],
    failurePolicy: 'ABORT', requiredAuthorizationClass: 'MODE_A', lockedParameters: structuredClone(inputs), editableBounds: [] };
}

const declaration = (node: Node): string => {
  const byName = (a: Node['inputs'][number], b: Node['inputs'][number]) => a.name.localeCompare(b.name);
  return canonicalJson({ ...node, inputs: [...node.inputs].sort(byName), lockedParameters: [...node.lockedParameters].sort(byName) });
};

export function readErc4626DepositNode(node: Node): Erc4626DepositFields {
  const assets = node.inputs.find(p => p.name === 'assets');
  const shares = node.inputs.find(p => p.name === 'minimum-shares');
  const certification = node.inputs.find(p => p.name === 'certification');
  if (assets?.kind !== 'QUANTITY' || !('address' in assets.value.asset) || shares?.kind !== 'QUANTITY' ||
    !('address' in shares.value.asset) || certification?.kind !== 'IDENTIFIER') throw new Error('VAULT_DEPOSIT_DECLARATION_INVALID');
  const fields = { chain: node.chainId, vault: shares.value.asset.address, underlying: assets.value.asset.address,
    assetDecimals: assets.value.asset.decimals, shareDecimals: shares.value.asset.decimals,
    amount: assets.value.amount, minimumShares: shares.value.amount, certificationDigest: certification.value };
  if (declaration(node) !== declaration(createErc4626DepositNode(node.nodeId, fields))) throw new Error('VAULT_DEPOSIT_DECLARATION_INVALID');
  return fields;
}
