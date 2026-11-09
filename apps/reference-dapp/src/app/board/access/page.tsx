// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: where Email 3's "Board now" lands (flofi.xyz/board/access#t=…). Opening it consumes nothing: email scanners
 * and previews open links on their own. The token is in the URL fragment (never sent to a server, never logged); only the person's own
 * "Continue" posts it. Never indexed, never referred.
 */
import type { Metadata } from 'next';
import { AccessContinue } from '../../../components/flight/access-continue';
import { FLIGHT_COPY } from '../../../components/flight/flight-copy';
import { siteLanguage } from '../../../components/site/site-language';

export const metadata: Metadata = { title: 'Flight FloFi', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default async function AccessPage() {
  const language = await siteLanguage();
  return <AccessContinue language={language} lang={FLIGHT_COPY[language].lang}/>;
}
