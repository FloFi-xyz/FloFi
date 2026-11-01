// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAccountCookie, currentAccountSession, nextPath, setAccountCookie, type AccountHost } from './account-host';
import { ACCOUNT_SESSION_COOKIE, sealAccountSession, type AccountSessionToken } from './account-session';

const state = vi.hoisted(() => ({ values: new Map<string, string>(), writes: [] as { name: string; options: Record<string, unknown> }[], host: 'flofi.xyz' }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: state.host }),
  cookies: async () => ({ get: (name: string) => state.values.has(name) ? { value: state.values.get(name) } : undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      state.writes.push({ name, options }); if (options.maxAge === 0) state.values.delete(name); else state.values.set(name, value);
    } }),
}));
const env = { FLOFI_SESSION_SECRET: 'k'.repeat(40) };
const now = Math.floor(Date.now() / 1000);
const session: AccountSessionToken = { accountId: `acct_${'a'.repeat(32)}`, sessionId: 'b'.repeat(32), method: 'google', authenticatedAt: now, expiresAt: now + 3600 };
const verifySession = vi.fn(async () => true);
const host = { store: { verifySession } } as unknown as AccountHost;
beforeEach(() => { state.values.clear(); state.writes = []; state.host = 'flofi.xyz'; verifySession.mockClear(); });

describe('account cookie host isolation', () => {
  it('reads only the host-prefixed HTTPS cookie and still requires the live server-side session', async () => {
    const token = sealAccountSession(env, session, state.host, new Date());
    // Even a valid old cookie planted by a sibling host cannot become the current account.
    state.values.set(ACCOUNT_SESSION_COOKIE, token);
    expect(await currentAccountSession(host, env)).toBeNull(); expect(verifySession).not.toHaveBeenCalled();
    await setAccountCookie(session, env);
    expect(state.writes[0]).toMatchObject({ name: '__Host-flofi_account_session', options: { httpOnly: true, secure: true, path: '/' } });
    state.values.set(ACCOUNT_SESSION_COOKIE, 'attacker-cookie');
    expect(await currentAccountSession(host, env)).toEqual(session);
    verifySession.mockResolvedValueOnce(false);
    expect(await currentAccountSession(host, env)).toBeNull();
    await clearAccountCookie();
    expect(state.values.has('__Host-flofi_account_session')).toBe(false); expect(state.values.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });
  it('preserves loopback HTTP without accepting its token on another host', async () => {
    state.host = '127.0.0.1:3148';
    await setAccountCookie(session, env);
    expect(state.writes[0]).toMatchObject({ name: ACCOUNT_SESSION_COOKIE, options: { secure: false, path: '/' } });
    expect(await currentAccountSession(host, env)).toEqual(session);
    state.host = 'localhost:3148'; expect(await currentAccountSession(host, env)).toBeNull();
  });
});

describe('BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 where a completed sign-in continues (P1-05, T05)', () => {
  it('a wallet sign-in with a pending onboarding enters the app directly; an account without a wallet adds wallets first', () => {
    expect(nextPath({ session, onboarding: 'pending', walletOnboarding: false }, 'sign-in', '/app')).toBe('/app');
    expect(nextPath({ session, onboarding: 'pending', walletOnboarding: true }, 'sign-in', '/app')).toBe('/onboarding/wallets');
  });
  it('keeps the earlier rule when the outcome carries no wallet decision, and never redirects a link', () => {
    expect(nextPath({ session, onboarding: 'pending' }, 'sign-in', '/app')).toBe('/onboarding/wallets');
    expect(nextPath({ session, onboarding: 'completed' }, 'sign-in', '/app/credentials')).toBe('/app/credentials');
    expect(nextPath({ session, onboarding: 'pending', walletOnboarding: true }, 'link', '/app/credentials')).toBe('/app/credentials');
  });
});
