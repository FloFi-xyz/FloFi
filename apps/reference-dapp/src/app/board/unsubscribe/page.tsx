// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: the unsubscribe link in every Flight FloFi email. Opening it changes nothing (scanners open links); the
 * person's click posts the signed token. Mail apps that support one-click unsubscribe (RFC 8058) post to the API directly.
 */
import type { Metadata } from 'next';
import { Unsubscribe } from '../../../components/flight/access-continue';
import { FLIGHT_COPY } from '../../../components/flight/flight-copy';
import { siteLanguage } from '../../../components/site/site-language';

export const metadata: Metadata = { title: 'Flight FloFi', robots: { index: false, follow: false }, referrer: 'no-referrer' };
// The email's own language (?l=pt / ?l=en in its links) wins over the site preference: a mail app's browser has no FloFi cookie.
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const l = (await searchParams).l, language = l === 'pt' ? 'PT' : l === 'en' ? 'EN' : await siteLanguage();
  return <Unsubscribe language={language} lang={FLIGHT_COPY[language].lang}/>;
}
