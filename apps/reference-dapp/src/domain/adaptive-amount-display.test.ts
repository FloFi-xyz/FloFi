// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ADAPTIVE_AMOUNT_PILOT, adaptiveDisplayAmount, adaptiveFractionDigits, trustedUsdPrice, type UsdPriceEvidence } from './adaptive-amount-display';
import { displayTokenAmount, displayTokenAmountAtDecimals } from './token-amount-display';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const at = (priceUsd: string, ageMs = 10_000): UsdPriceEvidence => ({ priceUsd, observedAt: new Date(NOW - ageMs).toISOString() });
/** Exact decimal → [numerator, scale] for error checks with BigInt (never floats). */
function exactOf(value: string): [bigint, number] { const [w, f = ''] = value.replace('-', '').split('.'); return [BigInt(w! + f), f.length]; }
function errorWithin(exact: string, shown: string, priceUsd: string) {
  const [e, es] = exactOf(exact), [s, ss] = exactOf(shown), [p, ps] = exactOf(priceUsd), scale = Math.max(es, ss);
  const E = e * 10n ** BigInt(scale - es), S = s * 10n ** BigInt(scale - ss), diff = E > S ? E - S : S - E;
  // monetary: diff/10^scale × p/10^ps ≤ 1/1000; relative: diff/E ≤ 10/10000
  return { monetary: diff * p * 1000n <= 10n ** BigInt(scale + ps), relative: diff * 10_000n <= E * 10n };
}
const canonical = (text: string) => text.replace(/^≈ /, '').replace(/ [A-Z]+$/, '').replace(/,/g, '');

describe('UX-06 adaptive decimals (presentation only)', () => {
  it('chooses the smallest precision within US$ 0.001 and 0.1 % (the guideline\'s example token at US$ 0.01)', () => {
    const shown = adaptiveDisplayAmount('123.456789', { price: at('0.01'), now: NOW, symbol: 'TKN' })!;
    expect(shown.basis).toBe('usd-impact');
    expect(shown.text).toBe('≈ 123.5 TKN');
    expect(shown.exact).toBe('123.456789');
    expect(errorWithin('123.456789', canonical(shown.text), '0.01')).toEqual({ monetary: true, relative: true });
    // One decimal fewer would exceed the monetary budget (|123 − 123.456789| × 0.01 ≈ US$ 0.0046).
    expect(errorWithin('123.456789', '123', '0.01').monetary).toBe(false);
  });
  it('grows the precision automatically for an expensive token (US$ 100,000)', () => {
    const digits = adaptiveFractionDigits('0.12345678', { numerator: 100_000n, denominator: 1n });
    expect(digits).toBe(8);
    const shown = adaptiveDisplayAmount('0.12345678', { price: at('100000'), now: NOW })!;
    expect(shown.text).toBe('0.12345678');
    expect(shown.approximate).toBe(false);
  });
  it('falls back to six significant digits without a trusted price, and says so', () => {
    for (const price of [null, at('2', 3 * 60_000), at('2', -60_000), at('0'), at('-1'), at('1e3'), at('abc'), { priceUsd: '2', observedAt: 'not a date' }]) {
      const shown = adaptiveDisplayAmount('0.000570195181991', { price, now: NOW, symbol: 'WETH' })!;
      expect(shown.basis).toBe('significant-digits');
      expect(shown.text).toBe(displayTokenAmount('0.000570195181991', { symbol: 'WETH' })!.text);
    }
  });
  it('trusts only a fresh, positive, well-formed price', () => {
    expect(trustedUsdPrice(at('3150.25'), NOW)).toEqual({ numerator: 315025n, denominator: 100n });
    expect(trustedUsdPrice(at('3150.25', ADAPTIVE_AMOUNT_PILOT.maxPriceAgeMs + 1), NOW)).toBeNull();
    expect(trustedUsdPrice(at('3150.25', -ADAPTIVE_AMOUNT_PILOT.clockSkewMs - 1), NOW)).toBeNull();
    expect(trustedUsdPrice(at('0.0'), NOW)).toBeNull();
  });
  it('never shows a positive amount as zero', () => {
    for (const [amount, price] of [['0.0000004', '0.0001'], ['0.000000000000000001', '0.000001'], ['0.9', '0.000000001']] as const) {
      const shown = adaptiveDisplayAmount(amount, { price: at(price), now: NOW, rounding: 'down' })!;
      expect(/^0([.,]0*)?$/.test(canonical(shown.text))).toBe(false);
      expect(displayTokenAmountAtDecimals(amount, 0, { rounding: 'down' })!.value).not.toBe('0');
    }
  });
  it('rounds by purpose: a minimum never above the exact value, a maximum never below it', () => {
    const values = ['1.999999999', '0.123456789', '987654.321987', '0.000100001', '42.0000001', '3.14159265358979'];
    for (const value of values) for (const price of ['0.01', '1', '3150.25', '65000']) {
      const down = canonical(adaptiveDisplayAmount(value, { price: at(price), now: NOW, rounding: 'down' })!.text);
      const up = canonical(adaptiveDisplayAmount(value, { price: at(price), now: NOW, rounding: 'up' })!.text);
      const [e, es] = exactOf(value), [d, ds] = exactOf(down), [u, us] = exactOf(up), scale = Math.max(es, ds, us);
      const lift = (n: bigint, s: number) => n * 10n ** BigInt(scale - s);
      expect(lift(d, ds) <= lift(e, es)).toBe(true);
      expect(lift(u, us) >= lift(e, es)).toBe(true);
      for (const shown of [down, up]) expect(errorWithin(value, shown, price)).toEqual({ monetary: true, relative: true });
    }
  });
  it('keeps the exact value available and formats PT separators', () => {
    const shown = adaptiveDisplayAmount({ units: '1234567891', decimals: 6 }, { price: at('1.0002'), now: NOW, language: 'PT', symbol: 'USDC' })!;
    expect(shown.exact).toBe('1234.567891');
    expect(shown.exactText).toBe('1.234,567891 USDC');
    expect(shown.text).toBe('≈ 1.234,568 USDC');
  });
});
