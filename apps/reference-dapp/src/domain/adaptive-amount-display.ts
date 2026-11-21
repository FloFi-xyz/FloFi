// SPDX-License-Identifier: AGPL-3.0-only
/**
 * UX-06 (owner guidelines of 21-11-2026): adaptive decimals for a token quantity, by its monetary impact and its relative error — PRESENTATION ONLY.
 *
 * Nothing here may feed a calculation, a workflow field, a request, an approval, a minimum or a transaction: the exact value stays in the financial
 * engine and is returned alongside the short one (`exact`, `exactText`) for the tooltip, disclosure and copy, exactly as `displayTokenAmount` does.
 *
 * Algorithm (exact BigInt arithmetic, never a JavaScript Number):
 *  1. the exact quantity (base units and decimals, or a canonical decimal);
 *  2. a USD price that is TRUSTED: a positive decimal from a verified source with its observation time, no older than `maxPriceAgeMs` and not in the
 *     future (beyond a small clock skew). A swap quote is not a USD price; a stablecoin is not assumed to be worth $1;
 *  3. for d = 0, 1, 2, … decimals, the amount rounded by purpose (`down` for what is received or guaranteed, `up` for what may be spent or paid,
 *     `nearest` for an estimate) and its error against the exact value;
 *  4. the SMALLEST d whose error is within BOTH limits: |monetary error| ≤ `maxAbsoluteErrorUsd` AND |relative error| ≤ `maxRelativeErrorBps`;
 *  5. a non-zero quantity never reads 0 (its first significant digit is kept);
 *  6. the exact value stays one tap away; "≈" marks a simplified estimate.
 * Without a trusted price the existing significant-digits policy applies (`displayTokenAmount`, six significant digits) and `basis` says so.
 * The limits are pilot parameters for presentation, not market rules.
 */
import { displayTokenAmount, displayTokenAmountAtDecimals, exactTokenAmount, roundToDecimals, type DisplayTokenAmount, type DisplayTokenAmountOptions,
  type TokenAmountSource } from './token-amount-display';

/** A USD price as a verified source reported it: a decimal string (never a float) and when it was observed (ISO 8601). */
export type UsdPriceEvidence = { readonly priceUsd: string; readonly observedAt: string };
export type AdaptivePolicy = { readonly maxAbsoluteErrorUsd: string; readonly maxRelativeErrorBps: number; readonly maxPriceAgeMs: number;
  /** Allowed clock skew for an observation time slightly ahead of this clock. */ readonly clockSkewMs: number };
/** Pilot parameters (UX-06 §9): US$ 0.001 and 0.1 %, a price at most two minutes old. */
export const ADAPTIVE_AMOUNT_PILOT: AdaptivePolicy = { maxAbsoluteErrorUsd: '0.001', maxRelativeErrorBps: 10, maxPriceAgeMs: 120_000, clockSkewMs: 5_000 };

const PRICE = /^(0|[1-9][0-9]{0,29})(?:\.([0-9]{1,18}))?$/;
type Ratio = { readonly numerator: bigint; readonly denominator: bigint };
function decimalRatio(value: string): Ratio | null {
  const match = PRICE.exec(value.trim());
  if (!match) return null;
  const fraction = match[2] ?? '';
  return { numerator: BigInt(match[1]! + fraction), denominator: 10n ** BigInt(fraction.length) };
}

/** The price as an exact ratio when it is trusted at `now` (positive, well formed, fresh, not from the future); otherwise null. */
export function trustedUsdPrice(price: UsdPriceEvidence | null | undefined, now: number, policy: AdaptivePolicy = ADAPTIVE_AMOUNT_PILOT): Ratio | null {
  if (!price || typeof price.priceUsd !== 'string' || typeof price.observedAt !== 'string') return null;
  const ratio = decimalRatio(price.priceUsd), observed = Date.parse(price.observedAt);
  if (!ratio || ratio.numerator <= 0n || !Number.isFinite(observed) || !Number.isFinite(now)) return null;
  const age = now - observed;
  return age <= policy.maxPriceAgeMs && age >= -policy.clockSkewMs ? ratio : null;
}

/**
 * The smallest number of decimals (0 … the amount's own) whose rounded value stays within both error limits at this price; the amount's own
 * scale (exact) when no smaller one does. `null` for an unavailable amount or an untrusted policy input.
 */
export function adaptiveFractionDigits(source: TokenAmountSource | null | undefined, price: Ratio, rounding: DisplayTokenAmountOptions['rounding'] = 'nearest',
  policy: AdaptivePolicy = ADAPTIVE_AMOUNT_PILOT): number | null {
  const exact = exactTokenAmount(source), budget = decimalRatio(policy.maxAbsoluteErrorUsd);
  if (!exact || !budget || !Number.isInteger(policy.maxRelativeErrorBps) || policy.maxRelativeErrorBps < 0 || price.numerator <= 0n) return null;
  for (let digits = 0; digits < exact.scale; digits++) {
    const shown = roundToDecimals(exact, rounding ?? 'nearest', digits);
    if (shown.magnitude === 0n && exact.magnitude !== 0n) continue;
    // The error in units of 10^-scale (both values on the exact value's scale).
    const lifted = shown.magnitude * 10n ** BigInt(exact.scale - shown.scale);
    const diff = lifted > exact.magnitude ? lifted - exact.magnitude : exact.magnitude - lifted;
    // |monetary error| = diff / 10^scale × price ≤ budget  ⇔  diff × price.n × budget.d ≤ budget.n × price.d × 10^scale
    const monetary = diff * price.numerator * budget.denominator <= budget.numerator * price.denominator * 10n ** BigInt(exact.scale);
    // |relative error| = diff / exact ≤ bps / 10 000  ⇔  diff × 10 000 ≤ exact × bps
    const relative = diff * 10_000n <= exact.magnitude * BigInt(policy.maxRelativeErrorBps);
    if (monetary && relative) return digits;
  }
  return exact.scale;
}

export type AdaptiveDisplayAmount = DisplayTokenAmount & {
  /** `usd-impact`: decimals chosen by monetary and relative error at a trusted price; `significant-digits`: the fallback without one. */
  readonly basis: 'usd-impact' | 'significant-digits';
};
/** A token quantity for a summary surface: adaptive decimals at a trusted USD price, else the six-significant-digit policy. */
export function adaptiveDisplayAmount(source: TokenAmountSource | null | undefined, options: DisplayTokenAmountOptions & { readonly price?: UsdPriceEvidence | null;
  readonly now?: number; readonly policy?: AdaptivePolicy } = {}): AdaptiveDisplayAmount | null {
  const { price = null, now = Date.now(), policy = ADAPTIVE_AMOUNT_PILOT, ...display } = options;
  const trusted = trustedUsdPrice(price, now, policy);
  const digits = trusted ? adaptiveFractionDigits(source, trusted, display.rounding ?? 'nearest', policy) : null;
  if (digits !== null) {
    const shown = displayTokenAmountAtDecimals(source, digits, display);
    return shown && { ...shown, basis: 'usd-impact' };
  }
  const fallback = displayTokenAmount(source, display);
  return fallback && { ...fallback, basis: 'significant-digits' };
}
