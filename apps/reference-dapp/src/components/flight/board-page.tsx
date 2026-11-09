// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: flofi.xyz/board, the Flight FloFi campaign page of the team-approved Claude Artifact "Flight FloFi" (version
 * 1793892357-f7d9): one page, English by default with the EN · PT switch, the main site unchanged ("O site principal não muda").
 * Order of the approved desktop board: header, hero (with the marquee), departures, how it works, Founding Members, example routes, footer
 * with the risk notice. "Board now" exists only on this page; the site keeps "Open" ("Botão 'Board now' só nesta página").
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: no aggregate count of people anywhere on the page (no "N OF 100" bar, no next seat number).
 */
import Link from 'next/link';
import type { FlightState } from '../../flight/http';
import { BoardExperience, RouteButton } from './board-experience';
import { FLIGHT_COPY, FLIGHT_LINKS } from './flight-copy';
import { LanguageSwitch } from './language-switch';
import styles from './flight.module.css';

export function BoardPage({ language, state }: { language: 'EN' | 'PT'; state: FlightState | null }) {
  const copy = FLIGHT_COPY[language];
  return <div className={styles.page} lang={copy.lang}>
    <a className={styles.skip} href="#top">{language === 'PT' ? 'Ir para o conteúdo' : 'Skip to content'}</a>
    <header className={styles.header}>
      <Link href="/" aria-label={copy.nav.home}>
        <img src="/brand/flight/flofi-logo-on-blue.svg" alt="FloFi"/>
      </Link>
      <nav className={styles.nav} aria-label={copy.nav.label}>
        <a href="#how">{copy.nav.how}</a><a href="#founding">{copy.nav.founding}</a><a href="#routes">{copy.nav.routes}</a>
        <LanguageSwitch language={language} label={copy.nav.language}/>
      </nav>
    </header>
    <main>
      <BoardExperience initial={state} language={language}/>
      <section id="how" className={`${styles.section} ${styles.how}`} aria-labelledby="how-title">
        <div className={styles.sectionHead}>
          <span className={styles.lbl}>{copy.how.eyebrow}</span>
          <h2 className={styles.h2} id="how-title">{copy.how.title[0]}<span className={styles.accentBlue}>{copy.how.title[1]}</span></h2>
        </div>
        <div className={styles.howGrid}>
          {copy.how.steps.map(([no, title, body]) => <div key={no} className={styles.step}>
            <span className={styles.stepNo} aria-hidden="true">{no}</span><h3 className={styles.stepTitle}>{title}</h3><p className={styles.stepBody}>{body}</p></div>)}
          <div className={styles.howArt} aria-hidden="true">
            <img src="/brand/flight/gota-safety.svg" alt=""/>
          </div>
        </div>
      </section>
      <section id="founding" className={styles.founding} aria-labelledby="founding-title">
        <div className={styles.foundingArt} aria-hidden="true">
          <div className={styles.miniPass}>
            <div className={styles.miniPassHead}><strong>{copy.pass.flight}</strong><span>{copy.pass.boardingPass}</span></div>
            <div className={styles.miniPassBody}>
              <span className={styles.boardLabel}>{copy.pass.passenger}</span><strong>{copy.founding.cardYou}</strong>
              <span className={styles.miniRoute}>ETH → BASE</span>
              <span className={styles.mono}>{state && !state.foundingOpen ? copy.pass.middleSeat : copy.founding.cardSeat}</span>
            </div>
          </div>
          <img src="/brand/flight/gota-captain.svg" alt=""/>
          <span className={styles.sticker}>{copy.pass.founding}</span>
        </div>
        <div className={styles.foundingText}>
          <span className={`${styles.lbl} ${styles.accentBlue}`}>{copy.founding.eyebrow}</span>
          <h2 className={styles.h2} id="founding-title">{copy.founding.title[0]}<span className={styles.accentBlue}>{copy.founding.title[1]}</span></h2>
          <ul className={styles.perks}>{copy.founding.perks.map(([title, body]) => <li key={title}><span><b>{title}</b> <span>{body}</span></span></li>)}</ul>
          {/* No count of seats taken or left (team decision, 9 Nov 2026): only whether Founding seats are still open. */}
          {state && <span className={`${styles.meta} ${styles.muted}`}>{state.foundingOpen ? copy.closedBeta : copy.passengerSeats}</span>}
        </div>
      </section>
      <section id="routes" className={styles.section} aria-labelledby="routes-title">
        <div className={styles.sectionHead}>
          <span className={styles.lbl}>{copy.routes.eyebrow}</span>
          <h2 className={styles.h2} id="routes-title">{copy.routes.title[0]}<span className={styles.accentBlue}>{copy.routes.title[1]}</span></h2>
        </div>
        <div className={styles.routeGrid}>{copy.routes.items.map(route => <div key={route.id} className={styles.routeCard}>
          <span className={styles.routeCode}>{route.from} <span aria-hidden="true">→</span><span className={styles.srOnly}>{copy.routeTo}</span> {route.to}</span>
          <p className={styles.routeQuote}>“{route.prompt}”</p>
          <span className={styles.routeMeta}>{route.meta}</span>
          <RouteButton prompt={route.prompt} routeId={route.id} label={copy.routes.use}/>
        </div>)}</div>
      </section>
    </main>
    <footer className={styles.footer}>
      <div className={styles.footerTop}>
        <img src="/brand/flight/flofi-logo-on-blue.svg" alt="FloFi"/>
        <nav className={styles.footerNav} aria-label={copy.footer.nav}>
          <Link href="/privacy">{copy.footer.privacy}</Link>
          <Link href="/docs/security">{copy.footer.risks}</Link>
          <a href={FLIGHT_LINKS.discord} target="_blank" rel="noopener noreferrer">{copy.footer.discord}</a>
          <a href={FLIGHT_LINKS.x} target="_blank" rel="noopener noreferrer">{copy.footer.x}</a>
          <LanguageSwitch language={language} label={copy.nav.language}/>
        </nav>
      </div>
      <p className={styles.footerRisk}>{copy.footer.risk}</p>
    </footer>
  </div>;
}
