// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02): the canonical Batch Payment operation. ONE semantic node pays several recipients, from one
 * source wallet, on one EVM network, in one asset (native ETH or one catalog ERC-20), each its own exact amount. The whole ordered manifest (every
 * recipient, every amount, the asset, the chain) is the node's declaration, so the semantic workflow hash binds it: changing, adding, removing or
 * reordering a payment is a different workflow and needs a fresh Review.
 *
 * The node is the operation's intent, not an executor. FloFi executes it as its ordered legs (one `asset.transfer` per payment, the existing
 * verified transfer declarations), and only as ONE atomic wallet authorization (an EIP-5792 atomic batch or the owner's own smart-account
 * operation): every leg settles, or none does. A wallet or deployment that cannot do that refuses the operation; it is never split into separate
 * transfers on its own.
 *
 *   payments   2..BATCH_PAYMENT_MAX_RECIPIENTS ordered `{recipient, amount}`: an explicit lower-case EVM address (never the zero address, never a
 *              precompile address 0x…01..0x…ff, never the connected owner placeholder) and a positive integer amount in the asset's base units; a
 *              recipient appears at most once
 *   total      the exact integer sum of the amounts, the node's MAXIMUM_INPUT (what the source wallet spends, before network fees)
 */
import { canonicalJson } from './canonical.js';
import type { SemanticWorkflow } from './semantic-workflow.js';

export const BATCH_PAYMENT_ACTION = 'asset.transfer.batch';
/** The semantic adapter: an atomic batch of `evm.native-transfer` / `evm.token-transfer` legs. */
export const BATCH_PAYMENT_ADAPTER = 'evm.batch-payment';
export const BATCH_PAYMENT_MIN_RECIPIENTS = 2;
/**
 * At most 8 payments: each payment is one leg of a FloFi workflow run, whose durable run schema holds at most 8 steps (migration 0015
 * `step_count BETWEEN 2 AND 8`, group and step indexes 0..7); an atomic wallet batch then carries at most 8 transfer calls plus its deadline
 * guard, inside EIP-5792's 16-call limit. Raising it is a migration, not a constant.
 */
export const BATCH_PAYMENT_MAX_RECIPIENTS = 8;
export type BatchPaymentAsset = { readonly kind: 'NATIVE' } | { readonly kind: 'TOKEN'; readonly address: string; readonly decimals: number; readonly officialId: string | null };
export type BatchPaymentLine = { readonly recipient: string; readonly amount: string };
export type BatchPaymentFields = { readonly chain: string; readonly asset: BatchPaymentAsset; readonly payments: readonly BatchPaymentLine[] };
type Node = SemanticWorkflow['nodes'][number];

const CHAIN = /^eip155:[1-9][0-9]{0,18}$/, ADDRESS = /^0x[0-9a-f]{40}$/;
/**
 * The zero address and the precompile range (0x…00 to 0x…ff: ecrecover, sha256, …, and the addresses EVM chains reserve for their own precompiles).
 * Nobody holds a key for them, so a payment there is lost; they are refused like the zero address, never paid.
 */
const RESERVED = /^0x0{38}[0-9a-f]{2}$/;
const UNITS = /^[1-9][0-9]{0,77}$/, OFFICIAL_ID = /^0x[0-9a-f]{64}$/, MAX_UINT256 = (1n << 256n) - 1n;
function fail(code: string): never { throw new Error(code); }
const slot = (index: number) => String(index + 1).padStart(2, '0');
export const batchPaymentRecipientInput = (index: number) => `payment-${slot(index)}-recipient`;
export const batchPaymentAmountInput = (index: number) => `payment-${slot(index)}-amount`;

/** The exact integer total of a manifest (base units), or a closed refusal. Never rounded, never a float. */
export function batchPaymentTotal(payments: readonly BatchPaymentLine[]): bigint {
  let total = 0n;
  for (const p of payments) {
    if (typeof p?.amount !== 'string' || !UNITS.test(p.amount)) fail('BATCH_PAYMENT_AMOUNT_INVALID');
    total += BigInt(p.amount);
  }
  if (total > MAX_UINT256) fail('BATCH_PAYMENT_TOTAL_OUT_OF_RANGE');
  return total;
}
/** Every rule of a manifest that does not depend on a network profile: count, recipients, duplicates, amounts, total. */
export function validateBatchPaymentFields(fields: BatchPaymentFields): void {
  if (!fields || typeof fields.chain !== 'string' || !CHAIN.test(fields.chain)) fail('BATCH_PAYMENT_FIELDS_INVALID');
  const a = fields.asset;
  if (!a || (a.kind !== 'NATIVE' && a.kind !== 'TOKEN')) fail('BATCH_PAYMENT_FIELDS_INVALID');
  if (a.kind === 'TOKEN' && (typeof a.address !== 'string' || !ADDRESS.test(a.address) || !Number.isSafeInteger(a.decimals) || a.decimals < 0 || a.decimals > 36 ||
      (a.officialId !== null && (typeof a.officialId !== 'string' || !OFFICIAL_ID.test(a.officialId))))) fail('BATCH_PAYMENT_FIELDS_INVALID');
  // An official id names an issuer-registered asset (a Robinhood Chain Stock Token): FloFi's atomic batches never carry one, whichever channel wrote it.
  if (a.kind === 'TOKEN' && a.officialId !== null) fail('BATCH_PAYMENT_ASSET_UNSUPPORTED');
  if (!Array.isArray(fields.payments) || fields.payments.length < BATCH_PAYMENT_MIN_RECIPIENTS) fail('BATCH_PAYMENT_TOO_FEW_RECIPIENTS');
  if (fields.payments.length > BATCH_PAYMENT_MAX_RECIPIENTS) fail('BATCH_PAYMENT_TOO_MANY_RECIPIENTS');
  const seen = new Set<string>();
  for (const p of fields.payments) {
    if (!p || typeof p.recipient !== 'string' || !ADDRESS.test(p.recipient) || RESERVED.test(p.recipient)) fail('BATCH_PAYMENT_RECIPIENT_INVALID');
    // A second payment to the same address is never merged or dropped: it is refused, and the person decides.
    if (seen.has(p.recipient)) fail('BATCH_PAYMENT_DUPLICATE_RECIPIENT');
    seen.add(p.recipient);
  }
  batchPaymentTotal(fields.payments);
}

/** The canonical node of a Batch Payment (closed declaration; the order of `payments` is part of it). */
export function createBatchPaymentNode(nodeId: string, fields: BatchPaymentFields): Node {
  validateBatchPaymentFields(fields);
  const asset = fields.asset.kind === 'NATIVE' ? { chainId: fields.chain, nativeId: 'ETH', decimals: 18 }
    : { chainId: fields.chain, address: fields.asset.address, decimals: fields.asset.decimals };
  const total = batchPaymentTotal(fields.payments).toString();
  const payments = fields.payments.flatMap((p, i) => [
    { name: batchPaymentRecipientInput(i), kind: 'ACCOUNT' as const, value: { chainId: fields.chain, address: p.recipient } },
    { name: batchPaymentAmountInput(i), kind: 'QUANTITY' as const, value: { asset, amount: p.amount } }]);
  const official = fields.asset.kind === 'TOKEN' && fields.asset.officialId ? [{ name: 'asset-official-id', kind: 'IDENTIFIER' as const, value: fields.asset.officialId }] : [];
  return { nodeId, actionType: BATCH_PAYMENT_ACTION, actionSchemaVersion: '1.0.0', chainId: fields.chain,
    requiredCapabilities: [BATCH_PAYMENT_ADAPTER],
    adapterConstraints: { adapters: [{ id: BATCH_PAYMENT_ADAPTER, version: '1.0.0' }], protocols: [fields.asset.kind === 'NATIVE' ? 'native' : 'erc20'] },
    inputs: [...payments, ...official], expectedOutputs: [], dependencies: [],
    userConstraints: [{ kind: 'MAXIMUM_INPUT', quantity: { asset, amount: total } }],
    failurePolicy: 'ABORT', requiredAuthorizationClass: 'MODE_A', lockedParameters: [], editableBounds: [] };
}
export const isBatchPaymentNode = (node: { readonly actionType: string }) => node.actionType === BATCH_PAYMENT_ACTION;
const ordered = (n: Node) => ({ ...n, inputs: [...n.inputs].sort((a, b) => a.name.localeCompare(b.name)) });
/** The manifest of a Batch Payment node; any port, constraint, lock or dependency beyond its own declaration is refused. */
export function readBatchPaymentNode(node: Node): BatchPaymentFields {
  if (!isBatchPaymentNode(node)) fail('BATCH_PAYMENT_PORTS_INVALID');
  const payments: BatchPaymentLine[] = [];
  let asset: BatchPaymentAsset | null = null;
  for (let i = 0; i < BATCH_PAYMENT_MAX_RECIPIENTS; i++) {
    const recipient = node.inputs.find(p => p.name === batchPaymentRecipientInput(i)), amount = node.inputs.find(p => p.name === batchPaymentAmountInput(i));
    if (!recipient && !amount) break;
    if (recipient?.kind !== 'ACCOUNT' || amount?.kind !== 'QUANTITY' || recipient.value.chainId !== node.chainId || amount.value.asset.chainId !== node.chainId)
      fail('BATCH_PAYMENT_PORTS_INVALID');
    const a = amount.value.asset as { readonly nativeId?: string; readonly address?: string; readonly decimals: number };
    const here: BatchPaymentAsset = typeof a.address === 'string' ? { kind: 'TOKEN', address: a.address, decimals: a.decimals, officialId: null }
      : a.nativeId === 'ETH' && a.decimals === 18 ? { kind: 'NATIVE' } : fail('BATCH_PAYMENT_PORTS_INVALID');
    if (asset && canonicalJson(asset) !== canonicalJson(here)) fail('BATCH_PAYMENT_ASSET_MIXED');
    asset = here;
    payments.push({ recipient: recipient.value.address, amount: amount.value.amount });
  }
  if (!asset) return fail('BATCH_PAYMENT_PORTS_INVALID');
  const id = node.inputs.find(p => p.name === 'asset-official-id');
  if (id && (id.kind !== 'IDENTIFIER' || asset.kind !== 'TOKEN')) fail('BATCH_PAYMENT_PORTS_INVALID');
  const fields: BatchPaymentFields = { chain: node.chainId, payments,
    asset: asset.kind === 'TOKEN' ? { ...asset, officialId: id?.kind === 'IDENTIFIER' ? id.value : null } : asset };
  if (canonicalJson(ordered(node)) !== canonicalJson(ordered(createBatchPaymentNode(node.nodeId, fields)))) fail('BATCH_PAYMENT_DECLARATION_INVALID');
  return fields;
}
