// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-LIQUIDITY-RELIABILITY-GLOBAL-PRECISION-001 (C): a token amount field as every surface shows it — at most six significant digits
 * (`displayAmountExpression`), and the exact recorded value one tap, click or key away. The exact value is never only a hover: when the short
 * value is not exact it is a button (aria-expanded) that reveals the exact value with a copy control, on desktop and touch alike; the tooltip is a
 * convenience on top. Presentation only: the value it is given is never changed, parsed back or sent anywhere.
 */
import { useState } from 'react';
import { useLocale } from '../i18n/locale';
import { displayAmountExpression, displayTokenAmount, type DisplayAmountExpression, type DisplayRounding } from '../domain/token-amount-display';
import { CopyValue } from './copy-value';
import { adaptiveDisplayAmount, type UsdPriceEvidence } from '../domain/adaptive-amount-display';

export function TokenAmountText({ value, rounding = 'nearest', marker, className }: { value: string; rounding?: DisplayRounding; marker?: boolean; className?: string }) {
  const { t, language } = useLocale();
  const shown = displayAmountExpression(value, { rounding, language: language === 'PT' ? 'PT' : 'EN', ...marker === undefined ? {} : { marker } });
  // Not an amount field (a word, "—", an address): exactly as written.
  if (!shown) return <span className={className}>{t(value)}</span>;
  return <ShortAmount shown={shown} {...className ? { className } : {}}/>;
}
/**
 * A balance or position amount in base units (`units`, `decimals`): the same presentation, for surfaces that hold base units. UX-06: with a
 * TRUSTED USD price (`price`: verified source, observation time) the decimals follow the amount's monetary and relative impact
 * (`adaptiveDisplayAmount`); without one — every surface today — the six-significant-digit policy applies unchanged. Presentation only.
 */
export function TokenUnitsText({ units, decimals, symbol, rounding = 'down', className, price = null, estimate = false }: { units: string; decimals: number; symbol?: string; rounding?: DisplayRounding;
  className?: string; price?: UsdPriceEvidence | null;
  /** The amount is an estimate (a quote): it always reads "≈", even when its short form is exact (flofi-security review, UX-01/UX-03). */
  estimate?: boolean }) {
  const { language } = useLocale();
  const options = { rounding, language: language === 'PT' ? 'PT' as const : 'EN' as const, symbol: symbol ?? null };
  const amount = price ? adaptiveDisplayAmount({ units, decimals }, { ...options, price }) : displayTokenAmount({ units, decimals }, options);
  if (!amount) return <span className={className}>—</span>;
  const text = estimate && !amount.text.startsWith('≈') ? `≈ ${amount.text}` : amount.text;
  if (estimate && !amount.approximate) return <span className={className}>{text}</span>;
  return <ShortAmount shown={{ text, exactText: amount.exactText, exact: `${amount.exact}${symbol ? ` ${symbol}` : ''}`, approximate: amount.approximate }}
    {...className ? { className } : {}}/>;
}
/** An already shortened amount (`DisplayAmountExpression`) with its exact value one tap away: for a surface that composes its own text (a sign). */
export function ShortAmount({ shown, className }: { shown: DisplayAmountExpression; className?: string }) {
  const { t } = useLocale();
  // A disclosure (aria-expanded) whose exact value follows the button in reading order; no generated id, so server and client markup match.
  const [open, setOpen] = useState(false);
  // Exact and shown in full: plain text. Rounded, or exact but compact ("1M"): the exact value is one tap away.
  if (!shown.approximate && shown.text === shown.exactText) return className ? <span className={className}>{shown.text}</span> : <>{shown.text}</>;
  return <span className={`token-amount${className ? ` ${className}` : ''}`} data-open={open || undefined}>
    {/* A stable name that starts with the visible amount (WCAG 2.5.3); the state is aria-expanded alone, announced once. */}
    <button type="button" className="token-amount-short" title={shown.exactText} aria-label={`${shown.text}, ${t('Show exact value')}`} aria-expanded={open}
      onClick={() => setOpen(v => !v)}>{shown.text}</button>
    {open && <span className="token-amount-exact" role="group" aria-label={t('Exact value')}>
      <CopyValue value={shown.exact} shown={shown.exactText} label="exact value"/></span>}
  </span>;
}
