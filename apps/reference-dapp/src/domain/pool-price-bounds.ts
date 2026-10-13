// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Price bounds a percentage below and above a verified pool price (quote per base, decimal text). The Canvas range control and the
 * Copilot's "10% range" share this function, so both author the same `PRICE` range and therefore the same aligned ticks in the IR.
 */
export const validPoolPrice = (price?: string) => Boolean(price && /^\d+(?:\.\d+)?$/.test(price) && /[1-9]/.test(price));
export function priceBoundsAround(price: string, lowerPercent: number, upperPercent: number): { rangeUnit: 'PRICE'; lower: string; upper: string } {
  if (!validPoolPrice(price)) throw new Error('Reference price unavailable. Try again when a price is available.');
  const [integer = '0', fraction = ''] = price.split('.');
  const raw = BigInt(integer + fraction);
  function boundary(multiplier: number) {
    const digits = (raw * BigInt(multiplier)).toString().padStart(fraction.length + 5, '0');
    const decimals = fraction.length + 4;
    return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(/0+$/, '').replace(/\.$/, '');
  }
  return { rangeUnit: 'PRICE', lower: boundary(10000 + Math.round(lowerPercent * 100)), upper: boundary(10000 + Math.round(upperPercent * 100)) };
}
