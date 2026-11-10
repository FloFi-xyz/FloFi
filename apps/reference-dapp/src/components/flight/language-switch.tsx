// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from '../../i18n/locale';
import styles from './flight.module.css';

type Language = 'EN' | 'PT';
const LANGUAGES = ['EN', 'PT'] as const;

/** The compact ··· → Language menu uses the site's shared, persistent language preference. */
export function LanguageSwitch({ language, label, upwards = false }: { language: Language; label: string; upwards?: boolean }) {
  const { setLanguage } = useLocale(), router = useRouter();
  const [open, setOpen] = useState(false), [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), category = useRef<HTMLButtonElement>(null);
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  function close(restoreFocus = false) {
    setOpen(false); setExpanded(false);
    if (restoreFocus) trigger.current?.focus();
  }
  useEffect(() => {
    if (open) {
      if (expanded) options.current[LANGUAGES.indexOf(language)]?.focus();
      else category.current?.focus();
    }
  }, [open, expanded, language]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); setExpanded(false); } };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    if (event.key === 'Tab') { close(true); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'ArrowLeft' && expanded) { event.preventDefault(); setExpanded(false); return; }
    if (!expanded && event.target === category.current && ['ArrowRight', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); setExpanded(true); return;
    }
    if (!expanded) return;
    const current = options.current.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (current + 1) % LANGUAGES.length;
    if (event.key === 'ArrowUp') next = (current + LANGUAGES.length - 1) % LANGUAGES.length;
    if (event.key === 'Home' || event.key.toLowerCase() === 'e') next = 0;
    if (event.key === 'End' || event.key.toLowerCase() === 'p') next = 1;
    if (next !== null) { event.preventDefault(); options.current[next]?.focus(); }
  }
  return <div ref={root} className={styles.lang} onKeyDown={keyDown} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
  }}>
    <button ref={trigger} type="button" className={styles.langTrigger} aria-label={label} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => { setOpen(value => !value); setExpanded(false); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setExpanded(false); } }}>
      <span aria-hidden="true">···</span>
    </button>
    {open && <div id={id} role="menu" aria-label={label} className={`${styles.langMenu}${upwards ? ` ${styles.langMenuUp}` : ''}`}>
      <button ref={category} type="button" role="menuitem" tabIndex={-1} className={styles.langCategory} aria-haspopup="menu"
        aria-expanded={expanded} aria-controls={expanded ? `${id}-languages` : undefined} onClick={() => setExpanded(value => !value)}>
        {label}<span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && <div id={`${id}-languages`} role="menu" aria-label={label} className={styles.langOptions}>
        {LANGUAGES.map((value, index) => <button key={value} ref={element => { options.current[index] = element; }} type="button" role="menuitemradio"
          tabIndex={-1} lang={value === 'PT' ? 'pt-BR' : 'en'} aria-checked={language === value} onClick={() => {
            setLanguage(value); close(true); if (value !== language) router.refresh();
          }}>
          <span>{value === 'PT' ? 'Português' : 'English'}</span><span aria-hidden="true">{language === value ? '✓' : ''}</span>
        </button>)}
      </div>}
    </div>}
  </div>;
}
