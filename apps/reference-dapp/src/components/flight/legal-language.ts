// SPDX-License-Identifier: AGPL-3.0-only
import { cookies, headers } from 'next/headers';
import { LANGUAGE_COOKIE, parseLanguage } from '../../i18n/language';

/** Legal-page handoff: shared saved preference, otherwise the browser's first language, Portuguese or English. */
export async function legalLanguage(): Promise<'EN' | 'PT'> {
  const saved = parseLanguage((await cookies()).get(LANGUAGE_COOKIE)?.value);
  if (saved) return saved;
  const preferred = ((await headers()).get('accept-language') ?? '').trim();
  return /^pt(?:-|,|;|$)/i.test(preferred) ? 'PT' : 'EN';
}
