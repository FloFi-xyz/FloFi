// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): a generic, strict EIP-712 hasher for typed data FloFi did not build itself — 0x
 * Gasless's Permit2 `PermitWitnessTransferFrom` (nested `TokenPermissions`, `SlippageAndActions` with `bytes[]`) and EIP-2612 `Permit` — so
 * FloFi can recompute the digest a wallet will sign and require it to equal the provider's `hash` before anything is shown or signed.
 *
 * Exactly EIP-712 `hashStruct`/`encodeType`/`encodeData` (https://eips.ethereum.org/EIPS/eip-712): nested structs, dynamic and fixed arrays,
 * `string`/`bytes` hashed, atomic types padded to one word. Strict where a lenient hasher would be dangerous: every declared field must be
 * present, no undeclared message key is accepted (a wallet would silently ignore it while a page could show it), type references must resolve,
 * recursion and sizes are bounded. Pure; it holds no key and signs nothing (`recoverTypedDataSigner` only recovers).
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesOf, hexOf, recoverDigestSigner } from './erc7710.js';

export type TypedDataField = { readonly name: string; readonly type: string };
export type TypedDataTypes = Readonly<Record<string, readonly TypedDataField[]>>;
export type TypedData = { readonly types: TypedDataTypes; readonly domain: Readonly<Record<string, unknown>>; readonly primaryType: string;
  readonly message: Readonly<Record<string, unknown>> };
/** The EIP-712 domain fields, in the only order the standard allows. */
export const DOMAIN_FIELDS: readonly TypedDataField[] = Object.freeze([
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' }]);

const fail = (code: string): never => { throw new Error(code); };
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const MAX_DEPTH = 8, MAX_ARRAY = 256, MAX_BYTES = 65_536, MAX_TYPES = 32, MAX_FIELDS = 32;
const keccak = (bytes: Uint8Array) => keccak_256(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);
function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
function wordOf(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) fail('EIP712_VALUE_INVALID');
  return bytesOf('0x' + value.toString(16).padStart(64, '0'));
}
const baseType = (type: string) => type.replace(/(\[[0-9]*\])+$/, '');
/** `T[]` / `T[n]` → `{ inner: T, length: n | null }`, or null for a non-array type. */
function arrayOf(type: string): { readonly inner: string; readonly length: number | null } | null {
  const match = /^(.*)\[([0-9]*)\]$/.exec(type);
  if (!match) return null;
  const length = match[2] === '' ? null : Number(match[2]);
  if (length !== null && (!Number.isSafeInteger(length) || length < 1 || length > MAX_ARRAY)) fail('EIP712_TYPE_INVALID');
  return { inner: match[1]!, length };
}
const ATOMIC = /^(address|bool|string|bytes|bytes([1-9]|[12][0-9]|3[0-2])|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256))$/;
const isAtomic = (type: string) => ATOMIC.test(type);

/** The declared struct types, validated: identifiers, bounded, every referenced type resolvable, no undeclared reference. */
function structTypes(types: unknown): Map<string, readonly TypedDataField[]> {
  if (!types || typeof types !== 'object' || Array.isArray(types)) return fail('EIP712_TYPES_INVALID');
  const entries = Object.entries(types as Record<string, unknown>).filter(([name]) => name !== 'EIP712Domain');
  if (entries.length < 1 || entries.length > MAX_TYPES) fail('EIP712_TYPES_INVALID');
  const map = new Map<string, readonly TypedDataField[]>();
  for (const [name, fields] of entries) {
    if (!IDENTIFIER.test(name) || isAtomic(name) || !Array.isArray(fields) || fields.length > MAX_FIELDS) fail('EIP712_TYPES_INVALID');
    const seen = new Set<string>();
    const parsed = (fields as unknown[]).map(field => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) return fail('EIP712_TYPES_INVALID');
      const { name: fieldName, type, ...rest } = field as Record<string, unknown>;
      if (Object.keys(rest).length || typeof fieldName !== 'string' || !IDENTIFIER.test(fieldName) || typeof type !== 'string' || seen.has(fieldName)) fail('EIP712_TYPES_INVALID');
      seen.add(fieldName as string);
      return { name: fieldName as string, type: type as string };
    });
    map.set(name, parsed);
  }
  for (const fields of map.values()) for (const field of fields) {
    const base = baseType(field.type);
    if (!isAtomic(base) && !map.has(base)) fail('EIP712_TYPES_INVALID');
  }
  return map;
}
/** Every struct type `primary` references (transitively), the primary first, then the rest sorted by name (EIP-712 `encodeType`). */
function dependencies(primary: string, types: Map<string, readonly TypedDataField[]>): string[] {
  const found = new Set<string>();
  const visit = (name: string, path: readonly string[]) => {
    if (path.includes(name)) fail('EIP712_TYPES_RECURSIVE');
    if (found.has(name)) return;
    found.add(name);
    for (const field of types.get(name)!) { const base = baseType(field.type); if (types.has(base)) visit(base, [...path, name]); }
  };
  if (!types.has(primary)) fail('EIP712_PRIMARY_TYPE_INVALID');
  visit(primary, []);
  found.delete(primary);
  return [primary, ...[...found].sort()];
}
export function encodeType(primary: string, types: TypedDataTypes): string {
  const map = structTypes(types);
  return dependencies(primary, map).map(name => `${name}(${map.get(name)!.map(f => `${f.type} ${f.name}`).join(',')})`).join('');
}
function integer(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : fail('EIP712_VALUE_INVALID');
  if (typeof value === 'string' && /^-?(0|[1-9][0-9]{0,77})$/.test(value)) return BigInt(value);
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value)) return BigInt(value);
  return fail('EIP712_VALUE_INVALID');
}
function hexBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) || (value.length - 2) / 2 > MAX_BYTES) fail('EIP712_VALUE_INVALID');
  return bytesOf((value as string).toLowerCase());
}
function encodeAtomic(type: string, value: unknown): Uint8Array {
  if (type === 'string') return typeof value === 'string' && value.length <= MAX_BYTES ? keccak(utf8(value)) : fail('EIP712_VALUE_INVALID');
  if (type === 'bytes') return keccak(hexBytes(value));
  if (type === 'bool') return typeof value === 'boolean' ? wordOf(value ? 1n : 0n) : fail('EIP712_VALUE_INVALID');
  if (type === 'address') {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail('EIP712_VALUE_INVALID');
    return wordOf(BigInt(value as string));
  }
  const fixed = /^bytes([0-9]+)$/.exec(type);
  if (fixed) {
    const bytes = hexBytes(value);
    if (bytes.length !== Number(fixed[1])) fail('EIP712_VALUE_INVALID');
    const out = new Uint8Array(32); out.set(bytes); return out;
  }
  const int = /^(u?)int([0-9]+)$/.exec(type)!, bits = BigInt(int[2]!), n = integer(value);
  if (int[1] === 'u') { if (n < 0n || n >= 1n << bits) fail('EIP712_VALUE_INVALID'); return wordOf(n); }
  const limit = 1n << (bits - 1n);
  if (n < -limit || n >= limit) fail('EIP712_VALUE_INVALID');
  return wordOf(BigInt.asUintN(256, n));
}
function encodeValue(type: string, value: unknown, types: Map<string, readonly TypedDataField[]>, depth: number): Uint8Array {
  if (depth > MAX_DEPTH) fail('EIP712_VALUE_TOO_DEEP');
  const array = arrayOf(type);
  if (array) {
    if (!Array.isArray(value) || value.length > MAX_ARRAY || (array.length !== null && value.length !== array.length)) fail('EIP712_VALUE_INVALID');
    return keccak(concat(...(value as unknown[]).map(item => encodeValue(array.inner, item, types, depth + 1))));
  }
  if (types.has(type)) return hashStructOf(type, value, types, depth + 1);
  if (!isAtomic(type)) fail('EIP712_TYPES_INVALID');
  return encodeAtomic(type, value);
}
function hashStructOf(name: string, value: unknown, types: Map<string, readonly TypedDataField[]>, depth: number): Uint8Array {
  const fields = types.get(name) ?? fail('EIP712_PRIMARY_TYPE_INVALID');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('EIP712_VALUE_INVALID');
  const record = value as Record<string, unknown>;
  // Strict: exactly the declared fields (a missing field is not zero; an extra one is not silently dropped).
  if (Object.keys(record).length !== fields.length || fields.some(f => !Object.hasOwn(record, f.name))) fail('EIP712_VALUE_INVALID');
  const typeHash = keccak(utf8(dependencies(name, types).map(n => `${n}(${types.get(n)!.map(f => `${f.type} ${f.name}`).join(',')})`).join('')));
  return keccak(concat(typeHash, ...fields.map(field => encodeValue(field.type, record[field.name], types, depth))));
}
/** `hashStruct(primaryType, message)` of a struct declared in `types`, as hex. */
export function hashStruct(primaryType: string, message: unknown, types: TypedDataTypes): string {
  return hexOf(hashStructOf(primaryType, message, structTypes(types), 0));
}
/**
 * The domain's own fields: those `types.EIP712Domain` declares (they must be exactly the domain's keys, in the standard order), or — when
 * the payload omits `EIP712Domain` — the keys present, in the standard order. Any other key is refused.
 */
export function domainFields(domain: unknown, declared?: unknown): TypedDataField[] {
  if (!domain || typeof domain !== 'object' || Array.isArray(domain)) return fail('EIP712_DOMAIN_INVALID');
  const keys = Object.keys(domain as Record<string, unknown>);
  if (keys.some(key => !DOMAIN_FIELDS.some(f => f.name === key))) fail('EIP712_DOMAIN_INVALID');
  const present = DOMAIN_FIELDS.filter(f => keys.includes(f.name));
  if (declared !== undefined) {
    if (!Array.isArray(declared) || declared.length !== present.length ||
        declared.some((f, i) => !f || typeof f !== 'object' || (f as TypedDataField).name !== present[i]!.name || (f as TypedDataField).type !== present[i]!.type ||
          Object.keys(f as object).length !== 2)) fail('EIP712_DOMAIN_INVALID');
  }
  if (!present.length) fail('EIP712_DOMAIN_INVALID');
  return present;
}
export function domainSeparator(domain: Readonly<Record<string, unknown>>, declared?: unknown): string {
  const fields = domainFields(domain, declared);
  const types = new Map<string, readonly TypedDataField[]>([['EIP712Domain', fields]]);
  return hexOf(hashStructOf('EIP712Domain', domain, types, 0));
}
/** The digest a wallet signs for `eth_signTypedData_v4`: keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message)). */
export function hashTypedData(data: TypedData): string {
  if (!data || typeof data !== 'object' || typeof data.primaryType !== 'string' || data.primaryType === 'EIP712Domain') return fail('EIP712_PRIMARY_TYPE_INVALID');
  const separator = domainSeparator(data.domain, (data.types as Record<string, unknown> | undefined)?.EIP712Domain);
  const struct = hashStruct(data.primaryType, data.message, data.types);
  return hexOf(keccak(concat(Uint8Array.of(0x19, 0x01), bytesOf(separator), bytesOf(struct))));
}
/** A 65-byte `r ‖ s ‖ v` signature split for APIs that want the parts (`v` normalised to 27/28). */
export function splitSignature(signature: string): { readonly v: 27 | 28; readonly r: string; readonly s: string } {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return fail('EIP712_SIGNATURE_INVALID');
  const raw = signature.toLowerCase(), v = Number.parseInt(raw.slice(130), 16);
  const normalized = v === 0 || v === 1 ? v + 27 : v;
  if (normalized !== 27 && normalized !== 28) fail('EIP712_SIGNATURE_INVALID');
  return { v: normalized as 27 | 28, r: '0x' + raw.slice(2, 66), s: '0x' + raw.slice(66, 130) };
}
/** The lower-case EOA that signed `digest` (65 bytes, low-s, v ∈ {27, 28} or {0, 1}); `EIP712_SIGNATURE_INVALID` otherwise. Recovery only. */
export function recoverTypedDataSigner(digest: string, signature: string): string {
  if (!/^0x[0-9a-f]{64}$/.test(digest)) fail('EIP712_DIGEST_INVALID');
  splitSignature(signature);
  try { return recoverDigestSigner(digest, signature); } catch { return fail('EIP712_SIGNATURE_INVALID'); }
}
