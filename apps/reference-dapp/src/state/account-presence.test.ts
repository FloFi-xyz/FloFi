// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../app/account-action', () => ({ accountPresence: vi.fn() }));
import { ACCOUNT_PRESENCE_FRESH_MS, fetchAccountPresence, forgetAccountPresence, knownAccountPresence, readAccountPresence, resetAccountPresenceForTests, seedAccountPresence } from './account-presence';

afterEach(() => forgetAccountPresence());
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

describe('BUILD-FLOFI-UX-FIX-003 shared account presence (Settings menu)', () => {
  it('shares one request between every reader and answers from memory while fresh', async () => {
    const pending = deferred<{ accounts: boolean; signedIn: boolean }>(), read = vi.fn(() => pending.promise);
    const first = readAccountPresence('page', read), second = readAccountPresence('page', read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(knownAccountPresence('page')).toBeNull();
    pending.resolve({ accounts: true, signedIn: true });
    await expect(Promise.all([first, second])).resolves.toEqual([{ accounts: true, signedIn: true }, { accounts: true, signedIn: true }]);
    expect(knownAccountPresence('page')).toEqual({ accounts: true, signedIn: true });
    await readAccountPresence('page', read);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('reads again once stale, and never shows another key’s value', async () => {
    const read = vi.fn(async () => ({ accounts: true, signedIn: false }));
    await readAccountPresence('page', read);
    await readAccountPresence('page', read, Date.now() + ACCOUNT_PRESENCE_FRESH_MS + 1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(knownAccountPresence('other')).toBeNull();
  });
  it('a session change forgets the value and a late answer of the old request is dropped', async () => {
    const old = deferred<{ accounts: boolean; signedIn: boolean }>();
    const late = readAccountPresence('page', () => old.promise);
    forgetAccountPresence();
    old.resolve({ accounts: true, signedIn: true });
    await late;
    expect(knownAccountPresence('page')).toBeNull();
  });
  it('a failed read leaves only the safe, already stale fallback (Sign in) and asks again next time', async () => {
    await expect(readAccountPresence('page', async () => { throw new Error('ACCOUNTS_UNAVAILABLE'); })).rejects.toThrow('ACCOUNTS_UNAVAILABLE');
    expect(knownAccountPresence('page')).toEqual({ accounts: true, signedIn: false });
    const read = vi.fn(async () => ({ accounts: true, signedIn: true }));
    await readAccountPresence('page', read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(knownAccountPresence('page')).toEqual({ accounts: true, signedIn: true });
  });
});

describe('BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: My Account known with the page', () => {
  afterEach(() => { resetAccountPresenceForTests(); vi.unstubAllGlobals(); });
  it('the server-verified presence of this page is used at once, with no request while fresh', async () => {
    resetAccountPresenceForTests();
    seedAccountPresence('page', { accounts: true, signedIn: true });
    expect(knownAccountPresence('page')).toEqual({ accounts: true, signedIn: true });
    const read = vi.fn(async () => ({ accounts: true, signedIn: false }));
    await expect(readAccountPresence('page', read)).resolves.toEqual({ accounts: true, signedIn: true });
    expect(read).not.toHaveBeenCalled();
    // Stale after the freshness window: read again (the shown value stays until the answer).
    await readAccountPresence('page', read, Date.now() + ACCOUNT_PRESENCE_FRESH_MS + 1);
    expect(read).toHaveBeenCalledOnce(); expect(knownAccountPresence('page')).toEqual({ accounts: true, signedIn: false });
  });
  it('an unknown seed is never assumed: the menu reads it itself', async () => {
    resetAccountPresenceForTests();
    seedAccountPresence('page', null);
    expect(knownAccountPresence('page')).toBeNull();
    const read = vi.fn(async () => ({ accounts: true, signedIn: false }));
    await readAccountPresence('page', read); expect(read).toHaveBeenCalledOnce();
  });
  it('is applied once per page, never over a value the page read, and never after a session change', async () => {
    resetAccountPresenceForTests();
    await readAccountPresence('page', async () => ({ accounts: true, signedIn: false }));
    seedAccountPresence('page', { accounts: true, signedIn: true });
    expect(knownAccountPresence('page')).toEqual({ accounts: true, signedIn: false });
    resetAccountPresenceForTests();
    forgetAccountPresence();
    seedAccountPresence('page', { accounts: true, signedIn: true });
    expect(knownAccountPresence('page')).toBeNull();
  });
  it('reads over the GET route and rejects anything but a well-formed answer', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: { accounts: true, signedIn: true } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchAccountPresence()).resolves.toEqual({ accounts: true, signedIn: true });
    expect(fetch).toHaveBeenCalledWith('/api/account/presence', expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'same-origin' }));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, code: 'ACCOUNTS_UNAVAILABLE' }), { status: 500 }));
    await expect(fetchAccountPresence()).rejects.toThrow('ACCOUNTS_UNAVAILABLE');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, value: { accounts: 'yes' } }), { status: 200 }));
    await expect(fetchAccountPresence()).rejects.toThrow('ACCOUNTS_UNAVAILABLE');
  });
});
