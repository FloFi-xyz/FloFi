// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { freshlyAuthenticated, newOidcFlow, readAccountSession, readEmailFlow, readOidcFlow, safeReturnPath, sealAccountSession, sealEmailFlow,
  sealOidcFlow, type AccountSessionToken } from './account-session';

const env = { FLOFI_SESSION_SECRET: 'k'.repeat(40) }, other = { FLOFI_SESSION_SECRET: 'z'.repeat(40) };
const now = new Date('2026-10-31T12:00:00.000Z'), at = Math.floor(now.getTime() / 1000);
const session: AccountSessionToken = { accountId: 'acct_' + 'a'.repeat(32), sessionId: 'b'.repeat(32), method: 'google', authenticatedAt: at, expiresAt: at + 3600 };
const key = '02' + 'c'.repeat(64);

describe('sealed account session cookie', () => {
  it('round-trips only for the same key, host and lifetime', () => {
    const token = sealAccountSession(env, session, 'flofi.xyz', now);
    expect(readAccountSession(env, token, now, 'flofi.xyz')).toEqual({ ...session, managedKey: null, managedUntil: null });
    expect(readAccountSession(other, token, now, 'flofi.xyz')).toBeNull();
    expect(readAccountSession(env, token, now, 'preview.flofi.xyz')).toBeNull();
    expect(readAccountSession(env, token, new Date((at + 3601) * 1000), 'flofi.xyz')).toBeNull();
    const [kind, body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), a: 'acct_' + 'f'.repeat(32) })).toString('base64url');
    expect(readAccountSession(env, `${kind}.${forged}.${mac}`, now, 'flofi.xyz')).toBeNull();
    expect(readAccountSession(env, undefined, now, 'flofi.xyz')).toBeNull();
  });
  it('carries the provider-session hint only while it is valid, and never other claims', () => {
    const token = sealAccountSession(env, { ...session, managedKey: key, managedUntil: at + 600 }, 'flofi.xyz', now);
    expect(readAccountSession(env, token, now, 'flofi.xyz')).toMatchObject({ managedKey: key, managedUntil: at + 600 });
    expect(readAccountSession(env, token, new Date((at + 601) * 1000), 'flofi.xyz')).toMatchObject({ managedKey: null, managedUntil: null });
    expect(Buffer.from(token.split('.')[1]!, 'base64url').toString()).not.toMatch(/token|secret|private|seed|mnemonic/i);
  });
  it('refuses to seal malformed sessions and requires a recent sign-in for sensitive actions', () => {
    expect(() => sealAccountSession(env, { ...session, accountId: 'acct_x' }, 'flofi.xyz', now)).toThrow('ACCOUNT_SESSION_INVALID');
    expect(freshlyAuthenticated(session, new Date((at + 600) * 1000))).toBe(true);
    expect(freshlyAuthenticated(session, new Date((at + 601) * 1000))).toBe(false);
  });
});

describe('sign-in flow cookies', () => {
  it('binds the OIDC nonce to the browser session key, or to a random value', () => {
    const bound = newOidcFlow('google', key, 'sign-in', '/app');
    expect(bound.nonce).toBe(createHash('sha256').update(key).digest('hex'));
    const plain = newOidcFlow('apple', null, 'sign-in', '/app');
    expect(plain.nonce).not.toBe(newOidcFlow('apple', null, 'sign-in', '/app').nonce);
    expect(() => newOidcFlow('google', 'not-a-key', 'sign-in', '/app')).toThrow('ACCOUNT_SESSION_KEY_INVALID');
    const token = sealOidcFlow(env, bound, 'flofi.xyz', now);
    expect(readOidcFlow(env, token, now, 'flofi.xyz')).toEqual(bound);
    expect(readOidcFlow(env, token, new Date(now.getTime() + 601_000), 'flofi.xyz')).toBeNull();
    // A flow cookie is never read as an account session, or the reverse.
    expect(readAccountSession(env, token, now, 'flofi.xyz')).toBeNull();
    expect(readOidcFlow(env, sealAccountSession(env, session, 'flofi.xyz', now), now, 'flofi.xyz')).toBeNull();
  });
  it('keeps no OTP code in the email challenge', () => {
    const token = sealEmailFlow(env, { otpId: 'otp-12345678', email: 'ana@example.com', sessionKey: key, intent: 'sign-in', returnTo: '/app' }, 'flofi.xyz', now);
    expect(readEmailFlow(env, token, now, 'flofi.xyz')).toEqual({ otpId: 'otp-12345678', email: 'ana@example.com', sessionKey: key, intent: 'sign-in', returnTo: '/app' });
    expect(Object.keys(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).sort()).toEqual(['d', 'e', 'k', 'm', 'o', 'r', 'u']);
  });
  it('only returns to FloFi app paths (no open redirect)', () => {
    expect(['/app', '/app/credentials', '/onboarding/wallets', '/app?x=1'].map(safeReturnPath)).toEqual(['/app', '/app/credentials', '/onboarding/wallets', '/app?x=1']);
    expect(['https://evil.example', '//evil.example', '/\\evil', '/docs', '/application', 'javascript:alert(1)', null].map(safeReturnPath)).toEqual(Array(7).fill('/app'));
  });
});
