// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { bpsToPercent, percentToBps } from '../domain/slippage-policy';

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
