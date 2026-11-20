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

export function TokenAmountText({ value, rounding = 'nearest', marker, className }: { value: string; rounding?: DisplayRounding; marker?: boolean; className?: string }) {
  const { t, language } = useLocale();
  const shown = displayAmountExpression(value, { rounding, language: language === 'PT' ? 'PT' : 'EN', ...marker === undefined ? {} : { marker } });
  // Not an amount field (a word, "—", an address): exactly as written.
  if (!shown) return <span className={className}>{t(value)}</span>;
  return <ShortAmount shown={shown} {...className ? { className } : {}}/>;
}
/** A balance or position amount in base units (`units`, `decimals`): the same presentation, for surfaces that hold base units. */
export function TokenUnitsText({ units, decimals, symbol, rounding = 'down', className }: { units: string; decimals: number; symbol?: string; rounding?: DisplayRounding;
  className?: string }) {
  const { language } = useLocale();
  const amount = displayTokenAmount({ units, decimals }, { rounding, language: language === 'PT' ? 'PT' : 'EN', symbol: symbol ?? null });
  if (!amount) return <span className={className}>—</span>;
  return <ShortAmount shown={{ text: amount.text, exactText: amount.exactText, exact: `${amount.exact}${symbol ? ` ${symbol}` : ''}`, approximate: amount.approximate }}
    {...className ? { className } : {}}/>;
}
function ShortAmount({ shown, className }: { shown: DisplayAmountExpression; className?: string }) {
  const { t } = useLocale();
  // A disclosure (aria-expanded) whose exact value follows the button in reading order; no generated id, so server and client markup match.
  const [open, setOpen] = useState(false);
  if (!shown.approximate) return className ? <span className={className}>{shown.text}</span> : <>{shown.text}</>;
  return <span className={`token-amount${className ? ` ${className}` : ''}`} data-open={open || undefined}>
    <button type="button" className="token-amount-short" title={shown.exactText} aria-expanded={open} onClick={() => setOpen(v => !v)}>
      {shown.text}<span className="sr-only"> — {t(open ? 'Hide exact value' : 'Show exact value')}</span>
    </button>
    {open && <span className="token-amount-exact" role="group" aria-label={t('Exact value')}>
      <CopyValue value={shown.exact} shown={shown.exactText} label="Exact value"/></span>}
  </span>;
}
