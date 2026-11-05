// SPDX-License-Identifier: AGPL-3.0-only
import { cookies } from 'next/headers';
import { DEFAULT_LANGUAGE, LANGUAGE_COOKIE, parseLanguage, type Language } from '../../i18n/language';

/** BUILD-FLOFI-SITE-001: the public site speaks the product's shared language preference (the same cookie and storage as /app); without one,
 * the product default (English since BUILD-FLOFI-LAUNCH-001), as sign-in and /app. */
export type SiteLanguage = Language;
export async function siteLanguage(): Promise<SiteLanguage> {
  const jar = await cookies();
  return parseLanguage(jar.get(LANGUAGE_COOKIE)?.value) ?? DEFAULT_LANGUAGE;
}
