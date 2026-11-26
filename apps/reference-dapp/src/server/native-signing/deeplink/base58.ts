// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: base58 (Bitcoin alphabet) for deeplink payloads, which can be a whole transaction (the Solana codec's own
 * decoder is bounded to key-sized values). Bounded here too: at most `max` characters, decoded with a byte-wise carry (no big integers).
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((char, i) => [char, i]));
export function base58EncodeBytes(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i]! << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const byte of bytes) { if (byte !== 0) break; out += '1'; }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}
export function base58DecodeBytes(text: string, max = 4_096): Uint8Array {
  if (typeof text !== 'string' || text.length === 0 || text.length > max) throw new Error('BASE58_INVALID');
  const bytes: number[] = [];
  for (const char of text) {
    const value = INDEX.get(char);
    if (value === undefined) throw new Error('BASE58_INVALID');
    let carry = value;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i]! * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  for (const char of text) { if (char !== '1') break; zeros++; }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}
