// SPDX-License-Identifier: AGPL-3.0-only
/** Request-boundary tests only: the host stands in for an already verified FloFi/Privy session; no wallet signature is simulated here. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ person: null as { accountId: string; emails: string[] } | null,
  cookie: null as string | null, now: Date.parse('2026-11-12T12:01:00Z'),
  account: vi.fn(), claim: vi.fn(), bind: vi.fn(), record: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => harness.cookie ? { value: harness.cookie } : undefined }) }));
vi.mock('./host', () => ({
  flightPerson: async () => harness.person,
  flightNow: async () => harness.now,
  flightStore: async () => ({ account: harness.account, claimVerifiedEntry: harness.claim, recordEvent: harness.record }),
  flightAccessStore: async () => ({ bindSession: harness.bind }),
  flightOutbox: async () => null, clientDigest: async () => null, requestClient: async () => null,
}));
import { handleBoard } from './http';

const request = (body: unknown = {}, origin = 'http://localhost') => new Request('http://localhost/api/board/board', { method: 'POST',
  headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  harness.person = null; harness.cookie = null;
  harness.claim.mockResolvedValue('NONE'); harness.bind.mockResolvedValue('NONE');
  harness.account.mockResolvedValue({ access: { kind: 'not_listed' }, pass: null, invites: [], listed: null });
});

describe('Flight boarding uses only the server-verified account', () => {
  it('requires an authenticated account even when the browser supplies an account, address or wallet', async () => {
    const response = await handleBoard(request({ accountId: 'other', email: 'listed@example.com', wallet: `0x${'a'.repeat(40)}` }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, code: 'FLIGHT_SIGN_IN_REQUIRED' });
    expect(harness.claim).not.toHaveBeenCalled(); expect(harness.account).not.toHaveBeenCalled();
  });

  it('supports a returning wallet session without an email parameter and ignores browser identity claims', async () => {
    harness.person = { accountId: 'server-account', emails: [] };
    harness.account.mockResolvedValue({ access: { kind: 'eligible', origin: 'LIST' }, pass: null, invites: [], listed: 'FIRST' });
    const response = await handleBoard(request({ accountId: 'other', email: 'other@example.com', wallet: `0x${'b'.repeat(40)}` }));
    expect(response.status).toBe(200);
    expect(harness.claim).toHaveBeenCalledExactlyOnceWith({ accountId: 'server-account', emails: [], now: harness.now });
    expect(harness.account).toHaveBeenCalledExactlyOnceWith({ accountId: 'server-account', emails: [], now: harness.now });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('binds a pending proof only to the authenticated account and clears its one-use browser cookie', async () => {
    harness.person = { accountId: 'server-account', emails: [] }; harness.cookie = 'a'.repeat(43); harness.bind.mockResolvedValue('CLAIMED');
    const response = await handleBoard(request());
    expect(harness.bind).toHaveBeenCalledExactlyOnceWith({ session: harness.cookie, accountId: 'server-account', now: harness.now });
    expect(harness.claim).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('keeps another account’s claim refused and never falls back from a conflicting pending proof to an email claim', async () => {
    harness.person = { accountId: 'wrong-account', emails: ['listed@example.com'] }; harness.cookie = 'a'.repeat(43);
    harness.bind.mockResolvedValue('CLAIMED_ELSEWHERE');
    const response = await handleBoard(request());
    expect(await response.json()).toMatchObject({ ok: true, access: 'CLAIMED_ELSEWHERE', flight: { access: { kind: 'not_listed' } } });
    expect(harness.claim).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin request before any account or campaign claim changes', async () => {
    harness.person = { accountId: 'server-account', emails: ['listed@example.com'] };
    const response = await handleBoard(request({}, 'https://unrelated.example'));
    expect(response.status).toBe(403); expect(harness.claim).not.toHaveBeenCalled(); expect(harness.account).not.toHaveBeenCalled();
  });
});
