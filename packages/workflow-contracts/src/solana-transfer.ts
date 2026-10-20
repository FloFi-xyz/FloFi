// SPDX-License-Identifier: Apache-2.0
import { canonicalJson } from './canonical.js';
import { TRANSFER_ACTION } from './native-transfer.js';
import type { SemanticWorkflow } from './semantic-workflow.js';
/**
 * BUILD-SOLANA-TRANSFER-UX-001: a direct transfer to another wallet on a Solana cluster, on the same chain-neutral `asset.transfer` action as
 * the EVM transfers. Native SOL moves through the System Program; an SPL token (classic SPL Token or Token-2022) moves through the token's own
 * program with `TransferChecked`, so mint and decimals are enforced on chain. The recipient is always an explicit wallet address: a Solana
 * transfer never binds "the connected owner" and never substitutes the sender. The token is bound by mint, decimals and token program.
 */
export const SOLANA_SYSTEM_TRANSFER_ADAPTER = 'solana.system-transfer';
export const SOLANA_TOKEN_TRANSFER_ADAPTER = 'solana.spl-transfer';
export const SOLANA_TOKEN_PROGRAMS = ['spl-token', 'token-2022'] as const;
export type SolanaTokenProgram = typeof SOLANA_TOKEN_PROGRAMS[number];
export type SolanaTransferToken = { readonly mint: string; readonly decimals: number; readonly program: SolanaTokenProgram };
/** `token: null` is native SOL (9 decimals, lamports). */
export type SolanaTransferFields = { readonly chain: string; readonly amount: string; readonly recipient: string; readonly token: SolanaTransferToken | null };
type Node = SemanticWorkflow['nodes'][number];
// Shape checks only; the compiler decodes every key to exactly 32 bytes before anything is simulated.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, CHAIN = /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/, AMOUNT = /^[1-9][0-9]{0,19}$/;
const U64 = 1n << 64n;
const adapterOf = (node: { readonly adapterConstraints: { readonly adapters: readonly { readonly id: string }[] } }) =>
  node.adapterConstraints.adapters.length === 1 ? node.adapterConstraints.adapters[0]!.id : null;
export const isSolanaTransferNode = (node: { readonly actionType: string; readonly adapterConstraints: { readonly adapters: readonly { readonly id: string }[] } }) =>
  node.actionType === TRANSFER_ACTION && [SOLANA_SYSTEM_TRANSFER_ADAPTER, SOLANA_TOKEN_TRANSFER_ADAPTER].includes(adapterOf(node) ?? '');
function validFields(fields: SolanaTransferFields): boolean {
  if (!CHAIN.test(fields.chain) || !AMOUNT.test(fields.amount) || BigInt(fields.amount) >= U64 || typeof fields.recipient !== 'string' || !BASE58.test(fields.recipient)) return false;
  const t = fields.token;
  if (t === null) return true;
  return typeof t === 'object' && typeof t.mint === 'string' && BASE58.test(t.mint) && t.mint !== fields.recipient && Number.isSafeInteger(t.decimals) &&
    t.decimals >= 0 && t.decimals <= 18 && SOLANA_TOKEN_PROGRAMS.includes(t.program);
}
const ordered = (n: Node) => ({ ...n, inputs: [...n.inputs].sort((a, b) => a.name.localeCompare(b.name)) });
export function createSolanaTransferNode(nodeId: string, fields: SolanaTransferFields): Node {
  if (!fields || !validFields(fields)) throw new Error('SOLANA_TRANSFER_FIELDS_INVALID');
  const t = fields.token, quantity = { asset: t ? { chainId: fields.chain, address: t.mint, decimals: t.decimals } : { chainId: fields.chain, nativeId: 'SOL', decimals: 9 }, amount: fields.amount };
  const adapter = t ? SOLANA_TOKEN_TRANSFER_ADAPTER : SOLANA_SYSTEM_TRANSFER_ADAPTER;
  return { nodeId, actionType: TRANSFER_ACTION, actionSchemaVersion: '1.0.0', chainId: fields.chain, requiredCapabilities: [adapter],
    adapterConstraints: { adapters: [{ id: adapter, version: '1.0.0' }], protocols: [t ? t.program : 'native'] },
    inputs: [{ name: 'amount', kind: 'QUANTITY', value: quantity }, { name: 'recipient', kind: 'ACCOUNT', value: { chainId: fields.chain, address: fields.recipient } },
      ...t ? [{ name: 'token-program', kind: 'IDENTIFIER' as const, value: t.program }] : []],
    expectedOutputs: [], dependencies: [], userConstraints: [{ kind: 'MAXIMUM_INPUT', quantity }],
    failurePolicy: 'ABORT', requiredAuthorizationClass: 'MODE_A', lockedParameters: [], editableBounds: [] };
}
/** Closed semantic declaration: any extra port, constraint, lock, dependency or a recipient other than an explicit account is refused. */
export function readSolanaTransferNode(node: Node): SolanaTransferFields {
  if (!isSolanaTransferNode(node)) throw new Error('SOLANA_TRANSFER_PORTS_INVALID');
  const amount = node.inputs.find(p => p.name === 'amount'), recipient = node.inputs.find(p => p.name === 'recipient'), program = node.inputs.find(p => p.name === 'token-program');
  if (amount?.kind !== 'QUANTITY' || recipient?.kind !== 'ACCOUNT' || recipient.value.chainId !== node.chainId || amount.value.asset.chainId !== node.chainId)
    throw new Error('SOLANA_TRANSFER_PORTS_INVALID');
  const native = adapterOf(node) === SOLANA_SYSTEM_TRANSFER_ADAPTER, asset = amount.value.asset;
  let token: SolanaTransferToken | null = null;
  if (native) {
    if (!('nativeId' in asset) || asset.nativeId !== 'SOL' || asset.decimals !== 9 || program) throw new Error('SOLANA_TRANSFER_PORTS_INVALID');
  } else {
    if (!('address' in asset) || program?.kind !== 'IDENTIFIER' || !SOLANA_TOKEN_PROGRAMS.includes(program.value as SolanaTokenProgram)) throw new Error('SOLANA_TRANSFER_PORTS_INVALID');
    token = { mint: asset.address, decimals: asset.decimals, program: program.value as SolanaTokenProgram };
  }
  const fields: SolanaTransferFields = { chain: node.chainId, amount: amount.value.amount, recipient: recipient.value.address, token };
  let canonical: Node;
  try { canonical = createSolanaTransferNode(node.nodeId, fields); } catch { throw new Error('SOLANA_TRANSFER_DECLARATION_INVALID'); }
  if (canonicalJson(ordered(node)) !== canonicalJson(ordered(canonical))) throw new Error('SOLANA_TRANSFER_DECLARATION_INVALID');
  return fields;
}
