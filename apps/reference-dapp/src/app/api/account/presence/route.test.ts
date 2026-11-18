// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the Settings menu's presence GET answers exactly what the action did, same-origin only. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ host: {} as object | null, session: null as object | null, fail: false }));
vi.mock('../../../../accounts/account-host', () => ({ accountHost: async () => { if (h.fail) throw new Error('db down'); return h.host; },
  currentAccountSession: async () => h.session }));
const { GET } = await import('./route');
const get = (query = '', site: string | null = 'same-origin') => GET(new Request(`https://flofi.test/api/account/presence${query}`, { headers: site ? { 'sec-fetch-site': site } : {} }));

describe('GET /api/account/presence', () => {
  beforeEach(() => { h.host = {}; h.session = null; h.fail = false; });
  it('answers accounts and a verified session, never cached', async () => {
    let response = await get();
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toEqual({ ok: true, value: { accounts: true, signedIn: false } });
    h.session = { accountId: 'acct_1' }; response = await get(); expect((await response.json()).value).toEqual({ accounts: true, signedIn: true });
    h.host = null; response = await get(); expect((await response.json()).value).toEqual({ accounts: false, signedIn: false });
  });
  it('a failed read is an error, never "signed in"; cross-origin and query strings are refused', async () => {
    h.fail = true; let response = await get(); expect(response.status).toBe(500); expect(await response.json()).toEqual({ ok: false, code: 'ACCOUNTS_UNAVAILABLE' });
    h.fail = false; response = await get('', 'cross-site'); expect(response.status).toBe(403);
    response = await get('?x=1'); expect(response.status).toBe(400);
  });
});
