// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { ELEVATED_SLIPPAGE_WARNING_BPS } from '@defi-workflow-engine/workflow-contracts';
import { bpsToPercent, percentToBps, priceDifferenceLabel, slippageRangeMessage } from '../domain/slippage-policy';
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

/** Why an applied max price difference was refused, in the wording the swap card's settings already use (never a raw code). */
export const appliedSlippageMessage = (code: string, maximumBps: number): string => slippageRangeMessage(code, maximumBps)
  ?? (/LOCK/.test(code) ? 'This step is protected. Unlock it before changing its max price difference.' : 'This max price difference cannot be applied to this step.');

/**
 * PR #254 follow-up: the max price difference of an existing card's own settings (Router bridge, universal bridge, Jupiter swap) applies like the
 * swap card's, without a separate "Review … change": a preset (or Auto) applies its value in one click; a typed value applies on Enter or when
 * focus leaves the max-price-difference controls (moving to a preset does not, the preset applies its own value); Escape discards a typed value
 * that was not applied. `canApplyAuto` may refuse an Auto value whose quote expired (it then asks again). `bps` is the APPLIED limit (the presets show it as pressed). `onCommit` receives exact basis points (or
 * INVALID_PRICE_DIFFERENCE) only when they differ from the applied limit, and applies them as one ordinary edit or returns why it cannot.
 * Nothing here simulates, authorizes, signs or executes.
 */
export function AppliedSlippageControls({ bps, maximumBps, onCommit, label, inputLabel, maxLength, autoBps, onRequestAuto, canApplyAuto, autoPending }: {
  bps: string; maximumBps: number; onCommit(bps: string): string | null; label: string; inputLabel?: string; maxLength: number;
  autoBps?: number | null; onRequestAuto?: () => void; canApplyAuto?: () => boolean; autoPending?: boolean;
}) {
  const { t } = useLocale();
  const [text, setText] = useState(() => bpsToPercent(bps));
  const [error, setError] = useState<string | null>(null);
  // The latest draft (a blur can follow a keystroke before the next render) and the applied limit it is compared with.
  const draft = useRef(text), applied = useRef(bps), field = useRef<HTMLInputElement>(null);
  draft.current = text;
  useEffect(() => { if (bps !== applied.current) { applied.current = bps; draft.current = bpsToPercent(bps); setText(draft.current); setError(null); } }, [bps]);
  // Escape in the field discards the draft. The settings popover closes on Escape from a document capture listener that stops the event, so this
  // window capture listener (which runs first) resets the draft before the field loses focus: closing never applies what was typed.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.target !== field.current) return;
      draft.current = bpsToPercent(applied.current); setText(draft.current); setError(null);
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, []);
  // Compared in exact basis points: "2,5" and "2.5" are the applied 2.5%, never a second edit.
  const commit = (next: string) => {
    const nextBps = priceDifferenceBps(next);
    if (nextBps === applied.current) { setError(null); return; }
    setError(onCommit(nextBps));
  };
  const choose = (value: string) => { draft.current = bpsToPercent(value); setText(draft.current); commit(draft.current); };
  return <div className="applied-slippage" onBlur={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) commit(draft.current); }}>
    <label>{label}<input ref={field} {...inputLabel ? { 'aria-label': inputLabel } : {}} type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
      maxLength={maxLength} value={text} aria-invalid={Boolean(error) || undefined}
      onChange={event => { setError(null); setText(event.target.value); }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(draft.current); } }}/></label>
    <SlippageChoices bps={bps} maximumBps={maximumBps} onBpsChange={choose} autoBps={autoBps ?? null}
      {...onRequestAuto ? { onRequestAuto } : {}} {...canApplyAuto ? { onApplyAuto: (value: string) => { if (canApplyAuto()) choose(value); } } : {}} autoPending={autoPending ?? false}/>
    {error && <p className="form-error" role="alert">{t(error)}</p>}
  </div>;
}
