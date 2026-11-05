// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { BoardPage } from '../../components/flight/board-page';
import { FLIGHT_COPY } from '../../components/flight/flight-copy';
import { siteLanguage } from '../../components/site/site-language';
import { flightState } from '../../flight/http';
import { FLOFI_PRODUCTION_ORIGIN } from '../../platform/navigation';

// BUILD-FLOFI-FLIGHT-001: flofi.xyz/board, the Flight FloFi campaign (team-approved Claude Artifact "Flight FloFi", version 1793892357-f7d9).
// The Open Graph image is the approved fixed 1200 × 630 board (opengraph-image.png next to this page; no counter, as the handoff asks).
export async function generateMetadata(): Promise<Metadata> {
  const t = FLIGHT_COPY[await siteLanguage()];
  return { metadataBase: new URL(FLOFI_PRODUCTION_ORIGIN), title: t.title, description: t.description, alternates: { canonical: '/board' },
    openGraph: { title: t.title, description: t.description, type: 'website', url: '/board' }, twitter: { card: 'summary_large_image', title: t.title, description: t.description } };
}
export default async function Page() {
  await connection();
  return <BoardPage language={await siteLanguage()} state={await flightState()}/>;
}
