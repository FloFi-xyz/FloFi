// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { portuguese } from './pt';
import { LANGUAGE_COOKIE, LANGUAGE_KEY, parseLanguage, type Language } from './language';
export type { Language } from './language';
export { LANGUAGE_COOKIE, LANGUAGE_KEY, parseLanguage } from './language';
function rememberLanguageCookie(language: Language) {
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${LANGUAGE_COOKIE}=${language}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  } catch { /* Optional preference storage. */ }
}
const templates = Object.entries(portuguese).filter(([key]) => key.includes('{0}')).map(([key, value]) => ({
  pattern: new RegExp('^' + key.split(/(\{\d+\})/).map(part => /^\{\d+\}$/.test(part) ? '(.+?)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$'), value,
}));
/** Translate only catalog messages. Unlisted symbols, addresses, hashes, IDs and user names pass through unchanged. */
export function translate<T>(language: Language, input: T, ...parameters: readonly (string | number)[]): T {
  if (typeof input !== 'string') return input;
  const text = input.trim();
  let value = language === 'PT' && Object.hasOwn(portuguese, text) ? portuguese[text] : undefined;
  if (parameters.length) {
    const message = (value ?? text).replace(/\{(\d+)\}/g, (placeholder, i: string) => String(parameters[Number(i)] ?? placeholder));
    return input.replace(text, () => message) as T;
  }
  if (language !== 'PT') return input;
  if (!value) for (const template of templates) { const match = template.pattern.exec(text); if (match) { value = template.value.replace(/\{(\d+)\}/g, (_, i: string) => match[Number(i) + 1] ?? ''); break; } }
  return (value === undefined ? input : input.replace(text, () => value!)) as T;
}
const defaults = { language: 'EN' as Language, setLanguage: (_value: Language) => { void _value; }, t: <T,>(value: T, ...parameters: readonly (string | number)[]) => translate('EN', value, ...parameters) };
const Context = createContext(defaults);
/** Presentation preference only: no dependency on workflow, wallet, quote, authorization or execution stores. */
export function LocaleProvider({ children, initialLanguage = 'EN' }: { children: ReactNode; initialLanguage?: Language }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);
  useEffect(() => { try { const saved = parseLanguage(localStorage.getItem(LANGUAGE_KEY)); if (saved) { setLanguageState(saved); rememberLanguageCookie(saved); } } catch { /* Optional preference storage. */ } }, []);
  useEffect(() => { document.documentElement.lang = language === 'PT' ? 'pt' : 'en'; }, [language]);
  const value = useMemo(() => ({ language, setLanguage: (next: Language) => {
    setLanguageState(next); try { localStorage.setItem(LANGUAGE_KEY, next); } catch { /* Still applies this visit. */ } rememberLanguageCookie(next);
  }, t: <T,>(input: T, ...parameters: readonly (string | number)[]) => translate(language, input, ...parameters) }), [language]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useLocale = () => useContext(Context);
