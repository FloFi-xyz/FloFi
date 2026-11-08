// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { BoardPage } from '../../components/flight/board-page';
import { boardingDay, FLIGHT_COPY } from '../../components/flight/flight-copy';
import { siteLanguage } from '../../components/site/site-language';
import { flightCalendar } from '../../flight/host';
import { flightState } from '../../flight/http';
import { FLOFI_PRODUCTION_ORIGIN } from '../../platform/navigation';

// BUILD-FLOFI-FLIGHT-001: flofi.xyz/board, the Flight FloFi campaign (team-approved Claude Artifact "Flight FloFi", version 1793892357-f7d9).
// The Open Graph image is the approved fixed 1200 × 630 board (opengraph-image.png next to this page; no counter, as the handoff asks).
export async function generateMetadata(): Promise<Metadata> {
  const language = await siteLanguage(), t = FLIGHT_COPY[language];
  // The boarding day is the deployment's campaign calendar, read at request time (BUILD-FLOFI-UX-005); a refused calendar names no day.
  const calendar = flightCalendar(), description = calendar ? t.description(boardingDay(calendar.boardingOpensAt, language)) : undefined;
  return { metadataBase: new URL(FLOFI_PRODUCTION_ORIGIN), title: t.title, alternates: { canonical: '/board' },
    ...description ? { description } : {}, openGraph: { title: t.title, ...description ? { description } : {}, type: 'website', url: '/board' },
    twitter: { card: 'summary_large_image', title: t.title, ...description ? { description } : {} } };
}
export default async function Page() {
  await connection();
  return <BoardPage language={await siteLanguage()} state={await flightState()}/>;
}
