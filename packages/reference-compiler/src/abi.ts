// SPDX-License-Identifier: AGPL-3.0-only
/** Exact SwapRouter02 ABI profile. Decoding requires canonical re-encoding. */
export const SWAP_ROUTER_02 = '0x2626664c2603336e57b271c5c0b26f421741e481';
export const APPROVE_SELECTOR = '0x095ea7b3';
export const MULTICALL_SELECTOR = '0x5ae401dc';
export const EXACT_INPUT_SINGLE_SELECTOR = '0x04e45aaf';
export type SwapArguments = { readonly tokenIn: string; readonly tokenOut: string; readonly fee: 100 | 500 | 3000 | 10000; readonly recipient: string; readonly amountIn: bigint; readonly amountOutMinimum: bigint; readonly sqrtPriceLimitX96: 0n; readonly deadline: bigint };
function fail(): never { throw new Error('ABI_NON_CANONICAL'); }
export function address(value: string): string {
  if (!/^0x[0-9a-f]{40}$/.test(value)) fail();
  return value;
}
function word(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) fail();
  const result = new Uint8Array(32);
  for (let index = 31; index >= 0; index--) { result[index] = Number(value & 255n); value >>= 8n; }
  return result;
}
function addressWord(value: string): Uint8Array {
  const result = new Uint8Array(32);
  result.set(bytes(address(value)), 12);
  return result;
}
function bytes(hex: string): Uint8Array {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(hex)) fail();
  const result = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < result.length; index++) result[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  return result;
}
function hex(value: Uint8Array): string { return '0x' + Array.from(value, byte => byte.toString(16).padStart(2, '0')).join(''); }
function join(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}
function equals(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((byte, index) => byte === right[index]); }
function readWord(data: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 32 > data.length) fail();
  let result = 0n;
  for (const byte of data.subarray(offset, offset + 32)) result = (result << 8n) | BigInt(byte);
  return result;
}
function readAddress(data: Uint8Array, offset: number): string {
  if (readWord(data, offset) >> 160n) fail();
  return hex(data.subarray(offset + 12, offset + 32));
}
export function encodeApprove(spender: string, amount: bigint): Uint8Array {
  return join(bytes(APPROVE_SELECTOR), addressWord(spender), word(amount));
}
export function decodeApprove(data: Uint8Array): { spender: string; amount: bigint } {
  if (data.length !== 68 || hex(data.subarray(0, 4)) !== APPROVE_SELECTOR) fail();
  const spender = readAddress(data, 4);
  const amount = readWord(data, 36);
  if (!equals(data, encodeApprove(spender, amount))) fail();
  return { spender, amount };
}
export function encodeSwap(input: SwapArguments): Uint8Array {
  if (![100, 500, 3000, 10000].includes(input.fee) || input.amountIn <= 0n || input.sqrtPriceLimitX96 !== 0n) fail();
  const inner = join(bytes(EXACT_INPUT_SINGLE_SELECTOR), addressWord(input.tokenIn), addressWord(input.tokenOut),
    word(BigInt(input.fee)), addressWord(input.recipient), word(input.amountIn), word(input.amountOutMinimum), word(0n));
  const pad = new Uint8Array((32 - inner.length % 32) % 32);
  return join(bytes(MULTICALL_SELECTOR), word(input.deadline), word(64n), word(1n), word(32n), word(BigInt(inner.length)), inner, pad);
}
export function decodeSwap(data: Uint8Array): SwapArguments {
  if (data.length < 4 + 5 * 32 || hex(data.subarray(0, 4)) !== MULTICALL_SELECTOR) fail();
  const body = data.subarray(4);
  const deadline = readWord(body, 0);
  if (readWord(body, 32) !== 64n || readWord(body, 64) !== 1n || readWord(body, 96) !== 32n) fail();
  const length = readWord(body, 128);
  if (length !== 228n) fail();
  const inner = body.subarray(160, 160 + Number(length));
  if (inner.length !== 228 || hex(inner.subarray(0, 4)) !== EXACT_INPUT_SINGLE_SELECTOR) fail();
  const fee = readWord(inner, 68);
  if (![100n, 500n, 3000n, 10000n].includes(fee)) fail();
  const input: SwapArguments = {
    tokenIn: readAddress(inner, 4), tokenOut: readAddress(inner, 36), fee: Number(fee) as SwapArguments['fee'],
    recipient: readAddress(inner, 100), amountIn: readWord(inner, 132), amountOutMinimum: readWord(inner, 164),
    sqrtPriceLimitX96: readWord(inner, 196) as 0n, deadline,
  };
  if (input.sqrtPriceLimitX96 !== 0n || !equals(data, encodeSwap(input))) fail();
  return input;
}

// ── BUILD-FLOFI-BRIDGE-LIVE-FIX-003: native ETH through SwapRouter02 and WETH9 ─────────────────────────────────────────────────────────
/** SwapRouter02 `unwrapWETH9(uint256 amountMinimum, address recipient)` (IPeripheryPaymentsWithFeeExtended). */
export const UNWRAP_WETH9_SELECTOR = '0x49404b7c';
/** SwapRouter02's `Constants.ADDRESS_THIS`: a swap recipient that keeps the output inside the router for the next call of the same multicall. */
export const ROUTER_ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
/** WETH9 `deposit()` (payable, mints exactly msg.value) and `withdraw(uint256)` (burns and sends exactly that native amount to msg.sender). */
export const WETH_DEPOSIT_SELECTOR = '0xd0e30db0';
export const WETH_WITHDRAW_SELECTOR = '0x2e1a7d4d';
/**
 * A native-ETH exact-input swap over SwapRouter02, inside `multicall(deadline, …)` so the reviewed deadline is enforced on chain:
 * `INPUT` — native ETH in: one `exactInputSingle(WETH9 → tokenOut, recipient = owner)` sent with `value = amountIn` (the router wraps exactly
 * that value); `OUTPUT` — native ETH out: `exactInputSingle(tokenIn → WETH9, recipient = the router)` then `unwrapWETH9(amountOutMinimum, owner)`,
 * which pays the whole unwrapped amount (at least the minimum) to the owner in native ETH. `weth` is the network's verified WETH9.
 */
export type NativeSwapArguments = SwapArguments & { readonly native: 'INPUT' | 'OUTPUT'; readonly weth: string };
function multicall(deadline: bigint, calls: readonly Uint8Array[]): Uint8Array {
  const padded = (call: Uint8Array) => join(word(BigInt(call.length)), call, new Uint8Array((32 - call.length % 32) % 32));
  const bodies = calls.map(padded), offsets: Uint8Array[] = [];
  let at = 32 * calls.length;
  for (const body of bodies) { offsets.push(word(BigInt(at))); at += body.length; }
  return join(bytes(MULTICALL_SELECTOR), word(deadline), word(64n), word(BigInt(calls.length)), ...offsets, ...bodies);
}
const exactInputSingle = (tokenIn: string, tokenOut: string, fee: number, recipient: string, amountIn: bigint, amountOutMinimum: bigint) =>
  join(bytes(EXACT_INPUT_SINGLE_SELECTOR), addressWord(tokenIn), addressWord(tokenOut), word(BigInt(fee)), addressWord(recipient), word(amountIn), word(amountOutMinimum), word(0n));
export function encodeNativeSwap(input: NativeSwapArguments): Uint8Array {
  if (![100, 500, 3000, 10000].includes(input.fee) || input.amountIn <= 0n || input.amountOutMinimum <= 0n || input.sqrtPriceLimitX96 !== 0n) fail();
  if (input.native === 'INPUT') {
    if (input.tokenIn !== address(input.weth) || input.tokenOut === input.weth) fail();
    return multicall(input.deadline, [exactInputSingle(input.weth, input.tokenOut, input.fee, input.recipient, input.amountIn, input.amountOutMinimum)]);
  }
  if (input.native !== 'OUTPUT' || input.tokenOut !== address(input.weth) || input.tokenIn === input.weth || input.recipient === ROUTER_ADDRESS_THIS) fail();
  return multicall(input.deadline, [exactInputSingle(input.tokenIn, input.weth, input.fee, ROUTER_ADDRESS_THIS, input.amountIn, input.amountOutMinimum),
    join(bytes(UNWRAP_WETH9_SELECTOR), word(input.amountOutMinimum), addressWord(input.recipient))]);
}
/** Reads a native swap back; only the exact canonical encoding of one of the two shapes above is accepted. */
export function decodeNativeSwap(data: Uint8Array, weth: string): NativeSwapArguments {
  if (data.length < 4 + 5 * 32 || hex(data.subarray(0, 4)) !== MULTICALL_SELECTOR) fail();
  const body = data.subarray(4), deadline = readWord(body, 0), count = readWord(body, 64);
  if (readWord(body, 32) !== 64n || (count !== 1n && count !== 2n)) fail();
  const element = (index: number) => { const start = 96 + Number(readWord(body, 96 + 32 * index)), length = Number(readWord(body, start)); return body.subarray(start + 32, start + 32 + length); };
  const swap = element(0);
  if (swap.length !== 228 || hex(swap.subarray(0, 4)) !== EXACT_INPUT_SINGLE_SELECTOR) fail();
  const fee = Number(readWord(swap, 68));
  if (![100, 500, 3000, 10000].includes(fee)) fail();
  const args = { tokenIn: readAddress(swap, 4), tokenOut: readAddress(swap, 36), fee: fee as SwapArguments['fee'], amountIn: readWord(swap, 132), amountOutMinimum: readWord(swap, 164),
    sqrtPriceLimitX96: 0n as const, deadline, weth };
  let result: NativeSwapArguments;
  if (count === 1n) result = { ...args, recipient: readAddress(swap, 100), native: 'INPUT' };
  else {
    const unwrap = element(1);
    if (unwrap.length !== 68 || hex(unwrap.subarray(0, 4)) !== UNWRAP_WETH9_SELECTOR || readAddress(swap, 100) !== ROUTER_ADDRESS_THIS || readWord(unwrap, 4) !== args.amountOutMinimum) fail();
    result = { ...args, recipient: readAddress(unwrap, 36), native: 'OUTPUT' };
  }
  if (readWord(swap, 196) !== 0n || !equals(data, encodeNativeSwap(result))) fail();
  return result;
}
export const encodeWethDeposit = (): Uint8Array => bytes(WETH_DEPOSIT_SELECTOR);
export const encodeWethWithdraw = (amount: bigint): Uint8Array => { if (amount <= 0n) fail(); return join(bytes(WETH_WITHDRAW_SELECTOR), word(amount)); };
