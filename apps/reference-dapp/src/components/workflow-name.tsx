// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/** Session identity only: renaming does not edit the canonical workflow or its revision. */
/** BUILD-FLOFI-BUILDER-UX-002: `shownName` presents the untouched default name in the interface language; renaming still edits `name` itself. */
/**
 * P0 approved UX (board 04): the name itself is the rename control — a button with a muted pencil; a click (or Enter) turns it into a text field,
 * Enter or leaving the field saves, Escape cancels. Save, Automate and the toolbar layout moved to the header's ··· menu (`WorkflowMoreMenu`).
 */
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: beside the name, a New workflow icon button (`onNew`): it starts an empty workflow in the Editor — Canvas,
 * proposals, drafts, the workflow's conversation, name and selection — exactly as `startNewWorkflow` does. Wallets, Credentials, preferences,
 * saved workflows and on-chain history (including runs already sent, which keep being observed) are untouched.
 */
export function WorkflowName({ name, shownName = name, rename, onNew }: { name: string; shownName?: string; rename: (name: string) => void;
  onNew?: (() => void) | undefined }) {
  const { t: tr } = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
    else if (returnFocus.current) { returnFocus.current = false; trigger.current?.focus(); }
  }, [editing]);
  function confirm() {
    // Opening the field and leaving it unchanged keeps the name (a translated default is never stored by accident).
    if (!cancelled.current && draft.trim() && draft.trim() !== shownName) rename(draft.trim());
    setEditing(false);
  }
  return <div className="canvas-name">
    {editing ? <input ref={input} aria-label={tr("Workflow name")} value={draft} maxLength={80}
      onChange={event => setDraft(event.target.value)} onBlur={confirm}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation();
          returnFocus.current = true;
          if (event.key === 'Escape') { cancelled.current = true; setEditing(false); }
          else confirm();
        }
      }}/>
      : <h2><button ref={trigger} type="button" className="workflow-rename" aria-label={tr('Rename workflow: {0}', shownName)} title={tr('Click to rename')}
        onClick={() => { cancelled.current = false; setDraft(shownName); setEditing(true); }}>
        <span className="workflow-name-text">{shownName}</span>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/></svg>
      </button></h2>}
    {onNew && !editing && <button type="button" className="workflow-new" aria-label={tr('New workflow')} title={tr('New workflow')} onClick={onNew}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M3 15h6"/><path d="M6 12v6"/></svg>
    </button>}
  </div>;
}

function MenuIcon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

/**
 * P0 approved UX (board 04): the Canvas header's ··· (More) menu — Save, Automate (only where automations are enabled: `onAutomate` is absent
 * otherwise, exactly as before) and the toolbar layout. Each item calls the same existing handler; nothing here saves, schedules or edits by itself.
 * The items stay in the document while the menu is closed (`hidden`), so the menu reads the same with or without scripts.
 */
export function WorkflowMoreMenu({ onSave, onAutomate, dock }: { onSave?: (() => void) | undefined; onAutomate?: (() => void) | undefined;
  dock?: { readonly docked: boolean; toggle(): void } | undefined }) {
  const { t: tr } = useLocale();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const items = () => [...menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []];
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  function close(refocus: boolean) { setOpen(false); if (refocus) trigger.current?.focus(); }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const list = items(), at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(false);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      list[(at + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); list[event.key === 'Home' ? 0 : list.length - 1]?.focus(); }
  }
  const run = (action: () => void) => () => { close(true); action(); };
  if (!onSave && !onAutomate && !dock) return null;
  return <div ref={root} className="workflow-more">
    <button ref={trigger} type="button" className="canvas-head-icon workflow-more-trigger" aria-label={tr('More options')} title={tr('More options')}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(current => !current)}>
      <MenuIcon><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></MenuIcon>
    </button>
    <div ref={menu} className="workflow-more-menu" role="menu" aria-label={tr('More options')} hidden={!open} onKeyDown={keys}>
      {onSave && <button type="button" role="menuitem" tabIndex={-1} className="workflow-save" onClick={run(onSave)}>
        <MenuIcon><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8V3"/></MenuIcon><span>{tr('Save workflow')}</span>
      </button>}
      {onAutomate && <button type="button" role="menuitem" tabIndex={-1} className="workflow-automate" onClick={run(onAutomate)}>
        <MenuIcon><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></MenuIcon><span>{tr('Automate this workflow')}</span>
      </button>}
      {dock && <button type="button" role="menuitem" tabIndex={-1} className="toolbox-mode-toggle" onClick={run(dock.toggle)}>
        <MenuIcon><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>{dock.docked ? <path d="M10 14h4v-4m0 4-4-4"/> : <path d="M14 10h-4v4m0-4 4 4"/>}</MenuIcon>
        <span>{tr(dock.docked ? 'Undock toolbar' : 'Dock toolbar')}</span>
      </button>}
    </div>
  </div>;
}
