// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: the check FloFi applies to the signed EVM transaction Privy returns, before FloFi broadcasts it.
 *
 * FloFi's server gate approved one exact request (all nine EIP-1559 fields) before Privy was asked. Privy's SDK receives those fields
 * as hex strings; if it filled in, overrode or mis-mapped any of them (a nonce, a fee), the bytes it signed would differ from what was
 * approved, and the broadcast check binds only the fields the attempt itself fixes. So the answer is accepted only as canonical type-2
 * RLP whose first nine fields are byte-identical to the approved request, with a well-formed signature; otherwise it is dropped (never
 * broadcast) and the attempt is UNKNOWN. The signer's identity is then checked by the server at broadcast (`floFiEvmBroadcast`).
 *
 * Restored from the removed FloFi Wallet codec (src/wallet-app/evm-transaction.ts on main): a small strict RLP that never imports the
 * workflow engine, cross-checked byte for byte against the engine's `unsignedEip1559` by its unit test.
 */
import type { EvmTransaction } from '../wallet-app/protocol';

export type RlpItem = Uint8Array | readonly RlpItem[];
const fail = (code: string): never => { throw new Error(code); };
const INVALID = 'FLOFI_WALLET_TRANSACTION_INVALID';

export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) fail(INVALID);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const concat = (...parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
/** A non-negative integer as minimal big-endian bytes (zero is empty), the RLP form of a quantity. */
export function quantityBytes(value: bigint): Uint8Array {
  if (value < 0n) fail(INVALID);
  let hex = value.toString(16);
  if (value === 0n) return new Uint8Array(0);
  if (hex.length % 2) hex = `0${hex}`;
  return hexToBytes(hex);
}
const lengthPrefix = (length: number, short: number) => {
  if (length <= 55) return Uint8Array.of(short + length);
  const size = quantityBytes(BigInt(length));
  return concat(Uint8Array.of(short + 55 + size.length), size);
};
export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) return item.length === 1 && item[0]! < 0x80 ? item : concat(lengthPrefix(item.length, 0x80), item);
  const body = concat(...item.map(rlpEncode));
  return concat(lengthPrefix(body.length, 0xc0), body);
}
/** Strict, canonical RLP: minimal lengths, single bytes below 0x80 never wrapped, nothing after the item. */
export function rlpDecode(bytes: Uint8Array): RlpItem {
  const read = (at: number): [RlpItem, number] => {
    const first = bytes[at];
    if (first === undefined) return fail(INVALID);
    if (first < 0x80) return [bytes.subarray(at, at + 1), at + 1];
    const list = first >= 0xc0, base = list ? 0xc0 : 0x80;
    let length: number, start: number;
    if (first - base <= 55) { length = first - base; start = at + 1; }
    else {
      const size = first - base - 55;
      if (bytes[at + 1] === 0 || at + 1 + size > bytes.length) fail(INVALID);
      length = Number(BigInt(`0x${bytesToHex(bytes.subarray(at + 1, at + 1 + size))}`));
      if (length <= 55 || !Number.isSafeInteger(length)) fail(INVALID);
      start = at + 1 + size;
    }
    const end = start + length;
    if (end > bytes.length) fail(INVALID);
    if (!list) {
      if (length === 1 && bytes[start]! < 0x80) fail(INVALID);
      return [bytes.subarray(start, end), end];
    }
    const items: RlpItem[] = [];
    let cursor = start;
    while (cursor < end) { const [item, next] = read(cursor); items.push(item); cursor = next; }
    // The last item must end exactly where its list ends (no item may run past it).
    if (cursor !== end) fail(INVALID);
    return [items, end];
  };
  const [item, end] = read(0);
  if (end !== bytes.length) fail(INVALID);
  return item;
}

/** The nine fields of a type-2 transaction, in signing order. */
function fields(tx: EvmTransaction): RlpItem[] {
  return [quantityBytes(BigInt(tx.chainId)), quantityBytes(BigInt(tx.nonce)), quantityBytes(BigInt(tx.maxPriorityFeePerGas)), quantityBytes(BigInt(tx.maxFeePerGas)),
    quantityBytes(BigInt(tx.gas)), hexToBytes(tx.to), quantityBytes(BigInt(tx.value)), hexToBytes(tx.data), []];
}
/** `0x02 ‖ rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data, []])`: exactly what the person approves. */
export const unsignedEip1559 = (tx: EvmTransaction): Uint8Array => concat(Uint8Array.of(2), rlpEncode(fields(tx)));

/**
 * The provider's signed transaction, accepted only if it is canonical type-2 RLP whose first nine fields are byte-identical to what the
 * person approved and whose signature fields are well formed (yParity 0/1, r and s non-zero, ≤ 32 bytes). Returns `0x…`.
 */
export function verifySignedEip1559(tx: EvmTransaction, signedHex: string): string {
  const signed = hexToBytes(signedHex.toLowerCase());
  if (signed[0] !== 2) fail('FLOFI_WALLET_SIGNED_TRANSACTION_MISMATCH');
  let decoded: RlpItem;
  try { decoded = rlpDecode(signed.subarray(1)); } catch { return fail('FLOFI_WALLET_SIGNED_TRANSACTION_MISMATCH'); }
  const expected = fields(tx);
  if (decoded instanceof Uint8Array || decoded.length !== 12) fail('FLOFI_WALLET_SIGNED_TRANSACTION_MISMATCH');
  const items = decoded as readonly RlpItem[];
  for (let i = 0; i < 9; i++) if (!equal(rlpEncode(items[i]!), rlpEncode(expected[i]!))) fail('FLOFI_WALLET_SIGNED_TRANSACTION_MISMATCH');
  const [yParity, r, s] = [items[9], items[10], items[11]];
  const scalar = (value: RlpItem | undefined) => value instanceof Uint8Array && value.length >= 1 && value.length <= 32 && value[0] !== 0;
  if (!(yParity instanceof Uint8Array) || !(yParity.length === 0 || (yParity.length === 1 && yParity[0] === 1)) || !scalar(r) || !scalar(s))
    fail('FLOFI_WALLET_SIGNED_TRANSACTION_MISMATCH');
  return `0x${bytesToHex(signed)}`;
}
