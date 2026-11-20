// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DISPLAY_SIGNIFICANT_DIGITS, displayAmountExpression, displayAmountText, displayTokenAmount, formatDisplayTokenAmount, shortTokenDecimal } from './token-amount-display';

const text = (value: Parameters<typeof formatDisplayTokenAmount>[0], options: Parameters<typeof formatDisplayTokenAmount>[1] = {}) => formatDisplayTokenAmount(value, options);
/** Significant digits of the number shown (compact units expanded). */
const significant = (shown: string) => shown.replace(/[^0-9]/g, '').replace(/^0+/, '').replace(/0+$/, '').length;

describe('C — the global six-significant-digit token presentation', () => {
  it('meets the acceptance examples exactly', () => {
    expect(text('0.000570195181991')).toBe('≈ 0.000570195');
    expect(text('0.987251987654')).toBe('≈ 0.987252');
    // The brief's "≈ 1234.57": the same six digits, with the locale's thousands separator (EN 1,234.57 · PT 1.234,57).
    expect(text('1234.567891')).toBe('≈ 1,234.57');
    expect(text('1234.567891', { language: 'PT' })).toBe('≈ 1.234,57');
    expect(text('0.00000000123456789')).toBe('≈ 0.00000000123457');
    expect(text('25.000000000')).toBe('25');
    expect(text('0')).toBe('0');
  });

  it('counts significant digits, not decimals, for tokens of 6, 8, 9, 18 and other decimals', () => {
    const cases: [string, number, string][] = [
      ['1234567', 6, '1.23457'],                    // USDC
      ['12345678', 8, '0.123457'],                  // cbBTC
      ['570195181', 9, '0.570195'],                 // SOL (lamports)
      ['570195181991000', 18, '0.000570195'],       // ETH / WETH
      ['987251987654000000', 18, '0.987252'],
      ['1', 18, '0.000000000000000001'],            // one wei: never 0
      ['123456789', 2, '1.23457M'],
      ['123456789', 4, '12,345.7'],
      ['42', 0, '42'],
      ['1000000000000000000000', 24, '0.001'],
    ];
    for (const [units, decimals, expected] of cases) {
      const shown = displayTokenAmount({ units, decimals })!;
      expect(shown.value, `${units}/${decimals}`).toBe(expected);
      expect(significant(shown.value)).toBeLessThanOrEqual(DISPLAY_SIGNIFICANT_DIGITS);
    }
  });

  it('never shows a positive amount as zero, at any magnitude', () => {
    for (let exponent = 1; exponent <= 60; exponent++) {
      const tiny = `0.${'0'.repeat(exponent - 1)}1`;
      for (const rounding of ['nearest', 'down', 'up'] as const) {
        const shown = displayTokenAmount(tiny, { rounding })!;
        expect(shown.value).not.toMatch(/^0([.,]0*)?$/);
        expect(shown.value).not.toMatch(/e/i);
      }
    }
    expect(text('0.0000001234564', { rounding: 'down' })).toBe('0.000000123456');
  });

  it('rounds a minimum down, a maximum up and an estimate to nearest — and marks only the estimate', () => {
    expect(text('0.9872519', { rounding: 'down' })).toBe('0.987251');
    expect(text('0.9872511', { rounding: 'up' })).toBe('0.987252');
    expect(text('0.9872515', { rounding: 'nearest' })).toBe('≈ 0.987252');
    expect(text('0.9872514', { rounding: 'nearest' })).toBe('≈ 0.987251');
    // A guaranteed minimum is never overstated and a maximum never understated.
    for (const value of ['1.0000009', '999999.99', '0.1234565', '7.77777777777']) {
      const exact = Number(value);
      expect(Number(displayTokenAmount(value, { rounding: 'down' })!.exact)).toBe(exact);
      expect(Number(shortTokenDecimal(value, 'down'))).toBeLessThanOrEqual(exact);
      expect(Number(shortTokenDecimal(value, 'up'))).toBeGreaterThanOrEqual(exact);
    }
    // An exact value carries no marker; an explicit marker can be requested for a rounded limit.
    expect(text('25', { rounding: 'up' })).toBe('25');
    expect(text('0.1234567', { rounding: 'up', marker: true })).toBe('≈ 0.123457');
  });

  it('keeps large integers readable without inventing precision: thousands grouped, a compact unit from seven digits', () => {
    expect(text('12345.678')).toBe('≈ 12,345.7');
    expect(text('123456.78')).toBe('≈ 123,457');
    expect(text('1234567.89')).toBe('≈ 1.23457M');
    expect(text('1000000')).toBe('1M');
    expect(text('999999.5')).toBe('≈ 1M');
    expect(text('2500000000')).toBe('2.5B');
    expect(text('1234567890123456')).toBe('≈ 1234.57T');
    expect(text('1234567.89', { language: 'PT' })).toBe('≈ 1,23457 mi');
    expect(displayTokenAmount('1234567.89')!.exactText).toBe('1,234,567.89');
  });

  it('respects EN and PT separators and keeps the symbol', () => {
    expect(text('12345.678', { language: 'PT', symbol: 'USDC' })).toBe('≈ 12.345,7 USDC');
    expect(text('0.000570195181991', { language: 'PT', symbol: 'WETH' })).toBe('≈ 0,000570195 WETH');
    expect(displayTokenAmount('0.000570195181991', { language: 'PT', symbol: 'WETH' })).toMatchObject({
      exact: '0.000570195181991', exactText: '0,000570195181991 WETH', approximate: true });
  });

  it('handles negatives and never turns an unavailable value into 0', () => {
    expect(text('-0.000570195181991')).toBe('≈ -0.000570195');
    expect(text('-1234.567891', { rounding: 'down' })).toBe('-1,234.56');
    expect(text('-1234.561', { rounding: 'up' })).toBe('-1,234.57');
    for (const missing of [null, undefined, '', 'abc', '1e-9', 'NaN', '1,5', '0x10'])
      expect(displayTokenAmount(missing as string | null)).toBeNull();
    expect(text(null)).toBe('—');
    expect(text(undefined, { unavailable: 'Not available' })).toBe('Not available');
    expect(displayTokenAmount({ units: '12', decimals: -1 })).toBeNull();
    expect(displayTokenAmount({ units: '1.5', decimals: 6 })).toBeNull();
  });

  it('is exact BigInt arithmetic: no Number conversion loses digits', () => {
    // 2^64 + 1 base units at 18 decimals: a Number would read 18.446744073709553.
    const shown = displayTokenAmount({ units: (2n ** 64n + 1n).toString(), decimals: 18 })!;
    expect(shown.exact).toBe('18.446744073709551617');
    expect(shown.value).toBe('18.4467');
    expect(displayTokenAmount({ units: 10n ** 40n + 1n, decimals: 0 })!.exact).toBe('10000000000000000000000000000000000000001');
  });

  it('reformats only a "<number> <symbol>" text; anything else is kept exactly as written', () => {
    expect(displayAmountText('0.000003724947756 ETH')!.text).toBe('≈ 0.00000372495 ETH');
    expect(displayAmountText('25 USDC')!.text).toBe('25 USDC');
    for (const free of ['0x1234abcd', 'Swap 0.123456789 WETH to USDC', '0.3 WETH + 1,008 USDC', 'Not recorded', '#12345678', 'position 1234567'])
      expect(displayAmountText(free), free).toBeNull();
  });
});

describe('C — amount fields composed of several tokens or bounds', () => {
  it('shortens each part, keeps bounds conservative and leaves any other text alone', () => {
    expect(displayAmountExpression('0.000570195181991 WETH + 1500.1234567 USDC')).toMatchObject({
      text: '≈ 0.000570195 WETH + ≈ 1,500.12 USDC', exact: '0.000570195181991 WETH + 1500.1234567 USDC', approximate: true });
    // A lower bound is rounded down and an upper bound up; the bound sign replaces the "≈" marker.
    expect(displayAmountExpression('≥ 0.9872519 WETH + 1.0000009 USDC')!.text).toBe('≥ 0.987251 WETH + 1 USDC');
    expect(displayAmountExpression('≤ 0.9872511 ETH')!.text).toBe('≤ 0.987252 ETH');
    expect(displayAmountExpression('25 USDC', { language: 'PT' })).toMatchObject({ text: '25 USDC', approximate: false });
    expect(displayAmountExpression('12345.678 USDC', { language: 'PT' })!.exactText).toBe('12.345,678 USDC');
    for (const other of ['—', 'Stays in your wallet', '#123456', '0x' + 'ab'.repeat(20), '1 of 2 steps', '0.5% slippage', '25 USDC to 0xabc and more'])
      expect(displayAmountExpression(other), other).toBeNull();
  });
});

describe('C — composed domain strings never look exact when rounded', () => {
  it('shortTokenDecimal keeps every integer digit and drops only the fraction of a large amount', () => {
    expect(shortTokenDecimal('12345678.9', 'down')).toBe('12345678');
    expect(shortTokenDecimal('12345678.9', 'up')).toBe('12345679');
    expect(shortTokenDecimal('12345678.4')).toBe('12345678');
    expect(shortTokenDecimal({ units: '12345678900000', decimals: 6 }, 'down')).toBe('12345678');
    expect(shortTokenDecimal('1234.567891')).toBe('1234.57');
    expect(shortTokenDecimal('0.000570195181991')).toBe('0.000570195');
  });
});

