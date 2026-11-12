// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Flight transition): /board?board=1 (back from sign-in). A person the product already admits goes to /app before anything renders
 * (an HTTP redirect for a document, a full-page hand-off otherwise); the product gate is only asked for an eligible closed-beta arrival, and
 * read-only. Everyone else gets the board, which opens on its checking state when it will check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { FlightState } from '../../flight/http';

const h = vi.hoisted(() => ({
  requireFlightAccess: vi.fn(), redirect: vi.fn((path: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { path }); }),
  headers: new Headers(), state: null as unknown,
}));
vi.mock('next/server', () => ({ connection: async () => undefined }));
vi.mock('next/navigation', () => ({ redirect: h.redirect, useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('next/headers', () => ({ headers: async () => h.headers, cookies: async () => ({ get: () => undefined }) }));
vi.mock('../../components/site/site-language', () => ({ siteLanguage: async () => 'EN' }));
vi.mock('../../flight/http', () => ({ flightState: async () => h.state }));
vi.mock('../../flight/host', () => ({ flightCalendar: () => null }));
vi.mock('../../server/flight-access', () => ({ requireFlightAccess: h.requireFlightAccess }));
import Page from './page';
import { BoardPage } from '../../components/flight/board-page';
import { FlightHandoff } from '../../components/flight/flight-transition';

type Props = { to?: string; arrival?: string | null; state?: unknown; message?: string };
const page = (search: Record<string, string> = { board: '1' }) => Page({ searchParams: Promise.resolve(search) }) as Promise<ReactElement<Props>>;
const flight = (access: string | null, me: Partial<FlightState['me']> = {}, phase: FlightState['phase'] = 'BOARDING') => ({ ok: true, now: 0, phase,
  closesAt: 0, boardingOpensAt: 0, foundingOpen: true, departures: [],
  me: { signedIn: true, hasEmail: true, accessPending: false, flight: access ? { access: { kind: access }, pass: null, invites: [], listed: 'FIRST' } : null, ...me } });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('FLOFI_BETA_ACCESS', 'beta');
  h.headers = new Headers({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  h.state = flight('eligible');
  h.requireFlightAccess.mockResolvedValue({ accountId: 'acct_a', sessionId: 's' });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('/board arrival', () => {
  it('redirects an admitted closed-beta arrival to /app before anything renders', async () => {
    await expect(page()).rejects.toMatchObject({ message: 'NEXT_REDIRECT', path: '/app' });
    await expect(page({ invite: '1' })).rejects.toMatchObject({ path: '/app' });
    expect(h.requireFlightAccess).toHaveBeenCalledTimes(2);
    expect(h.requireFlightAccess).toHaveBeenCalledWith();
  });
  it('hands a client-router request off to /app with a full navigation, never a redirect inside the board document', async () => {
    h.headers = new Headers({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' });
    const element = await page();
    expect(element.type).toBe(FlightHandoff);
    expect(element.props).toMatchObject({ to: '/app', message: 'Checking your boarding…' });
    expect(h.redirect).not.toHaveBeenCalled();
  });
  it('keeps a candidate the product gate refuses on the board, which then runs its own check', async () => {
    h.requireFlightAccess.mockRejectedValue(new Error('BETA_ACCESS_DENIED'));
    const element = await page();
    expect(element.type).toBe(BoardPage);
    expect(element.props).toMatchObject({ arrival: 'BOARD', state: h.state });
    h.requireFlightAccess.mockRejectedValue(new Error('BETA_UNAVAILABLE'));
    expect((await page()).type).toBe(BoardPage);
    expect(h.redirect).not.toHaveBeenCalled();
  });
  it('asks the product gate only for an eligible, signed-in, closed-beta arrival with nothing left to bind', async () => {
    const cases: [string, () => void, Record<string, string>?][] = [
      ['no return mark', () => undefined, {}],
      ['open rollout', () => vi.stubEnv('FLOFI_BETA_ACCESS', 'open')],
      ['unset rollout', () => vi.stubEnv('FLOFI_BETA_ACCESS', undefined)],
      ['signed out', () => { h.state = flight(null, { signedIn: false }); }],
      ['pending access link', () => { h.state = flight('eligible', { accessPending: true }); }],
      ['pass to show', () => { h.state = flight('boarded'); }],
      ['not on the list', () => { h.state = flight('not_listed'); }],
      ['group closed', () => { h.state = flight('batch_closed'); }],
      ['before boarding', () => { h.state = flight('eligible', {}, 'GATE_CLOSED'); }],
      ['campaign unavailable', () => { h.state = null; }],
    ];
    for (const [name, arrange, search] of cases) {
      vi.stubEnv('FLOFI_BETA_ACCESS', 'beta'); h.state = flight('eligible');
      arrange();
      const element = await page(search);
      expect(element.type, name).toBe(BoardPage);
      expect(element.props.state, name).toBe(h.state);
    }
    expect(h.requireFlightAccess).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });
  it('passes the arrival to the board, which opens on its checking state when it checks', async () => {
    h.state = flight('not_listed');
    expect((await page()).props.arrival).toBe('BOARD');
    expect((await page({ invite: '1' })).props.arrival).toBe('INVITE');
    expect((await page({})).props.arrival).toBeNull();
  });
});
