// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (KAN-25 §8.1): the web Chat's initiation reference. A genuine reference of the request's own FloFi
 * account is Web Chat; a missing, forged, altered, expired, future, over-long or another account's reference, or no account session, is the Editor.
 * The reference carries no account id, tenant, wallet address or email in clear.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('../accounts/account-host.ts', () => ({ accountHost: vi.fn(), currentAccountSession: vi.fn() }));
vi.mock('./platform-state-host.ts', () => ({ platformStateHost: vi.fn() }));
const { cookies } = await import('next/headers');
const { accountHost, currentAccountSession } = await import('../accounts/account-host.ts');
const { platformStateHost } = await import('./platform-state-host.ts');
const { CHAT_INITIATION_SECONDS, chatInitiationKey, issueChatInitiation, requestWebSurface, verifiedWebSurface, verifyChatInitiation } = await import('./chat-initiation.ts');
const { CHAT_INITIATION_COOKIE, CHAT_INITIATION_FORMAT, chatInitiationCookie, clearedChatInitiationCookie } = await import('../domain/chat-initiation.ts');

const ENV = { FLOFI_SESSION_SECRET: 's'.repeat(48) }, OTHER_ENV = { FLOFI_SESSION_SECRET: 'o'.repeat(48) };
const ACCOUNT = 'acct_' + 'a'.repeat(32), OTHER = 'acct_' + 'b'.repeat(32), TENANT = 'default';
const NOW = new Date('2026-11-28T12:00:00Z'), key = chatInitiationKey(ENV);
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
/** A reference with a VALID signature over an arbitrary payload (what only a holder of the key could make). */
const signed = (payload: unknown, k: Uint8Array = key) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `ci1.${body}.${createHmac('sha256', k).update(`ci1.${body}`).digest('base64url')}`;
};
const binding = (accountId: string, tenantId = TENANT) =>
  createHmac('sha256', key).update(`flofi.chat-initiation.account.v1\0${tenantId}\0${accountId}`).digest('base64url').slice(0, 32);

describe('chat initiation reference', () => {
  it('verifies for the account and tenant it was issued to, within its lifetime only', () => {
    const { reference, expiresAt } = issueChatInitiation(key, TENANT, ACCOUNT, NOW);
    expect(reference).toMatch(CHAT_INITIATION_FORMAT);
    expect(expiresAt).toBe(NOW.getTime() + CHAT_INITIATION_SECONDS * 1000);
    expect(verifyChatInitiation(key, reference, TENANT, ACCOUNT, NOW)).toBe(true);
    expect(verifyChatInitiation(key, reference, TENANT, ACCOUNT, later(CHAT_INITIATION_SECONDS - 1))).toBe(true);
    // Expired, another account, another tenant, another deployment key.
    expect(verifyChatInitiation(key, reference, TENANT, ACCOUNT, later(CHAT_INITIATION_SECONDS))).toBe(false);
    expect(verifyChatInitiation(key, reference, TENANT, OTHER, NOW)).toBe(false);
    expect(verifyChatInitiation(key, reference, 'tenant-b', ACCOUNT, NOW)).toBe(false);
    expect(verifyChatInitiation(chatInitiationKey(OTHER_ENV), reference, TENANT, ACCOUNT, NOW)).toBe(false);
    // Two references are never the same (random nonce).
    expect(issueChatInitiation(key, TENANT, ACCOUNT, NOW).reference).not.toBe(reference);
  });

  it('refuses any forged, altered or malformed reference (fail closed, never throws)', () => {
    const { reference } = issueChatInitiation(key, TENANT, ACCOUNT, NOW);
    const [prefix, body, mac] = reference.split('.') as [string, string, string];
    const flip = (s: string, at: number) => s.slice(0, at) + (s[at] === 'A' ? 'B' : 'A') + s.slice(at + 1);
    for (const forged of [`${prefix}.${flip(body, 5)}.${mac}`, `${prefix}.${body}.${flip(mac, 3)}`, `ci2.${body}.${mac}`, `${prefix}.${body}`, '', 'web_chat', 'chat',
      `${reference}.x`, randomBytes(64).toString('base64url'), signed({ a: binding(ACCOUNT), i: 1, e: 2, n: 'x' }, randomBytes(32))])
      expect(verifyChatInitiation(key, forged, TENANT, ACCOUNT, NOW), forged).toBe(false);
    for (const value of [null, undefined, 42, {}, ['ci1']]) expect(verifyChatInitiation(key, value, TENANT, ACCOUNT, NOW)).toBe(false);
    const at = Math.floor(NOW.getTime() / 1000);
    // Correctly signed but outside the policy: issued in the future, a lifetime longer than the policy, an extra or missing field, a non-integer.
    expect(verifyChatInitiation(key, signed({ a: binding(ACCOUNT), i: at + 120, e: at + 600, n: 'n' }), TENANT, ACCOUNT, NOW)).toBe(false);
    expect(verifyChatInitiation(key, signed({ a: binding(ACCOUNT), i: at, e: at + CHAT_INITIATION_SECONDS + 1, n: 'n' }), TENANT, ACCOUNT, NOW)).toBe(false);
    expect(verifyChatInitiation(key, signed({ a: binding(ACCOUNT), i: at, e: at + 60, n: 'n', o: 'web_chat' }), TENANT, ACCOUNT, NOW)).toBe(false);
    expect(verifyChatInitiation(key, signed({ a: binding(ACCOUNT), i: at, e: at + 60 }), TENANT, ACCOUNT, NOW)).toBe(false);
    expect(verifyChatInitiation(key, signed({ a: binding(ACCOUNT), i: at + 0.5, e: at + 60, n: 'n' }), TENANT, ACCOUNT, NOW)).toBe(false);
    // The same, within the policy, is genuine (the checks above are the policy, not the signature).
    expect(verifyChatInitiation(key, signed({ a: binding(ACCOUNT), i: at, e: at + 60, n: 'n' }), TENANT, ACCOUNT, NOW)).toBe(true);
    expect(() => issueChatInitiation(key, TENANT, ACCOUNT, NOW, CHAT_INITIATION_SECONDS + 1)).toThrow('CHAT_INITIATION_INVALID');
  });

  it('carries no identifier in clear', () => {
    const { reference } = issueChatInitiation(key, TENANT, ACCOUNT, NOW);
    const decoded = Buffer.from(reference.split('.')[1]!, 'base64url').toString('utf8');
    expect(Object.keys(JSON.parse(decoded)).sort()).toEqual(['a', 'e', 'i', 'n']);
    for (const text of [reference, decoded]) for (const secret of [ACCOUNT, ACCOUNT.slice(5), TENANT, ENV.FLOFI_SESSION_SECRET]) expect(text).not.toContain(secret);
    expect(decoded).toMatch(/^{"a":"[A-Za-z0-9_-]{32}","i":\d+,"e":\d+,"n":"[A-Za-z0-9_-]{22}"}$/);
  });

  it('is presented only on the app page, host-only and Strict, and only in its own format', () => {
    const { reference } = issueChatInitiation(key, TENANT, ACCOUNT, NOW);
    expect(chatInitiationCookie(reference, 120, true)).toBe(`${CHAT_INITIATION_COOKIE}=${reference}; Path=/app; Max-Age=120; SameSite=Strict; Secure`);
    expect(chatInitiationCookie(reference, 5_000, false)).toBe(`${CHAT_INITIATION_COOKIE}=${reference}; Path=/app; Max-Age=900; SameSite=Strict`);
    expect(chatInitiationCookie('x; Path=/; Domain=evil.example', 60, true)).toBeNull();
    expect(clearedChatInitiationCookie(true)).toBe(`${CHAT_INITIATION_COOKIE}=; Path=/app; Max-Age=0; SameSite=Strict; Secure`);
  });
});

describe('the web surface of a request', () => {
  const session = (accountId: string | null) => vi.mocked(currentAccountSession).mockResolvedValue(accountId ? { accountId } as never : null);
  beforeEach(() => {
    vi.mocked(accountHost).mockResolvedValue({} as never);
    vi.mocked(platformStateHost).mockResolvedValue({ db: {} as never, tenantId: TENANT });
    session(ACCOUNT);
  });

  it('is Web Chat only for a genuine, current reference of the account signed in on this request', async () => {
    const valid = issueChatInitiation(key, TENANT, ACCOUNT).reference;
    expect(await verifiedWebSurface(valid, ENV)).toBe('WEB_CHAT');
    // Missing reference: the Editor (and no account session is even read).
    vi.mocked(currentAccountSession).mockClear();
    expect(await verifiedWebSurface(undefined, ENV)).toBe('WEB_EDITOR');
    expect(await verifiedWebSurface('', ENV)).toBe('WEB_EDITOR');
    expect(currentAccountSession).not.toHaveBeenCalled();
    // Forged, expired, another account's, another deployment's.
    expect(await verifiedWebSurface(valid.slice(0, -2) + (valid.endsWith('AA') ? 'BB' : 'AA'), ENV)).toBe('WEB_EDITOR');
    expect(await verifiedWebSurface(issueChatInitiation(key, TENANT, ACCOUNT, new Date(Date.now() - (CHAT_INITIATION_SECONDS + 5) * 1000)).reference, ENV)).toBe('WEB_EDITOR');
    expect(await verifiedWebSurface(issueChatInitiation(key, TENANT, OTHER).reference, ENV)).toBe('WEB_EDITOR');
    expect(await verifiedWebSurface(issueChatInitiation(chatInitiationKey(OTHER_ENV), TENANT, ACCOUNT).reference, ENV)).toBe('WEB_EDITOR');
    // A genuine reference without an account session on this request, or a failing session read, is the Editor.
    session(null);
    expect(await verifiedWebSurface(valid, ENV)).toBe('WEB_EDITOR');
    vi.mocked(currentAccountSession).mockRejectedValue(new Error('DOWN'));
    expect(await verifiedWebSurface(valid, ENV)).toBe('WEB_EDITOR');
    // No session secret on a hosted deployment: no key, the Editor.
    session(ACCOUNT);
    expect(await verifiedWebSurface(valid, { VERCEL: '1', VERCEL_ENV: 'production' })).toBe('WEB_EDITOR');
  });

  it('reads the reference from the request cookie (and outside a request it is the Editor)', async () => {
    const valid = issueChatInitiation(key, TENANT, ACCOUNT).reference;
    vi.mocked(cookies).mockResolvedValue({ get: (name: string) => name === CHAT_INITIATION_COOKIE ? { name, value: valid } : undefined } as never);
    expect(await requestWebSurface(ENV)).toBe('WEB_CHAT');
    vi.mocked(cookies).mockResolvedValue({ get: () => undefined } as never);
    expect(await requestWebSurface(ENV)).toBe('WEB_EDITOR');
    vi.mocked(cookies).mockRejectedValue(new Error('outside a request'));
    expect(await requestWebSurface(ENV)).toBe('WEB_EDITOR');
  });
});
