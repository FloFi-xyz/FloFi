// SPDX-License-Identifier: AGPL-3.0-only
import { cookies } from 'next/headers';
import { LANGUAGE_COOKIE, parseLanguage, type Language } from '../../i18n/language';

/** BUILD-FLOFI-SITE-001: the public site speaks the product's shared language preference (the same cookie and storage as /app); Portuguese by
 * default, as the approved site and the previous landing. */
export type SiteLanguage = Language;
export async function siteLanguage(): Promise<SiteLanguage> {
  const jar = await cookies();
  return parseLanguage(jar.get(LANGUAGE_COOKIE)?.value) ?? 'PT';
}
