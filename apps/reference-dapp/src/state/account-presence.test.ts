// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../app/account-action', () => ({ accountPresence: vi.fn() }));
import { ACCOUNT_PRESENCE_FRESH_MS, forgetAccountPresence, knownAccountPresence, readAccountPresence } from './account-presence';

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
