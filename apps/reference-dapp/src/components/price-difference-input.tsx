// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { ELEVATED_SLIPPAGE_WARNING_BPS } from '@defi-workflow-engine/workflow-contracts';
import { bpsToPercent, percentToBps, priceDifferenceLabel } from '../domain/slippage-policy';
import { useLocale } from '../i18n/locale';

/** What a percent that has no whole basis-point value becomes: every slippage validator refuses it (nothing is rounded). */
export const INVALID_PRICE_DIFFERENCE = 'invalid';
/** The exact basis points a typed percent means ("0.5" → "50"), or INVALID_PRICE_DIFFERENCE. */
export const priceDifferenceBps = (percent: string): string => percentToBps(percent) ?? INVALID_PRICE_DIFFERENCE;

/**
 * P0 approved UX (boards 04, 12, 16): a slippage limit is typed as "Max price difference" in percent ("0.5" is 0.5%). The form around it keeps
 * exact basis points: `bps` is its value and `onBpsChange` receives the exact conversion of what was typed, or INVALID_PRICE_DIFFERENCE, so the
 * form's own validation refuses it. What the person typed stays in the field ("0." while typing "0.5"); a new value from outside replaces it.
 */
export function PriceDifferenceInput({ bps, onBpsChange, ...props }: { bps: string; onBpsChange(bps: string): void }
  & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'>) {
  const [text, setText] = useState(() => bpsToPercent(bps));
  const sent = useRef(bps);
  useEffect(() => { if (bps !== sent.current) { sent.current = bps; setText(bpsToPercent(bps)); } }, [bps]);
  return <input {...props} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={text} onChange={event => {
    const value = event.target.value, next = priceDifferenceBps(value);
    setText(value); sent.current = next; onBpsChange(next);
  }}/>;
}

/**
 * A preset as people read it in their language: "1%", "2.5%" (EN) or "2,5%" (PT), "5%". Presentation only: the value carried is exact basis
 * points (`String(preset)`), never this text.
 */
export const presetLabel = (bps: number, language: string): string => language === 'PT' ? priceDifferenceLabel(bps).replace('.', ',') : priceDifferenceLabel(bps);

/**
 * Apply a concrete value. The workflow always stores the same numeric limit the person sees. Execution UX regression fixes: a preset is the value
 * itself ("1%", "2,5%"/"2.5%", "5%"), never "Manual 1%"; where the form applies at once (`onBpsChange` of the action settings), one click applies it.
 */
export function SlippageChoices({ bps, maximumBps, onBpsChange, autoBps, onRequestAuto, onApplyAuto, autoPending }: {
  bps: string; maximumBps: number; onBpsChange(bps: string): void; autoBps?: number | null;
  onRequestAuto?: () => void; onApplyAuto?: (bps: string) => void; autoPending?: boolean;
}) {
  const { t, language } = useLocale();
  const recommendation = autoBps != null && Number.isSafeInteger(autoBps) && autoBps >= 1 && autoBps <= maximumBps ? autoBps : null;
  return <>
    <div className="row" role="group" aria-label={t('Max price difference options')}>
      {recommendation !== null && <button type="button" onClick={() => (onApplyAuto ?? onBpsChange)(String(recommendation))}>
        {t('Use Auto ({0})', priceDifferenceLabel(recommendation))}</button>}
      {recommendation === null && onRequestAuto && <button type="button" onClick={onRequestAuto} disabled={autoPending}>
        {t(autoPending ? 'Checking route…' : 'Auto slippage')}</button>}
      {[100, 250, 500].filter(preset => preset <= maximumBps).map(preset => <button key={preset} type="button"
        onClick={() => onBpsChange(String(preset))} aria-pressed={Number(bps) === preset}>
        {presetLabel(preset, language)}</button>)}
    </div>
    {Number(bps) > ELEVATED_SLIPPAGE_WARNING_BPS && Number(bps) <= maximumBps && <p className="muted" role="status">
      {t('Above 3%, the price can move substantially against you before the operation stops.')}</p>}
  </>;
}
