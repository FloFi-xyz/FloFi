// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Flight transition): /board's first paint. Back from sign-in during boarding, the page opens on FloFi's checking state with the
 * board hidden underneath (never a board painted and then replaced); every other visit shows the board at once.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FlightState } from '../../flight/http';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
import { BoardPage } from './board-page';

const state = (phase: FlightState['phase']): FlightState => ({ ok: true, now: 0, phase, closesAt: 0, boardingOpensAt: 0, foundingOpen: true, departures: [],
  me: { signedIn: true, hasEmail: true, accessPending: false, flight: null } });
/** What is painted: everything before the hidden board. */
const painted = (html: string) => html.slice(0, html.indexOf('data-flight-board-content'));

describe('/board first paint', () => {
  it('opens an arrival the board checks on the branded checking state, with the board hidden', () => {
    const html = renderToStaticMarkup(<BoardPage language="EN" state={state('BOARDING')} arrival="BOARD"/>);
    expect(html).toMatch(/^(<link [^>]*>)*<div class="[^"]+" lang="en" data-flight-page="">/);
    expect(painted(html)).toContain('Checking your boarding…');
    expect(painted(html)).not.toMatch(/Say where you|Board now|<header/);
    expect(html).toMatch(/<div hidden="" data-flight-board-content="">/);
    // Portuguese uses the board's own copy.
    expect(painted(renderToStaticMarkup(<BoardPage language="PT" state={state('BOARDING')} arrival="BOARD"/>))).toContain('Conferindo seu embarque…');
  });
  it('shows the board at once on every other visit', () => {
    for (const [phase, arrival] of [['BOARDING', null], ['BOARDING', 'INVITE'], ['GATE_CLOSED', 'BOARD'], ['FINAL_CALL', 'BOARD']] as const) {
      const html = renderToStaticMarkup(<BoardPage language="EN" state={state(phase)} arrival={arrival}/>);
      expect(html, `${phase} ${arrival}`).not.toContain('data-flight-transition');
      expect(html, `${phase} ${arrival}`).toMatch(/<div data-flight-board-content=""><a [^>]*href="#top"/);
    }
    expect(renderToStaticMarkup(<BoardPage language="EN" state={null}/>)).not.toContain('data-flight-transition');
  });
  it('opens /app from the boarding pass panel with a full navigation (a plain link, never a client-side route change)', () => {
    const source = readFileSync(new URL('./board-experience.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/<Link[^>]*href="\/app/);
    expect(source).toContain('<a className={`${styles.btn} ${styles.btnBlue}`} href="/app">{t.open}</a>');
  });
});

describe('BUILD-FLOFI-IDENTITY-RECOVERY-UX-001: signed in with another method than the one the person boarded with', () => {
  const notListed = (boardedElsewhere: boolean): FlightState => ({ ok: true, now: 0, phase: 'BOARDING', closesAt: 0, boardingOpensAt: 0, foundingOpen: true, departures: [],
    me: { signedIn: true, hasEmail: true, accessPending: false, flight: { access: { kind: 'not_listed' }, pass: null, invites: [], listed: null }, ...boardedElsewhere ? { boardedElsewhere } : {} } });
  it('never says "Not on the list" to a person whose address boarded with another account, and offers one way back', () => {
    for (const [language, title, action, help] of [['EN', 'You boarded with ', 'Continue to my account', 'Need help signing in?'],
      ['PT', 'Você embarcou com ', 'Continuar para minha conta', 'Precisa de ajuda para entrar?']] as const) {
      const html = renderToStaticMarkup(<BoardPage language={language} state={notListed(true)}/>);
      const hero = html.slice(html.indexOf('data-boarded-elsewhere="true"'), html.lastIndexOf('/brand/flight/gota-safety.svg'));
      expect(hero, language).toContain(title);
      expect(html, language).not.toMatch(/Not on the list\.|Fora da lista\./);
      // Authentication UX & Login Regression Fix (item 6): the board panel stays; one main action; help is secondary and closed.
      expect(hero.match(/data-continue-account="true"/g), language).toHaveLength(1);
      expect(hero, language).toContain(action);
      expect(hero, language).toContain(`aria-expanded="false" aria-controls="flight-sign-in-help">${help}</button>`);
      // No email, no 6-digit code and no beta explanation by default; no second main button.
      expect(hero, language).not.toMatch(/type="email"|one-time-code|000000|6-digit|6 dígitos|beta/i);
      expect(hero, language).not.toMatch(/Bring this sign-in|Trazer este login|Sign in with another method|Entrar com outro método/);
      expect(hero.match(/<(a|button) [^>]*class="[^"]*btn[^"]*"/g), language).toHaveLength(1);
      // The mascot and the departures-board flaps are preserved.
      expect(html, language).toContain('/brand/flight/gota-safety.svg');
      expect(hero, language).toContain(language === 'EN' ? 'aria-label="OTHER LOGIN"' : 'aria-label="OUTRO LOGIN"');
    }
  });
  it('keeps "Not on the list" otherwise, with a quiet link for a signed-in person who boarded another way', () => {
    const html = renderToStaticMarkup(<BoardPage language="EN" state={notListed(false)}/>);
    expect(html).toContain('Not on the list. ');
    expect(html).not.toContain('data-boarded-elsewhere');
    expect(html).toContain('Boarded with another sign-in method?');
  });
});
