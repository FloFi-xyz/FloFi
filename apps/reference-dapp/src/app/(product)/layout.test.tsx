// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Flight transition): the product layout's gate. A refusal leaves for /board — an HTTP redirect for a document request, a full-page
 * hand-off for a Server Action re-render or a client-router fetch (never a client navigation that draws /board inside the product document) —
 * and a failure to check access shows "Try again", never /board. Neither renders the workspace or reads its data.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const h = vi.hoisted(() => ({
  requireFlightAccess: vi.fn(), redirect: vi.fn((path: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { path }); }),
  headers: new Headers(), cookies: vi.fn(), copilotConfig: vi.fn(() => ({ mode: 'replay' })), workspace: vi.fn(() => null),
}));
vi.mock('next/server', () => ({ connection: async () => undefined }));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('next/headers', () => ({ headers: async () => h.headers, cookies: async () => h.cookies() }));
vi.mock('../../server/flight-access', () => ({ requireFlightAccess: h.requireFlightAccess }));
vi.mock('../../server/engineering-ui', () => ({ engineeringUiAllowed: async () => false }));
vi.mock('../../server/network-scope', () => ({ networkScope: () => 'PUBLIC_MAINNET' }));
vi.mock('../../server/copilot-service', () => ({ copilotConfig: h.copilotConfig }));
vi.mock('../../learning/config', () => ({ learningConfig: () => ({ enabled: false }), sessionAdaptation: () => false }));
vi.mock('../../accounts/privy-server', () => ({ privyBrowserConfig: () => null }));
vi.mock('../../accounts/privy-client', () => ({ FloFiPrivyProvider: ({ children }: { children: unknown }) => children }));
vi.mock('../../components/product-workspace', () => ({ ProductWorkspace: () => { h.workspace(); return <div className="app-shell">workspace</div>; } }));
import ProductLayout from './layout';
import { FlightGateScreen } from '../../components/flight/flight-transition';

const layout = () => ProductLayout({ children: <p>page</p> }) as Promise<ReactElement<{ response?: string }>>;
const refuse = (code: string) => h.requireFlightAccess.mockRejectedValue(new Error(code));
beforeEach(() => {
  vi.clearAllMocks();
  h.headers = new Headers({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  h.cookies.mockReturnValue({ get: () => undefined });
  h.requireFlightAccess.mockResolvedValue(null);
});

describe('product layout Flight gate', () => {
  it('renders the workspace for a request the gate lets in', async () => {
    const html = renderToStaticMarkup(await layout());
    expect(html).toContain('class="app-shell"');
    expect(html).toContain('<p>page</p>');
    expect(h.redirect).not.toHaveBeenCalled();
  });
  it('redirects a refused document request to /board, as before', async () => {
    for (const code of ['BETA_SIGN_IN_REQUIRED', 'BETA_ACCESS_DENIED', 'BETA_ACCESS_REVOKED', 'BETA_WALLET_NOT_LINKED', 'BETA_ACCESS_CLOSED']) {
      refuse(code);
      await expect(layout(), code).rejects.toMatchObject({ message: 'NEXT_REDIRECT', path: '/board' });
    }
    expect(h.workspace).not.toHaveBeenCalled();
    expect(h.cookies).not.toHaveBeenCalled();
  });
  it('hands a refused Server Action re-render or client-router fetch off to /board with a full navigation, never a redirect into this document', async () => {
    for (const values of [{ 'next-action': '7f001122', 'sec-fetch-mode': 'cors' }, { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }]) {
      h.headers = new Headers(values);
      refuse('BETA_WALLET_NOT_LINKED');
      const element = await layout();
      expect(element.type).toBe(FlightGateScreen);
      expect(element.props.response).toBe('HANDOFF');
      const html = renderToStaticMarkup(element);
      expect(html).toContain('Taking you to Flight FloFi…');
      expect(html).not.toMatch(/app-shell|<p>page<\/p>/);
    }
    expect(h.redirect).not.toHaveBeenCalled();
    expect(h.workspace).not.toHaveBeenCalled();
  });
  it('shows "We could not check your access" when the access store is unavailable, on every kind of request, and reads nothing else', async () => {
    for (const values of [{ 'sec-fetch-mode': 'navigate' }, { 'next-action': '7f001122' }, { 'sec-fetch-mode': 'cors' }, {}]) {
      for (const code of ['BETA_UNAVAILABLE', 'BETA_ACCESS_UNAVAILABLE', 'BETA_CONFIGURATION_INVALID']) {
        h.headers = new Headers(values);
        refuse(code);
        const element = await layout();
        expect(element.type).toBe(FlightGateScreen);
        expect(element.props.response).toBe('RETRY');
        const html = renderToStaticMarkup(element);
        expect(html).toContain('We could not check your access');
        expect(html).not.toMatch(/app-shell|<p>page<\/p>|Taking you to Flight FloFi/);
      }
    }
    expect(h.redirect).not.toHaveBeenCalled();
    expect(h.workspace).not.toHaveBeenCalled();
    expect(h.cookies).not.toHaveBeenCalled();
    expect(h.copilotConfig).not.toHaveBeenCalled();
  });
});
