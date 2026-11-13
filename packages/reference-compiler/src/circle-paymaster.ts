// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §3): Circle's permissionless USDC paymaster — pure pins, encodings and checks. Nothing here
 * holds a key, reads a chain or sends anything.
 *
 * Circle's paymaster fronts an ERC-4337 operation's native fee from its own EntryPoint deposit and, inside the SAME operation, takes USDC from the
 * owner's account: its validation executes the owner's EIP-2612 `permit` (spender = the paymaster, value = a cap the owner signed, deadline =
 * 2^256−1 because ERC-4337 validation cannot read the block time) and pulls a USDC prefund; its `postOp` refunds what the actual gas did not use.
 * The owner is the economic payer; FloFi never pays, and never signs for the owner.
 *
 *   pins          EntryPoint v0.7 / v0.8, Circle paymaster v0.7 (Base, Arbitrum One) and v0.8 (Ethereum, Base, Arbitrum One), native USDC and its
 *                 permit domain (`USD Coin`, `2`) per chain. Sources: Circle's addresses page and Circle-maintained viem guide, the Circle-authored
 *                 `circle-paymaster-aa-sdk-middleware`, `@circle-fin/app-kit` (USDC permit metadata "verified on-chain"), `circlefin/stablecoin-evm`
 *                 (`EIP2612.sol`, `FiatTokenV2_2.sol`: ECDSA for an account without code, ERC-1271 otherwise — both pinned 7702 delegates validate a
 *                 raw ECDSA signature of the owner over the digest). The runtime re-verifies the contracts on chain before use.
 *   paymasterData `abi.encodePacked(uint8 mode = 0, address token, uint256 permitAmount, bytes permitSignature)`, strictly decoded back.
 *   cap           the most the owner can pay: the operation's worst-case native cost (every gas limit, the paymaster's included, at the signed
 *                 `maxFeePerGas`) priced in USDC from FloFi's verified price source, plus Circle's surcharge and FloFi's disclosed margin.
 */
import { abiDecode, abiEncode, bytesOf, EIP712_DOMAIN_TYPEHASH, evmAddress, hexOf, keccakHex, recoverDigestSigner, selectorOf } from './erc7710.js';
import { decodeOwnerAccountCallData, EIP7702_INIT_CODE_MARKER, ENTRY_POINT_V0_7, ENTRY_POINT_V0_8, maxSponsoredCost, OWNER_ACCOUNT_KINDS, unpackPaymasterAndData, userOperationGas,
  type OwnerAccountKind, type PackedUserOperation, type UserOperationGas } from './erc4337.js';

function fail(code: string): never { throw new Error(code); }
const UINT256_MAX = (1n << 256n) - 1n;
const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// ── Pins ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Circle Paymaster for EntryPoint v0.7 (`TokenPaymasterV07`): Base and Arbitrum One only (no Ethereum deployment). */
export const CIRCLE_PAYMASTER_V07 = '0x6c973ebe80dcd8660841d4356bf15c32460271c9';
/** Circle Paymaster for EntryPoint v0.8 (`TokenPaymasterV08`): the same address on Ethereum, Base and Arbitrum One. */
export const CIRCLE_PAYMASTER_V08 = '0x0578cfb241215b77442a541325d6a4e6dfe700ec';
/** The native USDC permit domain on these three chains (legacy FiatToken deployments: `USD Coin`; newer ones say `USDC`). */
export const CIRCLE_USDC_PERMIT_DOMAIN = Object.freeze({ name: 'USD Coin', version: '2' });
export type CircleChainPins = { readonly chainId: number; readonly usdc: string; readonly paymasters: Readonly<Record<string, string>> };
/** chainId → native USDC and the Circle paymaster per EntryPoint (lower-case). A chain or EntryPoint absent here has no Circle paymaster. */
export const CIRCLE_PAYMASTER_PINS: Readonly<Record<number, CircleChainPins>> = Object.freeze({
  1: Object.freeze({ chainId: 1, usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', paymasters: Object.freeze({ [ENTRY_POINT_V0_8]: CIRCLE_PAYMASTER_V08 }) }),
  8453: Object.freeze({ chainId: 8453, usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    paymasters: Object.freeze({ [ENTRY_POINT_V0_7]: CIRCLE_PAYMASTER_V07, [ENTRY_POINT_V0_8]: CIRCLE_PAYMASTER_V08 }) }),
  42161: Object.freeze({ chainId: 42161, usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    paymasters: Object.freeze({ [ENTRY_POINT_V0_7]: CIRCLE_PAYMASTER_V07, [ENTRY_POINT_V0_8]: CIRCLE_PAYMASTER_V08 }) }),
});
export const CIRCLE_USDC_DECIMALS = 6;
/** The pins of a chain, or null when Circle has no paymaster there. */
export const circlePinsOf = (chainId: number): CircleChainPins | null => CIRCLE_PAYMASTER_PINS[chainId] ?? null;
/** The pinned Circle paymaster for a chain and EntryPoint, or null (e.g. EntryPoint v0.7 on Ethereum). */
export function circlePaymasterOf(chainId: number, entryPoint: string): string | null {
  const pins = circlePinsOf(chainId);
  return pins?.paymasters[evmAddress(entryPoint)] ?? null;
}
/** Every Circle paymaster pinned on a chain (the relayer set an S1 token-fee claim is checked against). */
export const circlePaymastersOf = (chainId: number): readonly string[] => [...new Set(Object.values(circlePinsOf(chainId)?.paymasters ?? {}))];

// ── Gas of the paymaster ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Circle's documented paymaster limits (viem guide: 200,000 validation, 15,000 postOp) and FloFi's bounds: the postOp limit is the larger of
 * 15,000 and the paymaster's own `additionalGasCharge()` (what its middleware passes), and neither limit may exceed its bound.
 */
export const CIRCLE_PAYMASTER_GAS = Object.freeze({ verification: 200_000n, postOp: 15_000n, verificationMax: 400_000n, postOpMax: 150_000n });
export function circlePostOpGasLimit(additionalGasCharge: bigint | null): bigint {
  const charge = additionalGasCharge ?? 0n;
  if (charge < 0n || charge > CIRCLE_PAYMASTER_GAS.postOpMax) fail('CIRCLE_PAYMASTER_GAS_UNBOUNDED');
  return charge > CIRCLE_PAYMASTER_GAS.postOp ? charge : CIRCLE_PAYMASTER_GAS.postOp;
}
/** The worst-case native cost of a Circle operation: every gas limit, the paymaster's included, at its signed `maxFeePerGas`. */
export function circleMaxNativeCost(gas: UserOperationGas, paymaster: { readonly verificationGasLimit: bigint; readonly postOpGasLimit: bigint }): bigint {
  return maxSponsoredCost(gas, paymaster);
}

// ── Price → USDC cap ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Circle's published surcharge on the gas cost (10 %), and FloFi's disclosed margin over its own price (price moves, Circle's own oracle). */
export const CIRCLE_SURCHARGE_BPS = 1_000n;
export const CIRCLE_PRICE_MARGIN_BPS = 2_000n;
/** Prices are 8-decimal fixed point (Chainlink USD feeds; FloFi's `PRICE_SCALE`). */
export const CIRCLE_PRICE_SCALE = 8;
/**
 * The USDC (6 decimals) the owner may pay at most for `nativeWei` of gas: ceil(nativeWei × ETH/USD ÷ USDC/USD × (1 + surcharge) × (1 + margin)),
 * exact integer math. `usdcUsd` (when the price source has a USDC feed) only ever raises the cap: a USDC above $1 is counted as $1.
 */
export function circleUsdcWorstCase(input: { readonly nativeWei: bigint; readonly ethUsd: bigint; readonly usdcUsd?: bigint | null;
  readonly surchargeBps?: bigint; readonly marginBps?: bigint }): bigint {
  const one = 10n ** BigInt(CIRCLE_PRICE_SCALE);
  const { nativeWei, ethUsd } = input, surcharge = input.surchargeBps ?? CIRCLE_SURCHARGE_BPS, margin = input.marginBps ?? CIRCLE_PRICE_MARGIN_BPS;
  if (typeof nativeWei !== 'bigint' || nativeWei < 0n || typeof ethUsd !== 'bigint' || ethUsd <= 0n || surcharge < 0n || margin < 0n) fail('CIRCLE_PRICE_INVALID');
  const usdc = input.usdcUsd === undefined || input.usdcUsd === null ? one : input.usdcUsd <= 0n ? fail('CIRCLE_PRICE_INVALID') : input.usdcUsd < one ? input.usdcUsd : one;
  const numerator = nativeWei * ethUsd * 10n ** BigInt(CIRCLE_USDC_DECIMALS) * (10_000n + surcharge) * (10_000n + margin);
  const denominator = 10n ** 18n * usdc * 10_000n * 10_000n;
  const amount = (numerator + denominator - 1n) / denominator;
  return nativeWei > 0n && amount === 0n ? 1n : amount;
}

// ── EIP-2612 permit (FiatToken v2.2) ─────────────────────────────────────────────────────────────────────────────────────────
export const PERMIT_TYPEHASH = keccakHex('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)');
/** The permit deadline Circle's paymaster requires (it cannot read the block time): never expires; the nonce makes it single-use. */
export const CIRCLE_PERMIT_DEADLINE = UINT256_MAX;
export type CirclePermit = { readonly chainId: number; readonly token: string; readonly owner: string; readonly spender: string; readonly value: bigint;
  readonly nonce: bigint; readonly deadline: bigint };
function permitOf(p: CirclePermit): CirclePermit {
  if (!Number.isSafeInteger(p.chainId) || p.chainId <= 0) fail('CIRCLE_PERMIT_INVALID');
  const u = (v: unknown) => typeof v === 'bigint' && v >= 0n && v <= UINT256_MAX ? v : fail('CIRCLE_PERMIT_INVALID');
  return { chainId: p.chainId, token: evmAddress(p.token), owner: evmAddress(p.owner), spender: evmAddress(p.spender), value: u(p.value), nonce: u(p.nonce), deadline: u(p.deadline) };
}
export function permitDomainSeparator(chainId: number, token: string): string {
  return keccakHex(abiEncode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [EIP712_DOMAIN_TYPEHASH, keccakHex(CIRCLE_USDC_PERMIT_DOMAIN.name), keccakHex(CIRCLE_USDC_PERMIT_DOMAIN.version), BigInt(chainId), evmAddress(token)]));
}
/** The EIP-712 digest FiatToken recovers the permit's signer from (`_permit`: owner, spender, value, nonces[owner], deadline). */
export function permitDigest(permit: CirclePermit): string {
  const p = permitOf(permit);
  const struct = keccakHex(abiEncode(['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256'], [PERMIT_TYPEHASH, p.owner, p.spender, p.value, p.nonce, p.deadline]));
  return keccakHex(concat(Uint8Array.of(0x19, 0x01), bytesOf(permitDomainSeparator(p.chainId, p.token)), bytesOf(struct)));
}
/** The `eth_signTypedData_v4` payload of the permit (the wallet shows token, spender, value and deadline as signed). */
export function permitTypedData(permit: CirclePermit) {
  const p = permitOf(permit);
  return {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }],
    },
    primaryType: 'Permit' as const,
    domain: { name: CIRCLE_USDC_PERMIT_DOMAIN.name, version: CIRCLE_USDC_PERMIT_DOMAIN.version, chainId: p.chainId, verifyingContract: p.token },
    message: { owner: p.owner, spender: p.spender, value: p.value.toString(), nonce: p.nonce.toString(), deadline: p.deadline.toString() },
  };
}
/** The address that signed the permit (65-byte r ‖ s ‖ v, low-s), or a closed refusal (CIRCLE_PERMIT_INVALID). */
export function recoverPermitSigner(permit: CirclePermit, signature: string): string {
  try { return recoverDigestSigner(permitDigest(permit), signature); } catch { return fail('CIRCLE_PERMIT_INVALID'); }
}
/**
 * The permit FloFi asks the owner to sign for a Circle operation on `chainId` through `entryPoint`'s pinned paymaster: spender = that paymaster,
 * value = the reviewed cap (never unlimited), the owner's current USDC permit nonce, the never-expiring deadline the paymaster requires.
 */
export function circlePermit(input: { readonly chainId: number; readonly entryPoint: string; readonly owner: string; readonly cap: bigint; readonly nonce: bigint }): CirclePermit {
  const pins = circlePinsOf(input.chainId) ?? fail('CIRCLE_CHAIN_UNSUPPORTED');
  const spender = circlePaymasterOf(input.chainId, input.entryPoint) ?? fail('CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED');
  if (typeof input.cap !== 'bigint' || input.cap <= 0n || input.cap === UINT256_MAX) fail('CIRCLE_PERMIT_CAP_INVALID');
  return permitOf({ chainId: input.chainId, token: pins.usdc, owner: input.owner, spender, value: input.cap, nonce: input.nonce, deadline: CIRCLE_PERMIT_DEADLINE });
}

// ── paymasterData ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export type CirclePaymasterData = { readonly mode: 0; readonly token: string; readonly permitAmount: bigint; readonly permitSignature: string };
/** `abi.encodePacked(uint8 0, address token, uint256 permitAmount, bytes permitSignature)` (65-byte ECDSA signature: 118 bytes in all). */
export function encodeCirclePaymasterData(p: Omit<CirclePaymasterData, 'mode'>): string {
  if (!/^0x[0-9a-fA-F]{130}$/.test(p.permitSignature)) fail('CIRCLE_PERMIT_INVALID');
  if (typeof p.permitAmount !== 'bigint' || p.permitAmount <= 0n || p.permitAmount > UINT256_MAX) fail('CIRCLE_PERMIT_CAP_INVALID');
  return '0x00' + evmAddress(p.token).slice(2) + p.permitAmount.toString(16).padStart(64, '0') + p.permitSignature.slice(2).toLowerCase();
}
/** The strict decoder: exactly 118 bytes, mode 0, a 65-byte signature. Anything else is refused (CIRCLE_PAYMASTER_DATA_INVALID). */
export function decodeCirclePaymasterData(data: string): CirclePaymasterData {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{236}$/.test(data)) fail('CIRCLE_PAYMASTER_DATA_INVALID');
  const hex = data.toLowerCase();
  if (hex.slice(2, 4) !== '00') fail('CIRCLE_PAYMASTER_DATA_INVALID');
  return { mode: 0, token: '0x' + hex.slice(4, 44), permitAmount: BigInt('0x' + hex.slice(44, 108)), permitSignature: '0x' + hex.slice(108) };
}
/** `paymasterAndData` = paymaster ‖ uint128 validation gas ‖ uint128 postOp gas ‖ Circle's paymasterData. */
export function circlePaymasterAndData(input: { readonly paymaster: string; readonly verificationGasLimit: bigint; readonly postOpGasLimit: bigint;
  readonly token: string; readonly permitAmount: bigint; readonly permitSignature: string }): string {
  const gas = (v: bigint) => { if (typeof v !== 'bigint' || v <= 0n || v >= 1n << 128n) fail('CIRCLE_PAYMASTER_GAS_INVALID'); return v.toString(16).padStart(32, '0'); };
  return evmAddress(input.paymaster) + gas(input.verificationGasLimit) + gas(input.postOpGasLimit)
    + encodeCirclePaymasterData({ token: input.token, permitAmount: input.permitAmount, permitSignature: input.permitSignature }).slice(2);
}

// ── The operation check (before the owner signs it, and again before it is relayed) ──────────────────────────────────────────
export type CircleOperationExpectation = { readonly chainId: number; readonly entryPoint: string; readonly owner: string; readonly accountKind: OwnerAccountKind;
  /** The cap the owner reviewed (the permit's value). */ readonly permitCap: bigint;
  /** The owner's USDC permit nonce the permit was signed for. */ readonly permitNonce: bigint;
  /**
   * Owner requirement (FloFi Wallet): the operation upgrades the owner's plain account to `Simple7702Account` v0.8 inside itself (the EIP-7702
   * initCode marker; the owner's own signed authorization travels beside it to the bundler). Absent: no initCode at all.
   */
  readonly eip7702Upgrade?: boolean };
/**
 * Refuses any operation that is not exactly a Circle-paid operation of the owner's own account: sender = owner; no initCode (or, for an upgrade the
 * owner authorized, exactly the EIP-7702 marker of a `Simple7702Account` v0.8 account); the account kind's EntryPoint; `paymasterAndData`
 * naming the paymaster pinned for this chain and EntryPoint, with bounded paymaster gas; mode 0; token = the pinned USDC; permitAmount = the
 * reviewed cap; a 65-byte permit signature recovering to the owner over the pinned domain, spender = the paymaster, the signed nonce and the
 * never-expiring deadline; sane fees; account call data FloFi can read.
 * Returns the decoded parts.
 */
export function assertCirclePaymasterOperation(op: PackedUserOperation, x: CircleOperationExpectation): {
  readonly paymaster: string; readonly verificationGasLimit: bigint; readonly postOpGasLimit: bigint; readonly data: CirclePaymasterData } {
  const pins = circlePinsOf(x.chainId) ?? fail('CIRCLE_CHAIN_UNSUPPORTED');
  const owner = evmAddress(x.owner), entryPoint = evmAddress(x.entryPoint);
  if (evmAddress(op.sender) !== owner) fail('CIRCLE_OPERATION_SENDER_INVALID');
  // FloFi never sends an initCode of its own: only the EIP-7702 marker of an upgrade the owner explicitly authorized, to the pinned v0.8 delegate.
  const initCode = typeof op.initCode === 'string' ? op.initCode.toLowerCase() : null;
  if (x.eip7702Upgrade === true ? initCode !== EIP7702_INIT_CODE_MARKER || x.accountKind !== 'SIMPLE_7702_V0_8' : initCode !== '0x') fail('ERC4337_INIT_CODE_REFUSED');
  if (OWNER_ACCOUNT_KINDS[x.accountKind]?.entryPoint !== entryPoint) fail('CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED');
  const pinned = circlePaymasterOf(x.chainId, entryPoint) ?? fail('CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED');
  let pm: ReturnType<typeof unpackPaymasterAndData>;
  try { pm = unpackPaymasterAndData(op.paymasterAndData); } catch { return fail('CIRCLE_PAYMASTER_DATA_INVALID'); }
  if (!pm) return fail('CIRCLE_PAYMASTER_DATA_INVALID');
  if (pm.paymaster !== pinned) fail('CIRCLE_PAYMASTER_NOT_PINNED');
  if (pm.verificationGasLimit <= 0n || pm.verificationGasLimit > CIRCLE_PAYMASTER_GAS.verificationMax || pm.postOpGasLimit < CIRCLE_PAYMASTER_GAS.postOp
    || pm.postOpGasLimit > CIRCLE_PAYMASTER_GAS.postOpMax) fail('CIRCLE_PAYMASTER_GAS_INVALID');
  const d = decodeCirclePaymasterData(pm.data);
  if (d.token !== pins.usdc) fail('CIRCLE_PAYMASTER_TOKEN_INVALID');
  if (typeof x.permitCap !== 'bigint' || x.permitCap <= 0n || d.permitAmount !== x.permitCap) fail('CIRCLE_PERMIT_AMOUNT_MISMATCH');
  const permit = circlePermit({ chainId: x.chainId, entryPoint, owner, cap: x.permitCap, nonce: x.permitNonce });
  if (recoverPermitSigner(permit, d.permitSignature) !== owner) fail('CIRCLE_PERMIT_INVALID');
  const gas = userOperationGas(op);
  if (gas.maxPriorityFeePerGas > gas.maxFeePerGas || gas.maxFeePerGas === 0n || gas.callGasLimit === 0n || gas.verificationGasLimit === 0n) fail('ERC4337_GAS_INVALID');
  decodeOwnerAccountCallData(x.accountKind, op.callData);
  return { paymaster: pm.paymaster, verificationGasLimit: pm.verificationGasLimit, postOpGasLimit: pm.postOpGasLimit, data: d };
}

// ── On-chain reads (call data and strict decoders; the caller's transport performs them) ─────────────────────────────────────
export const CIRCLE_SELECTORS = Object.freeze({
  entryPoint: selectorOf('entryPoint()'), additionalGasCharge: selectorOf('additionalGasCharge()'), name: selectorOf('name()'), version: selectorOf('version()'),
  nonces: selectorOf('nonces(address)'), balanceOf: selectorOf('balanceOf(address)'),
});
/** `eth_call` data of `nonces(owner)` / `balanceOf(owner)`. */
export const permitNoncesCall = (owner: string) => CIRCLE_SELECTORS.nonces + hexOf(abiEncode(['address'], [evmAddress(owner)])).slice(2);
export const balanceOfCall = (owner: string) => CIRCLE_SELECTORS.balanceOf + hexOf(abiEncode(['address'], [evmAddress(owner)])).slice(2);
const answer = (value: unknown): Uint8Array => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{64})+$/.test(value) ? bytesOf(value.toLowerCase()) : fail('CIRCLE_RPC_INVALID');
export function decodeUintAnswer(value: unknown): bigint { const [n] = abiDecode(['uint256'], answer(value)) as [bigint]; return n; }
export function decodeAddressAnswer(value: unknown): string { const [a] = abiDecode(['address'], answer(value)) as [string]; return a.toLowerCase(); }
/** A Solidity `string` return value (ABI `bytes` layout), as UTF-8 text. */
export function decodeStringAnswer(value: unknown): string {
  let raw: string;
  try { [raw] = abiDecode(['bytes'], answer(value)) as [string]; } catch { return fail('CIRCLE_RPC_INVALID'); }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytesOf(raw));
}
