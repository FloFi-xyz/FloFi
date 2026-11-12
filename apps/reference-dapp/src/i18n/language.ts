// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-UX-001: language preference identities shared by the server layout (cookie → first paint) and the client LocaleProvider.
 * Kept free of `'use client'` so a Server Component may parse the cookie without crossing the client boundary.
 */
export type Language = 'EN' | 'PT';
export const LANGUAGE_KEY = 'flofi.language';
export const LANGUAGE_COOKIE = 'flofi_language';
export const parseLanguage = (value: string | null | undefined): Language | null => value === 'PT' || value === 'EN' ? value : null;
/** Team decision for the 17 Nov 2026 launch (BUILD-FLOFI-LAUNCH-001, superseding the 4 Nov Portuguese default of BUILD-FLOFI-SITE-001): the
 * approved landing speaks English by default, and so does the journey it opens (sign-in, onboarding and /app), so a new visitor never switches
 * language between the landing and the product. A saved preference (the cookie above, or the storage key the provider restores) always wins, so
 * existing English and Portuguese choices are unchanged, and Portuguese stays one choice away (Preferences on the site, Settings in /app). */
export const DEFAULT_LANGUAGE: Language = 'EN';
/**
 * Surfaces that keep English whatever the product default is (pinned by locale.test.tsx, so a future change of DEFAULT_LANGUAGE cannot reach them):
 * - the MCP signing surface, embedded in a chat host's frame where FloFi's preference cookie and storage never reach it:
 *   EMBEDDED_APPROVAL_PATH in server/embedded-approval.ts;
 * - FloFi Wallet, on its own host, which never sees the product's preference and has its own language switch;
 * - the admin console, written in English only.
 */
const ENGLISH_DEFAULT = (pathname: string) => pathname === '/mcp/approve' || pathname === '/wallet' || pathname.startsWith('/wallet/')
  || pathname === '/admin' || pathname.startsWith('/admin/');
/** The language for a visitor with no saved preference on `pathname` (the proxy's `x-flofi-pathname`). */
export const defaultLanguageFor = (pathname: string | null | undefined): Language => pathname && ENGLISH_DEFAULT(pathname) ? 'EN' : DEFAULT_LANGUAGE;
/** The document language for a preference: Brazilian Portuguese or English (the provider keeps the same value after hydration). */
export const documentLanguage = (language: Language) => language === 'PT' ? 'pt-BR' : 'en';

/**
 * P0 hotfix (locale contract): THE one resolver of the person's language, used by the root, product, account and wallet layouts, the site, the
 * server actions and the FloFi Assistant (`server/request-language.ts`).
 *
 *   1. the preference cookie is authoritative (the server reads only it, so the first paint is already in the chosen language);
 *   2. without it, the default for this path (English; the pinned English surfaces stay English);
 *   3. browser storage mirrors the cookie and is never a second authority: on load a differing stored value never flips the page
 *      (`LocaleProvider` aligns storage to the cookie), and only a legacy value with NO cookie at all is migrated once, before the first paint
 *      (`languageMigrationScript`);
 *   4. nothing a backend returns changes it: only the person's own choice (`setLanguage`) writes the cookie and storage.
 *
 * `chosen` is false when the language is the default (no cookie): the default is never written as anyone's preference.
 */
export type ResolvedLanguage = { readonly language: Language; readonly chosen: boolean };
export function resolveLanguage(cookie: string | null | undefined, pathname: string | null | undefined): ResolvedLanguage {
  const chosen = parseLanguage(cookie);
  return chosen ? { language: chosen, chosen: true } : { language: defaultLanguageFor(pathname), chosen: false };
}
/** Whether this path keeps English when it has no cookie, whatever was saved elsewhere (nothing is migrated there). */
export const englishPinnedPath = (pathname: string | null | undefined): boolean => Boolean(pathname && ENGLISH_DEFAULT(pathname));
/** The preference cookie the browser writes, synchronously, when the person chooses a language (one year, whole origin, readable by the page). */
export const languageCookie = (language: Language, secure: boolean): string =>
  `${LANGUAGE_COOKIE}=${language}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`;
/** The preference in a `document.cookie` string (the browser's view of the same authority), or null. */
export function cookieLanguage(cookies: string | null | undefined): Language | null {
  for (const part of (cookies ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === LANGUAGE_COOKIE) return parseLanguage(part.slice(at + 1).trim());
  }
  return null;
}
/** Set once per tab by the migration, so a browser that drops the cookie can never reload in a loop. */
export const LANGUAGE_MIGRATION_KEY = 'flofi.language.migrated';
/**
 * The one-time migration of a legacy preference kept only in storage (its cookie expired or was never written), as an inline `<head>` script the
 * CSP nonce allows. The server rendered `rendered` (the default: the request had no cookie). When storage holds the OTHER language, the script
 * writes the cookie, hides the document and reloads once, before the first paint, so the person never sees the page flip. A stored value equal
 * to what was rendered needs nothing (the default is not written as a preference). Only emitted when the request had no cookie and the path is
 * not an English-pinned surface. Data only: it reads and writes the language preference, nothing else.
 */
export function languageMigrationScript(rendered: Language): string {
  const key = JSON.stringify(LANGUAGE_KEY), cookie = JSON.stringify(LANGUAGE_COOKIE), once = JSON.stringify(LANGUAGE_MIGRATION_KEY), shown = JSON.stringify(rendered);
  return `(function(){try{var s=localStorage.getItem(${key});if(s!=="PT"&&s!=="EN")return;` +
    `var has=function(){return document.cookie.split(";").some(function(p){var i=p.indexOf("=");return i>0&&p.slice(0,i).trim()===${cookie}})};` +
    `if(has()||s===${shown}||sessionStorage.getItem(${once})===s)return;` +
    `document.cookie=${cookie}+"="+s+"; Path=/; Max-Age=31536000; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"");` +
    `if(!has())return;sessionStorage.setItem(${once},s);document.documentElement.style.visibility="hidden";location.reload()}catch(e){}})();`;
}
