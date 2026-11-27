// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (R06/R07): the global token-amount presentation rule, on the owner's own examples, through every shared
 * entry point the surfaces use: the shared formatter (`displayTokenAmount`, Chat/Telegram/Review), the Canvas rule (`significantAmount`, every read-only
 * card value, now including source boxes) and balance shortcuts (`shortcutFigure`). Presentation only: the exact strings and integer amounts passed in
 * are never changed, and nonzero never reads as zero.
 */
import { describe, expect, it } from 'vitest';
import { displayTokenAmount } from './token-amount-display';
import { shortcutFigure } from './amount-shortcuts';
import { significantAmount } from '../components/composer-card';

const EXAMPLES: readonly (readonly [string, string])[] = [
  ['0.057923834925903535', '0.0579238'],
  ['0.039961699395000574', '0.0399617'],
  ['0.040000000000000000', '0.04'],
  ['100.000000', '100'],
  ['0.000000123456789', '0.000000123457'],
];

describe('global token amount presentation', () => {
  it.each(EXAMPLES)('%s reads %s on the Canvas and in the shared formatter', (exact, shown) => {
    expect(significantAmount(exact)).toBe(shown);
    expect(displayTokenAmount(exact, { marker: false, group: false })?.value).toBe(shown);
  });

  it('uses the interface decimal separator and keeps whole amounts whole', () => {
    expect(significantAmount('0.057923834925903535', 6, 'PT')).toBe('0,0579238');
    expect(significantAmount('0.040000000000000000', 6, 'PT')).toBe('0,04');
    expect(significantAmount('250')).toBe('250');
  });

  it('never shows a nonzero amount as zero', () => {
    for (const tiny of ['0.000000000000000001', '0.0000000000001', '0.000001'])
      expect(Number(significantAmount(tiny))).toBeGreaterThan(0);
    // A balance shortcut of 2 wei: six significant digits below one unit, never "0…".
    expect(shortcutFigure(2n, 18, 'ETH')).toBe('0.000000000000000002 ETH');
    expect(shortcutFigure(57_923_834_925_903_535n, 18, 'ETH')).toBe('0.0579238… ETH');
    // From one unit up the shortcut keeps its six decimals (rounded down: it never shows more than is held).
    expect(shortcutFigure(1_234_567_891n, 6, 'USDC')).toBe('1,234.567891 USDC');
  });

  it('R07: presentation never changes the value it is given', () => {
    const exact = '0.057923834925903535', copy = exact.slice();
    significantAmount(exact); displayTokenAmount(exact, { marker: false, group: false });
    expect(exact).toBe(copy);
    expect(displayTokenAmount(exact)?.exact ?? exact).toBe(exact);
  });
});
