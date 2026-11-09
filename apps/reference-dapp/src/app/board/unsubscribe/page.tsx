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
export default async function UnsubscribePage() {
  const language = await siteLanguage();
  return <Unsubscribe language={language} lang={FLIGHT_COPY[language].lang}/>;
}
