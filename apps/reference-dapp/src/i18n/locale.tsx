// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { translate } from './translate';
import { LANGUAGE_KEY, cookieLanguage, documentLanguage, languageCookie, type Language } from './language';
export type { Language } from './language';
export { DEFAULT_LANGUAGE, LANGUAGE_COOKIE, LANGUAGE_KEY, parseLanguage } from './language';
// The catalog lookup lives in `translate.ts` (no client boundary), so domain and server code share the exact same function.
export { translate } from './translate';
/** The person's choice, written synchronously to the authoritative cookie and to its storage mirror (before any refresh reads it). */
export function rememberLanguage(language: Language) {
  try { document.cookie = languageCookie(language, window.location.protocol === 'https:'); } catch { /* Still applies this visit. */ }
  try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* Optional mirror. */ }
}
/**
 * On load the cookie wins (locale contract, `language.ts`): storage that differs from a cookie the person set is aligned to it, never the
 * reverse, so a stale stored value can never flip the page. With no cookie at all nothing is written (the default is nobody's preference);
 * a legacy stored value was already migrated before the first paint by the root layout's script.
 */
export function alignStoredLanguage() {
  let chosen: Language | null;
  try { chosen = cookieLanguage(document.cookie); } catch { return; }
  if (!chosen) return;
  try { if (localStorage.getItem(LANGUAGE_KEY) !== chosen) localStorage.setItem(LANGUAGE_KEY, chosen); } catch { /* Optional mirror. */ }
}
const defaults = { language: 'EN' as Language, setLanguage: (_value: Language) => { void _value; }, t: <T,>(value: T, ...parameters: readonly (string | number)[]) => translate('EN', value, ...parameters) };
const Context = createContext(defaults);
/** One language per document: every provider on the page (the root layout's and a route group's) follows the person's choice at once. */
const LANGUAGE_EVENT = 'flofi:language';
/** Presentation preference only: no dependency on workflow, wallet, quote, authorization or execution stores. */
export function LocaleProvider({ children, initialLanguage = 'EN' }: { children: ReactNode; initialLanguage?: Language }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);
  // P0 hotfix (locale contract): the server already rendered the cookie's language; storage never flips it (it is aligned to the cookie).
  useEffect(() => { alignStoredLanguage(); }, []);
  useEffect(() => {
    const follow = (event: Event) => { const next = (event as CustomEvent<unknown>).detail; if (next === 'EN' || next === 'PT') setLanguageState(next); };
    window.addEventListener(LANGUAGE_EVENT, follow);
    return () => window.removeEventListener(LANGUAGE_EVENT, follow);
  }, []);
  useEffect(() => { document.documentElement.lang = documentLanguage(language); }, [language]);
  const value = useMemo(() => ({ language, setLanguage: (next: Language) => {
    // Cookie and storage first, synchronously, so a refresh the caller starts next already renders the new language on the server. Only the
    // person's own choice reaches here: no server response or stored value calls it.
    rememberLanguage(next); setLanguageState(next);
    try { window.dispatchEvent(new CustomEvent(LANGUAGE_EVENT, { detail: next })); } catch { /* This provider already follows. */ }
  }, t: <T,>(input: T, ...parameters: readonly (string | number)[]) => translate(language, input, ...parameters) }), [language]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useLocale = () => useContext(Context);
