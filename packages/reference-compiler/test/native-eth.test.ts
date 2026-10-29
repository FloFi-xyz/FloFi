// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { decodeNativeSwap, encodeNativeSwap, encodeWethDeposit, encodeWethWithdraw, EXACT_INPUT_SINGLE_SELECTOR, MULTICALL_SELECTOR, ROUTER_ADDRESS_THIS, toHex, UNWRAP_WETH9_SELECTOR,
  WETH_DEPOSIT_SELECTOR, WETH_WITHDRAW_SELECTOR, type NativeSwapArguments } from '../src/index.js';

/** BUILD-FLOFI-BRIDGE-LIVE-FIX-003: native ETH through SwapRouter02 (multicall + unwrapWETH9) and WETH9 deposit/withdraw. */
const selector = (signature: string) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(signature))).toString('hex').slice(0, 8);
const WETH = '0x4200000000000000000000000000000000000006', USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', OWNER = '0x1111111111111111111111111111111111111111';
const base = { fee: 500 as const, recipient: OWNER, amountIn: 1_000_000_000_000_000n, amountOutMinimum: 2_970_000n, sqrtPriceLimitX96: 0n as const, deadline: 1_800_000_000n, weth: WETH };

describe('native ETH calldata', () => {
  it('uses the verified selectors of SwapRouter02 and WETH9', () => {
    expect(selector('multicall(uint256,bytes[])')).toBe(MULTICALL_SELECTOR);
    expect(selector('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))')).toBe(EXACT_INPUT_SINGLE_SELECTOR);
    expect(selector('unwrapWETH9(uint256,address)')).toBe(UNWRAP_WETH9_SELECTOR);
    expect(selector('deposit()')).toBe(WETH_DEPOSIT_SELECTOR);
    expect(selector('withdraw(uint256)')).toBe(WETH_WITHDRAW_SELECTOR);
    expect(toHex(encodeWethDeposit())).toBe('0xd0e30db0');
    expect(toHex(encodeWethWithdraw(10n ** 16n))).toBe('0x2e1a7d4d' + (10n ** 16n).toString(16).padStart(64, '0'));
    expect(() => encodeWethWithdraw(0n)).toThrow('ABI_NON_CANONICAL');
  });
  it('native input: one exactInputSingle from WETH9 to the owner, round-tripped exactly', () => {
    const input: NativeSwapArguments = { ...base, native: 'INPUT', tokenIn: WETH, tokenOut: USDC };
    const data = encodeNativeSwap(input), hex = toHex(data);
    expect(hex.slice(0, 10)).toBe(MULTICALL_SELECTOR);
    expect(hex).toContain(EXACT_INPUT_SINGLE_SELECTOR.slice(2)); expect(hex).not.toContain(UNWRAP_WETH9_SELECTOR.slice(2));
    expect(decodeNativeSwap(data, WETH)).toEqual(input);
  });
  it('native output: the swap pays the router, then unwrapWETH9 pays at least the minimum to the owner in native ETH', () => {
    const output: NativeSwapArguments = { ...base, native: 'OUTPUT', tokenIn: USDC, tokenOut: WETH, amountIn: 5_000_000n, amountOutMinimum: 1_600_000_000_000_000n };
    const data = encodeNativeSwap(output), hex = toHex(data);
    expect(hex).toContain(ROUTER_ADDRESS_THIS.slice(2).padStart(64, '0'));
    expect(hex.endsWith(UNWRAP_WETH9_SELECTOR.slice(2) + output.amountOutMinimum.toString(16).padStart(64, '0') + OWNER.slice(2).padStart(64, '0') + '0'.repeat(56))).toBe(true);
    expect(decodeNativeSwap(data, WETH)).toEqual(output);
  });
  it('refuses a substituted wrapped asset, a router recipient, a zero minimum or any non-canonical bytes', () => {
    expect(() => encodeNativeSwap({ ...base, native: 'INPUT', tokenIn: USDC, tokenOut: WETH })).toThrow('ABI_NON_CANONICAL');
    expect(() => encodeNativeSwap({ ...base, native: 'OUTPUT', tokenIn: USDC, tokenOut: USDC })).toThrow('ABI_NON_CANONICAL');
    expect(() => encodeNativeSwap({ ...base, native: 'OUTPUT', tokenIn: USDC, tokenOut: WETH, recipient: ROUTER_ADDRESS_THIS })).toThrow('ABI_NON_CANONICAL');
    expect(() => encodeNativeSwap({ ...base, native: 'INPUT', tokenIn: WETH, tokenOut: USDC, amountOutMinimum: 0n })).toThrow('ABI_NON_CANONICAL');
    const data = encodeNativeSwap({ ...base, native: 'OUTPUT', tokenIn: USDC, tokenOut: WETH });
    const padding = new Uint8Array(data); padding[padding.length - 1] = 1;
    expect(() => decodeNativeSwap(padding, WETH)).toThrow('ABI_NON_CANONICAL');
    // A changed recipient decodes to that other recipient (never the owner): the service compares it with the reviewed owner.
    const elsewhere = new Uint8Array(data); elsewhere[elsewhere.length - 33] ^= 1;
    expect(decodeNativeSwap(elsewhere, WETH).recipient).not.toBe(OWNER);
    expect(() => decodeNativeSwap(data, USDC)).toThrow('ABI_NON_CANONICAL');
  });
});
