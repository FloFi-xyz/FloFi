// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { HistoryDeleteRefusal, HistoryDisposition } from '@defi-workflow-engine/cloud-runtime';
import { useLocale } from '../i18n/locale';
import styles from './history-actions.module.css';

export type HistoryChange = (action: 'DELETE' | 'ARCHIVE') => Promise<HistoryDisposition>;
const DELETE_REFUSAL: Record<HistoryDeleteRefusal, string> = {
  AUTHORIZATION: 'This record contains a previous execution authorization. Archive it to preserve its history.',
  EXECUTION_ACTIVITY: 'This record has execution activity or evidence. Archive it to preserve its history.',
  DEPENDENCY: 'This record is linked to another operation. Archive it to preserve its history.',
};
/** History disposal only. The server rechecks financial eligibility on every irreversible confirmation. */
export function HistoryActions({ kind, change, changed }: { kind: 'execution' | 'workflow'; change: HistoryChange; changed(disposition: 'DELETED' | 'ARCHIVED'): void }) {
  const { t } = useLocale();
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false), menuId = useId(), feedbackId = useId();
  const root = useRef<HTMLDivElement>(null), menuButton = useRef<HTMLButtonElement>(null), firstAction = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null), active = useRef(true), inFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (confirming) dialog.current?.showModal(); else dialog.current?.close(); }, [confirming]);
  useEffect(() => {
    if (!menuOpen) return;
    firstAction.current?.focus();
    const dismiss = () => { setMenuOpen(false); setError(null); };
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) dismiss(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dismiss();
      menuButton.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [menuOpen]);
  function cancelConfirmation() {
    if (inFlight.current) return;
    setError(null);
    setConfirming(false);
  }
  async function apply(action: 'DELETE' | 'ARCHIVE') {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await change(action);
      if (!active.current) return;
      if (result.ok && result.disposition !== 'VISIBLE') { setMenuOpen(false); setConfirming(false); changed(result.disposition); }
      else setError(!result.ok && result.code === 'RUN_DELETE_REFUSED'
        ? result.reason ? DELETE_REFUSAL[result.reason] : 'FloFi could not verify that this entire record is safe to delete. Archive it to preserve its history.'
        : !result.ok && result.code === 'HISTORY_READ_ONLY' ? 'History changes are temporarily unavailable. Your records are preserved.'
        : !result.ok && result.code === 'RUN_NOT_FOUND' ? 'This record is unavailable for the verified wallet. Refresh the history.'
          : 'The result could not be confirmed. Refresh the history before trying again.');
    } catch { if (active.current) setError('The result could not be confirmed. Refresh the history before trying again.'); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  }
  const lateFeedback = !menuOpen && !confirming && error;
  return <div ref={root} className={`history-actions ${styles.actions}`}>
    <button ref={menuButton} type="button" className={`workspace-action ${styles.more}`} aria-disabled={busy} aria-label={t(kind === 'execution' ? 'More execution actions' : 'More workflow actions')}
      aria-describedby={lateFeedback ? feedbackId : undefined} aria-expanded={menuOpen} aria-controls={menuId} onClick={() => {
        if (inFlight.current) return;
        if (menuOpen) setError(null);
        setMenuOpen(!menuOpen);
      }}><span aria-hidden="true">⋯</span>{lateFeedback ? <span className={styles.errorMark} aria-hidden="true">!</span> : null}</button>
    {lateFeedback ? <span className={styles.sr} id={feedbackId} role="alert">{t(lateFeedback)}</span> : null}
    <div id={menuId} className={styles.menu} role="group" aria-label={t('Record actions')} hidden={!menuOpen}>
      <button ref={firstAction} type="button" aria-disabled={busy} aria-label={t(kind === 'execution' ? 'Archive execution' : 'Archive workflow')} onClick={() => void apply('ARCHIVE')}>{t(busy ? 'Archiving…' : 'Archive')}</button>
      <button type="button" aria-disabled={busy} aria-label={t(kind === 'execution' ? 'Delete execution' : 'Delete workflow')} onClick={() => {
        if (inFlight.current) return;
        setMenuOpen(false); setError(null); setConfirming(true);
      }}>{t('Delete')}</button>
      {menuOpen && error && <p role="alert">{t(error)}</p>}
    </div>
    <dialog ref={dialog} aria-label={t('Delete permanently?')} onClose={() => menuButton.current?.focus()} onCancel={event => { event.preventDefault(); cancelConfirmation(); }}>
      <h2>{t('Delete permanently?')}</h2><p>{t('This cannot be undone. Only records proven to have no financial submission or pending responsibility can be deleted.')}</p>
      {confirming && error && <p role="alert">{t(error)}</p>}
      <button type="button" className="workspace-action" disabled={busy} onClick={cancelConfirmation}>{t('Cancel')}</button>
      <button type="button" className="workspace-action workspace-action-danger" disabled={busy} onClick={() => void apply('DELETE')}>{t(busy ? 'Deleting…' : 'Delete permanently')}</button>
      {error && <button type="button" className="workspace-action" disabled={busy} onClick={() => void apply('ARCHIVE')}>{t('Archive instead')}</button>}
    </dialog>
  </div>;
}
