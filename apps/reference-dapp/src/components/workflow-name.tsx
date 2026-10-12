// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useEffect, useRef, useState } from 'react';

/** Session identity only: renaming does not edit the canonical workflow or its revision. */
/** UX-002: `onAutomate` is the existing "Automate this workflow" action, offered here beside rename/save. */
export function WorkflowName({ name, rename, onSave, onAutomate }: { name: string; rename: (name: string) => void; onSave?: (() => void) | undefined; onAutomate?: (() => void) | undefined }) {
  const { t: tr } = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
  }, [editing]);
  function confirm() {
    if (!cancelled.current && draft.trim()) rename(draft.trim());
    setEditing(false);
  }
  return <div className="canvas-name">
    {editing ? <input ref={input} aria-label={tr("Workflow name")} value={draft} maxLength={80}
      onChange={event => setDraft(event.target.value)} onBlur={confirm}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation();
          if (event.key === 'Escape') { cancelled.current = true; setEditing(false); }
          else confirm();
        }
      }}/>
      : <><h2>{name}</h2><button type="button" className="workflow-rename" aria-label={tr("Rename workflow")} title={tr("Rename workflow")}
        onClick={() => { cancelled.current = false; setDraft(name); setEditing(true); }}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z"/></svg>
      </button></>}
    {onSave && <button type="button" className="workflow-save" aria-label={tr("Save workflow")} title={tr("Save workflow")} onClick={onSave}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8V3"/></svg>
    </button>}
    {onAutomate && <button type="button" className="workflow-automate" aria-label={tr("Automate this workflow")} title={tr("Automate this workflow")} onClick={onAutomate}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
    </button>}
  </div>;
}
