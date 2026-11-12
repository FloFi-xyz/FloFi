// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Flight transition): FloFi's branded full-screen states, as the server renders them (first paint). The checking state replaces
 * the board (which stays mounted but hidden), the gate's hand-off is a status with no product content, and "We could not check your
 * access" offers only Try again, in English and Brazilian Portuguese.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../../i18n/locale';
import { BoardFrame } from './board-frame';
import { FlightGateScreen, FlightTransition } from './flight-transition';

// React hoists a preload of the logo ahead of the markup; the screens themselves follow it.
const render = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node).replace(/^(<link rel="preload"[^>]*\/>)+/, '');

describe('Flight transition screens', () => {
  it('shows the checking state from the first paint and keeps the board hidden underneath', () => {
    const html = render(<BoardFrame checking message="Checking your boarding…"><main id="board-content">Say where you’re going.</main></BoardFrame>);
    expect(html).toMatch(/^<div[^>]*role="status"[^>]*aria-busy="true"[^>]*data-flight-transition=""/);
    expect(html).toContain('Checking your boarding…');
    expect(html).toContain('src="/brand/flight/flofi-logo-on-blue.svg" alt="FloFi"');
    expect(html).toMatch(/<div hidden="" data-flight-board-content=""><main id="board-content">/);
  });
  it('shows the board alone when nothing is being checked', () => {
    const html = render(<BoardFrame checking={false} message="Checking your boarding…"><main id="board-content">Say where you’re going.</main></BoardFrame>);
    expect(html).toBe('<div data-flight-board-content=""><main id="board-content">Say where you’re going.</main></div>');
  });
  it('hands off to /board as a status, with nothing of the workspace', () => {
    const html = render(<LocaleProvider><FlightGateScreen response="HANDOFF"/></LocaleProvider>);
    expect(html).toContain('role="status"');
    expect(html).toContain('Taking you to Flight FloFi…');
    expect(html).not.toMatch(/app-shell|Try again|<button/);
    expect(render(<LocaleProvider initialLanguage="PT"><FlightGateScreen response="HANDOFF"/></LocaleProvider>)).toContain('Levando você ao Flight FloFi…');
  });
  it('says access could not be checked, offers Try again and never presents it as a refusal', () => {
    const html = render(<LocaleProvider><FlightGateScreen response="RETRY"/></LocaleProvider>);
    expect(html).toMatch(/<main[^>]*data-flight-gate="retry"/);
    expect(html).toMatch(/<h1[^>]*>We could not check your access<\/h1>/);
    expect(html).toContain('Your FloFi workspace opens once your Flight FloFi access is confirmed.');
    expect(html).toMatch(/<button type="button"[^>]*>Try again<\/button>/);
    expect(html).not.toMatch(/href=|app-shell|Board now|Not on the list/);
    const pt = render(<LocaleProvider initialLanguage="PT"><FlightGateScreen response="RETRY"/></LocaleProvider>);
    expect(pt).toContain('Não conseguimos verificar seu acesso');
    expect(pt).toContain('Seu espaço de trabalho FloFi abre assim que seu acesso ao Flight FloFi for confirmado.');
    expect(pt).toContain('Tentar novamente');
  });
  it('renders any message in the same branded frame', () => {
    expect(render(<FlightTransition message="Conferindo seu embarque…"/>)).toContain('<p class="');
  });
});
