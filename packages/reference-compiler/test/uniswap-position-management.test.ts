// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { decodeUniswapAmounts, decodeUniswapBurn, decodeUniswapCollect, decodeUniswapDecreaseLiquidity, decodeUniswapMulticall,
  decodeUniswapMulticallResult, decodeUniswapPositionRequest, encodeUniswapBurn, encodeUniswapCollect, encodeUniswapDecreaseLiquidity,
  encodeUniswapMulticall, sqrtRatioAtTick, uniswapAmountsForLiquidity, uniswapComposition, uniswapLiquidityPortion, uniswapPositionPlan,
  UNISWAP_MAX_UINT128, UNISWAP_POSITION_SELECTORS as SEL, UNISWAP_POSITION_TOPICS as TOPIC } from '../src/index.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const w = (n: bigint) => n.toString(16).padStart(64, '0');

describe('Uniswap v3 position management calldata (BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001)', () => {
  it('pins the NonfungiblePositionManager selectors and the receipt topics it reconciles', () => {
    expect(SEL).toMatchObject({ decreaseLiquidity: '0x0c49ccbe', collect: '0xfc6f7865', burn: '0x42966c68', multicall: '0xac9650d8' });
    expect(TOPIC.decreaseLiquidity).toBe('0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4');
    expect(TOPIC.collect).toBe('0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01');
  });

  it('encodes decreaseLiquidity, collect and burn exactly and decodes only canonical calldata', () => {
    const decrease = { tokenId: 9_001n, liquidity: 123_456n, amount0Min: 10n, amount1Min: 0n, deadline: 1_900_000_000n };
    const data = encodeUniswapDecreaseLiquidity(decrease);
    expect(data).toBe('0x0c49ccbe' + w(9_001n) + w(123_456n) + w(10n) + w(0n) + w(1_900_000_000n));
    expect(decodeUniswapDecreaseLiquidity(data)).toEqual(decrease);
    expect(() => decodeUniswapDecreaseLiquidity(data.toUpperCase().replace('0X', '0x'))).toThrow('UNISWAP_DECREASE_INVALID');
    expect(() => decodeUniswapDecreaseLiquidity(data + '00')).toThrow('UNISWAP_DECREASE_INVALID');
    expect(() => encodeUniswapDecreaseLiquidity({ ...decrease, liquidity: 0n })).toThrow('UNISWAP_DECREASE_INVALID');
    expect(() => encodeUniswapDecreaseLiquidity({ ...decrease, liquidity: UNISWAP_MAX_UINT128 + 1n })).toThrow('UNISWAP_DECREASE_INVALID');
    // A liquidity word above uint128 is not canonical for the manager's uint128 field.
    expect(() => decodeUniswapDecreaseLiquidity('0x0c49ccbe' + w(1n) + w(UNISWAP_MAX_UINT128 + 1n) + w(0n) + w(0n) + w(1n))).toThrow('UNISWAP_DECREASE_INVALID');

    const collect = { tokenId: 9_001n, recipient: OWNER, amount0Max: UNISWAP_MAX_UINT128, amount1Max: UNISWAP_MAX_UINT128 };
    const c = encodeUniswapCollect(collect);
    expect(c).toBe('0xfc6f7865' + w(9_001n) + OWNER.slice(2).padStart(64, '0') + w(UNISWAP_MAX_UINT128) + w(UNISWAP_MAX_UINT128));
    expect(decodeUniswapCollect(c)).toEqual(collect);
    // The zero recipient would route the tokens to the manager itself (its unwrap path): never encoded or accepted.
    expect(() => encodeUniswapCollect({ ...collect, recipient: '0x' + '0'.repeat(40) })).toThrow('UNISWAP_COLLECT_INVALID');
    expect(() => encodeUniswapCollect({ ...collect, amount0Max: 0n, amount1Max: 0n })).toThrow('UNISWAP_COLLECT_INVALID');
    expect(() => decodeUniswapCollect('0xfc6f7865' + w(1n) + w(1n << 160n) + w(1n) + w(1n))).toThrow('UNISWAP_COLLECT_INVALID');

    expect(decodeUniswapBurn(encodeUniswapBurn(9_001n))).toBe(9_001n);
    expect(() => encodeUniswapBurn(0n)).toThrow('UNISWAP_BURN_INVALID');
  });

  it('encodes multicall(bytes[]) in the standard ABI layout and rejects anything non-canonical', () => {
    const encoded = encodeUniswapMulticall(['0x01020304', '0xaabb']);
    expect(encoded).toBe('0xac9650d8' + w(32n) + w(2n) + w(64n) + w(128n) + w(4n) + '01020304'.padEnd(64, '0') + w(2n) + 'aabb'.padEnd(64, '0'));
    expect(decodeUniswapMulticall(encoded)).toEqual(['0x01020304', '0xaabb']);
    expect(() => encodeUniswapMulticall(['0x01'])).toThrow('UNISWAP_MULTICALL_INVALID');
    // Trailing garbage, a moved offset or a wrong head offset are refused.
    expect(() => decodeUniswapMulticall(encoded + w(0n))).toThrow('UNISWAP_MULTICALL_INVALID');
    expect(() => decodeUniswapMulticall(encoded.replace(w(128n), w(96n)))).toThrow('UNISWAP_MULTICALL_INVALID');
    expect(() => decodeUniswapMulticall('0xac9650d8' + w(64n) + encoded.slice(74))).toThrow('UNISWAP_MULTICALL_INVALID');
    // multicall's return value is bytes[] with the same layout (without the selector).
    const result = '0x' + encoded.slice(10);
    expect(decodeUniswapMulticallResult(result, 2)).toEqual(['0x01020304', '0xaabb']);
    expect(() => decodeUniswapMulticallResult(result, 3)).toThrow('UNISWAP_MULTICALL_RESULT_INVALID');
    expect(decodeUniswapAmounts('0x' + w(5n) + w(7n))).toEqual({ amount0: 5n, amount1: 7n });
    expect(() => decodeUniswapAmounts('0x' + w(5n))).toThrow('UNISWAP_AMOUNTS_RESULT_INVALID');
  });

  it('derives a percentage of the position liquidity with integer arithmetic, never of a wallet balance', () => {
    expect(uniswapLiquidityPortion(1_000_001n, 5_000)).toBe(500_000n);
    expect(uniswapLiquidityPortion(1_000_001n, 2_500)).toBe(250_000n);
    expect(uniswapLiquidityPortion(1_000_001n, 7_500)).toBe(750_000n);
    expect(uniswapLiquidityPortion(1_000_001n, 10_000)).toBe(1_000_001n);
    expect(uniswapLiquidityPortion(UNISWAP_MAX_UINT128, 3_333)).toBe(UNISWAP_MAX_UINT128 * 3_333n / 10_000n);
    expect(() => uniswapLiquidityPortion(3n, 1)).toThrow('UNISWAP_POSITION_PORTION_TOO_SMALL');
    for (const bad of [0, 10_001, 12.5, Number.NaN]) expect(() => uniswapLiquidityPortion(1_000n, bad)).toThrow('UNISWAP_POSITION_PORTION_INVALID');
    expect(() => uniswapLiquidityPortion(0n, 5_000)).toThrow('UNISWAP_POSITION_LIQUIDITY_INVALID');
  });

  it('plans one wallet request per operation: collect alone, or decrease + collect (+ burn only when closing) in one atomic multicall', () => {
    const base = { tokenId: 77n, recipient: OWNER, positionLiquidity: 1_000_000n, amount0Min: 1n, amount1Min: 2n, deadline: 1_900_000_000n };
    const collect = uniswapPositionPlan({ ...base, operation: 'COLLECT', partBps: null, close: false });
    expect(collect.liquidityToRemove).toBe(0n);
    expect(collect.calls.map(c => c.kind)).toEqual(['COLLECT']);
    expect(collect.data.startsWith(SEL.collect)).toBe(true);
    expect(decodeUniswapCollect(collect.data)).toMatchObject({ tokenId: 77n, recipient: OWNER, amount0Max: UNISWAP_MAX_UINT128, amount1Max: UNISWAP_MAX_UINT128 });

    const half = uniswapPositionPlan({ ...base, operation: 'DECREASE', partBps: 5_000, close: false });
    expect(half.liquidityToRemove).toBe(500_000n);
    expect(half.calls.map(c => c.kind)).toEqual(['DECREASE_LIQUIDITY', 'COLLECT']);
    expect(decodeUniswapPositionRequest(half.data).map(c => c.kind)).toEqual(['DECREASE_LIQUIDITY', 'COLLECT']);
    expect(decodeUniswapDecreaseLiquidity(half.calls[0]!.data)).toEqual({ tokenId: 77n, liquidity: 500_000n, amount0Min: 1n, amount1Min: 2n, deadline: 1_900_000_000n });

    const exit = uniswapPositionPlan({ ...base, operation: 'EXIT', partBps: null, close: false });
    expect(exit.liquidityToRemove).toBe(1_000_000n);
    expect(exit.calls.map(c => c.kind)).toEqual(['DECREASE_LIQUIDITY', 'COLLECT']);
    // Removing 100% never burns by itself: closing is a separate, explicit choice.
    const close = uniswapPositionPlan({ ...base, operation: 'EXIT', partBps: null, close: true });
    expect(close.calls.map(c => c.kind)).toEqual(['DECREASE_LIQUIDITY', 'COLLECT', 'BURN']);
    expect(decodeUniswapPositionRequest(close.data).map(c => c.kind)).toEqual(['DECREASE_LIQUIDITY', 'COLLECT', 'BURN']);
    const emptyClose = uniswapPositionPlan({ ...base, positionLiquidity: 0n, operation: 'EXIT', partBps: null, close: true });
    expect(emptyClose.calls.map(c => c.kind)).toEqual(['COLLECT', 'BURN']);
    expect(uniswapPositionPlan({ ...base, positionLiquidity: 0n, operation: 'EXIT', partBps: null, close: false }).calls.map(c => c.kind)).toEqual(['COLLECT']);

    expect(() => uniswapPositionPlan({ ...base, operation: 'DECREASE', partBps: 10_000, close: false })).toThrow('UNISWAP_POSITION_PORTION_INVALID');
    expect(() => uniswapPositionPlan({ ...base, operation: 'DECREASE', partBps: null, close: false })).toThrow('UNISWAP_POSITION_PORTION_INVALID');
    expect(() => uniswapPositionPlan({ ...base, operation: 'DECREASE', partBps: 5_000, close: true })).toThrow('UNISWAP_POSITION_OPERATION_INVALID');
    expect(() => uniswapPositionPlan({ ...base, operation: 'COLLECT', partBps: 5_000, close: false })).toThrow('UNISWAP_POSITION_PORTION_INVALID');
    expect(() => uniswapPositionPlan({ ...base, operation: 'COLLECT', partBps: null, close: true })).toThrow('UNISWAP_POSITION_OPERATION_INVALID');
  });

  it('refuses a request whose calls are out of order, mixed across positions or not position management at all', () => {
    const collect = encodeUniswapCollect({ tokenId: 1n, recipient: OWNER, amount0Max: UNISWAP_MAX_UINT128, amount1Max: UNISWAP_MAX_UINT128 });
    const decrease = encodeUniswapDecreaseLiquidity({ tokenId: 1n, liquidity: 5n, amount0Min: 0n, amount1Min: 0n, deadline: 10n });
    expect(() => decodeUniswapPositionRequest(encodeUniswapMulticall([encodeUniswapBurn(1n), collect]))).toThrow('UNISWAP_POSITION_REQUEST_INVALID');
    expect(() => decodeUniswapPositionRequest(encodeUniswapMulticall([decrease, encodeUniswapCollect({ tokenId: 2n, recipient: OWNER, amount0Max: 1n, amount1Max: 1n })])))
      .toThrow('UNISWAP_POSITION_REQUEST_INVALID');
    expect(() => decodeUniswapPositionRequest(encodeUniswapMulticall([decrease, decrease]))).toThrow('UNISWAP_POSITION_REQUEST_INVALID');
    expect(() => decodeUniswapPositionRequest(decrease)).toThrow('UNISWAP_POSITION_REQUEST_INVALID');
    expect(() => decodeUniswapPositionRequest('0x095ea7b3' + w(1n) + w(1n))).toThrow('UNISWAP_POSITION_REQUEST_INVALID');
  });

  it('describes principal at the pool price with the pool rounding (below, inside and above the range)', () => {
    const lower = 190_000, upper = 200_000, liquidity = 10n ** 15n;
    const below = uniswapAmountsForLiquidity(sqrtRatioAtTick(185_000), lower, upper, liquidity);
    expect(below.amount1).toBe(0n);
    expect(below.amount0 > 0n).toBe(true);
    const above = uniswapAmountsForLiquidity(sqrtRatioAtTick(205_000), lower, upper, liquidity);
    expect(above.amount0).toBe(0n);
    const inside = uniswapAmountsForLiquidity(sqrtRatioAtTick(195_000), lower, upper, liquidity);
    // The mint math rounds a deposit up; a removal of the same liquidity rounds down, so it is never larger.
    const mint = uniswapComposition(sqrtRatioAtTick(195_000), 195_000, lower, upper, inside.amount0 * 2n, inside.amount1 * 2n);
    expect(inside.amount0 > 0n && inside.amount1 > 0n).toBe(true);
    const scaled = uniswapAmountsForLiquidity(sqrtRatioAtTick(195_000), lower, upper, mint.liquidity);
    expect(scaled.amount0 <= mint.amount0 && scaled.amount1 <= mint.amount1).toBe(true);
    expect(() => uniswapAmountsForLiquidity(sqrtRatioAtTick(195_000), upper, lower, liquidity)).toThrow('UNISWAP_POSITION_INVALID');
  });
});
