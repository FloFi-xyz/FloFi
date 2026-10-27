// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef, useState } from 'react';
import type { HistoryDisposition } from '@defi-workflow-engine/cloud-runtime';
import { useLocale } from '../i18n/locale';
import styles from './history-actions.module.css';

export type HistoryChange = (action: 'DELETE' | 'ARCHIVE') => Promise<HistoryDisposition>;
/** History disposal only. The server rechecks financial eligibility on every irreversible confirmation. */
export function HistoryActions({ kind, change, changed }: { kind: 'execution' | 'workflow'; change: HistoryChange; changed(disposition: 'DELETED' | 'ARCHIVED'): void }) {
  const { t } = useLocale();
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), active = useRef(true), inFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (confirming) dialog.current?.showModal(); else dialog.current?.close(); }, [confirming]);
  async function apply(action: 'DELETE' | 'ARCHIVE') {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await change(action);
      if (!active.current) return;
      if (result.ok && result.disposition !== 'VISIBLE') { setConfirming(false); changed(result.disposition); }
      else setError(!result.ok && result.code === 'RUN_DELETE_REFUSED'
        ? 'This record may have financial activity, authorization or pending dependencies. Archive it to preserve its history.'
        : !result.ok && result.code === 'RUN_NOT_FOUND' ? 'This record is unavailable for the verified wallet. Refresh the history.'
          : 'The result could not be confirmed. Refresh the history before trying again.');
    } catch { if (active.current) setError('The result could not be confirmed. Refresh the history before trying again.'); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  }
  return <div className={`history-actions ${styles.actions}`}>
    <button type="button" className="quiet" disabled={busy} aria-label={t(kind === 'execution' ? 'Delete execution' : 'Delete workflow')} onClick={() => { setError(null); setConfirming(true); }}>{t('Delete')}</button>
    <button type="button" className="quiet" disabled={busy} aria-label={t(kind === 'execution' ? 'Archive execution' : 'Archive workflow')} onClick={() => void apply('ARCHIVE')}>{t('Archive')}</button>
    {!confirming && error && <p role="alert">{t(error)}</p>}
    <dialog ref={dialog} aria-label={t('Delete permanently?')} onCancel={event => { event.preventDefault(); if (!busy) setConfirming(false); }}>
      <h2>{t('Delete permanently?')}</h2><p>{t('This cannot be undone. Only records proven to have no financial submission or pending responsibility can be deleted.')}</p>
      {error && <p role="alert">{t(error)}</p>}
      <button type="button" disabled={busy} onClick={() => setConfirming(false)}>{t('Cancel')}</button>
      <button type="button" disabled={busy} onClick={() => void apply('DELETE')}>{t(busy ? 'Deleting…' : 'Delete permanently')}</button>
      {error && <button type="button" disabled={busy} onClick={() => void apply('ARCHIVE')}>{t('Archive instead')}</button>}
    </dialog>
  </div>;
}
