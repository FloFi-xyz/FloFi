// SPDX-License-Identifier: Apache-2.0
import { canonicalJson } from './canonical.js';
import type { SemanticWorkflow } from './semantic-workflow.js';
/** Chain-neutral transfer of an asset; the adapter decides how it executes. */
export const TRANSFER_ACTION = 'asset.transfer';
export const NATIVE_TRANSFER_ADAPTER = 'evm.native-transfer';
/** BUILD-RH-002: the same transfer action and engine for a canonical ERC-20 (`transfer(recipient, amount)`). */
export const TOKEN_TRANSFER_ADAPTER = 'evm.token-transfer';
/**
 * `CONNECTED_OWNER` binds the executing owner at Simulate/Review (owner binding is session state). BUILD-RH-002: a profile may
 * also accept an explicit EVM recipient address on the same chain (lower-case, never the zero address).
 */
export type TransferRecipient = 'CONNECTED_OWNER' | string;
export type NativeTransferFields = { chain: string; amount: string; recipient: TransferRecipient };
export type TransferToken = { readonly address: string; readonly decimals: number; readonly officialId: string | null };
export type TokenTransferFields = { chain: string; token: TransferToken; amount: string; recipient: TransferRecipient };
type Node = SemanticWorkflow['nodes'][number];
const ADDRESS = /^0x[0-9a-f]{40}$/, ZERO = '0x0000000000000000000000000000000000000000', OFFICIAL_ID = /^0x[0-9a-f]{64}$/;
const recipientValid = (recipient: unknown) => recipient === 'CONNECTED_OWNER' || (typeof recipient === 'string' && ADDRESS.test(recipient) && recipient !== ZERO);
const recipientInput = (chain: string, recipient: TransferRecipient) => recipient === 'CONNECTED_OWNER'
  ? { name: 'recipient', kind: 'IDENTIFIER' as const, value: 'CONNECTED_OWNER' }
  : { name: 'recipient', kind: 'ACCOUNT' as const, value: { chainId: chain, address: recipient } };
function recipientOf(node: Node): TransferRecipient {
  const recipient = node.inputs.find(p => p.name === 'recipient');
  if (recipient?.kind === 'IDENTIFIER' && recipient.value === 'CONNECTED_OWNER') return 'CONNECTED_OWNER';
  if (recipient?.kind === 'ACCOUNT' && recipient.value.chainId === node.chainId) return recipient.value.address;
  throw new Error('TRANSFER_PORTS_INVALID');
}
const ordered = (n: Node) => ({ ...n, inputs: [...n.inputs].sort((a, b) => a.name.localeCompare(b.name)) });
/** Owner binding is session state: authored intent names the connected owner or an explicit recipient, never the signer's own address. */
export function createNativeTransferNode(nodeId: string, fields: NativeTransferFields): Node {
  if (!/^eip155:[1-9][0-9]{0,18}$/.test(fields.chain) || !/^[1-9][0-9]{0,77}$/.test(fields.amount) ||
      BigInt(fields.amount) >= 1n << 256n || !recipientValid(fields.recipient)) throw new Error('TRANSFER_FIELDS_INVALID');
  const quantity = { asset: { chainId: fields.chain, nativeId: 'ETH', decimals: 18 }, amount: fields.amount };
  return { nodeId, actionType: TRANSFER_ACTION, actionSchemaVersion: '1.0.0', chainId: fields.chain,
    requiredCapabilities: [NATIVE_TRANSFER_ADAPTER],
    adapterConstraints: { adapters: [{ id: NATIVE_TRANSFER_ADAPTER, version: '1.0.0' }], protocols: ['native'] },
    inputs: [{ name: 'amount', kind: 'QUANTITY', value: quantity }, recipientInput(fields.chain, fields.recipient)],
    expectedOutputs: [], dependencies: [], userConstraints: [{ kind: 'MAXIMUM_INPUT', quantity }],
    failurePolicy: 'ABORT', requiredAuthorizationClass: 'MODE_A', lockedParameters: [], editableBounds: [] };
}
/** Closed semantic declaration: any extra port, constraint, lock or dependency is refused. */
export function readNativeTransferNode(node: Node): NativeTransferFields {
  const amount = node.inputs.find(p => p.name === 'amount');
  if (amount?.kind !== 'QUANTITY' || !('nativeId' in amount.value.asset)) throw new Error('TRANSFER_PORTS_INVALID');
  const fields: NativeTransferFields = { chain: node.chainId, amount: amount.value.amount, recipient: recipientOf(node) };
  if (canonicalJson(ordered(node)) !== canonicalJson(ordered(createNativeTransferNode(node.nodeId, fields)))) throw new Error('TRANSFER_DECLARATION_INVALID');
  return fields;
}
/**
 * BUILD-RH-002: a canonical ERC-20 transfer (a catalog asset such as USDG, WETH or a Robinhood Stock Token). The token is bound by
 * chain + address + decimals, and an issuer-registered asset also by its official id.
 */
export function createTokenTransferNode(nodeId: string, fields: TokenTransferFields): Node {
  const t = fields.token;
  if (!/^eip155:[1-9][0-9]{0,18}$/.test(fields.chain) || !/^[1-9][0-9]{0,77}$/.test(fields.amount) || BigInt(fields.amount) >= 1n << 256n ||
      !recipientValid(fields.recipient) || !t || !ADDRESS.test(t.address) || !Number.isSafeInteger(t.decimals) || t.decimals < 0 || t.decimals > 36 ||
      (t.officialId !== null && (typeof t.officialId !== 'string' || !OFFICIAL_ID.test(t.officialId)))) throw new Error('TRANSFER_FIELDS_INVALID');
  const quantity = { asset: { chainId: fields.chain, address: t.address, decimals: t.decimals }, amount: fields.amount };
  return { nodeId, actionType: TRANSFER_ACTION, actionSchemaVersion: '1.0.0', chainId: fields.chain,
    requiredCapabilities: [TOKEN_TRANSFER_ADAPTER],
    adapterConstraints: { adapters: [{ id: TOKEN_TRANSFER_ADAPTER, version: '1.0.0' }], protocols: ['erc20'] },
    inputs: [{ name: 'amount', kind: 'QUANTITY', value: quantity }, recipientInput(fields.chain, fields.recipient),
      ...t.officialId ? [{ name: 'asset-official-id', kind: 'IDENTIFIER' as const, value: t.officialId }] : []],
    expectedOutputs: [], dependencies: [], userConstraints: [{ kind: 'MAXIMUM_INPUT', quantity }],
    failurePolicy: 'ABORT', requiredAuthorizationClass: 'MODE_A', lockedParameters: [], editableBounds: [] };
}
export const isTokenTransferNode = (node: { readonly actionType: string; readonly adapterConstraints: { readonly adapters: readonly { readonly id: string }[] } }) =>
  node.actionType === TRANSFER_ACTION && node.adapterConstraints.adapters.length === 1 && node.adapterConstraints.adapters[0]!.id === TOKEN_TRANSFER_ADAPTER;
export function readTokenTransferNode(node: Node): TokenTransferFields {
  if (!isTokenTransferNode(node)) throw new Error('TRANSFER_PORTS_INVALID');
  const amount = node.inputs.find(p => p.name === 'amount'), id = node.inputs.find(p => p.name === 'asset-official-id');
  if (amount?.kind !== 'QUANTITY' || !('address' in amount.value.asset) || (id && id.kind !== 'IDENTIFIER')) throw new Error('TRANSFER_PORTS_INVALID');
  const fields: TokenTransferFields = { chain: node.chainId, amount: amount.value.amount, recipient: recipientOf(node),
    token: { address: amount.value.asset.address, decimals: amount.value.asset.decimals, officialId: id?.kind === 'IDENTIFIER' ? id.value : null } };
  if (amount.value.asset.chainId !== node.chainId || canonicalJson(ordered(node)) !== canonicalJson(ordered(createTokenTransferNode(node.nodeId, fields))))
    throw new Error('TRANSFER_DECLARATION_INVALID');
  return fields;
}
/** Either transfer adapter's closed declaration. */
export type TransferFields = { readonly kind: 'NATIVE'; readonly fields: NativeTransferFields } | { readonly kind: 'TOKEN'; readonly fields: TokenTransferFields };
export function readTransferNode(node: Node): TransferFields {
  return isTokenTransferNode(node) ? { kind: 'TOKEN', fields: readTokenTransferNode(node) } : { kind: 'NATIVE', fields: readNativeTransferNode(node) };
}
