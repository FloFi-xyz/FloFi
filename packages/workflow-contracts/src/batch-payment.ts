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
import { SOLANA_TOKEN_PROGRAMS, type SolanaTokenProgram } from './solana-transfer.js';

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
// Final security review: the reserved system range is 0x…000 to 0x…fff (precompiles, including P256VERIFY at 0x…0100 on Ethereum, Base and Arbitrum).
const RESERVED = /^0x0{37}[0-9a-f]{3}$/;
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

/*
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02): the same Batch Payment operation on Solana mainnet-beta. A parallel family: the
 * EVM types, readers and node bytes above are unchanged. ONE semantic node pays 2..8 explicit Solana wallets from the owner's wallet in one asset
 * (native SOL or one SPL token bound by mint, decimals and token program), each its own exact amount, executed as ONE atomic owner-signed v0
 * transaction (System `Transfer` / ATA `CreateIdempotent` + `TransferChecked` legs). Base58 keys are case-sensitive: recipients are compared and
 * stored exactly as written, never lower-cased or trimmed. Shape checks only here; the compiler decodes every key to 32 canonical bytes, refuses
 * off-curve keys and reads every account from the chain.
 */
/** The semantic adapter of a Solana batch: ONE atomic owner-signed transaction of System / SPL transfer legs. */
export const BATCH_PAYMENT_SOLANA_ADAPTER = 'solana.batch-payment';
export type SolanaBatchPaymentAsset =
  | { readonly kind: 'NATIVE' }
  | { readonly kind: 'SPL_TOKEN'; readonly mint: string; readonly decimals: number; readonly program: SolanaTokenProgram };
export type SolanaBatchPaymentFields = { readonly chain: string; readonly asset: SolanaBatchPaymentAsset; readonly payments: readonly BatchPaymentLine[] };
/** Either family, tagged, for the few readers that serve both (linter dispatch, engine authoring, MCP views). */
export type BatchPaymentManifest = ({ readonly family: 'EVM' } & BatchPaymentFields) | ({ readonly family: 'SOLANA' } & SolanaBatchPaymentFields);

const SOLANA_CHAIN = /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/, BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, SOLANA_UNITS = /^[1-9][0-9]{0,19}$/, U64 = 1n << 64n;
const WRAPPED_SOL_MINTS: readonly string[] = Object.freeze(['So11111111111111111111111111111111111111112', '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP']);
/**
 * Addresses that are never a payee: native programs, loaders, sysvars, precompiles, the token, ATA, compute-budget, memo and Lighthouse programs and
 * both native mints. Nobody holds a wallet key for them, and most ARE Ed25519 curve points, so the compiler's on-curve check alone does not exclude them.
 */
export const SOLANA_BATCH_PAYMENT_RESERVED_RECIPIENTS: readonly string[] = Object.freeze([
  '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'ComputeBudget111111111111111111111111111111', 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95',
  'So11111111111111111111111111111111111111112', '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP',
  'Sysvar1111111111111111111111111111111111111', 'SysvarC1ock11111111111111111111111111111111', 'SysvarRent111111111111111111111111111111111',
  'SysvarRecentB1ockHashes11111111111111111111', 'SysvarEpochSchedu1e111111111111111111111111', 'SysvarFees111111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111', 'SysvarS1otHashes111111111111111111111111111', 'SysvarS1otHistory11111111111111111111111111',
  'SysvarStakeHistory1111111111111111111111111', 'SysvarEpochRewards1111111111111111111111111', 'SysvarLastRestartS1ot1111111111111111111111',
  'NativeLoader1111111111111111111111111111111', 'BPFLoader1111111111111111111111111111111111', 'BPFLoader2111111111111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111', 'LoaderV411111111111111111111111111111111111', 'Config1111111111111111111111111111111111111',
  'Stake11111111111111111111111111111111111111', 'StakeConfig11111111111111111111111111111111', 'Vote111111111111111111111111111111111111111',
  'AddressLookupTab1e1111111111111111111111111', 'Ed25519SigVerify111111111111111111111111111', 'KeccakSecp256k11111111111111111111111111111',
  'Secp256r1SigVerify1111111111111111111111111', 'Feature111111111111111111111111111111111111', '1nc1nerator11111111111111111111111111111111',
  'ZkTokenProof1111111111111111111111111111111', 'ZkE1Gama1Proof11111111111111111111111111111', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo']);

/** The exact integer total of a Solana manifest (lamports or token base units): each amount 1..2^64-1 and the total below 2^64 (u64 accounts). */
export function solanaBatchPaymentTotal(payments: readonly BatchPaymentLine[]): bigint {
  let total = 0n;
  for (const p of payments) {
    if (typeof p?.amount !== 'string' || !SOLANA_UNITS.test(p.amount) || BigInt(p.amount) >= U64) fail('BATCH_PAYMENT_AMOUNT_INVALID');
    total += BigInt(p.amount);
  }
  if (total >= U64) fail('BATCH_PAYMENT_TOTAL_OUT_OF_RANGE');
  return total;
}
/** Every rule of a Solana manifest that does not depend on the chain: cluster shape, asset identity shape, count, recipients, duplicates, amounts, total. */
export function validateSolanaBatchPaymentFields(fields: SolanaBatchPaymentFields): void {
  if (!fields || typeof fields.chain !== 'string' || !SOLANA_CHAIN.test(fields.chain)) fail('BATCH_PAYMENT_FIELDS_INVALID');
  const a = fields.asset as { readonly kind?: unknown; readonly mint?: unknown; readonly decimals?: unknown; readonly program?: unknown } | null;
  if (!a || (a.kind !== 'NATIVE' && a.kind !== 'SPL_TOKEN')) fail('BATCH_PAYMENT_FIELDS_INVALID');
  if (a.kind === 'SPL_TOKEN' && (typeof a.mint !== 'string' || !BASE58_KEY.test(a.mint) || !Number.isSafeInteger(a.decimals) || (a.decimals as number) < 0 ||
      (a.decimals as number) > 18 || !SOLANA_TOKEN_PROGRAMS.includes(a.program as SolanaTokenProgram))) fail('BATCH_PAYMENT_FIELDS_INVALID');
  // Wrapped SOL is native SOL held in a token account: a batch pays native SOL with the System Program, never by wrapping.
  if (a.kind === 'SPL_TOKEN' && WRAPPED_SOL_MINTS.includes(a.mint as string)) fail('BATCH_PAYMENT_ASSET_UNSUPPORTED');
  const mint = a.kind === 'SPL_TOKEN' ? a.mint as string : null;
  if (!Array.isArray(fields.payments) || fields.payments.length < BATCH_PAYMENT_MIN_RECIPIENTS) fail('BATCH_PAYMENT_TOO_FEW_RECIPIENTS');
  if (fields.payments.length > BATCH_PAYMENT_MAX_RECIPIENTS) fail('BATCH_PAYMENT_TOO_MANY_RECIPIENTS');
  const seen = new Set<string>();
  for (const p of fields.payments) {
    if (!p || typeof p.recipient !== 'string' || !BASE58_KEY.test(p.recipient) || SOLANA_BATCH_PAYMENT_RESERVED_RECIPIENTS.includes(p.recipient) || p.recipient === mint)
      fail('BATCH_PAYMENT_RECIPIENT_INVALID');
    // Exact string: base58 is case-sensitive, so two spellings that differ in case are two different keys (never merged, never lower-cased).
    if (seen.has(p.recipient)) fail('BATCH_PAYMENT_DUPLICATE_RECIPIENT');
    seen.add(p.recipient);
  }
  solanaBatchPaymentTotal(fields.payments);
}
/** The canonical node of a Solana Batch Payment (closed declaration; the order of `payments` is part of it). */
export function createSolanaBatchPaymentNode(nodeId: string, fields: SolanaBatchPaymentFields): Node {
  validateSolanaBatchPaymentFields(fields);
  const { chain, asset } = fields;
  const quantity = asset.kind === 'NATIVE' ? { chainId: chain, nativeId: 'SOL', decimals: 9 } : { chainId: chain, address: asset.mint, decimals: asset.decimals };
  const total = solanaBatchPaymentTotal(fields.payments).toString();
  const payments = fields.payments.flatMap((p, i) => [
    { name: batchPaymentRecipientInput(i), kind: 'ACCOUNT' as const, value: { chainId: chain, address: p.recipient } },
    { name: batchPaymentAmountInput(i), kind: 'QUANTITY' as const, value: { asset: quantity, amount: p.amount } }]);
  const program = asset.kind === 'SPL_TOKEN' ? [{ name: 'token-program', kind: 'IDENTIFIER' as const, value: asset.program }] : [];
  return { nodeId, actionType: BATCH_PAYMENT_ACTION, actionSchemaVersion: '1.0.0', chainId: chain,
    requiredCapabilities: [BATCH_PAYMENT_SOLANA_ADAPTER],
    adapterConstraints: { adapters: [{ id: BATCH_PAYMENT_SOLANA_ADAPTER, version: '1.0.0' }], protocols: [asset.kind === 'NATIVE' ? 'native' : asset.program] },
    inputs: [...payments, ...program], expectedOutputs: [], dependencies: [],
    userConstraints: [{ kind: 'MAXIMUM_INPUT', quantity: { asset: quantity, amount: total } }],
    failurePolicy: 'ABORT', requiredAuthorizationClass: 'MODE_A', lockedParameters: [], editableBounds: [] };
}
/** A Batch Payment whose one adapter is the Solana batch adapter (the action alone, `isBatchPaymentNode`, serves both families). */
export const isSolanaBatchPaymentNode = (node: { readonly actionType: string; readonly adapterConstraints: { readonly adapters: readonly { readonly id: string }[] } }) =>
  node.actionType === BATCH_PAYMENT_ACTION && node.adapterConstraints.adapters.length === 1 && node.adapterConstraints.adapters[0]!.id === BATCH_PAYMENT_SOLANA_ADAPTER;
/**
 * The manifest of a Solana Batch Payment node. Closed declaration: an EVM adapter, a non-Solana chain, any extra port (a 9th slot, a stray
 * `token-program` on SOL), a missing `token-program`, a lock, a dependency or another constraint is `BATCH_PAYMENT_DECLARATION_INVALID`.
 */
export function readSolanaBatchPaymentNode(node: Node): SolanaBatchPaymentFields {
  if (!isBatchPaymentNode(node)) fail('BATCH_PAYMENT_PORTS_INVALID');
  if (!isSolanaBatchPaymentNode(node) || !SOLANA_CHAIN.test(node.chainId)) fail('BATCH_PAYMENT_DECLARATION_INVALID');
  const program = node.inputs.find(p => p.name === 'token-program');
  const payments: BatchPaymentLine[] = [];
  let asset: SolanaBatchPaymentAsset | null = null;
  for (let i = 0; i < BATCH_PAYMENT_MAX_RECIPIENTS; i++) {
    const recipient = node.inputs.find(p => p.name === batchPaymentRecipientInput(i)), amount = node.inputs.find(p => p.name === batchPaymentAmountInput(i));
    if (!recipient && !amount) break;
    if (recipient?.kind !== 'ACCOUNT' || amount?.kind !== 'QUANTITY' || recipient.value.chainId !== node.chainId || amount.value.asset.chainId !== node.chainId)
      fail('BATCH_PAYMENT_PORTS_INVALID');
    const a = amount.value.asset as { readonly nativeId?: string; readonly address?: string; readonly decimals: number };
    let here: SolanaBatchPaymentAsset;
    if (typeof a.address === 'string') {
      if (program?.kind !== 'IDENTIFIER' || !SOLANA_TOKEN_PROGRAMS.includes(program.value as SolanaTokenProgram)) fail('BATCH_PAYMENT_DECLARATION_INVALID');
      here = { kind: 'SPL_TOKEN', mint: a.address, decimals: a.decimals, program: (program as { readonly value: string }).value as SolanaTokenProgram };
    } else if (a.nativeId === 'SOL' && a.decimals === 9) here = { kind: 'NATIVE' };
    else return fail('BATCH_PAYMENT_PORTS_INVALID');
    if (asset && canonicalJson(asset) !== canonicalJson(here)) fail('BATCH_PAYMENT_ASSET_MIXED');
    asset = here;
    payments.push({ recipient: recipient.value.address, amount: amount.value.amount });
  }
  if (!asset) return fail('BATCH_PAYMENT_PORTS_INVALID');
  const fields: SolanaBatchPaymentFields = { chain: node.chainId, asset, payments };
  if (canonicalJson(ordered(node)) !== canonicalJson(ordered(createSolanaBatchPaymentNode(node.nodeId, fields)))) fail('BATCH_PAYMENT_DECLARATION_INVALID');
  return fields;
}
/** Either family's manifest, tagged. A Solana adapter or a Solana chain reads as Solana; everything else is the unchanged EVM reader. */
export function readAnyBatchPaymentNode(node: Node): BatchPaymentManifest {
  if (isSolanaBatchPaymentNode(node) || node.chainId.startsWith('solana:')) return { family: 'SOLANA', ...readSolanaBatchPaymentNode(node) };
  return { family: 'EVM', ...readBatchPaymentNode(node) };
}
