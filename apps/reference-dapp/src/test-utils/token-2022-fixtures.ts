// SPDX-License-Identifier: AGPL-3.0-only
/** Test fixtures only: byte-exact Token-2022 mint and Clock sysvar accounts, built independently of the decoders under test. */
import type { RawSolanaAccount } from '@defi-workflow-engine/reference-compiler';

/** A Token-2022 mint: the 82-byte base mint, then (with extensions) padding to 165, account type 1 and the TLV entries. */
export function token2022Mint(decimals: number, extensions: readonly { type: number; value: Uint8Array }[] = [], initialized = true): Uint8Array {
  const tlv = extensions.reduce((size, extension) => size + 4 + extension.value.length, 0);
  const data = new Uint8Array(extensions.length ? 166 + tlv : 82), view = new DataView(data.buffer);
  view.setBigUint64(36, 10n ** 15n, true); data[44] = decimals; data[45] = initialized ? 1 : 0;
  if (extensions.length) {
    data[165] = 1;
    let at = 166;
    for (const { type, value } of extensions) { view.setUint16(at, type, true); view.setUint16(at + 2, value.length, true); data.set(value, at + 4); at += 4 + value.length; }
  }
  return data;
}
export function scaledUiAmount(multiplier: number, effectiveAt: bigint, next: number): { type: number; value: Uint8Array } {
  const value = new Uint8Array(56), view = new DataView(value.buffer);
  view.setFloat64(32, multiplier, true); view.setBigInt64(40, effectiveAt, true); view.setFloat64(48, next, true);
  return { type: 25, value };
}
export function interestBearing(initializedAt: bigint, averageRate: number, updatedAt: bigint, currentRate: number): { type: number; value: Uint8Array } {
  const value = new Uint8Array(52), view = new DataView(value.buffer);
  view.setBigInt64(32, initializedAt, true); view.setInt16(40, averageRate, true); view.setBigInt64(42, updatedAt, true); view.setInt16(50, currentRate, true);
  return { type: 10, value };
}
export const metadataPointer = () => ({ type: 18, value: new Uint8Array(64).fill(4) });
export function clockAccount(unixTimestamp: bigint, owner = 'Sysvar1111111111111111111111111111111111111'): NonNullable<RawSolanaAccount> {
  const data = new Uint8Array(40);
  new DataView(data.buffer).setBigInt64(32, unixTimestamp, true);
  return { lamports: 1_169_280n, owner, data };
}
