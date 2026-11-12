// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { BoardPage } from '../../components/flight/board-page';
import { boardingDay, FLIGHT_COPY } from '../../components/flight/flight-copy';
import { FlightHandoff } from '../../components/flight/flight-transition';
import { siteLanguage } from '../../components/site/site-language';
import { betaAccessMode } from '../../flight/beta-access';
import { boardArrival, boardArrivalCandidate, decideBoardArrival, type BoardArrivalFacts } from '../../flight/board-arrival';
import { flightCalendar } from '../../flight/host';
import { flightState } from '../../flight/http';
import { requireFlightAccess } from '../../server/flight-access';
import { flightRequestKind, fullNavigation } from '../../server/flight-gate';
import { FLOFI_PRODUCTION_ORIGIN } from '../../platform/navigation';
import './flight-document.css';

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
type Search = Promise<Record<string, string | string[] | undefined>>;
export default async function Page({ searchParams }: { searchParams: Search }) {
  await connection();
  const [language, state, arrival] = await Promise.all([siteLanguage(), flightState(), searchParams.then(boardArrival)]);
  // P0 hotfix (Flight transition): back from sign-in, a person the product already admits goes straight to /app before anything renders.
  // Read-only: the product gate is only asked (no grant, wallet link, claim or session is written); everyone else gets the board's own check.
  const facts: BoardArrivalFacts = { arrival, mode: betaAccessMode(), phase: state?.phase ?? null, signedIn: state?.me.signedIn ?? false,
    accessPending: state?.me.accessPending ?? false, access: state?.me.flight?.access.kind ?? null };
  const productAccess = boardArrivalCandidate(facts) && await requireFlightAccess().then(() => true, () => false);
  if (decideBoardArrival({ ...facts, productAccess }) === 'APP') {
    // A document request gets the HTTP redirect; a client-router request a full navigation, so /app never loads inside this document.
    if (fullNavigation(flightRequestKind(await headers())) === 'REDIRECT') redirect('/app');
    return <FlightHandoff to="/app" message={FLIGHT_COPY[language].boarding.checking}/>;
  }
  return <BoardPage language={language} state={state} arrival={arrival}/>;
}
