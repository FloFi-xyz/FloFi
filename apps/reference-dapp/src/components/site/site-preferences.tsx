// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from '../../i18n/locale';
import type { SiteLanguage } from './site-language';
import styles from './site.module.css';

/**
 * BUILD-FLOFI-SITE-001: the header's "Preferences" (⋯) control. It sets the product's one shared language preference (the same cookie and storage
 * /app and sign-in read) and re-renders the page in that language. Language is the only preference the site offers.
 */
export function SitePreferences({ language, labels }: { language: SiteLanguage; labels: { preferences: string; language: string; portuguese: string; english: string } }) {
  const { setLanguage } = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // The radio shows the choice at once; the page follows when the refreshed render arrives (and a later server language wins).
  const [chosen, setChosen] = useState(language);
  useEffect(() => { setChosen(language); }, [language]);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // P0 hotfix (locale contract): no restore-on-arrival flip. A preference kept only in storage (its cookie expired or was cleared) is migrated
  // before the first paint by the root layout's script, so the server already renders it; a stored value never overrides the cookie.
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    const away = (event: FocusEvent) => { if (!(event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget))) setOpen(false); };
    const current = root.current;
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape); current?.addEventListener('focusout', away);
    current?.querySelector<HTMLInputElement>('input:checked')?.focus();
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); current?.removeEventListener('focusout', away); };
  }, [open]);
  // The menu stays open on the chosen radio (keyboard focus is kept, arrows keep switching); Escape or a click elsewhere closes it. Choosing the
  // language already shown still saves it, so a default the visitor confirms follows them into sign-in and /app.
  function choose(next: SiteLanguage) {
    setChosen(next);
    setLanguage(next);
    if (next !== language) router.refresh();
  }
  return <div className={styles.prefs} ref={root}>
    <button ref={button} type="button" className={styles.prefsButton} aria-label={labels.preferences} aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(value => !value)}>
      <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
    </button>
    {open && <div id={menuId} className={styles.prefsMenu} role="group" aria-label={labels.preferences}>
      <fieldset><legend>{labels.language}</legend>
        {([['PT', labels.portuguese, 'pt-BR'], ['EN', labels.english, 'en']] as const).map(([value, label, lang]) => <label key={value} className={styles.prefsOption} lang={lang}>
          <input type="radio" name={`${menuId}-language`} value={value} checked={chosen === value} onChange={() => choose(value)}
            onClick={() => { if (chosen === value) choose(value); }}/>{label}
        </label>)}
      </fieldset>
    </div>}
  </div>;
}
