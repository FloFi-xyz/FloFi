// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: exact NonfungiblePositionManager calldata for managing an existing Uniswap v3 position from the owner's
 * wallet — collect, partial decrease (+ collect of the withdrawn principal and fees), full exit and optional burn of the empty NFT.
 * Pure: no network I/O, no signing.
 *
 * Protocol facts this module relies on (NonfungiblePositionManager v1.0.0, the pinned deployments FloFi verifies by code hash):
 * - `decreaseLiquidity` only credits the position's `tokensOwed` (principal + fees checkpointed by the pool poke); it transfers nothing.
 * - `collect` with `amount0Max = amount1Max = type(uint128).max` pays everything owed; when the position still has liquidity it first pokes
 *   the pool (`burn(0)`) so fees accrued since the last checkpoint are included. A fixed collect bound computed at Review would leave fees
 *   accrued after it behind, so FloFi always collects the maximum and reviews a lower bound instead.
 * - `burn` reverts ("Not cleared") unless liquidity and both `tokensOwed` are zero.
 * - `multicall(bytes[])` executes its calls in order and reverts as a whole when any call reverts (atomic within one transaction).
 * - `recipient` is the owner: tokens are returned as the pool's own ERC-20s (WETH stays WETH; nothing is unwrapped or swapped).
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sqrtRatioAtTick, Q96 } from './liquidity.js';

export const UNISWAP_MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-f]{40}$/;

const SIGNATURES = Object.freeze({
  decreaseLiquidity: 'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))',
  collect: 'collect((uint256,address,uint128,uint128))',
  burn: 'burn(uint256)',
  multicall: 'multicall(bytes[])',
  getApproved: 'getApproved(uint256)',
  isApprovedForAll: 'isApprovedForAll(address,address)',
});
export const UNISWAP_POSITION_SELECTORS = Object.freeze({
  decreaseLiquidity: '0x0c49ccbe', collect: '0xfc6f7865', burn: '0x42966c68', multicall: '0xac9650d8',
  getApproved: '0x081812fc', isApprovedForAll: '0xe985e9c5',
});
const EVENTS = Object.freeze({
  decreaseLiquidity: 'DecreaseLiquidity(uint256,uint128,uint256,uint256)',
  collect: 'Collect(uint256,address,uint256,uint256)',
  poolBurn: 'Burn(address,int24,int24,uint128,uint256,uint256)',
  poolCollect: 'Collect(address,address,int24,int24,uint128,uint128)',
});
export const UNISWAP_POSITION_TOPICS = Object.freeze({
  decreaseLiquidity: '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4',
  collect: '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01',
  poolBurn: '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c',
  poolCollect: '0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0',
});
const keccakHex = (text: string) => '0x' + Array.from(keccak_256(new TextEncoder().encode(text)), b => b.toString(16).padStart(2, '0')).join('');
// The pins are re-derived at load: a typo in a selector or topic can never reach a Review.
for (const [name, signature] of Object.entries(SIGNATURES))
  if (keccakHex(signature).slice(0, 10) !== UNISWAP_POSITION_SELECTORS[name as keyof typeof SIGNATURES]) throw new Error('UNISWAP_SELECTOR_PIN_INVALID');
for (const [name, signature] of Object.entries(EVENTS))
  if (keccakHex(signature) !== UNISWAP_POSITION_TOPICS[name as keyof typeof EVENTS]) throw new Error('UNISWAP_TOPIC_PIN_INVALID');

function fail(code: string): never { throw new Error(code); }
const word = (value: bigint) => { if (value < 0n || value > MAX_UINT256) fail('UNISWAP_ABI_INVALID'); return value.toString(16).padStart(64, '0'); };
const addressWord = (value: string) => { if (!ADDRESS.test(value)) fail('UNISWAP_ABI_INVALID'); return value.slice(2).padStart(64, '0'); };
function checkHex(data: unknown, code: string): string {
  if (typeof data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(data)) fail(code);
  return data;
}
const wordIn = (data: string, offsetChars: number, code: string) => {
  if (data.length < offsetChars + 64) fail(code);
  return BigInt('0x' + data.slice(offsetChars, offsetChars + 64));
};

export type UniswapDecreaseLiquidityParams = { readonly tokenId: bigint; readonly liquidity: bigint; readonly amount0Min: bigint; readonly amount1Min: bigint;
  readonly deadline: bigint };
export type UniswapCollectParams = { readonly tokenId: bigint; readonly recipient: string; readonly amount0Max: bigint; readonly amount1Max: bigint };

function checkTokenId(tokenId: bigint, code: string) { if (typeof tokenId !== 'bigint' || tokenId <= 0n || tokenId > MAX_UINT256) fail(code); }
function checkDecrease(p: UniswapDecreaseLiquidityParams) {
  checkTokenId(p.tokenId, 'UNISWAP_DECREASE_INVALID');
  if (p.liquidity <= 0n || p.liquidity > UNISWAP_MAX_UINT128 || p.amount0Min < 0n || p.amount1Min < 0n || p.amount0Min > MAX_UINT256 ||
      p.amount1Min > MAX_UINT256 || p.deadline <= 0n || p.deadline >= 1n << 64n) fail('UNISWAP_DECREASE_INVALID');
}
/** Exact `decreaseLiquidity(DecreaseLiquidityParams)` calldata. */
export function encodeUniswapDecreaseLiquidity(p: UniswapDecreaseLiquidityParams): string {
  checkDecrease(p);
  return UNISWAP_POSITION_SELECTORS.decreaseLiquidity + word(p.tokenId) + word(p.liquidity) + word(p.amount0Min) + word(p.amount1Min) + word(p.deadline);
}
/** Strict decode: only canonical re-encodable calldata is accepted. */
export function decodeUniswapDecreaseLiquidity(data: string): UniswapDecreaseLiquidityParams {
  if (typeof data !== 'string' || !/^0x0c49ccbe[0-9a-f]{320}$/.test(data)) fail('UNISWAP_DECREASE_INVALID');
  const at = (i: number) => BigInt('0x' + data.slice(10 + i * 64, 74 + i * 64));
  const p = { tokenId: at(0), liquidity: at(1), amount0Min: at(2), amount1Min: at(3), deadline: at(4) };
  if (encodeUniswapDecreaseLiquidity(p) !== data) fail('UNISWAP_DECREASE_INVALID');
  return p;
}
function checkCollect(p: UniswapCollectParams) {
  checkTokenId(p.tokenId, 'UNISWAP_COLLECT_INVALID');
  if (!ADDRESS.test(p.recipient) || p.recipient === ZERO_ADDRESS || p.amount0Max < 0n || p.amount1Max < 0n || p.amount0Max > UNISWAP_MAX_UINT128 ||
      p.amount1Max > UNISWAP_MAX_UINT128 || (p.amount0Max === 0n && p.amount1Max === 0n)) fail('UNISWAP_COLLECT_INVALID');
}
/** Exact `collect(CollectParams)` calldata. The recipient is never the zero address (that would route WETH through an unwrap step). */
export function encodeUniswapCollect(p: UniswapCollectParams): string {
  checkCollect(p);
  return UNISWAP_POSITION_SELECTORS.collect + word(p.tokenId) + addressWord(p.recipient) + word(p.amount0Max) + word(p.amount1Max);
}
export function decodeUniswapCollect(data: string): UniswapCollectParams {
  if (typeof data !== 'string' || !/^0xfc6f7865[0-9a-f]{256}$/.test(data)) fail('UNISWAP_COLLECT_INVALID');
  const at = (i: number) => BigInt('0x' + data.slice(10 + i * 64, 74 + i * 64));
  const recipient = at(1);
  if (recipient >> 160n) fail('UNISWAP_COLLECT_INVALID');
  const p = { tokenId: at(0), recipient: '0x' + recipient.toString(16).padStart(40, '0'), amount0Max: at(2), amount1Max: at(3) };
  if (encodeUniswapCollect(p) !== data) fail('UNISWAP_COLLECT_INVALID');
  return p;
}
/** Exact `burn(uint256)` calldata (the NFT of an empty, fully collected position). */
export function encodeUniswapBurn(tokenId: bigint): string {
  checkTokenId(tokenId, 'UNISWAP_BURN_INVALID');
  return UNISWAP_POSITION_SELECTORS.burn + word(tokenId);
}
export function decodeUniswapBurn(data: string): bigint {
  if (typeof data !== 'string' || !/^0x42966c68[0-9a-f]{64}$/.test(data)) fail('UNISWAP_BURN_INVALID');
  const tokenId = BigInt('0x' + data.slice(10));
  if (encodeUniswapBurn(tokenId) !== data) fail('UNISWAP_BURN_INVALID');
  return tokenId;
}
/** ABI `bytes[]` tail (offsets relative to the array head). */
function encodeBytesArray(items: readonly string[]): string {
  let head = word(BigInt(items.length)), tail = '', offset = BigInt(items.length * 32);
  for (const item of items) {
    const body = checkHex(item, 'UNISWAP_MULTICALL_INVALID').slice(2), length = body.length / 2;
    const padded = body + '0'.repeat((64 - (body.length % 64)) % 64);
    head += word(offset);
    tail += word(BigInt(length)) + padded;
    offset += BigInt(32 + padded.length / 2);
  }
  return head + tail;
}
function decodeBytesArray(data: string, start: number, code: string): string[] {
  const count = wordIn(data, start, code);
  if (count > 16n) fail(code);
  const items: string[] = [];
  for (let i = 0; i < Number(count); i++) {
    const offset = wordIn(data, start + 64 + i * 64, code);
    if (offset > BigInt(data.length)) fail(code);
    const at = start + 64 + Number(offset) * 2, length = wordIn(data, at, code);
    if (length > BigInt(data.length)) fail(code);
    const end = at + 64 + Number(length) * 2;
    if (end > data.length) fail(code);
    items.push('0x' + data.slice(at + 64, end));
  }
  return items;
}
/** Exact `multicall(bytes[])` calldata. */
export function encodeUniswapMulticall(calls: readonly string[]): string {
  if (!Array.isArray(calls) || calls.length < 2 || calls.length > 3) fail('UNISWAP_MULTICALL_INVALID');
  return UNISWAP_POSITION_SELECTORS.multicall + word(32n) + encodeBytesArray(calls);
}
export function decodeUniswapMulticall(data: string): string[] {
  if (typeof data !== 'string' || !/^0xac9650d8(?:[0-9a-f]{64})+$/.test(data)) fail('UNISWAP_MULTICALL_INVALID');
  if (wordIn(data, 10, 'UNISWAP_MULTICALL_INVALID') !== 32n) fail('UNISWAP_MULTICALL_INVALID');
  const calls = decodeBytesArray(data, 74, 'UNISWAP_MULTICALL_INVALID');
  if (encodeUniswapMulticall(calls) !== data) fail('UNISWAP_MULTICALL_INVALID');
  return calls;
}
/** `multicall` return data: `bytes[] results` (one entry per inner call). */
export function decodeUniswapMulticallResult(data: string, expected: number): string[] {
  checkHex(data, 'UNISWAP_MULTICALL_RESULT_INVALID');
  if (wordIn(data, 2, 'UNISWAP_MULTICALL_RESULT_INVALID') !== 32n) fail('UNISWAP_MULTICALL_RESULT_INVALID');
  const results = decodeBytesArray(data, 66, 'UNISWAP_MULTICALL_RESULT_INVALID');
  if (results.length !== expected) fail('UNISWAP_MULTICALL_RESULT_INVALID');
  return results;
}
/** `decreaseLiquidity` and `collect` both return `(uint256 amount0, uint256 amount1)`. */
export function decodeUniswapAmounts(data: string): { amount0: bigint; amount1: bigint } {
  if (typeof data !== 'string' || !/^0x[0-9a-f]{128}$/.test(data)) fail('UNISWAP_AMOUNTS_RESULT_INVALID');
  return { amount0: BigInt('0x' + data.slice(2, 66)), amount1: BigInt('0x' + data.slice(66, 130)) };
}

/**
 * The liquidity a percentage of the position removes, in integer arithmetic (rounded down). `partBps` is basis points of the selected
 * position's liquidity — never of the wallet's balance. 10 000 bps is the whole position.
 */
export function uniswapLiquidityPortion(liquidity: bigint, partBps: number): bigint {
  if (typeof liquidity !== 'bigint' || liquidity <= 0n || liquidity > UNISWAP_MAX_UINT128) fail('UNISWAP_POSITION_LIQUIDITY_INVALID');
  if (!Number.isSafeInteger(partBps) || partBps < 1 || partBps > 10_000) fail('UNISWAP_POSITION_PORTION_INVALID');
  const portion = liquidity * BigInt(partBps) / 10_000n;
  if (portion <= 0n) fail('UNISWAP_POSITION_PORTION_TOO_SMALL');
  return portion;
}
/**
 * Principal a liquidity amount represents at a pool price (SqrtPriceMath, rounded down as the pool rounds a removal). Used to describe a
 * position and to cross-check the public simulation; the reviewed amounts and minimums always come from the simulation itself.
 */
export function uniswapAmountsForLiquidity(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  if (tickLower >= tickUpper || liquidity < 0n || liquidity > UNISWAP_MAX_UINT128 || sqrtPriceX96 <= 0n) fail('UNISWAP_POSITION_INVALID');
  const lo = sqrtRatioAtTick(tickLower), hi = sqrtRatioAtTick(tickUpper);
  const s = sqrtPriceX96 <= lo ? lo : sqrtPriceX96 >= hi ? hi : sqrtPriceX96;
  return { amount0: liquidity * Q96 * (hi - s) / hi / s, amount1: liquidity * (s - lo) / Q96 };
}

export type UniswapPositionOperation = 'COLLECT' | 'DECREASE' | 'EXIT';
export type UniswapPositionInnerKind = 'DECREASE_LIQUIDITY' | 'COLLECT' | 'BURN';
export type UniswapPositionInnerCall = { readonly kind: UniswapPositionInnerKind; readonly data: string };
export type UniswapPositionPlanInput = {
  readonly operation: UniswapPositionOperation; readonly tokenId: bigint; readonly recipient: string;
  /** The position's on-chain liquidity at the Review block. */ readonly positionLiquidity: bigint;
  /** DECREASE: 1–9 999 bps of the position's liquidity. EXIT always removes all of it. */ readonly partBps: number | null;
  /** EXIT only, and only when the owner explicitly asked to close the position: burn the emptied NFT in the same transaction. */ readonly close: boolean;
  readonly amount0Min: bigint; readonly amount1Min: bigint; readonly deadline: bigint;
};
export type UniswapPositionPlan = { readonly liquidityToRemove: bigint; readonly calls: readonly UniswapPositionInnerCall[]; readonly data: string };

/**
 * The single wallet request of one position operation. More than one protocol call is wrapped in the manager's own `multicall`, so the
 * decrease, the collection and an explicit burn land together or not at all.
 */
export function uniswapPositionPlan(input: UniswapPositionPlanInput): UniswapPositionPlan {
  const { operation, tokenId, recipient, positionLiquidity, partBps, close } = input;
  if (!['COLLECT', 'DECREASE', 'EXIT'].includes(operation) || typeof close !== 'boolean' || (close && operation !== 'EXIT') ||
      positionLiquidity < 0n || positionLiquidity > UNISWAP_MAX_UINT128) fail('UNISWAP_POSITION_OPERATION_INVALID');
  if (operation === 'DECREASE' ? !Number.isSafeInteger(partBps) || partBps! < 1 || partBps! > 9_999 : partBps !== null) fail('UNISWAP_POSITION_PORTION_INVALID');
  const collect: UniswapPositionInnerCall = { kind: 'COLLECT', data: encodeUniswapCollect({ tokenId, recipient, amount0Max: UNISWAP_MAX_UINT128, amount1Max: UNISWAP_MAX_UINT128 }) };
  let liquidityToRemove = 0n;
  const calls: UniswapPositionInnerCall[] = [];
  if (operation === 'DECREASE' || operation === 'EXIT') {
    liquidityToRemove = operation === 'EXIT' ? positionLiquidity : uniswapLiquidityPortion(positionLiquidity, partBps!);
    if (operation === 'DECREASE' && liquidityToRemove >= positionLiquidity) fail('UNISWAP_POSITION_PORTION_INVALID');
    if (liquidityToRemove > 0n) calls.push({ kind: 'DECREASE_LIQUIDITY', data: encodeUniswapDecreaseLiquidity({ tokenId, liquidity: liquidityToRemove,
      amount0Min: input.amount0Min, amount1Min: input.amount1Min, deadline: input.deadline }) });
  }
  calls.push(collect);
  if (close) calls.push({ kind: 'BURN', data: encodeUniswapBurn(tokenId) });
  return { liquidityToRemove, calls, data: calls.length === 1 ? calls[0]!.data : encodeUniswapMulticall(calls.map(call => call.data)) };
}

/** Strict decode of a reviewed position request back into its protocol calls (the inverse of `uniswapPositionPlan`'s `data`). */
export function decodeUniswapPositionRequest(data: string): UniswapPositionInnerCall[] {
  const inner = typeof data === 'string' && data.startsWith(UNISWAP_POSITION_SELECTORS.multicall) ? decodeUniswapMulticall(data) : [data];
  const calls = inner.map((call): UniswapPositionInnerCall => {
    if (call.startsWith(UNISWAP_POSITION_SELECTORS.decreaseLiquidity)) { decodeUniswapDecreaseLiquidity(call); return { kind: 'DECREASE_LIQUIDITY', data: call }; }
    if (call.startsWith(UNISWAP_POSITION_SELECTORS.collect)) { decodeUniswapCollect(call); return { kind: 'COLLECT', data: call }; }
    if (call.startsWith(UNISWAP_POSITION_SELECTORS.burn)) { decodeUniswapBurn(call); return { kind: 'BURN', data: call }; }
    return fail('UNISWAP_POSITION_REQUEST_INVALID');
  });
  // Allowed shapes only: [COLLECT], [DECREASE, COLLECT], [DECREASE, COLLECT, BURN], [COLLECT, BURN].
  const shape = calls.map(call => call.kind).join(',');
  if (!['COLLECT', 'DECREASE_LIQUIDITY,COLLECT', 'DECREASE_LIQUIDITY,COLLECT,BURN', 'COLLECT,BURN'].includes(shape)) fail('UNISWAP_POSITION_REQUEST_INVALID');
  const ids = new Set(calls.map(call => call.kind === 'BURN' ? decodeUniswapBurn(call.data) : call.kind === 'COLLECT' ? decodeUniswapCollect(call.data).tokenId
    : decodeUniswapDecreaseLiquidity(call.data).tokenId));
  if (ids.size !== 1) fail('UNISWAP_POSITION_REQUEST_INVALID');
  return calls;
}
