// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-P1 pool conversational reliability: a percentage or price range read in the direction a person reads the pool (USDC per WETH), whatever
 * the pool's token order. On Base mainnet WETH is token0 and USDC token1, so "USDC per WETH" is token1 per token0 and a higher tick is a higher price.
 */
import { describe, expect, it } from 'vitest';
import { sqrtRatioAtTick, uniswapAlignPriceRange, uniswapAlignQuotePriceRange, uniswapBandAroundSqrtPrice, uniswapBandAroundSqrtPriceIn, uniswapPriceAtSqrt,
  uniswapPriceAtTick, uniswapQuotePriceAtSqrt, uniswapQuotePriceAtTick } from '../src/index.js';

// Base mainnet pool order: token0 WETH (18 decimals), token1 USDC (6 decimals). USDC per WETH = token1 per token0.
const D0 = 18, D1 = 6, SPACING = 60;
const human = (tick: number) => Number(uniswapPriceAtTick(tick, D0, D1, 'TOKEN1_PER_TOKEN0'));
const float = (tick: number) => Math.pow(1.0001, tick) * 1e12;
// A pool at about 3,000 USDC per WETH: ratio = 3000 · 10^(6 − 18).
const TICK = -196_257, SQRT = sqrtRatioAtTick(TICK) + 12_345n;

describe('Uniswap v3 price orientation', () => {
  it('reads token1 per token0 as the exact inverse of the quote convention, a higher tick being a higher price', () => {
    for (const tick of [-200_000, -196_257, -50_000, 0, 50_000]) expect(Math.abs(human(tick) / float(tick) - 1)).toBeLessThan(1e-7);
    expect(human(-196_200)).toBeGreaterThan(human(-196_260));
    const inverse = Number(uniswapQuotePriceAtSqrt(SQRT, D0, D1, 18)) * Number(uniswapPriceAtSqrt(SQRT, D0, D1, 'TOKEN1_PER_TOKEN0', 18));
    expect(Math.abs(inverse - 1)).toBeLessThan(1e-12);
    expect(uniswapPriceAtSqrt(SQRT, D0, D1, 'TOKEN0_PER_TOKEN1')).toBe(uniswapQuotePriceAtSqrt(SQRT, D0, D1));
    expect(uniswapPriceAtTick(TICK, D0, D1, 'TOKEN0_PER_TOKEN1')).toBe(uniswapQuotePriceAtTick(TICK, D0, D1));
  });
  it('the default orientation is unchanged: TOKEN0_PER_TOKEN1 is exactly the existing quote helpers', () => {
    expect(uniswapBandAroundSqrtPriceIn(SQRT, 1_000, SPACING, 'TOKEN0_PER_TOKEN1')).toEqual(uniswapBandAroundSqrtPrice(SQRT, 1_000, SPACING));
    expect(uniswapAlignPriceRange('0.0003', '0.0004', D0, D1, SPACING, 'TOKEN0_PER_TOKEN1')).toEqual(uniswapAlignQuotePriceRange('0.0003', '0.0004', D0, D1, SPACING));
  });
  it('±10% in USDC per WETH is symmetric in USDC per WETH, aligned outward to the spacing, and contains the requested band', () => {
    const price = Number(uniswapPriceAtSqrt(SQRT, D0, D1, 'TOKEN1_PER_TOKEN0', 18));
    const { tickLower, tickUpper } = uniswapBandAroundSqrtPriceIn(SQRT, 1_000, SPACING, 'TOKEN1_PER_TOKEN0');
    expect(Math.abs(tickLower % SPACING)).toBe(0); expect(Math.abs(tickUpper % SPACING)).toBe(0);
    expect(human(tickLower)).toBeLessThanOrEqual(price * 0.9); expect(human(tickUpper)).toBeGreaterThanOrEqual(price * 1.1);
    // Outward by less than one spacing step (0.6%) on each side.
    expect(human(tickLower + SPACING)).toBeGreaterThan(price * 0.9); expect(human(tickUpper - SPACING)).toBeLessThan(price * 1.1);
    // Reading the band the other way round would not be ±10% in USDC per WETH: it is a different, inverted band.
    const inverted = uniswapBandAroundSqrtPrice(SQRT, 1_000, SPACING);
    expect(inverted).not.toEqual({ tickLower, tickUpper });
  });
  it('an explicit USDC-per-WETH price range aligns outward and contains the requested prices', () => {
    const { tickLower, tickUpper } = uniswapAlignPriceRange('2800', '3200', D0, D1, SPACING, 'TOKEN1_PER_TOKEN0');
    expect(Math.abs(tickLower % SPACING)).toBe(0); expect(Math.abs(tickUpper % SPACING)).toBe(0);
    expect(human(tickLower)).toBeLessThanOrEqual(2800); expect(human(tickUpper)).toBeGreaterThanOrEqual(3200);
    expect(human(tickLower + SPACING)).toBeGreaterThan(2800); expect(human(tickUpper - SPACING)).toBeLessThan(3200);
  });
  it('refuses an inverted, empty or unusable range and an unknown orientation (fail closed)', () => {
    expect(() => uniswapAlignPriceRange('3200', '2800', D0, D1, SPACING, 'TOKEN1_PER_TOKEN0')).toThrow('UNISWAP_RANGE_INVALID');
    expect(() => uniswapAlignPriceRange('3000', '3000', D0, D1, SPACING, 'TOKEN1_PER_TOKEN0')).toThrow('UNISWAP_RANGE_INVALID');
    expect(() => uniswapAlignPriceRange('0', '3000', D0, D1, SPACING, 'TOKEN1_PER_TOKEN0')).toThrow('UNISWAP_PRICE_INVALID');
    expect(() => uniswapAlignPriceRange('2800', '3200', D0, D1, 0, 'TOKEN1_PER_TOKEN0')).toThrow('UNISWAP_TICK_SPACING_INVALID');
    expect(() => uniswapBandAroundSqrtPriceIn(SQRT, 0, SPACING, 'TOKEN1_PER_TOKEN0')).toThrow('UNISWAP_BAND_INVALID');
    expect(() => uniswapBandAroundSqrtPriceIn(SQRT, 9_001, SPACING, 'TOKEN1_PER_TOKEN0')).toThrow('UNISWAP_BAND_INVALID');
    expect(() => uniswapBandAroundSqrtPriceIn(SQRT, 1_000, SPACING, 'SIDEWAYS' as 'TOKEN0_PER_TOKEN1')).toThrow('UNISWAP_PRICE_ORIENTATION_INVALID');
    expect(() => uniswapPriceAtSqrt(0n, D0, D1, 'TOKEN1_PER_TOKEN0')).toThrow('UNISWAP_PRICE_INVALID');
  });
});
