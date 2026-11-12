// SPDX-License-Identifier: AGPL-3.0-only
import type { Language } from '../../i18n/language';
import { requestLanguage } from '../../server/request-language';

/** BUILD-FLOFI-SITE-001: the public site speaks the product's shared language preference (the same cookie and storage as /app); without one,
 * the product default (English since BUILD-FLOFI-LAUNCH-001), as sign-in and /app. */
export type SiteLanguage = Language;
export async function siteLanguage(): Promise<SiteLanguage> {
  // P0 hotfix: the one locale resolver (cookie authoritative, else the default), as the layouts and server actions.
  return (await requestLanguage()).language;
}
