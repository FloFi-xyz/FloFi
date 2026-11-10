// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { LANGUAGE_KEY, parseLanguage, useLocale } from '../../i18n/locale';
import styles from './flight.module.css';

/** Flight and legal pages share the product's saved language; this menu never changes a wallet or workflow. */
export function LanguageSwitch({ language, label }: { language: 'EN' | 'PT'; label: string }) {
  const { setLanguage } = useLocale(), router = useRouter();
  const [open, setOpen] = useState(false), [languages, setLanguages] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const languageButton = useRef<HTMLButtonElement>(null), menuId = useId();
  const close = (restore = false) => { setOpen(false); setLanguages(false); if (restore) trigger.current?.focus(); };
  // Restore a surviving local preference if its cookie was cleared, as the main site's menu already does.
  useEffect(() => {
    let saved: 'EN' | 'PT' | null = null;
    try { saved = parseLanguage(localStorage.getItem(LANGUAGE_KEY)); } catch { /* Optional preference storage. */ }
    if (saved && saved !== language) { setLanguage(saved); router.refresh(); }
  }, []); // Only on arrival; subsequent choices go through the menu.
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) { setOpen(false); setLanguages(false); } };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    if (languages) root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    else languageButton.current?.focus();
  }, [open, languages]);
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'ArrowLeft' && languages) { event.preventDefault(); setLanguages(false); return; }
    if (event.key === 'ArrowRight' && !languages && open) { event.preventDefault(); setLanguages(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !open) return;
    const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>(languages ? '[role="menuitemradio"]' : '[role="menuitem"]') ?? []);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[index]?.focus();
  }
  return <div ref={root} className={styles.lang} onKeyDown={navigate}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <button ref={trigger} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
      className={styles.langTrigger} onClick={() => { if (open) close(); else setOpen(true); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}><span aria-hidden="true">···</span></button>
    {open ? <div id={menuId} role="menu" aria-label={label} className={styles.langPopover}>
      {languages ? (['EN', 'PT'] as const).map(value => <button key={value} type="button" role="menuitemradio" lang={value === 'PT' ? 'pt-BR' : 'en'}
        aria-checked={language === value} onClick={() => {
          setLanguage(value); close(true); if (value !== language) router.refresh();
        }}>{value === 'EN' ? 'English' : 'Português'}<span aria-hidden="true">{language === value ? '✓' : ''}</span></button>)
        : <button ref={languageButton} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={languages} onClick={() => setLanguages(true)}>Language<span aria-hidden="true">›</span></button>}
    </div> : null}
  </div>;
}
