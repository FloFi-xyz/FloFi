// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: the Relay protocol v2 codec, dependency-free.
 *
 * Relay quotes return `protocol.v2.orderData` and `orderId`. The order says what the solver must deliver (destination chain,
 * recipient, currency, guaranteed minimum), where refunds go and until when. The source deposit carries `orderId` as its
 * `id`, so the deposit is bound to that order. FloFi recomputes `orderId` itself — the EIP-712 `hashStruct` of the normalized
 * order with no domain (Relay settlement-sdk `getOrderId`; reproduced exactly for four live quotes on 2026-10-25) — and
 * builds the deposit itself (EVM calldata; Solana instruction with every account derived), then requires the provider's
 * transaction to equal FloFi's byte for byte. Nothing from the provider is signed unexamined.
 *
 * Deployments, verified read-only on 2026-10-25:
 *  - EVM Depository `0x4cd00e387622c35bddb9b4c962c136462338bc31` on Base, Arbitrum One, Ethereum and Robinhood Chain:
 *    `depositErc20(address depositor, address token, uint256 amount, bytes32 id)` (0xe8017952) and
 *    `depositNative(address depositor, bytes32 id)` (0x49290c1c); events `RelayErc20Deposit(address,address,uint256,bytes32)`
 *    and `RelayNativeDeposit(address,uint256,bytes32)`, unindexed (observed in real deposits on Arbitrum One and Robinhood Chain).
 *  - Solana Depository program `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2`: Anchor `deposit_token(amount: u64, id: [u8; 32])`
 *    and `deposit_native(amount, id)`; PDAs `relay_depository` = seeds ["relay_depository"], `vault` = seeds ["vault"]
 *    (Relay SVM Depository reference; derived and matched against live quotes).
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { associatedTokenAddress, base58Decode, findProgramAddress, solanaAddress, u64Bytes, type SolanaInstruction } from './solana.js';

export const RELAY_EVM_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
export const RELAY_SOLANA_DEPOSITORY_PROGRAM = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
export const RELAY_SELECTORS = Object.freeze({ depositErc20: '0xe8017952', depositNative: '0x49290c1c', approve: '0x095ea7b3' });
export const RELAY_TOPICS = Object.freeze({
  erc20Deposit: '0x49fed1d0b752ce30eee63c7a81133f3363b532fec5d4d7dd1ccfd005de4555e1',
  nativeDeposit: '0x8032066556caf3967d8fec4ad22a2d9e1e9576556b2903a0fcd5b1fd201e3477',
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
});
export const SOLANA_SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const SOLANA_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SOLANA_TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const enc = new TextEncoder();
const fail = (code: string): never => { throw new Error(code); };
const hex = (bytes: Uint8Array) => '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const anchorDiscriminator = (name: string) => hex(sha256(enc.encode(`global:${name}`)).slice(0, 8)).slice(2);
export const RELAY_SOLANA_DISCRIMINATORS = Object.freeze({ depositToken: anchorDiscriminator('deposit_token'), depositNative: anchorDiscriminator('deposit_native') });
export const RELAY_SOLANA_DEPOSITORY = findProgramAddress([enc.encode('relay_depository')], RELAY_SOLANA_DEPOSITORY_PROGRAM);
export const RELAY_SOLANA_VAULT = findProgramAddress([enc.encode('vault')], RELAY_SOLANA_DEPOSITORY_PROGRAM);

// --- order hash ------------------------------------------------------------------------------------------------------
export type RelayVm = 'ethereum-vm' | 'solana-vm';
export type RelayOrderData = {
  readonly version: string; readonly solverChainId: string; readonly solver: string; readonly salt: string;
  readonly inputs: readonly { readonly payment: { readonly chainId: string; readonly currency: string; readonly amount: string; readonly weight: string };
    readonly refunds: readonly { readonly chainId: string; readonly recipient: string; readonly currency: string; readonly minimumAmount: string;
      readonly deadline: number; readonly extraData: string }[] }[];
  readonly output: { readonly chainId: string; readonly payments: readonly { readonly recipient: string; readonly currency: string; readonly minimumAmount: string;
    readonly expectedAmount: string }[]; readonly calls: readonly string[]; readonly deadline: number; readonly extraData: string };
  readonly fees: readonly { readonly recipientChainId: string; readonly recipient: string; readonly currencyChainId: string; readonly currency: string; readonly amount: string }[];
};
type Field = readonly [string, string];
const ORDER_TYPES: Readonly<Record<string, readonly Field[]>> = Object.freeze({
  Order: [['version', 'string'], ['solverChainId', 'string'], ['solver', 'address'], ['salt', 'uint256'], ['inputs', 'Input[]'], ['output', 'Output'], ['fees', 'Fee[]']],
  Input: [['payment', 'InputPayment'], ['refunds', 'InputRefund[]']],
  InputPayment: [['chainId', 'string'], ['currency', 'bytes'], ['amount', 'uint256'], ['weight', 'uint256']],
  InputRefund: [['chainId', 'string'], ['recipient', 'bytes'], ['currency', 'bytes'], ['minimumAmount', 'uint256'], ['deadline', 'uint32'], ['extraData', 'bytes']],
  Output: [['chainId', 'string'], ['payments', 'OutputPayment[]'], ['deadline', 'uint32'], ['calls', 'bytes[]'], ['extraData', 'bytes']],
  OutputPayment: [['recipient', 'bytes'], ['currency', 'bytes'], ['minimumAmount', 'uint256'], ['expectedAmount', 'uint256']],
  Fee: [['recipientChainId', 'string'], ['recipient', 'bytes'], ['currencyChainId', 'string'], ['currency', 'bytes'], ['amount', 'uint256']],
});
function dependencies(type: string, found = new Set<string>()): Set<string> {
  for (const [, fieldType] of ORDER_TYPES[type]!) { const base = fieldType.replace(/\[\]$/, ''); if (ORDER_TYPES[base] && !found.has(base)) { found.add(base); dependencies(base, found); } }
  return found;
}
const encodeType = (type: string) => [type, ...[...dependencies(type)].filter(t => t !== type).sort()]
  .map(t => `${t}(${ORDER_TYPES[t]!.map(([name, fieldType]) => `${fieldType} ${name}`).join(',')})`).join('');
const word = (value: bigint, bits = 256): Uint8Array => {
  if (value < 0n || value >= 1n << BigInt(bits)) fail('RELAY_ORDER_INVALID');
  const out = new Uint8Array(32); let v = value; for (let i = 31; i >= 0; i--) { out[i] = Number(v & 255n); v >>= 8n; } return out;
};
const strictHex = (value: unknown): Uint8Array => {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) fail('RELAY_ORDER_INVALID');
  return Uint8Array.from(((value as string).slice(2).match(/../g) ?? []).map(b => parseInt(b, 16)));
};
const uint = (value: unknown, bits: number): bigint => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  // Relay writes `salt` as 0x-hex and amounts as decimal strings; both are integers to EIP-712.
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value)) { const n = BigInt(value); if (n >= 1n << BigInt(bits)) fail('RELAY_ORDER_INVALID'); return n; }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) fail('RELAY_ORDER_INVALID');
  const n = BigInt(value as string); if (n >= 1n << BigInt(bits)) fail('RELAY_ORDER_INVALID'); return n;
};
function encodeField(type: string, value: unknown): Uint8Array {
  if (type.endsWith('[]')) {
    if (!Array.isArray(value) || value.length > 64) fail('RELAY_ORDER_INVALID');
    const base = type.slice(0, -2), parts = (value as unknown[]).map(item => encodeField(base, item));
    return keccak_256(Uint8Array.from(parts.flatMap(p => [...p])));
  }
  if (ORDER_TYPES[type]) return hashStruct(type, value);
  if (type === 'string') { if (typeof value !== 'string') fail('RELAY_ORDER_INVALID'); return keccak_256(enc.encode(value as string)); }
  if (type === 'bytes') return keccak_256(strictHex(value));
  if (type === 'address') { const bytes = strictHex(value); if (bytes.length !== 20) fail('RELAY_ORDER_INVALID'); const out = new Uint8Array(32); out.set(bytes, 12); return out; }
  if (type === 'uint256') return word(uint(value, 256));
  if (type === 'uint32') return word(uint(value, 32));
  return fail('RELAY_ORDER_INVALID');
}
function hashStruct(type: string, value: unknown): Uint8Array {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RELAY_ORDER_INVALID');
  const fields = ORDER_TYPES[type]!, record = value as Record<string, unknown>;
  // Closed shape: an unknown or missing field means FloFi does not understand the order.
  if (Object.keys(record).length !== fields.length || fields.some(([name]) => !(name in record))) fail('RELAY_ORDER_SHAPE_UNSUPPORTED');
  return keccak_256(Uint8Array.from([...keccak_256(enc.encode(encodeType(type))), ...fields.flatMap(([name, fieldType]) => [...encodeField(fieldType, record[name])])]));
}
/** A Relay address/currency in its VM's byte encoding (EVM: 20 bytes; Solana: 32-byte base58 key), as 0x-hex. */
export function relayAddressBytes(address: string, vm: RelayVm): string {
  if (vm === 'ethereum-vm') { if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) fail('RELAY_ORDER_INVALID'); return address.toLowerCase(); }
  let bytes: Uint8Array;
  try { bytes = base58Decode(solanaAddress(address)); } catch { return fail('RELAY_ORDER_INVALID'); }
  return hex(bytes);
}
/** `getOrderId`: the EIP-712 hashStruct of the order with every address/currency in its chain's VM encoding. */
/** The order has exactly the fields of its EIP-712 types, recursively: an unknown or missing field means FloFi does not understand it. */
function assertShape(type: string, value: unknown): void {
  if (type.endsWith('[]')) { if (!Array.isArray(value) || value.length > 64) fail('RELAY_ORDER_SHAPE_UNSUPPORTED'); for (const item of value as unknown[]) assertShape(type.slice(0, -2), item); return; }
  const fields = ORDER_TYPES[type];
  if (!fields) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RELAY_ORDER_SHAPE_UNSUPPORTED');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some(([name]) => !(name in record))) fail('RELAY_ORDER_SHAPE_UNSUPPORTED');
  for (const [name, fieldType] of fields) assertShape(fieldType, record[name]);
}
export function relayOrderId(order: RelayOrderData, vmOf: (chainSlug: string) => RelayVm): string {
  assertShape('Order', order);
  const vm = (slug: string) => { const v = vmOf(slug); if (v !== 'ethereum-vm' && v !== 'solana-vm') fail('RELAY_CHAIN_UNSUPPORTED'); return v; };
  const normalized = {
    version: order.version, solverChainId: order.solverChainId, solver: order.solver, salt: order.salt,
    inputs: order.inputs.map(input => ({
      payment: { chainId: input.payment.chainId, currency: relayAddressBytes(input.payment.currency, vm(input.payment.chainId)), amount: input.payment.amount, weight: input.payment.weight },
      refunds: input.refunds.map(r => ({ chainId: r.chainId, recipient: relayAddressBytes(r.recipient, vm(r.chainId)), currency: relayAddressBytes(r.currency, vm(r.chainId)),
        minimumAmount: r.minimumAmount, deadline: r.deadline, extraData: r.extraData })) })),
    output: { chainId: order.output.chainId, payments: order.output.payments.map(p => ({ recipient: relayAddressBytes(p.recipient, vm(order.output.chainId)),
      currency: relayAddressBytes(p.currency, vm(order.output.chainId)), minimumAmount: p.minimumAmount, expectedAmount: p.expectedAmount })),
      deadline: order.output.deadline, calls: order.output.calls, extraData: order.output.extraData },
    fees: order.fees.map(f => ({ recipientChainId: f.recipientChainId, recipient: relayAddressBytes(f.recipient, vm(f.recipientChainId)), currencyChainId: f.currencyChainId,
      currency: relayAddressBytes(f.currency, vm(f.currencyChainId)), amount: f.amount })),
  };
  return hex(hashStruct('Order', normalized));
}

// --- EVM depository --------------------------------------------------------------------------------------------------
const aw = (address: string) => { if (!/^0x[0-9a-f]{40}$/.test(address)) fail('RELAY_CALLDATA_INVALID'); return address.slice(2).padStart(64, '0'); };
const uw = (value: bigint) => { if (value < 0n || value >= 1n << 256n) fail('RELAY_CALLDATA_INVALID'); return value.toString(16).padStart(64, '0'); };
const bw = (id: string) => { if (!/^0x[0-9a-f]{64}$/.test(id)) fail('RELAY_CALLDATA_INVALID'); return id.slice(2); };
export const encodeRelayDepositErc20 = (depositor: string, token: string, amount: bigint, id: string) => RELAY_SELECTORS.depositErc20 + aw(depositor) + aw(token) + uw(amount) + bw(id);
export const encodeRelayDepositNative = (depositor: string, id: string) => RELAY_SELECTORS.depositNative + aw(depositor) + bw(id);
export const encodeErc20ApproveExact = (spender: string, amount: bigint) => RELAY_SELECTORS.approve + aw(spender) + uw(amount);
export type RelayEvmLog = { readonly address: string; readonly topics: readonly string[]; readonly data: string };
export type RelayDepositEvent = { readonly kind: 'ERC20' | 'NATIVE'; readonly from: string; readonly token: string | null; readonly amount: bigint; readonly id: string };
/** A Depository deposit event (unindexed fields in `data`), or null when the log is not one. */
export function decodeRelayDepositLog(log: RelayEvmLog, depository = RELAY_EVM_DEPOSITORY): RelayDepositEvent | null {
  if (typeof log?.address !== 'string' || log.address.toLowerCase() !== depository || !Array.isArray(log.topics) || log.topics.length !== 1) return null;
  const topic = String(log.topics[0]).toLowerCase(), data = String(log.data).toLowerCase();
  const at = (i: number) => data.slice(2 + i * 64, 66 + i * 64), address = (i: number) => '0x' + at(i).slice(24);
  if (topic === RELAY_TOPICS.erc20Deposit) {
    if (!/^0x[0-9a-f]{256}$/.test(data) || !/^0{24}/.test(at(0)) || !/^0{24}/.test(at(1))) fail('RELAY_LOG_INVALID');
    return { kind: 'ERC20', from: address(0), token: address(1), amount: BigInt('0x' + at(2)), id: '0x' + at(3) };
  }
  if (topic === RELAY_TOPICS.nativeDeposit) {
    if (!/^0x[0-9a-f]{192}$/.test(data) || !/^0{24}/.test(at(0))) fail('RELAY_LOG_INVALID');
    return { kind: 'NATIVE', from: address(0), token: null, amount: BigInt('0x' + at(1)), id: '0x' + at(2) };
  }
  return null;
}
export function encodeRelayDepositLog(event: RelayDepositEvent, depository = RELAY_EVM_DEPOSITORY): RelayEvmLog {
  return event.kind === 'ERC20' ? { address: depository, topics: [RELAY_TOPICS.erc20Deposit], data: '0x' + aw(event.from) + aw(event.token!) + uw(event.amount) + bw(event.id) }
    : { address: depository, topics: [RELAY_TOPICS.nativeDeposit], data: '0x' + aw(event.from) + uw(event.amount) + bw(event.id) };
}

// --- Solana depository -----------------------------------------------------------------------------------------------
/**
 * The deposit instruction FloFi builds itself. Token: [relay_depository, sender (signer, writable), depositor, vault, mint,
 * sender ATA (writable), vault ATA (writable), token program, associated token program, system program]. Native: [relay_depository,
 * sender (signer, writable), depositor, vault (writable), system program]. The owner is both sender and depositor.
 */
export function relaySolanaDepositInstruction(input: { owner: string; mint: string | null; tokenProgram: string | null; amount: bigint; orderId: string }): SolanaInstruction {
  const owner = solanaAddress(input.owner);
  if (input.amount < 1n || input.amount > 0xffff_ffff_ffff_ffffn) fail('RELAY_AMOUNT_INVALID');
  const id = strictHex(input.orderId);
  if (id.length !== 32) fail('RELAY_ORDER_INVALID');
  const ro = (pubkey: string) => ({ pubkey, isSigner: false, isWritable: false }), rw = (pubkey: string) => ({ pubkey, isSigner: false, isWritable: true });
  const sender = { pubkey: owner, isSigner: true, isWritable: true };
  if (input.mint === null) {
    return { programId: RELAY_SOLANA_DEPOSITORY_PROGRAM, accounts: [ro(RELAY_SOLANA_DEPOSITORY), sender, ro(owner), rw(RELAY_SOLANA_VAULT), ro(SOLANA_SYSTEM_PROGRAM_ID)],
      data: Uint8Array.from([...strictHex('0x' + RELAY_SOLANA_DISCRIMINATORS.depositNative), ...u64Bytes(input.amount), ...id]) };
  }
  const mint = solanaAddress(input.mint), program = input.tokenProgram;
  if (program !== SOLANA_TOKEN_PROGRAM_ID && program !== SOLANA_TOKEN_2022_PROGRAM_ID) fail('RELAY_TOKEN_PROGRAM_UNSUPPORTED');
  const ownerAta = associatedTokenAddress(owner, mint, program!, SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID);
  const vaultAta = associatedTokenAddress(RELAY_SOLANA_VAULT, mint, program!, SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID);
  return { programId: RELAY_SOLANA_DEPOSITORY_PROGRAM, accounts: [ro(RELAY_SOLANA_DEPOSITORY), sender, ro(owner), ro(RELAY_SOLANA_VAULT), ro(mint), rw(ownerAta), rw(vaultAta),
    ro(program!), ro(SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID), ro(SOLANA_SYSTEM_PROGRAM_ID)],
    data: Uint8Array.from([...strictHex('0x' + RELAY_SOLANA_DISCRIMINATORS.depositToken), ...u64Bytes(input.amount), ...id]) };
}

// --- order verification ----------------------------------------------------------------------------------------------
export type RelayOrderExpectation = {
  readonly orderId: string; readonly sourceSlug: string; readonly destinationSlug: string;
  /** Relay currency encodings: EVM lowercase hex (native = zero address), Solana base58 (native = System Program id). */
  readonly inputCurrency: string; readonly outputCurrency: string; readonly amount: string;
  readonly owner: string; readonly recipient: string; readonly slippageBps: number; readonly nowSeconds: number;
  readonly vmOf: (chainSlug: string) => RelayVm;
};
export type VerifiedRelayOrder = { readonly orderId: string; readonly solver: string; readonly expectedOutput: string; readonly minimumOutput: string;
  readonly deadline: number; readonly refunds: readonly { readonly chainId: string; readonly recipient: string; readonly currency: string }[] };
const same = (a: string, b: string, vm: RelayVm) => vm === 'ethereum-vm' ? a.toLowerCase() === b.toLowerCase() : a === b;
/**
 * The order is exactly what the owner intends: hash matches, one input of the exact amount and currency on the source chain, one
 * output payment to the recipient in the destination currency on the destination chain, no destination calls, no order fees,
 * refunds only to the owner (source) or the recipient (destination), a guaranteed minimum within the owner's slippage, a future deadline.
 */
export function verifyRelayOrder(order: RelayOrderData, x: RelayOrderExpectation): VerifiedRelayOrder {
  if (!order || typeof order !== 'object' || order.version !== 'v1') fail('RELAY_ORDER_VERSION_UNSUPPORTED');
  if (relayOrderId(order, x.vmOf) !== x.orderId.toLowerCase()) fail('RELAY_ORDER_ID_MISMATCH');
  const srcVm = x.vmOf(x.sourceSlug), dstVm = x.vmOf(x.destinationSlug);
  if (!/^0x[0-9a-fA-F]{40}$/.test(order.solver)) fail('RELAY_ORDER_SOLVER_INVALID');
  if (order.inputs.length !== 1) fail('RELAY_ORDER_INPUTS_UNSUPPORTED');
  const input = order.inputs[0]!;
  if (input.payment.chainId !== x.sourceSlug || !same(input.payment.currency, x.inputCurrency, srcVm) || input.payment.amount !== x.amount || input.payment.weight !== '1')
    fail('RELAY_ORDER_INPUT_MISMATCH');
  const out = order.output;
  if (out.chainId !== x.destinationSlug || out.payments.length !== 1) fail('RELAY_ORDER_OUTPUT_MISMATCH');
  const payment = out.payments[0]!;
  if (!same(payment.recipient, x.recipient, dstVm)) fail('RELAY_ORDER_RECIPIENT_MISMATCH');
  if (!same(payment.currency, x.outputCurrency, dstVm)) fail('RELAY_ORDER_OUTPUT_CURRENCY_MISMATCH');
  if (out.calls.length !== 0) fail('RELAY_ORDER_DESTINATION_CALLS_UNSUPPORTED');
  if (order.fees.length !== 0) fail('RELAY_ORDER_FEES_UNEXPECTED');
  if (input.refunds.length < 1 || input.refunds.length > 4) fail('RELAY_ORDER_REFUND_INVALID');
  for (const r of input.refunds) {
    const ok = r.chainId === x.sourceSlug ? same(r.recipient, x.owner, srcVm) && same(r.currency, x.inputCurrency, srcVm)
      : r.chainId === x.destinationSlug ? same(r.recipient, x.recipient, dstVm) && same(r.currency, x.outputCurrency, dstVm) : false;
    if (!ok || r.minimumAmount !== '0' && !/^[1-9][0-9]{0,77}$/.test(r.minimumAmount)) fail('RELAY_ORDER_REFUND_RECIPIENT_UNEXPECTED');
  }
  if (!input.refunds.some(r => r.chainId === x.sourceSlug)) fail('RELAY_ORDER_REFUND_INVALID');
  const minimum = uint(payment.minimumAmount, 256), expected = uint(payment.expectedAmount, 256);
  if (minimum < 1n || minimum > expected) fail('RELAY_ORDER_MINIMUM_INVALID');
  // Relay floors the minimum: ⌊expected × (10 000 − slippage) / 10 000⌋ is the lowest value the owner's bound allows.
  if (minimum < expected * BigInt(10_000 - x.slippageBps) / 10_000n) fail('RELAY_ORDER_MINIMUM_BELOW_SLIPPAGE');
  if (!Number.isSafeInteger(out.deadline) || out.deadline <= x.nowSeconds + 600) fail('RELAY_ORDER_DEADLINE_INVALID');
  return { orderId: x.orderId.toLowerCase(), solver: order.solver.toLowerCase(), expectedOutput: expected.toString(), minimumOutput: minimum.toString(), deadline: out.deadline,
    refunds: input.refunds.map(r => ({ chainId: r.chainId, recipient: r.recipient, currency: r.currency })) };
}
