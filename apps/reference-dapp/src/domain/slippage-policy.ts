// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-UX-001: the one slippage default every authoring surface starts a NEW artifact with — Canvas cards and inspector forms,
 * the exact chat grammar, the Copilot planners, the strategy engine behind MCP and the channels, and automation proposals. 100 bps is 1%
 * (never 100%). It is only a starting value: an owner's explicit choice always wins, a saved, imported, reviewed or running workflow keeps the
 * value written in its canonical node, and each protocol's own limit still refuses anything above it (the policy never widens a limit).
 * Actions that have no slippage (transfers, Aave supply/borrow/repay/withdraw) never receive a field from here.
 */
export const DEFAULT_SLIPPAGE_BPS = 100;
/** The same default as the string the editor commands and chat grammars carry. */
export const DEFAULT_SLIPPAGE = String(DEFAULT_SLIPPAGE_BPS);

/** The default within a protocol's own maximum: the policy value, or the protocol's limit when that is lower (recorded by the caller). */
export function defaultSlippageWithin(maximumBps: number): number {
  if (!Number.isSafeInteger(maximumBps) || maximumBps < 1) throw new Error('SLIPPAGE_LIMIT_INVALID');
  return Math.min(DEFAULT_SLIPPAGE_BPS, maximumBps);
}

/** "1% (100 bps)", "0.5% (50 bps)", "0.25% (25 bps)": how FloFi shows a slippage limit to people. */
export function formatSlippage(bps: number | string): string {
  const value = typeof bps === 'string' ? Number(bps) : bps;
  if (!Number.isSafeInteger(value) || value < 0) return `${bps} bps`;
  const percent = (value / 100).toFixed(2).replace(/\.?0+$/, '');
  return `${percent}% (${value} bps)`;
}

/**
 * P0 approved UX (boards 04, 12, 16): people set a slippage limit as "Max price difference" in percent, never in basis points. Every draft, command
 * and workflow keeps exact basis points: these convert decimal strings exactly (no floating point; 100 bps = 1%). A percent with more than two
 * decimals has no whole basis-point value and stays invalid, so validation refuses it instead of rounding.
 */
export function bpsToPercent(bps: string): string {
  if (!/^\d+$/.test(bps)) return bps;
  const digits = bps.replace(/^0+(?=\d)/, '').padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, ''), fraction = digits.slice(-2).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
export function percentToBps(percent: string): string | null {
  const match = /^(\d*)(?:[.,](\d{0,2}))?$/.exec(percent.trim());
  if (!match || !match[1] && !match[2]) return null;
  return `${match[1] || '0'}${(match[2] ?? '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
}
/** "1%", "0.75%": a basis-point limit as people read it (the same words as the card's "Max price difference"). */
export const priceDifferenceLabel = (bps: number | string): string => `${bpsToPercent(String(bps))}%`;
