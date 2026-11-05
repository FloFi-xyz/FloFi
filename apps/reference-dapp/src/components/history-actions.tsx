// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { HistoryDisposition } from '@defi-workflow-engine/cloud-runtime';
import { useLocale } from '../i18n/locale';
import styles from './history-actions.module.css';

export type HistoryChange = (action: 'DELETE' | 'ARCHIVE') => Promise<HistoryDisposition>;
/** History disposal only. The server rechecks financial eligibility on every irreversible confirmation. */
export function HistoryActions({ kind, change, changed }: { kind: 'execution' | 'workflow'; change: HistoryChange; changed(disposition: 'DELETED' | 'ARCHIVED'): void }) {
  const { t } = useLocale();
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false), menuId = useId();
  const root = useRef<HTMLDivElement>(null), menuButton = useRef<HTMLButtonElement>(null), firstAction = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null), active = useRef(true), inFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (confirming) dialog.current?.showModal(); else dialog.current?.close(); }, [confirming]);
  useEffect(() => { if (error && !busy && !confirming) menuButton.current?.focus(); }, [error, busy, confirming]);
  useEffect(() => {
    if (!menuOpen) return;
    firstAction.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); menuButton.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menuOpen]);
  async function apply(action: 'DELETE' | 'ARCHIVE') {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await change(action);
      if (!active.current) return;
      if (result.ok && result.disposition !== 'VISIBLE') { setConfirming(false); changed(result.disposition); }
      else setError(!result.ok && result.code === 'RUN_DELETE_REFUSED'
        ? 'This record may have financial activity, authorization or pending dependencies. Archive it to preserve its history.'
        : !result.ok && result.code === 'HISTORY_READ_ONLY' ? 'History changes are temporarily unavailable. Your records are preserved.'
        : !result.ok && result.code === 'RUN_NOT_FOUND' ? 'This record is unavailable for the verified wallet. Refresh the history.'
          : 'The result could not be confirmed. Refresh the history before trying again.');
    } catch { if (active.current) setError('The result could not be confirmed. Refresh the history before trying again.'); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  }
  return <div ref={root} className={`history-actions ${styles.actions}`} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false); }}>
    <button ref={menuButton} type="button" className={`workspace-action ${styles.more}`} disabled={busy} aria-label={t(kind === 'execution' ? 'More execution actions' : 'More workflow actions')}
      aria-expanded={menuOpen} aria-controls={menuId} onClick={() => setMenuOpen(value => !value)}><span aria-hidden="true">⋯</span></button>
    <div id={menuId} className={styles.menu} role="group" aria-label={t('Record actions')} hidden={!menuOpen}>
      <button ref={firstAction} type="button" disabled={busy} aria-label={t(kind === 'execution' ? 'Archive execution' : 'Archive workflow')} onClick={() => { setMenuOpen(false); void apply('ARCHIVE'); }}>{t('Archive')}</button>
      <button type="button" disabled={busy} aria-label={t(kind === 'execution' ? 'Delete execution' : 'Delete workflow')} onClick={() => { setMenuOpen(false); setError(null); setConfirming(true); }}>{t('Delete')}</button>
    </div>
    {!confirming && error && <p role="alert">{t(error)}</p>}
    <dialog ref={dialog} aria-label={t('Delete permanently?')} onClose={() => menuButton.current?.focus()} onCancel={event => { event.preventDefault(); if (!busy) setConfirming(false); }}>
      <h2>{t('Delete permanently?')}</h2><p>{t('This cannot be undone. Only records proven to have no financial submission or pending responsibility can be deleted.')}</p>
      {error && <p role="alert">{t(error)}</p>}
      <button type="button" className="workspace-action" disabled={busy} onClick={() => { setConfirming(false); menuButton.current?.focus(); }}>{t('Cancel')}</button>
      <button type="button" className="workspace-action workspace-action-danger" disabled={busy} onClick={() => void apply('DELETE')}>{t(busy ? 'Deleting…' : 'Delete permanently')}</button>
      {error && <button type="button" className="workspace-action" disabled={busy} onClick={() => void apply('ARCHIVE')}>{t('Archive instead')}</button>}
    </dialog>
  </div>;
}
