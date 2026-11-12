// SPDX-License-Identifier: AGPL-3.0-only
import { cookies, headers } from 'next/headers';
import { LANGUAGE_COOKIE, parseLanguage, resolveLanguage, type Language, type ResolvedLanguage } from '../i18n/language';

/**
 * P0 hotfix (locale contract, `i18n/language.ts`): the language of this request, from the preference cookie (authoritative), else the default
 * for the page's path (the proxy's authoritative `x-flofi-pathname`). The root, product, account and wallet layouts, the site and the server
 * actions all read the language through this one function, so a page, its server-rendered parts and its actions never disagree.
 */
export async function requestLanguage(): Promise<ResolvedLanguage> {
  let cookie: string | undefined, pathname: string | null;
  // Outside a request (an open-mode action called by a script or a test) there is no preference: the general default.
  try { cookie = (await cookies()).get(LANGUAGE_COOKIE)?.value; } catch { cookie = undefined; }
  try { pathname = (await headers()).get('x-flofi-pathname'); } catch { pathname = null; }
  return resolveLanguage(cookie, pathname);
}
/**
 * The language a server action answers in: the cookie when the person chose one (it wins over anything the page sends); otherwise the
 * language the page says it shows (the person's choice in a browser that keeps no cookie); otherwise the default. Presentation only: a
 * language never changes what an action decides, and nothing an action returns changes the interface language.
 */
export async function actionLanguage(shown: unknown = null): Promise<Language> {
  const resolved = await requestLanguage();
  return resolved.chosen ? resolved.language : parseLanguage(typeof shown === 'string' ? shown : null) ?? resolved.language;
}
