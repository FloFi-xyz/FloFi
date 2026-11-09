// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: a boarding card's public page, flofi.xyz/card/{id} (the card flow's screen 4). Readable without signing in,
 * so X's crawler sees its preview (twitter:card summary_large_image, og:image the card's own 1200 × 630 image). It shows the card and
 * nothing else about the person: no email, wallet, invite or account. The handle is self-declared and says so. The id is random (60 bits),
 * never sequential, and the page is not indexed by search engines. "Board too" goes to /board?source=card&ref={id}.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { FoundingPass } from '../../../components/flight/boarding-pass';
import { FLIGHT_COPY } from '../../../components/flight/flight-copy';
import styles from '../../../components/flight/flight.module.css';
import { siteLanguage } from '../../../components/site/site-language';
import { cardMeta } from '../../../flight/card-image';
import { flightStore } from '../../../flight/host';
import type { PublicCard } from '../../../flight/store';
import { FLOFI_PRODUCTION_ORIGIN } from '../../../platform/navigation';

type Props = { params: Promise<{ id: string }> };
async function load(id: string): Promise<PublicCard | null> {
  if (!/^[a-z2-7]{12}$/.test(id)) return null;
  const store = await flightStore().catch(() => null);
  return store ? store.publicCard(id).catch(() => null) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params, card = await load(id), t = FLIGHT_COPY[await siteLanguage()].card;
  if (!card) return { title: 'Flight FloFi', robots: { index: false, follow: false } };
  const who = card.handle ? `@${card.handle}` : t.someone, route = `${card.route.from} → ${card.route.to}`, image = `/card/${id}/image`;
  const title = t.title(who), description = `${route} · ${cardMeta(card)} · ${FLIGHT_COPY[await siteLanguage()].pass.youApprove}`;
  return { metadataBase: new URL(FLOFI_PRODUCTION_ORIGIN), title, description, alternates: { canonical: `/card/${id}` }, robots: { index: false, follow: false },
    openGraph: { title, description, type: 'website', url: `/card/${id}`, siteName: 'FloFi', images: [{ url: image, width: 1200, height: 630, alt: t.alt(route, cardMeta(card)) }] },
    twitter: { card: 'summary_large_image', site: '@FloFi_xyz', title, description, images: [{ url: image, alt: t.alt(route, cardMeta(card)) }] } };
}

export default async function CardPage({ params }: Props) {
  await connection();
  const { id } = await params, card = await load(id);
  if (!card) notFound();
  const language = await siteLanguage(), copy = FLIGHT_COPY[language], t = copy.card;
  const who = card.handle ? `@${card.handle}` : t.someone, [first, accent] = t.boarded(who);
  return <div className={styles.page} lang={copy.lang}>
    <header className={styles.header}>
      <Link href="/" aria-label={copy.nav.home}><img src="/brand/flight/flofi-logo-on-blue.svg" alt="FloFi"/></Link>
    </header>
    <main className={styles.cardPublic}>
      <section aria-label={copy.pass.boardingPass}>
        <FoundingPass pass={{ handle: card.handle, route: card.route, seat: card.seat, founding: card.founding, departedAt: card.departedAt }} copy={copy} titleId="card-title"/>
      </section>
      <section className={styles.cardPublicText}>
        <h1>{first}<span className={styles.accentPeri}>{accent}</span></h1>
        <p className={styles.heroBody}>{t.body}</p>
        <div className={styles.ctaRow}>
          <Link className={`${styles.btn} ${styles.btnNavy}`} href={`/board?source=card&ref=${id}`}>{t.boardToo} <span aria-hidden="true">→</span></Link>
        </div>
        <p className={styles.small}>{t.closed}</p>
        {card.handle && <p className={styles.small}>{t.handle}</p>}
      </section>
    </main>
    <footer className={styles.footer}><p className={styles.footerRisk}>{copy.footer.risk}</p></footer>
  </div>;
}
