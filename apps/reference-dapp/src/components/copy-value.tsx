// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useState } from 'react';
import { useLocale } from '../i18n/locale';

/**
 * A value with every recorded digit one copy away (the visible text is readable; the full value is in its tooltip and copied as is). Shared by the
 * execution receipt (BUILD-FLOFI-UX-REFINEMENT-HISTORY-001) and the Review's Technical details (BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002); unchanged.
 */
export function CopyValue({ value, shown, label, step = null }: { value: string; shown: string; label: string; step?: number | null }) {
  const { t } = useLocale();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => { try { await navigator.clipboard.writeText(value); setState('copied'); } catch { setState('failed'); } };
  // A step's control names its step, so several "Copy Recipient" buttons stay distinct; the outcome is announced in the one persistent region.
  const name = step === null ? t(label) : `${t(label)} · ${t('Step {0}: {1}', step, t(label))}`;
  return <span className="execution-receipt-copy"><span title={value}>{shown}</span>
    <button type="button" className="execution-receipt-copy-button" aria-label={t('Copy {0}', name)} onClick={() => void copy()}>{t(state === 'copied' ? 'Copied' : 'Copy')}</button>
    <span className="sr-only" role="status">{state === 'copied' ? t('{0} copied.', t(label)) : state === 'failed' ? `${t('Copy unavailable.')} ${value}` : ''}</span>
    {state === 'failed' && <span className="execution-receipt-copy-failed" aria-hidden="true">{t('Copy unavailable.')} {value}</span>}</span>;
}
