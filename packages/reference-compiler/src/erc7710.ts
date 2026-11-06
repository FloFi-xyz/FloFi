// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-AUTOMATION-002: ERC-7710 delegations of the MetaMask Delegation Framework v1.3.0 — pure encoding, hashing, signer recovery and a
 * model of exactly the caveat enforcers FloFi compiles. Nothing here holds a key or sends anything.
 *
 * The owner's account is a MetaMask EIP-7702 smart account (`EIP7702StatelessDeleGator`). The owner signs ONE EIP-712 `Delegation` to a
 * FloFi session signer; its caveats are the on-chain ceiling of that grant. `DelegationManager.redeemDelegations` validates the owner's
 * signature (for a 7702 account: `isValidSignature` = ECDSA recovery of the account's own key over the same digest), the authority chain,
 * `disabledDelegations`, then runs each enforcer's hooks around the execution, which the owner's account performs as itself.
 *
 * Sources (read at tag v1.3.0): `src/utils/Constants.sol` (typehashes), `src/libraries/EncoderLib.sol` (hashing), `src/DelegationManager.sol`
 * (domain `DelegationManager`/`1`, `ROOT_AUTHORITY`, validation order), the enforcers' `getTermsInfo`, and `documents/Deployments.md`
 * (deterministic addresses). The model below mirrors those hooks for the enforcers FloFi uses; any other enforcer is refused by the model,
 * so it never accepts what it does not understand. A model is not the bytecode: tests that use it are MOCKED evidence.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { parseRlpInteger, rlpBytes, rlpDecode, rlpEncode, rlpInteger, rlpList } from './rlp.js';

function fail(code: string): never { throw new Error(code); }
const HEX = /^0x(?:[0-9a-f]{2})*$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
export const hexOf = (bytes: Uint8Array): string => '0x' + Buffer.from(bytes).toString('hex');
export function bytesOf(hex: string): Uint8Array {
  if (typeof hex !== 'string' || !HEX.test(hex.toLowerCase())) fail('ERC7710_HEX_INVALID');
  return Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
}
const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
export const keccakHex = (bytes: Uint8Array | string): string => hexOf(keccak_256(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes));
export const selectorOf = (signature: string): string => keccakHex(signature).slice(0, 10);
export function evmAddress(value: unknown): string {
  if (typeof value !== 'string' || !ADDRESS.test(value.toLowerCase())) fail('ERC7710_ADDRESS_INVALID');
  return value.toLowerCase();
}

// ── Minimal strict ABI codec (address, uint256, bytes32, bool, bytes, tuples, dynamic arrays) ───────────────────────────────────
export type AbiType = 'address' | 'uint256' | 'bytes32' | 'bool' | 'bytes' | { readonly tuple: readonly AbiType[] } | { readonly array: AbiType };
type AbiValue = string | bigint | boolean | readonly AbiValue[];
const isDynamic = (t: AbiType): boolean => t === 'bytes' || (typeof t === 'object' && ('array' in t || t.tuple.some(isDynamic)));
const staticSize = (t: AbiType): number => typeof t === 'object' && 'tuple' in t ? t.tuple.reduce((n, c) => n + staticSize(c), 0) : 32;
export function word(value: bigint): Uint8Array {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << 256n) fail('ERC7710_ABI_VALUE_INVALID');
  return bytesOf('0x' + value.toString(16).padStart(64, '0'));
}
const pad32 = (bytes: Uint8Array): Uint8Array => concat(bytes, new Uint8Array((32 - bytes.length % 32) % 32));
function encodeValue(type: AbiType, value: AbiValue): Uint8Array {
  if (type === 'address') return concat(new Uint8Array(12), bytesOf(evmAddress(value)));
  if (type === 'uint256') return word(value as bigint);
  if (type === 'bool') return word(value === true ? 1n : value === false ? 0n : fail('ERC7710_ABI_VALUE_INVALID'));
  if (type === 'bytes32') { const b = bytesOf(value as string); return b.length === 32 ? b : fail('ERC7710_ABI_VALUE_INVALID'); }
  if (type === 'bytes') { const b = bytesOf(value as string); return concat(word(BigInt(b.length)), pad32(b)); }
  if ('tuple' in type) return encodeSequence(type.tuple, value as readonly AbiValue[]);
  const items = value as readonly AbiValue[];
  if (!Array.isArray(items)) fail('ERC7710_ABI_VALUE_INVALID');
  return concat(word(BigInt(items.length)), encodeSequence(items.map(() => type.array), items));
}
function encodeSequence(types: readonly AbiType[], values: readonly AbiValue[]): Uint8Array {
  if (!Array.isArray(values) || values.length !== types.length) fail('ERC7710_ABI_VALUE_INVALID');
  const headSize = types.reduce((n, t) => n + (isDynamic(t) ? 32 : staticSize(t)), 0);
  const heads: Uint8Array[] = [], tails: Uint8Array[] = [];
  let offset = headSize;
  types.forEach((t, i) => {
    const encoded = encodeValue(t, values[i]!);
    if (isDynamic(t)) { heads.push(word(BigInt(offset))); tails.push(encoded); offset += encoded.length; } else heads.push(encoded);
  });
  return concat(...heads, ...tails);
}
export const abiEncode = (types: readonly AbiType[], values: readonly AbiValue[]): Uint8Array => encodeSequence(types, values);

function readWord(data: Uint8Array, at: number): bigint {
  if (!Number.isSafeInteger(at) || at < 0 || at + 32 > data.length) fail('ERC7710_ABI_DECODE_INVALID');
  return BigInt(hexOf(data.subarray(at, at + 32)));
}
function readOffset(data: Uint8Array, at: number): number {
  const value = readWord(data, at);
  if (value > BigInt(data.length)) fail('ERC7710_ABI_DECODE_INVALID');
  return Number(value);
}
function decodeValue(type: AbiType, data: Uint8Array, at: number): AbiValue {
  if (type === 'address') { const w = readWord(data, at); if (w >> 160n) fail('ERC7710_ABI_DECODE_INVALID'); return '0x' + w.toString(16).padStart(40, '0'); }
  if (type === 'uint256') return readWord(data, at);
  if (type === 'bool') { const w = readWord(data, at); return w === 1n ? true : w === 0n ? false : fail('ERC7710_ABI_DECODE_INVALID'); }
  if (type === 'bytes32') { readWord(data, at); return hexOf(data.subarray(at, at + 32)); }
  if (type === 'bytes') {
    const length = Number(readWord(data, at));
    if (!Number.isSafeInteger(length) || at + 32 + length > data.length) fail('ERC7710_ABI_DECODE_INVALID');
    return hexOf(data.subarray(at + 32, at + 32 + length));
  }
  if ('tuple' in type) return decodeSequence(type.tuple, data, at);
  const length = Number(readWord(data, at));
  if (!Number.isSafeInteger(length) || length > 4096) fail('ERC7710_ABI_DECODE_INVALID');
  return decodeSequence(Array.from({ length }, () => type.array), data, at + 32);
}
function decodeSequence(types: readonly AbiType[], data: Uint8Array, base: number): AbiValue[] {
  let at = base;
  return types.map(t => {
    const value = isDynamic(t) ? decodeValue(t, data, base + readOffset(data, at)) : decodeValue(t, data, at);
    at += isDynamic(t) ? 32 : staticSize(t);
    return value;
  });
}
/** Decodes and re-encodes: a non-canonical encoding is refused, so a decoded value always has exactly one byte representation. */
export function abiDecode(types: readonly AbiType[], data: Uint8Array): AbiValue[] {
  const values = decodeSequence(types, data, 0);
  if (hexOf(abiEncode(types, values)) !== hexOf(data)) fail('ERC7710_ABI_NON_CANONICAL');
  return values;
}

// ── Framework v1.3.0 constants ───────────────────────────────────────────────────────────────────────────────────────────────
export const DELEGATION_FRAMEWORK_V1_3 = Object.freeze({
  version: '1.3.0',
  delegationManager: '0xdb9b1e94b5b69df7e401ddbede43491141047db3',
  eip7702StatelessDeleGator: '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b',
  enforcers: Object.freeze({
    allowedCalldata: '0xc2b0d624c1c4319760c96503ba27c347f3260f55',
    allowedMethods: '0x2c21fd0cb9dc8445cb3fb0dc5e7bb0aca01842b5',
    allowedTargets: '0x7f20f61b1f09b08d970938f6fa563634d65c4eeb',
    erc20BalanceChange: '0xcdf6ab796408598cea671d79506d7d48e97a5437',
    /** BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the whole calldata of a single call must equal the terms (keccak equality). */
    exactCalldata: '0x99f2e9bf15ce5ec84685604836f71ab835dbbded',
    /** BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: a 32-byte id usable once per (caller, delegator) — one workflow call, once, ever. */
    id: '0xc8b5d93463c893401094cc70e66a206fb5987997',
    limitedCalls: '0x04658b29f6b82ed55274221a06fc97d318e25416',
    logicalOrWrapper: '0xe1302607a3251af54c3a6e69318d6aa07f5eb46c',
    redeemer: '0xe144b0b2618071b4e56f746313528a669c7e65c5',
    timestamp: '0x1046bb45c8d673d4ea75321280db34899413c069',
    valueLte: '0x92bf12322527caa612fd31a0e810472bbb106a8f',
  }),
  source: 'MetaMask/delegation-framework tag v1.3.0, documents/Deployments.md (deterministic CREATE2 deployment)',
});
export type EnforcerName = keyof typeof DELEGATION_FRAMEWORK_V1_3.enforcers;
export const ROOT_AUTHORITY = '0x' + 'f'.repeat(64);
/** The 7702 designator an upgraded owner account carries: `0xef0100 ‖ implementation`. */
export const DELEGATOR_DESIGNATOR = '0xef0100' + DELEGATION_FRAMEWORK_V1_3.eip7702StatelessDeleGator.slice(2);
export const EIP712_DOMAIN_TYPEHASH = keccakHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
export const DELEGATION_TYPEHASH = keccakHex('Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)');
export const CAVEAT_TYPEHASH = keccakHex('Caveat(address enforcer,bytes terms)');
const CAVEAT_TUPLE: AbiType = { tuple: ['address', 'bytes', 'bytes'] };
const DELEGATION_TUPLE: AbiType = { tuple: ['address', 'address', 'bytes32', { array: CAVEAT_TUPLE }, 'uint256', 'bytes'] };
const DELEGATION_SIGNATURE = '(address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)';
export const REDEEM_DELEGATIONS_SELECTOR = selectorOf('redeemDelegations(bytes[],bytes32[],bytes[])');
export const DISABLE_DELEGATION_SELECTOR = selectorOf(`disableDelegation(${DELEGATION_SIGNATURE})`);
export const DISABLED_DELEGATIONS_SELECTOR = selectorOf('disabledDelegations(bytes32)');
export const REDEEMED_DELEGATION_TOPIC = keccakHex(`RedeemedDelegation(address,address,${DELEGATION_SIGNATURE})`);
export const DISABLED_DELEGATION_TOPIC = keccakHex(`DisabledDelegation(bytes32,address,address,${DELEGATION_SIGNATURE})`);
/** `ModeCode` for a single call with the default exec type: CALLTYPE_SINGLE 0x00, EXECTYPE_DEFAULT 0x00, no selector, no payload. */
export const MODE_SINGLE_DEFAULT = '0x' + '0'.repeat(64);
export const APPROVE_METHOD = '0x095ea7b3';
export const EXACT_INPUT_SINGLE_METHOD = '0x04e45aaf';
/** Aave V3 Pool `supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)`. */
export const AAVE_V3_SUPPLY_METHOD = selectorOf('supply(address,uint256,address,uint16)');
/** Aave V3 Pool `borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)`. */
export const AAVE_V3_BORROW_METHOD = selectorOf('borrow(address,uint256,uint256,uint16,address)');
/** Aave V3 variable-rate interest mode (the only mode FloFi borrows with). */
export const AAVE_V3_VARIABLE_RATE = 2n;

export type Caveat = { readonly enforcer: string; readonly terms: string; readonly args: string };
export type Delegation = { readonly delegate: string; readonly delegator: string; readonly authority: string; readonly caveats: readonly Caveat[];
  readonly salt: bigint; readonly signature: string };

const caveatHash = (c: Caveat): Uint8Array => keccak_256(abiEncode(['bytes32', 'address', 'bytes32'], [CAVEAT_TYPEHASH, c.enforcer, keccakHex(bytesOf(c.terms))]));
/** `EncoderLib._getDelegationHash`: signature and caveat args are excluded, so they never change what the owner signed. */
export function delegationHash(d: Omit<Delegation, 'signature'>): string {
  const caveats = keccakHex(concat(...d.caveats.map(caveatHash)));
  return keccakHex(abiEncode(['bytes32', 'address', 'address', 'bytes32', 'bytes32', 'uint256'],
    [DELEGATION_TYPEHASH, evmAddress(d.delegate), evmAddress(d.delegator), d.authority, caveats, d.salt]));
}
export function domainSeparator(chainId: number, manager = DELEGATION_FRAMEWORK_V1_3.delegationManager): string {
  return keccakHex(abiEncode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [EIP712_DOMAIN_TYPEHASH, keccakHex('DelegationManager'), keccakHex('1'), BigInt(chainId), manager]));
}
/** `MessageHashUtils.toTypedDataHash(domain, delegationHash)` — what the owner's wallet signs and the manager verifies. */
export function delegationDigest(chainId: number, d: Omit<Delegation, 'signature'>): string {
  return keccakHex(concat(Uint8Array.of(0x19, 0x01), bytesOf(domainSeparator(chainId)), bytesOf(delegationHash(d))));
}
/** The `eth_signTypedData_v4` payload of a delegation (caveat args are not part of the type). */
export function delegationTypedData(chainId: number, d: Omit<Delegation, 'signature'>) {
  return {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      Delegation: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' },
        { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' }],
      Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }],
    },
    primaryType: 'Delegation' as const,
    domain: { name: 'DelegationManager', version: '1', chainId, verifyingContract: DELEGATION_FRAMEWORK_V1_3.delegationManager },
    message: { delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats: d.caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms })),
      salt: d.salt.toString() },
  };
}
/** The address whose key produced a 65-byte r ‖ s ‖ v signature over a 32-byte digest (low-s enforced), or a closed refusal. */
export function recoverDigestSigner(digest: string, signature: string): string {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) fail('ERC7710_SIGNATURE_INVALID');
  const raw = bytesOf(signature.toLowerCase()), v = raw[64]!, recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) fail('ERC7710_SIGNATURE_INVALID');
  try {
    const hash = bytesOf(digest), compact = raw.subarray(0, 64);
    const publicKey = secp256k1.Signature.fromBytes(compact).addRecoveryBit(recovery).recoverPublicKey(hash).toBytes(false);
    if (!secp256k1.verify(compact, hash, publicKey, { prehash: false })) fail('ERC7710_SIGNATURE_INVALID');
    return hexOf(keccak_256(publicKey.subarray(1)).subarray(12));
  } catch { return fail('ERC7710_SIGNATURE_INVALID'); }
}

// ── Caveat terms (exactly the `getTermsInfo` layouts) ───────────────────────────────────────────────────────────────────────
const E = DELEGATION_FRAMEWORK_V1_3.enforcers;
const caveat = (enforcer: string, terms: Uint8Array): Caveat => ({ enforcer, terms: hexOf(terms), args: '0x' });
const u128 = (value: bigint) => { if (value < 0n || value >= 1n << 128n) fail('ERC7710_TERMS_INVALID'); return bytesOf('0x' + value.toString(16).padStart(32, '0')); };
export const terms = Object.freeze({
  allowedTargets: (targets: readonly string[]) => targets.length ? caveat(E.allowedTargets, concat(...targets.map(t => bytesOf(evmAddress(t))))) : fail('ERC7710_TERMS_INVALID'),
  allowedMethods: (selectors: readonly string[]) => selectors.length && selectors.every(s => /^0x[0-9a-f]{8}$/.test(s))
    ? caveat(E.allowedMethods, concat(...selectors.map(bytesOf))) : fail('ERC7710_TERMS_INVALID'),
  /** `dataStart` (32 bytes) ‖ expected bytes at that calldata offset. */
  allowedCalldata: (dataStart: number, value: Uint8Array) => value.length ? caveat(E.allowedCalldata, concat(word(BigInt(dataStart)), value)) : fail('ERC7710_TERMS_INVALID'),
  valueLte: (max: bigint) => caveat(E.valueLte, word(max)),
  /** Open bounds: usable strictly after `after` and strictly before `before` (seconds; 0 = unbounded). */
  timestamp: (after: bigint, before: bigint) => caveat(E.timestamp, concat(u128(after), u128(before))),
  limitedCalls: (limit: bigint) => limit > 0n ? caveat(E.limitedCalls, word(limit)) : fail('ERC7710_TERMS_INVALID'),
  redeemer: (redeemers: readonly string[]) => redeemers.length ? caveat(E.redeemer, concat(...redeemers.map(r => bytesOf(evmAddress(r))))) : fail('ERC7710_TERMS_INVALID'),
  /** 73 bytes: decrease flag ‖ token ‖ recipient ‖ amount (maximum decrease, or minimum increase). */
  erc20BalanceChange: (decrease: boolean, token: string, recipient: string, amount: bigint) =>
    caveat(E.erc20BalanceChange, concat(Uint8Array.of(decrease ? 1 : 0), bytesOf(evmAddress(token)), bytesOf(evmAddress(recipient)), word(amount))),
  /** The exact calldata of the call (any length, including empty for a plain native transfer). */
  exactCalldata: (data: string) => caveat(E.exactCalldata, bytesOf(data)),
  /** IdEnforcer: one 32-byte id; the first successful redemption that carries it marks it used for this delegator, forever. */
  id: (value: bigint) => value >= 0n && value < 1n << 256n ? caveat(E.id, word(value)) : fail('ERC7710_TERMS_INVALID'),
  /** `abi.encode(CaveatGroup[])`, `CaveatGroup { Caveat[] caveats }`. Every group must be a complete, equally safe permission set. */
  logicalOrWrapper: (groups: readonly (readonly Caveat[])[]) => groups.length && groups.every(g => g.length)
    ? caveat(E.logicalOrWrapper, abiEncode([{ array: { tuple: [{ array: CAVEAT_TUPLE }] } }], [groups.map(g => [g.map(c => [c.enforcer, c.terms, c.args])])]))
    : fail('ERC7710_TERMS_INVALID'),
});
/** `abi.encode(SelectedGroup)`: the group the redeemer selects, with one (empty) argument per caveat of that group. */
export const logicalOrArgs = (groupIndex: number, caveatCount: number): string =>
  hexOf(abiEncode([{ tuple: ['uint256', { array: 'bytes' }] }], [[BigInt(groupIndex), Array.from({ length: caveatCount }, () => '0x')]]));
export function decodeLogicalOrTerms(termsHex: string): Caveat[][] {
  const [groups] = abiDecode([{ array: { tuple: [{ array: CAVEAT_TUPLE }] } }], bytesOf(termsHex)) as [[[string, string, string][]][]];
  return groups.map(([caveats]) => caveats.map(([enforcer, t, args]) => ({ enforcer, terms: t, args })));
}
export function decodeLogicalOrArgs(argsHex: string): { readonly groupIndex: number; readonly caveatArgs: readonly string[] } {
  const [[index, args]] = abiDecode([{ tuple: ['uint256', { array: 'bytes' }] }], bytesOf(argsHex)) as [[bigint, string[]]];
  if (index > 1024n) fail('ERC7710_ABI_DECODE_INVALID');
  return { groupIndex: Number(index), caveatArgs: args };
}

// ── FloFi call templates → one signed grant ─────────────────────────────────────────────────────────────────────────────────
/**
 * The call classes FloFi can scope on-chain with fixed calldata offsets. Each becomes one LogicalOrWrapper group whose caveats pin the
 * target, the selector and every material calldata word, so the least restrictive group is still the intended permission.
 */
export type CallTemplate =
  /**
   * `approve(spender, amount)`. BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: with `amount` the approved amount is pinned exactly (a Credential's
   * swap approval is its pair's per-call cap), so a compromised session key can never grant an unlimited or larger allowance.
   */
  | { readonly kind: 'ERC20_APPROVE'; readonly token: string; readonly spender: string; readonly amount?: bigint }
  /**
   * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: with `fee` the pool fee tier is pinned and `sqrtPriceLimitX96` must be 0, so a compromised
   * session key cannot route a Credential's swap through another (thin) pool or a partial-fill price limit. The minimum output of a reusable
   * Credential swap still cannot be pinned on-chain (it depends on the price at execution): that bound is the per-call input cap, and a
   * workflow run uses an exact workflow grant (`compileWorkflowGrant`) whose signed calldata includes the minimum output.
   */
  | { readonly kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE'; readonly router: string; readonly tokenIn: string; readonly tokenOut: string; readonly perCallInputCap: bigint;
      readonly fee?: number }
  /**
   * BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: `Pool.supply(asset, amount, onBehalfOf = owner, referralCode = 0)` from the owner's account.
   * On-chain: target, selector, asset, beneficiary (the owner's own position), no referral, and at most `perCallCap` of the asset leaving the
   * owner's account per call (ERC20BalanceChangeEnforcer).
   */
  | { readonly kind: 'AAVE_V3_SUPPLY'; readonly pool: string; readonly asset: string; readonly perCallCap: bigint }
  /**
   * BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: `Pool.borrow(asset, amount, 2, 0, onBehalfOf = owner)` from the owner's account. On-chain: target,
   * selector, asset, VARIABLE rate only, no referral, the debt is the owner's own, the borrowed asset must arrive in the owner's account, and
   * the amount is below a byte-aligned ceiling (`borrowCeiling(perCallCap)`: its leading calldata bytes are pinned to zero). v1.3.0 has no
   * "argument ≤ x" enforcer, so the exact cap is the executor's (re-checked against the workflow authorization before every signature).
   */
  | { readonly kind: 'AAVE_V3_BORROW'; readonly pool: string; readonly asset: string; readonly perCallCap: bigint };
/** The smallest power of 256 strictly above `cap`: the on-chain ceiling of a Borrow template (amount < ceiling, enforced by AllowedCalldata). */
export function borrowCeiling(cap: bigint): bigint {
  if (cap <= 0n || cap >= 1n << 248n) fail('ERC7710_TEMPLATE_INVALID');
  let bytes = 1n;
  while (cap >= 1n << (8n * bytes)) bytes++;
  return 1n << (8n * bytes);
}
export type GrantScope = {
  readonly chainId: number; readonly owner: string; readonly session: string; readonly validAfter: bigint; readonly validBefore: bigint;
  readonly maxCalls: bigint; readonly templates: readonly CallTemplate[]; readonly salt: bigint;
};
const addressWord = (value: string) => concat(new Uint8Array(12), bytesOf(evmAddress(value)));
export function templateGroup(template: CallTemplate, owner: string): Caveat[] {
  if (template.kind === 'ERC20_APPROVE') {
    if (template.amount !== undefined && template.amount <= 0n) fail('ERC7710_TEMPLATE_INVALID');
    return [terms.allowedTargets([template.token]), terms.allowedMethods([APPROVE_METHOD]),
      terms.allowedCalldata(4, template.amount === undefined ? addressWord(template.spender) : concat(addressWord(template.spender), word(template.amount)))];
  }
  if (template.kind === 'AAVE_V3_SUPPLY') {
    if (template.perCallCap <= 0n) fail('ERC7710_TEMPLATE_INVALID');
    // supply calldata: asset @4, amount @36, onBehalfOf @68, referralCode @100.
    return [terms.allowedTargets([template.pool]), terms.allowedMethods([AAVE_V3_SUPPLY_METHOD]), terms.allowedCalldata(4, addressWord(template.asset)),
      terms.allowedCalldata(68, addressWord(owner)), terms.allowedCalldata(100, word(0n)),
      terms.erc20BalanceChange(true, template.asset, owner, template.perCallCap)];
  }
  if (template.kind === 'AAVE_V3_BORROW') {
    // borrow calldata: asset @4, amount @36, interestRateMode @68, referralCode @100, onBehalfOf @132. The amount's leading zero bytes bound it.
    const ceiling = borrowCeiling(template.perCallCap), significant = (ceiling.toString(16).length - 1) / 2;
    return [terms.allowedTargets([template.pool]), terms.allowedMethods([AAVE_V3_BORROW_METHOD]), terms.allowedCalldata(4, addressWord(template.asset)),
      terms.allowedCalldata(36, new Uint8Array(32 - significant)), terms.allowedCalldata(68, word(AAVE_V3_VARIABLE_RATE)), terms.allowedCalldata(100, word(0n)),
      terms.allowedCalldata(132, addressWord(owner)), terms.erc20BalanceChange(false, template.asset, owner, 1n)];
  }
  if (template.perCallInputCap <= 0n || evmAddress(template.tokenIn) === evmAddress(template.tokenOut)) fail('ERC7710_TEMPLATE_INVALID');
  // IV3SwapRouter.ExactInputSingleParams: tokenIn @4, tokenOut @36, fee @68, recipient @100, amountIn @132, amountOutMinimum @164, sqrtPriceLimitX96 @196.
  if (template.fee !== undefined && !UNISWAP_V3_FEES.includes(template.fee)) fail('ERC7710_TEMPLATE_INVALID');
  return [terms.allowedTargets([template.router]), terms.allowedMethods([EXACT_INPUT_SINGLE_METHOD]),
    ...template.fee === undefined ? [terms.allowedCalldata(4, addressWord(template.tokenIn)), terms.allowedCalldata(36, addressWord(template.tokenOut))]
      : [terms.allowedCalldata(4, concat(addressWord(template.tokenIn), addressWord(template.tokenOut), word(BigInt(template.fee)))), terms.allowedCalldata(196, word(0n))],
    terms.allowedCalldata(100, addressWord(owner)), terms.erc20BalanceChange(true, template.tokenIn, owner, template.perCallInputCap)];
}
/** The unsigned root delegation of a grant. Top-level caveats bind redeemer, validity, call count and zero native value. */
export function compileGrant(scope: GrantScope): Omit<Delegation, 'signature'> {
  if (!Number.isSafeInteger(scope.chainId) || scope.chainId <= 0 || !scope.templates.length || scope.templates.length > 16 || scope.maxCalls <= 0n
    || scope.validBefore <= scope.validAfter || scope.salt < 0n) fail('ERC7710_SCOPE_INVALID');
  const owner = evmAddress(scope.owner), session = evmAddress(scope.session);
  if (owner === session) fail('ERC7710_SCOPE_INVALID');
  return { delegate: session, delegator: owner, authority: ROOT_AUTHORITY, salt: scope.salt, caveats: [terms.redeemer([session]),
    terms.timestamp(scope.validAfter, scope.validBefore), terms.limitedCalls(scope.maxCalls), terms.valueLte(0n),
    terms.logicalOrWrapper(scope.templates.map(t => templateGroup(t, owner)))] };
}
export type Call = { readonly target: string; readonly value: bigint; readonly data: string };

// ── Workflow-scoped grants: exact calls, each usable once (BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001) ─────────────────────
/**
 * One owner signature per chain authorizes exactly the calls of one immutable workflow on that chain, and nothing else:
 *
 *   root caveats       Redeemer(session) · Timestamp(validAfter, validBefore) · LimitedCalls(number of calls) · ValueLte(largest native value)
 *   one group per call AllowedTargets([target]) · ExactCalldata(the call's whole calldata) · ValueLte(its native value) · Id(its own id)
 *
 * Every amount, asset, recipient, beneficiary, rate mode, fee tier and minimum output is part of the exact calldata the owner signed. A
 * compromised session key can only redeem a subset of these calls, in any order, each at most once (IdEnforcer: an interrupted run can never
 * reuse a call that already succeeded), before validBefore, and nothing after the owner disables the delegation. The workflow's dependent
 * amounts are therefore fixed when the owner signs: a step consuming an earlier step's output uses that step's on-chain guaranteed minimum.
 */
export type WorkflowCall =
  | { readonly kind: 'ERC20_APPROVE'; readonly token: string; readonly spender: string; readonly amount: bigint }
  | { readonly kind: 'ERC20_TRANSFER'; readonly token: string; readonly to: string; readonly amount: bigint }
  | { readonly kind: 'NATIVE_TRANSFER'; readonly to: string; readonly amount: bigint }
  /** SwapRouter02 `exactInputSingle`: the output goes to the owner; `amountOutMinimum` is enforced by the router itself. */
  | { readonly kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE'; readonly router: string; readonly tokenIn: string; readonly tokenOut: string; readonly fee: number;
      readonly amountIn: bigint; readonly amountOutMinimum: bigint }
  /** Aave V3 `supply(asset, amount, owner, 0)`. */
  | { readonly kind: 'AAVE_V3_SUPPLY'; readonly pool: string; readonly asset: string; readonly amount: bigint }
  /** Aave V3 `borrow(asset, amount, 2 (variable), 0, owner)`: the exact amount, the owner's own debt, the asset paid to the owner. */
  | { readonly kind: 'AAVE_V3_BORROW'; readonly pool: string; readonly asset: string; readonly amount: bigint }
  /** Aave V3 `repay(asset, amount, 2 (variable), owner)`: the owner's own variable debt. */
  | { readonly kind: 'AAVE_V3_REPAY'; readonly pool: string; readonly asset: string; readonly amount: bigint }
  /** Aave V3 `withdraw(asset, amount, owner)`: back to the owner's own account. */
  | { readonly kind: 'AAVE_V3_WITHDRAW'; readonly pool: string; readonly asset: string; readonly amount: bigint };
export const ERC20_TRANSFER_METHOD = selectorOf('transfer(address,uint256)');
/** Aave V3 Pool `repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)`. */
export const AAVE_V3_REPAY_METHOD = selectorOf('repay(address,uint256,uint256,address)');
/** Aave V3 Pool `withdraw(address asset, uint256 amount, address to)`. */
export const AAVE_V3_WITHDRAW_METHOD = selectorOf('withdraw(address,uint256,address)');
/** The Uniswap v3 fee tiers a workflow swap may name. */
export const UNISWAP_V3_FEES: readonly number[] = Object.freeze([100, 500, 3000, 10000]);
/** The longest window a workflow grant may be valid for (the product chooses a much shorter one). */
export const WORKFLOW_GRANT_MAX_WINDOW_SECONDS = 7n * 24n * 3600n;
export const WORKFLOW_GRANT_MAX_CALLS = 16;
const UINT256_MAX = (1n << 256n) - 1n;
const exactAmount = (value: bigint) => value > 0n && value < UINT256_MAX ? value : fail('ERC7710_WORKFLOW_CALL_INVALID');
const callHex = (selector: string, ...parts: readonly Uint8Array[]) => selector + hexOf(concat(...parts)).slice(2);
/** The exact single call one workflow call is, from the owner's account (the bytes ExactCalldata pins). */
export function workflowCallData(call: WorkflowCall, owner: string): Call {
  const o = evmAddress(owner);
  switch (call.kind) {
    case 'ERC20_APPROVE': return { target: evmAddress(call.token), value: 0n, data: callHex(APPROVE_METHOD, addressWord(call.spender), word(exactAmount(call.amount))) };
    case 'ERC20_TRANSFER': return { target: evmAddress(call.token), value: 0n, data: callHex(ERC20_TRANSFER_METHOD, addressWord(call.to), word(exactAmount(call.amount))) };
    case 'NATIVE_TRANSFER': return { target: evmAddress(call.to), value: exactAmount(call.amount), data: '0x' };
    case 'UNISWAP_V3_EXACT_INPUT_SINGLE': {
      if (!UNISWAP_V3_FEES.includes(call.fee) || evmAddress(call.tokenIn) === evmAddress(call.tokenOut) || call.amountOutMinimum <= 0n || call.amountOutMinimum >= UINT256_MAX)
        fail('ERC7710_WORKFLOW_CALL_INVALID');
      // IV3SwapRouter.ExactInputSingleParams: tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96 (0: no limit).
      return { target: evmAddress(call.router), value: 0n, data: callHex(EXACT_INPUT_SINGLE_METHOD, addressWord(call.tokenIn), addressWord(call.tokenOut),
        word(BigInt(call.fee)), addressWord(o), word(exactAmount(call.amountIn)), word(call.amountOutMinimum), word(0n)) };
    }
    case 'AAVE_V3_SUPPLY': return { target: evmAddress(call.pool), value: 0n,
      data: callHex(AAVE_V3_SUPPLY_METHOD, addressWord(call.asset), word(exactAmount(call.amount)), addressWord(o), word(0n)) };
    case 'AAVE_V3_BORROW': return { target: evmAddress(call.pool), value: 0n,
      data: callHex(AAVE_V3_BORROW_METHOD, addressWord(call.asset), word(exactAmount(call.amount)), word(AAVE_V3_VARIABLE_RATE), word(0n), addressWord(o)) };
    case 'AAVE_V3_REPAY': return { target: evmAddress(call.pool), value: 0n,
      data: callHex(AAVE_V3_REPAY_METHOD, addressWord(call.asset), word(exactAmount(call.amount)), word(AAVE_V3_VARIABLE_RATE), addressWord(o)) };
    case 'AAVE_V3_WITHDRAW': return { target: evmAddress(call.pool), value: 0n,
      data: callHex(AAVE_V3_WITHDRAW_METHOD, addressWord(call.asset), word(exactAmount(call.amount)), addressWord(o)) };
    default: return fail('ERC7710_WORKFLOW_CALL_INVALID');
  }
}
/** The IdEnforcer id of call `index` of one workflow grant: unique per chain, owner and grant salt (never reused across grants). */
export function workflowCallId(chainId: number, owner: string, salt: bigint, index: number): bigint {
  return BigInt(keccakHex(abiEncode(['bytes32', 'uint256', 'address', 'uint256', 'uint256'],
    [keccakHex('flofi.workflow-call.v1'), BigInt(chainId), evmAddress(owner), salt, BigInt(index)])));
}
export type WorkflowGrantScope = {
  readonly chainId: number; readonly owner: string; readonly session: string; readonly validAfter: bigint; readonly validBefore: bigint;
  readonly calls: readonly WorkflowCall[]; readonly salt: bigint;
};
/** The unsigned root delegation of a workflow grant (see WorkflowCall). */
export function compileWorkflowGrant(scope: WorkflowGrantScope): Omit<Delegation, 'signature'> {
  if (!Number.isSafeInteger(scope.chainId) || scope.chainId <= 0 || !scope.calls.length || scope.calls.length > WORKFLOW_GRANT_MAX_CALLS
    || scope.validAfter < 0n || scope.validBefore <= scope.validAfter || scope.validBefore - scope.validAfter > WORKFLOW_GRANT_MAX_WINDOW_SECONDS
    || scope.salt < 0n || scope.salt > UINT256_MAX) fail('ERC7710_SCOPE_INVALID');
  const owner = evmAddress(scope.owner), session = evmAddress(scope.session);
  if (owner === session) fail('ERC7710_SCOPE_INVALID');
  const calls = scope.calls.map(c => workflowCallData(c, owner));
  const maxValue = calls.reduce((m, c) => c.value > m ? c.value : m, 0n);
  const groups = calls.map((c, i) => [terms.allowedTargets([c.target]), terms.exactCalldata(c.data), terms.valueLte(c.value),
    terms.id(workflowCallId(scope.chainId, owner, scope.salt, i))]);
  return { delegate: session, delegator: owner, authority: ROOT_AUTHORITY, salt: scope.salt, caveats: [terms.redeemer([session]),
    terms.timestamp(scope.validAfter, scope.validBefore), terms.limitedCalls(BigInt(calls.length)), terms.valueLte(maxValue), terms.logicalOrWrapper(groups)] };
}
/**
 * The exact calls a delegation authorizes when it has the workflow-grant shape, else null: what an owner's wallet signature actually
 * permits, read back from the caveats alone (for display, verification and the adversarial probe), never from FloFi's own records.
 */
export function workflowGrantCalls(d: Omit<Delegation, 'signature'>): readonly (Call & { readonly id: bigint })[] | null {
  const [redeemer, timestamp, limited, value, or, ...rest] = d.caveats;
  if (rest.length || !redeemer || redeemer.enforcer !== E.redeemer || timestamp?.enforcer !== E.timestamp || limited?.enforcer !== E.limitedCalls
    || value?.enforcer !== E.valueLte || or?.enforcer !== E.logicalOrWrapper) return null;
  let groups: Caveat[][];
  try { groups = decodeLogicalOrTerms(or.terms); } catch { return null; }
  if (BigInt(limited.terms) !== BigInt(groups.length)) return null;
  const out: (Call & { id: bigint })[] = [];
  for (const g of groups) {
    const [targets, exact, lte, id, ...more] = g;
    if (more.length || targets?.enforcer !== E.allowedTargets || exact?.enforcer !== E.exactCalldata || lte?.enforcer !== E.valueLte || id?.enforcer !== E.id) return null;
    if (bytesOf(targets.terms).length !== 20 || bytesOf(lte.terms).length !== 32 || bytesOf(id.terms).length !== 32) return null;
    out.push({ target: hexOf(bytesOf(targets.terms)), value: BigInt(lte.terms), data: exact.terms, id: BigInt(id.terms) });
  }
  return out;
}
/** `ExecutionLib.encodeSingle`: target ‖ value ‖ calldata, packed. */
export const encodeSingleExecution = (call: Call): string => hexOf(concat(bytesOf(evmAddress(call.target)), word(call.value), bytesOf(call.data)));
export function decodeSingleExecution(packed: string): Call {
  const b = bytesOf(packed);
  if (b.length < 52) fail('ERC7710_EXECUTION_INVALID');
  return { target: hexOf(b.subarray(0, 20)), value: BigInt(hexOf(b.subarray(20, 52))), data: hexOf(b.subarray(52)) };
}
const delegationValue = (d: Delegation) => [d.delegate, d.delegator, d.authority, d.caveats.map(c => [c.enforcer, c.terms, c.args]), d.salt, d.signature];
/** The signed delegation with per-call args: the LogicalOrWrapper caveat selects `groupIndex`. */
export function withGroupArgs(d: Delegation, groupIndex: number): Delegation {
  return { ...d, caveats: d.caveats.map(c => c.enforcer !== E.logicalOrWrapper ? { ...c, args: '0x' }
    : { ...c, args: logicalOrArgs(groupIndex, decodeLogicalOrTerms(c.terms)[groupIndex]?.length ?? fail('ERC7710_GROUP_INVALID')) }) };
}
export const permissionContext = (chain: readonly Delegation[]): string => hexOf(abiEncode([{ array: DELEGATION_TUPLE }], [chain.map(delegationValue)]));
export function decodePermissionContext(context: string): Delegation[] {
  const [items] = abiDecode([{ array: DELEGATION_TUPLE }], bytesOf(context)) as [[string, string, string, [string, string, string][], bigint, string][]];
  return items.map(([delegate, delegator, authority, caveats, salt, signature]) => ({ delegate, delegator, authority, salt, signature,
    caveats: caveats.map(([enforcer, t, args]) => ({ enforcer, terms: t, args })) }));
}
/** `redeemDelegations([context], [MODE_SINGLE_DEFAULT], [encodeSingle(call)])` — one canonical single-call redemption. */
export function redeemCalldata(delegation: Delegation, groupIndex: number, call: Call): string {
  return REDEEM_DELEGATIONS_SELECTOR + hexOf(abiEncode([{ array: 'bytes' }, { array: 'bytes32' }, { array: 'bytes' }],
    [[permissionContext([withGroupArgs(delegation, groupIndex)])], [MODE_SINGLE_DEFAULT], [encodeSingleExecution(call)]])).slice(2);
}
export function decodeRedeemCalldata(data: string): { readonly contexts: readonly string[]; readonly modes: readonly string[]; readonly executions: readonly string[] } {
  if (!data.toLowerCase().startsWith(REDEEM_DELEGATIONS_SELECTOR)) fail('ERC7710_REDEEM_INVALID');
  const [contexts, modes, executions] = abiDecode([{ array: 'bytes' }, { array: 'bytes32' }, { array: 'bytes' }], bytesOf('0x' + data.slice(10).toLowerCase())) as [string[], string[], string[]];
  if (contexts.length !== modes.length || modes.length !== executions.length) fail('ERC7710_REDEEM_INVALID');
  return { contexts, modes, executions };
}
/** The owner's own revocation: a self-call of the 7702 account's `disableDelegation(delegation)`. */
export const disableDelegationCalldata = (d: Delegation): string => DISABLE_DELEGATION_SELECTOR + hexOf(abiEncode([DELEGATION_TUPLE], [delegationValue(d)])).slice(2);
export function decodeDisableDelegationCalldata(data: string): Delegation {
  if (!data.toLowerCase().startsWith(DISABLE_DELEGATION_SELECTOR)) fail('ERC7710_DISABLE_INVALID');
  const [[delegate, delegator, authority, caveats, salt, signature]] = abiDecode([DELEGATION_TUPLE], bytesOf('0x' + data.slice(10).toLowerCase())) as
    [[string, string, string, [string, string, string][], bigint, string]];
  return { delegate, delegator, authority, salt, signature, caveats: caveats.map(([enforcer, t, args]) => ({ enforcer, terms: t, args })) };
}
export function disabledDelegationsCalldata(hash: string): string {
  if (bytesOf(hash).length !== 32) fail('ERC7710_HASH_INVALID');
  return DISABLED_DELEGATIONS_SELECTOR + hash.slice(2).toLowerCase();
}

// ── Enforcer model (MOCKED evidence only; mirrors the v1.3.0 hooks for the enforcers above) ─────────────────────────────────────
export type ModelContext = {
  readonly redeemer: string; readonly call: Call; readonly blockTimestamp: bigint; readonly delegationHash: string;
  /** Calls already counted for this delegation by LimitedCallsEnforcer. */
  readonly callCount: bigint;
  /**
   * IdEnforcer state: the ids already used, keyed `${caller}:${delegator}:${id}` where caller is `manager` (a root caveat) or `wrapper` (a caveat
   * inside LogicalOrWrapper, whose hooks the wrapper calls). Absent ⇒ no id has been used.
   */
  readonly usedIds?: ReadonlySet<string>;
  /** The delegator (IdEnforcer keys ids per delegator); absent ⇒ ids are keyed with an empty delegator. */
  readonly delegator?: string;
};
export type BalanceRule = { readonly decrease: boolean; readonly token: string; readonly recipient: string; readonly amount: bigint };
export type ModelVerdict = { readonly ok: true; readonly groupIndex: number | null; readonly countsCall: boolean; readonly balanceRules: readonly BalanceRule[];
  /** IdEnforcer keys this redemption marks used when it succeeds (see ModelContext.usedIds). */
  readonly usedIds: readonly string[] }
  | { readonly ok: false; readonly code: string };
type CaveatResult = { ok: true; countsCall: boolean; balanceRules: BalanceRule[]; groupIndex: number | null; usedIds: string[] } | { ok: false; code: string };
function checkCaveat(c: Caveat, ctx: ModelContext, caller: 'manager' | 'wrapper' = 'manager'): CaveatResult {
  const t = bytesOf(c.terms), data = bytesOf(ctx.call.data);
  const pass: CaveatResult = { ok: true, countsCall: false, balanceRules: [], groupIndex: null, usedIds: [] };
  const addresses = (bytes: Uint8Array) => bytes.length && bytes.length % 20 === 0 ? Array.from({ length: bytes.length / 20 }, (_, i) => hexOf(bytes.subarray(i * 20, i * 20 + 20))) : null;
  switch (c.enforcer) {
    case E.allowedTargets: { const list = addresses(t); return !list ? { ok: false, code: 'AllowedTargetsEnforcer:invalid-terms-length' }
      : list.includes(evmAddress(ctx.call.target)) ? pass : { ok: false, code: 'AllowedTargetsEnforcer:target-address-not-allowed' }; }
    case E.allowedMethods: {
      if (!t.length || t.length % 4) return { ok: false, code: 'AllowedMethodsEnforcer:invalid-terms-length' };
      if (data.length < 4) return { ok: false, code: 'AllowedMethodsEnforcer:invalid-execution-data-length' };
      const method = hexOf(data.subarray(0, 4));
      return Array.from({ length: t.length / 4 }, (_, i) => hexOf(t.subarray(i * 4, i * 4 + 4))).includes(method) ? pass : { ok: false, code: 'AllowedMethodsEnforcer:method-not-allowed' };
    }
    case E.allowedCalldata: {
      if (t.length < 33) return { ok: false, code: 'AllowedCalldataEnforcer:invalid-terms-size' };
      const start = BigInt(hexOf(t.subarray(0, 32))), value = t.subarray(32);
      if (start + BigInt(value.length) > BigInt(data.length)) return { ok: false, code: 'AllowedCalldataEnforcer:invalid-calldata-length' };
      return hexOf(data.subarray(Number(start), Number(start) + value.length)) === hexOf(value) ? pass : { ok: false, code: 'AllowedCalldataEnforcer:invalid-calldata' };
    }
    case E.valueLte: return t.length !== 32 ? { ok: false, code: 'ValueLteEnforcer:invalid-terms-length' }
      : ctx.call.value <= BigInt(hexOf(t)) ? pass : { ok: false, code: 'ValueLteEnforcer:value-too-high' };
    case E.timestamp: {
      if (t.length !== 32) return { ok: false, code: 'TimestampEnforcer:invalid-terms-length' };
      const after = BigInt(hexOf(t.subarray(0, 16))), before = BigInt(hexOf(t.subarray(16)));
      if (after > 0n && !(ctx.blockTimestamp > after)) return { ok: false, code: 'TimestampEnforcer:early-delegation' };
      if (before > 0n && !(ctx.blockTimestamp < before)) return { ok: false, code: 'TimestampEnforcer:expired-delegation' };
      return pass;
    }
    case E.limitedCalls: return t.length !== 32 ? { ok: false, code: 'LimitedCallsEnforcer:invalid-terms-length' }
      : ctx.callCount + 1n <= BigInt(hexOf(t)) ? { ...pass, countsCall: true } : { ok: false, code: 'LimitedCallsEnforcer:limit-exceeded' };
    case E.redeemer: { const list = addresses(t); return !list ? { ok: false, code: 'RedeemerEnforcer:invalid-terms-length' }
      : list.includes(evmAddress(ctx.redeemer)) ? pass : { ok: false, code: 'RedeemerEnforcer:unauthorized-redeemer' }; }
    case E.exactCalldata: return keccakHex(t) === keccakHex(data) ? pass : { ok: false, code: 'ExactCalldataEnforcer:invalid-calldata' };
    case E.id: {
      if (t.length !== 32) return { ok: false, code: 'IdEnforcer:invalid-terms-length' };
      const key = `${caller}:${ctx.delegator ? evmAddress(ctx.delegator) : ''}:${BigInt(hexOf(t)).toString()}`;
      return ctx.usedIds?.has(key) ? { ok: false, code: 'IdEnforcer:id-already-used' } : { ...pass, usedIds: [key] };
    }
    case E.erc20BalanceChange: {
      if (t.length !== 73) return { ok: false, code: 'ERC20BalanceChangeEnforcer:invalid-terms-length' };
      return { ...pass, balanceRules: [{ decrease: t[0] !== 0, token: hexOf(t.subarray(1, 21)), recipient: hexOf(t.subarray(21, 41)), amount: BigInt(hexOf(t.subarray(41))) }] };
    }
    case E.logicalOrWrapper: {
      let groups: Caveat[][], selected: { groupIndex: number; caveatArgs: readonly string[] };
      try { groups = decodeLogicalOrTerms(c.terms); selected = decodeLogicalOrArgs(c.args); } catch { return { ok: false, code: 'LogicalOrWrapperEnforcer:decode-failed' }; }
      const group = groups[selected.groupIndex];
      if (!group) return { ok: false, code: 'LogicalOrWrapperEnforcer:invalid-group-index' };
      if (selected.caveatArgs.length !== group.length) return { ok: false, code: 'LogicalOrWrapperEnforcer:invalid-caveat-args-length' };
      const results = group.map((inner, i) => checkCaveat({ ...inner, args: selected.caveatArgs[i]! }, ctx, 'wrapper'));
      const failed = results.find(r => !r.ok);
      if (failed && !failed.ok) return failed;
      const ok = results as Extract<CaveatResult, { ok: true }>[];
      // A LimitedCalls caveat inside the wrapper counts under the wrapper's own key, not the manager's: not modelled (FloFi never nests one).
      if (group.some(inner => inner.enforcer === E.limitedCalls)) return { ok: false, code: 'ENFORCER_NOT_MODELED' };
      return { ok: true, countsCall: false, balanceRules: ok.flatMap(r => r.balanceRules), groupIndex: selected.groupIndex, usedIds: ok.flatMap(r => r.usedIds) };
    }
    default: return { ok: false, code: 'ENFORCER_NOT_MODELED' };
  }
}
/**
 * The before-hooks of every caveat of a root delegation, for one single-call redemption. A passing verdict lists the balance rules the
 * after-hooks will check and whether LimitedCallsEnforcer counts the call. Mode, delegate and signature are checked by the caller
 * (`verifyRedemption`).
 */
export function modelBeforeHooks(d: Delegation, ctx: ModelContext): ModelVerdict {
  let countsCall = false, groupIndex: number | null = null;
  const balanceRules: BalanceRule[] = [], usedIds: string[] = [];
  const context: ModelContext = { ...ctx, delegator: ctx.delegator ?? d.delegator };
  for (const c of d.caveats) {
    const r = checkCaveat(c, context);
    if (!r.ok) return r;
    countsCall ||= r.countsCall; balanceRules.push(...r.balanceRules); usedIds.push(...r.usedIds); groupIndex = r.groupIndex ?? groupIndex;
  }
  return { ok: true, groupIndex, countsCall, balanceRules, usedIds };
}
/**
 * ERC20BalanceChangeEnforcer after-hook: `balance >= before - amount` (decrease) or `balance >= before + amount` (increase). Solidity 0.8 checked
 * arithmetic: a decrease rule whose `amount` exceeds the balance cached before the call reverts with Panic(0x11) whatever the call did — a
 * per-call cap above the owner's balance can never be redeemed.
 */
export function modelAfterHook(rule: BalanceRule, before: bigint, after: bigint): { readonly ok: true } | { readonly ok: false; readonly code: string } {
  if (rule.decrease && rule.amount > before) return { ok: false, code: 'Panic(0x11)' };
  if (rule.decrease) return after >= before - rule.amount ? { ok: true } : { ok: false, code: 'ERC20BalanceChangeEnforcer:exceeded-balance-decrease' };
  return after >= before + rule.amount ? { ok: true } : { ok: false, code: 'ERC20BalanceChangeEnforcer:insufficient-balance-increase' };
}

// ── EIP-1559 transactions of a session signer (encoding and sender recovery; signing lives with the signer provider) ──────────
export type Eip1559 = { readonly chainId: bigint; readonly nonce: bigint; readonly maxPriorityFeePerGas: bigint; readonly maxFeePerGas: bigint;
  readonly gasLimit: bigint; readonly to: string; readonly value: bigint; readonly data: string };
const txFields = (tx: Eip1559) => [rlpInteger(tx.chainId), rlpInteger(tx.nonce), rlpInteger(tx.maxPriorityFeePerGas), rlpInteger(tx.maxFeePerGas),
  rlpInteger(tx.gasLimit), bytesOf(evmAddress(tx.to)), rlpInteger(tx.value), bytesOf(tx.data), []];
const typed = (body: Uint8Array) => concat(Uint8Array.of(2), body);
export const unsignedEip1559 = (tx: Eip1559): Uint8Array => typed(rlpEncode(txFields(tx)));
export const eip1559SigningHash = (tx: Eip1559): string => keccakHex(unsignedEip1559(tx));
export function signedEip1559(tx: Eip1559, yParity: 0 | 1, r: bigint, s: bigint): { readonly raw: string; readonly hash: string } {
  const raw = typed(rlpEncode([...txFields(tx), rlpInteger(BigInt(yParity)), rlpInteger(r), rlpInteger(s)]));
  return { raw: hexOf(raw), hash: keccakHex(raw) };
}
/** Decodes a signed type-2 transaction and recovers its sender (verification only). */
export function decodeSignedEip1559(rawHex: string): { readonly tx: Eip1559; readonly from: string; readonly hash: string } {
  const raw = bytesOf(rawHex.toLowerCase());
  if (raw[0] !== 2) fail('ERC7710_TX_TYPE_INVALID');
  const fields = rlpList(rlpDecode(raw.subarray(1)));
  if (fields.length !== 12 || rlpList(fields[8]!).length !== 0) fail('ERC7710_TX_SHAPE_INVALID');
  const to = rlpBytes(fields[5]!);
  if (to.length !== 20) fail('ERC7710_TX_SHAPE_INVALID');
  const tx: Eip1559 = { chainId: parseRlpInteger(fields[0]!), nonce: parseRlpInteger(fields[1]!), maxPriorityFeePerGas: parseRlpInteger(fields[2]!),
    maxFeePerGas: parseRlpInteger(fields[3]!), gasLimit: parseRlpInteger(fields[4]!), to: hexOf(to), value: parseRlpInteger(fields[6]!), data: hexOf(rlpBytes(fields[7]!)) };
  const yParity = parseRlpInteger(fields[9]!), r = parseRlpInteger(fields[10]!), s = parseRlpInteger(fields[11]!);
  if (yParity > 1n) fail('ERC7710_TX_SIGNATURE_INVALID');
  const canonical = signedEip1559(tx, Number(yParity) as 0 | 1, r, s);
  if (canonical.raw !== hexOf(raw)) fail('ERC7710_TX_NON_CANONICAL');
  const sig = hexOf(concat(word(r), word(s), Uint8Array.of(Number(yParity))));
  return { tx, from: recoverDigestSigner(eip1559SigningHash(tx), sig), hash: canonical.hash };
}
