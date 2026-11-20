// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-RELIABILITY-GLOBAL-PRECISION-001 (C): the one presentation rule for a token quantity, on every surface, for every token
 * and network: at most six significant digits.
 *
 * Presentation only. Nothing here may feed a financial computation, a workflow field, a request or a transaction: the exact value stays in the
 * financial engine (base units, exact decimals) and is returned alongside the short one (`exact`) for the tooltip, disclosure and copy.
 *
 * Rules:
 *  - six significant digits, never six decimals (0.000570195181991 → ≈ 0.000570195; 1234.567891 → ≈ 1234.57);
 *  - exact decimal arithmetic on BigInt (never a JavaScript Number), any decimals, any magnitude; trailing zeros removed (25.000000000 → 25);
 *  - a positive (or negative) amount never reads 0: six significant digits of any non-zero value are never all zero;
 *  - rounding by purpose: `nearest` (half-up) for an estimate, marked "≈" when it is not exact; `down` (toward zero) for what is received or
 *    guaranteed (minimums); `up` (away from zero) for what may be spent or paid (maximums, fee caps). A rounded limit is a reading aid: the
 *    contractually authorized value is the exact one;
 *  - no scientific notation; from 1,000,000 a compact unit (1.23457M · 1,23457 mi), always with the exact value available;
 *  - EN/PT separators (EN 12,345.6 · PT 12.345,6); four-digit integers are not grouped (1234.57);
 *  - an unavailable value is never turned into 0: it is `null` (or the caller's placeholder).
 */
export const DISPLAY_SIGNIFICANT_DIGITS = 6;
export type DisplayRounding = 'nearest' | 'down' | 'up';
export type DisplayLanguage = 'EN' | 'PT';
/** A canonical decimal ("0.00057", "-3", "25.000000000"), base units with their decimals, or an integer. */
export type TokenAmountSource = string | bigint | { readonly units: string | bigint; readonly decimals: number };
export type DisplayTokenAmountOptions = {
  readonly rounding?: DisplayRounding; readonly language?: DisplayLanguage;
  /** Prefix "≈ " when the shown value is not exact. Default: only for `nearest` (an estimate); a minimum or maximum carries its own label. */
  readonly marker?: boolean;
  /** Appended after a space ("WETH"); a symbol is never parsed, rounded or translated. */
  readonly symbol?: string | null;
};
export type DisplayTokenAmount = {
  /** What a surface shows: marker, short localized number, symbol ("≈ 0.000570195 WETH"). */
  readonly text: string;
  /** The short localized number alone ("0,000570195"). */
  readonly value: string;
  /** The exact value as a canonical decimal (copy, machine use): "0.000570195181991". */
  readonly exact: string;
  /** The exact value localized, with its symbol, for a tooltip or disclosure ("0,000570195181991 WETH"). */
  readonly exactText: string;
  /** The short value differs from the exact one. */
  readonly approximate: boolean;
  readonly rounding: DisplayRounding;
};

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const UNITS = /^-?\d+$/;
const COMPACT: readonly { readonly power: number; readonly EN: string; readonly PT: string }[] = [
  { power: 12, EN: 'T', PT: ' tri' }, { power: 9, EN: 'B', PT: ' bi' }, { power: 6, EN: 'M', PT: ' mi' },
];

type Exact = { readonly negative: boolean; readonly magnitude: bigint; readonly scale: number };

function parse(source: TokenAmountSource | null | undefined): Exact | null {
  if (source === null || source === undefined) return null;
  if (typeof source === 'bigint') return { negative: source < 0n, magnitude: source < 0n ? -source : source, scale: 0 };
  if (typeof source === 'object') {
    const { decimals } = source, units = typeof source.units === 'bigint' ? source.units.toString() : source.units;
    if (typeof units !== 'string' || !UNITS.test(units) || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) return null;
    const value = BigInt(units);
    return normalize({ negative: value < 0n, magnitude: value < 0n ? -value : value, scale: decimals });
  }
  if (typeof source !== 'string') return null;
  const match = DECIMAL.exec(source.trim());
  if (!match) return null;
  const fraction = match[3] ?? '';
  return normalize({ negative: match[1] === '-', magnitude: BigInt(match[2]! + fraction), scale: fraction.length });
}
/** Trailing fractional zeros carry no information (25.000000000 is 25). */
function normalize(value: Exact): Exact {
  let { magnitude, scale } = value;
  if (magnitude === 0n) return { negative: false, magnitude: 0n, scale: 0 };
  while (scale > 0 && magnitude % 10n === 0n) { magnitude /= 10n; scale -= 1; }
  return { negative: value.negative, magnitude, scale };
}
/** Keep `digits` significant digits of the magnitude, rounding by purpose (on the magnitude: `down` toward zero, `up` away from it). */
function round(value: Exact, rounding: DisplayRounding, digits = DISPLAY_SIGNIFICANT_DIGITS): Exact {
  const length = value.magnitude.toString().length;
  if (length <= digits) return value;
  const step = 10n ** BigInt(length - digits), quotient = value.magnitude / step, remainder = value.magnitude % step;
  const up = rounding === 'up' ? remainder > 0n : rounding === 'nearest' ? remainder * 2n >= step : false;
  return normalize({ negative: value.negative, magnitude: (quotient + (up ? 1n : 0n)) * step, scale: value.scale });
}
const separators = (language: DisplayLanguage) => language === 'PT' ? { group: '.', decimal: ',' } : { group: ',', decimal: '.' };
function parts(value: Exact): { whole: string; fraction: string } {
  const text = value.magnitude.toString().padStart(value.scale + 1, '0');
  return { whole: text.slice(0, text.length - value.scale), fraction: text.slice(text.length - value.scale) };
}
/** Integers of five or more digits are grouped (12,345); 1234 stays as written. */
function localize(value: Exact, language: DisplayLanguage, group = true): string {
  const { whole, fraction } = parts(value), s = separators(language);
  const grouped = group && whole.length > 4 ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, s.group) : whole;
  return `${value.negative ? '-' : ''}${grouped}${fraction ? s.decimal + fraction : ''}`;
}
/** The exact value as a canonical decimal ("-0.5", "1234.567891", "25"). */
function canonical(value: Exact): string {
  const { whole, fraction } = parts(value);
  return `${value.negative ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`;
}

/**
 * The presentation of one token quantity. `null` when the value is unavailable or not a number (never 0): the caller shows its own placeholder.
 */
export function displayTokenAmount(source: TokenAmountSource | null | undefined, options: DisplayTokenAmountOptions = {}): DisplayTokenAmount | null {
  const exact = parse(source);
  if (!exact) return null;
  const rounding = options.rounding ?? 'nearest', language = options.language ?? 'EN';
  const shown = round(exact, rounding), approximate = shown.magnitude * 10n ** BigInt(Math.max(0, exact.scale - shown.scale)) !==
    exact.magnitude * 10n ** BigInt(Math.max(0, shown.scale - exact.scale));
  const unit = COMPACT.find(c => shown.magnitude >= 10n ** BigInt(c.power + shown.scale));
  const value = unit ? localize(normalize({ ...shown, scale: shown.scale + unit.power }), language, false) + unit[language] : localize(shown, language);
  const marker = approximate && (options.marker ?? rounding === 'nearest') ? '≈ ' : '';
  const symbol = options.symbol ? ` ${options.symbol}` : '';
  return { text: `${marker}${value}${symbol}`, value, exact: canonical(exact), exactText: `${localize(exact, language)}${symbol}`, approximate, rounding };
}
/** The text of `displayTokenAmount`, or `unavailable` (default "—") when there is no value. Never "0" for a missing value. */
export function formatDisplayTokenAmount(source: TokenAmountSource | null | undefined, options: DisplayTokenAmountOptions & { readonly unavailable?: string } = {}): string {
  return displayTokenAmount(source, options)?.text ?? options.unavailable ?? '—';
}
/**
 * A recorded "<number> <symbol>" text ("0.000003724947756 ETH", "25 USDC") shortened by the same rule. `null` for anything else (a word, several
 * amounts, an address), which callers keep exactly as written: no free text, hash, address, id or user message is ever rewritten.
 */
export function displayAmountText(text: string, options: Omit<DisplayTokenAmountOptions, 'symbol'> = {}): DisplayTokenAmount | null {
  const match = /^(-?\d+(?:\.\d+)?)(?: ([^\s\d][^\s]*))?$/.exec(text.trim());
  if (!match) return null;
  return displayTokenAmount(match[1]!, { ...options, symbol: match[2] ?? null });
}
/**
 * The canonical (EN-separator, ungrouped, unmarked) six-significant-digit decimal, for domain presentation strings that are composed further
 * ("0.000570195 WETH"). Same rounding rules; `null` when unavailable.
 */
export function shortTokenDecimal(source: TokenAmountSource | null | undefined, rounding: DisplayRounding = 'nearest'): string | null {
  const exact = parse(source);
  return exact ? canonical(round(exact, rounding)) : null;
}
export type DisplayAmountExpression = {
  /** "≥ 0.5 WETH + 1500 USDC" shortened part by part. */
  readonly text: string;
  /** The exact expression, localized ("≥ 0,500000123 WETH + 1.500,123456 USDC"). */
  readonly exactText: string;
  /** The exact expression as recorded (canonical decimals), for copy. */
  readonly exact: string;
  readonly approximate: boolean;
};
/**
 * A recorded amount field: one "<number> <symbol>" or several joined by " + ", optionally prefixed by a bound sign ("≥ ", "≤ ", "≈ ", "~"). Only
 * for a field known to hold token amounts (a result, a minimum, a fee); `null` for any other text, which callers render exactly as written.
 * A lower bound ("≥") is shortened down and an upper bound ("≤") up, whatever `rounding` says, so a bound never claims more than it guarantees.
 */
export function displayAmountExpression(value: string, options: Omit<DisplayTokenAmountOptions, 'symbol'> = {}): DisplayAmountExpression | null {
  const match = /^(≥|≤|≈|~)?\s*(.+)$/.exec(value.trim());
  if (!match) return null;
  const sign = match[1] ?? '', rounding: DisplayRounding = sign === '≥' ? 'down' : sign === '≤' ? 'up' : options.rounding ?? 'nearest';
  const pieces = match[2]!.split(' + ');
  const parts = pieces.map(piece => /^-?\d+(?:\.\d+)? [^\s\d][^\s]*$/.test(piece) ? displayAmountText(piece, { ...options, rounding, ...sign ? { marker: false } : {} }) : null);
  if (!parts.length || parts.some(part => part === null)) return null;
  const shown = parts as DisplayTokenAmount[], prefix = sign ? `${sign} ` : '';
  return { text: prefix + shown.map(p => p.text).join(' + '), exactText: prefix + shown.map(p => p.exactText).join(' + '),
    exact: prefix + pieces.join(' + '), approximate: shown.some(p => p.approximate) };
}
