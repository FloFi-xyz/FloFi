// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the admin boundary's pure parts — configuration, the admin-only sign-in proof, the sealed session reference, CSRF
 * tokens and the mutation request checks. A product wallet sign-in can never be replayed as an admin sign-in, nor the reverse.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestWallet } from '../../../../packages/reference-reconciler/test/test-wallet.ts';
import { challengeMessage, issueWalletChallenge, readWalletSession, verifyWalletSignIn } from '../server/wallet-session.ts';
import { adminConfig } from './config.ts';
import { authenticateAdmin, cookieValue, csrfRefusal, mutationRefusal, type AdminContext } from './guard.ts';
import { ADMIN_SIGN_IN_STATEMENT, adminChallengeMessage, adminCsrfToken, adminCsrfValid, issueAdminChallenge, readAdminSession, sealAdminSession,
  verifyAdminSignature } from './session.ts';
import type { AdminSessionRow } from './store.ts';

const secret = randomBytes(32).toString('hex');
const env = { FLOFI_ADMIN: 'enabled', FLOFI_ADMIN_SESSION_SECRET: secret };
const key = (() => { const c = adminConfig(env); if (!c.enabled) throw new Error(c.code); return c.key; })();
const origin = { domain: 'flofi.example', uri: 'https://flofi.example' };
const t0 = new Date('2026-10-14T12:00:00.000Z'), later = (s: number) => new Date(t0.getTime() + s * 1000);
const PRINCIPAL = 'adm_' + 'a'.repeat(26), SESSION = 'ab'.repeat(16);
/** Changes one MAC character that carries full bits (never the final, partially used base64url character). */
const flip = (token: string) => { const i = token.length - 5; return token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1); };

function adminProof(wallet = createTestWallet(), signer = wallet, k = key) {
  const { token } = issueAdminChallenge(k, { ...origin, now: t0 });
  const message = adminChallengeMessage(k, { challengeToken: token, ...origin, address: wallet.address, chainId: 8453, now: t0 });
  return { wallet, token, message, signature: signer.signMessage(message) };
}

describe('BUILD-ADMIN-001 admin configuration', () => {
  it('is off unless explicitly enabled with a dedicated secret', () => {
    expect(adminConfig({})).toEqual({ enabled: false, code: 'ADMIN_NOT_ENABLED' });
    expect(adminConfig({ FLOFI_ADMIN_SESSION_SECRET: secret })).toEqual({ enabled: false, code: 'ADMIN_NOT_ENABLED' });
    expect(adminConfig({ FLOFI_ADMIN: 'true', FLOFI_ADMIN_SESSION_SECRET: secret })).toEqual({ enabled: false, code: 'ADMIN_NOT_ENABLED' });
    expect(adminConfig({ FLOFI_ADMIN: 'enabled' })).toEqual({ enabled: false, code: 'ADMIN_SESSION_SECRET_INVALID' });
    expect(adminConfig({ FLOFI_ADMIN: 'enabled', FLOFI_ADMIN_SESSION_SECRET: 'short' })).toEqual({ enabled: false, code: 'ADMIN_SESSION_SECRET_INVALID' });
    expect(adminConfig({ FLOFI_ADMIN: 'enabled', FLOFI_ADMIN_SESSION_SECRET: `${secret} x` })).toEqual({ enabled: false, code: 'ADMIN_SESSION_SECRET_INVALID' });
  });
  it('refuses a secret shared with any other FloFi boundary', () => {
    for (const name of ['FLOFI_SESSION_SECRET', 'API_AUTH_TOKEN', 'FLOFI_CHANNEL_SECRET', 'FLOFI_AUTOMATION_SECRET', 'FLOFI_DEVELOPER_SECRET', 'FLOFI_MCP_OAUTH_SECRET', 'OPENAI_API_KEY'])
      expect(adminConfig({ ...env, [name]: secret })).toEqual({ enabled: false, code: 'ADMIN_SESSION_SECRET_REUSED' });
    const config = adminConfig({ ...env, FLOFI_SESSION_SECRET: randomBytes(32).toString('hex') });
    expect(config.enabled && config.key.length).toBe(32);
  });
});

describe('BUILD-ADMIN-001 admin sign-in proof', () => {
  it('a wallet signs the admin-only statement; the server recovers exactly that address', () => {
    const { wallet, token, message, signature } = adminProof();
    expect(message).toContain(ADMIN_SIGN_IN_STATEMENT);
    expect(message).toMatch(/\nURI: https:\/\/flofi\.example\/admin\nVersion: 1\nChain ID: 8453\nNonce: [0-9a-f]{32}\n/);
    const verified = verifyAdminSignature(key, { challengeToken: token, ...origin, address: wallet.address, chainId: 8453, signature, now: later(30) });
    expect(verified.account).toBe(wallet.address);
    expect(verified.sessionId).toMatch(/^[a-f0-9]{32}$/);
    // The same challenge always maps to the same session id: a replay cannot open a second session (the row already exists).
    expect(verifyAdminSignature(key, { challengeToken: token, ...origin, address: wallet.address, chainId: 8453, signature, now: later(31) }).sessionId).toBe(verified.sessionId);
    expect(adminProof(wallet).token).not.toBe(token);
  });
  it('refuses another signer, an expired or foreign challenge, another origin and another key', () => {
    const { wallet, token, signature } = adminProof(createTestWallet(), createTestWallet());
    const attempt = (over: Partial<Parameters<typeof verifyAdminSignature>[1]>, k = key) =>
      () => verifyAdminSignature(k, { challengeToken: token, ...origin, address: wallet.address, chainId: 8453, signature, now: later(30), ...over });
    expect(attempt({})).toThrow('WALLET_SIGNATURE_INVALID');
    const good = adminProof();
    const valid = { challengeToken: good.token, address: good.wallet.address, signature: good.signature };
    expect(attempt({ ...valid, now: later(301) })).toThrow('ADMIN_SIGN_IN_CHALLENGE_INVALID');
    expect(attempt({ ...valid, domain: 'evil.example' })).toThrow('ADMIN_SIGN_IN_ORIGIN_MISMATCH');
    expect(attempt({ ...valid, chainId: 1 })).toThrow('WALLET_SIGNATURE_INVALID');
    expect(attempt({ ...valid, challengeToken: flip(good.token) })).toThrow('ADMIN_SIGN_IN_CHALLENGE_INVALID');
    expect(attempt(valid, Buffer.alloc(32, 7))).toThrow('ADMIN_SIGN_IN_CHALLENGE_INVALID');
    expect(attempt({ ...valid, address: 'not-an-address' })).toThrow('WALLET_ADDRESS_INVALID');
  });
  it('a product wallet sign-in is never an admin sign-in, and the reverse', () => {
    const wallet = createTestWallet(), productEnv = { FLOFI_SESSION_SECRET: secret };
    // Same secret material on purpose: the admin key is HKDF-separated, so neither boundary accepts the other's challenge.
    const product = issueWalletChallenge(productEnv, { ...origin, now: t0 });
    const productMessage = challengeMessage(productEnv, { challengeToken: product.token, ...origin, address: wallet.address, chainId: 8453, now: t0 });
    expect(() => verifyAdminSignature(key, { challengeToken: product.token, ...origin, address: wallet.address, chainId: 8453,
      signature: wallet.signMessage(productMessage), now: later(30) })).toThrow('ADMIN_SIGN_IN_CHALLENGE_INVALID');
    const admin = adminProof(wallet);
    expect(() => verifyWalletSignIn(productEnv, { challengeToken: admin.token, ...origin, address: wallet.address, chainId: 8453, signature: admin.signature,
      now: later(30) })).toThrow('WALLET_SIGN_IN_CHALLENGE_INVALID');
    const productSession = verifyWalletSignIn(productEnv, { challengeToken: product.token, ...origin, address: wallet.address, chainId: 8453,
      signature: wallet.signMessage(productMessage), now: later(30) });
    expect(readAdminSession(key, productSession.token, later(60), origin.domain)).toBeNull();
    const adminToken = sealAdminSession(key, { sessionId: SESSION, principalId: PRINCIPAL, domain: origin.domain, issuedAt: t0, expiresAt: later(3600) });
    expect(readWalletSession(productEnv, adminToken, later(60), origin.domain)).toBeNull();
  });
});

describe('BUILD-ADMIN-001 sealed admin session reference and CSRF token', () => {
  const token = sealAdminSession(key, { sessionId: SESSION, principalId: PRINCIPAL, domain: origin.domain, issuedAt: t0, expiresAt: later(3600) });
  it('reads back only on this host, with this key, before expiry and untampered', () => {
    expect(readAdminSession(key, token, later(60), origin.domain)).toEqual({ sessionId: SESSION, principalId: PRINCIPAL, issuedAt: t0, expiresAt: later(3600) });
    expect(readAdminSession(key, token, later(3600), origin.domain)).toBeNull();
    expect(readAdminSession(key, token, later(60), 'other.example')).toBeNull();
    expect(readAdminSession(Buffer.alloc(32, 1), token, later(60), origin.domain)).toBeNull();
    const [kind, body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), p: 'adm_' + 'b'.repeat(26) })).toString('base64url');
    expect(readAdminSession(key, `${kind}.${forged}.${mac}`, later(60), origin.domain)).toBeNull();
    expect(readAdminSession(key, undefined, later(60), origin.domain)).toBeNull();
    expect(readAdminSession(key, 'x'.repeat(3000), later(60), origin.domain)).toBeNull();
    expect(() => sealAdminSession(key, { sessionId: 'nope', principalId: PRINCIPAL, domain: origin.domain, issuedAt: t0, expiresAt: later(1) })).toThrow('ADMIN_SESSION_INVALID');
  });
  it('binds the CSRF token to the session', () => {
    const csrf = adminCsrfToken(key, SESSION);
    expect(adminCsrfValid(key, SESSION, csrf)).toBe(true);
    expect(adminCsrfValid(key, 'cd'.repeat(16), csrf)).toBe(false);
    expect(adminCsrfValid(Buffer.alloc(32, 3), SESSION, csrf)).toBe(false);
    expect(adminCsrfValid(key, SESSION, null)).toBe(false);
    expect(adminCsrfValid(key, SESSION, csrf.slice(1))).toBe(false);
  });
});

describe('BUILD-ADMIN-001 request guard', () => {
  const request = (init: { method?: string; headers?: Record<string, string> }) => new Request('https://flofi.example/admin/api/x',
    { method: init.method ?? 'POST', headers: init.headers ?? {}, ...(init.method ?? 'POST') === 'POST' ? { body: '{}' } : {} });
  const good = { 'content-type': 'application/json', origin: 'https://flofi.example', 'sec-fetch-site': 'same-origin' };
  const o = { ...origin, secure: true };
  it('accepts only same-origin JSON POSTs', () => {
    expect(mutationRefusal(request({ headers: good }), o)).toBeNull();
    expect(mutationRefusal(request({ headers: { 'content-type': 'application/json; charset=utf-8', origin: 'https://flofi.example' } }), o)).toBeNull();
    expect(mutationRefusal(request({ method: 'GET', headers: good }), o)).toBe('METHOD_NOT_ALLOWED');
    expect(mutationRefusal(request({ headers: { ...good, 'content-type': 'text/plain' } }), o)).toBe('ADMIN_CONTENT_TYPE_INVALID');
    expect(mutationRefusal(request({ headers: { ...good, 'content-type': 'application/x-www-form-urlencoded' } }), o)).toBe('ADMIN_CONTENT_TYPE_INVALID');
    expect(mutationRefusal(request({ headers: { 'content-type': 'application/json' } }), o)).toBe('ADMIN_ORIGIN_INVALID');
    expect(mutationRefusal(request({ headers: { ...good, origin: 'https://evil.example' } }), o)).toBe('ADMIN_ORIGIN_INVALID');
    expect(mutationRefusal(request({ headers: { ...good, origin: 'http://flofi.example' } }), o)).toBe('ADMIN_ORIGIN_INVALID');
    expect(mutationRefusal(request({ headers: { ...good, 'sec-fetch-site': 'cross-site' } }), o)).toBe('ADMIN_ORIGIN_INVALID');
    expect(mutationRefusal(request({ headers: { ...good, 'sec-fetch-site': 'same-site' } }), o)).toBe('ADMIN_ORIGIN_INVALID');
  });
  it('requires the CSRF header of this session', () => {
    const context = { sessionId: SESSION } as AdminContext;
    expect(csrfRefusal(request({ headers: { ...good, 'x-flofi-admin-csrf': adminCsrfToken(key, SESSION) } }), key, context)).toBeNull();
    expect(csrfRefusal(request({ headers: good }), key, context)).toBe('ADMIN_CSRF_INVALID');
    expect(csrfRefusal(request({ headers: { ...good, 'x-flofi-admin-csrf': adminCsrfToken(key, 'cd'.repeat(16)) } }), key, context)).toBe('ADMIN_CSRF_INVALID');
  });
  it('authenticates only a live server-side session of the sealed principal; storage failures refuse', async () => {
    const token = sealAdminSession(key, { sessionId: SESSION, principalId: PRINCIPAL, domain: origin.domain, issuedAt: t0, expiresAt: later(3600) });
    const row = (principalId = PRINCIPAL): AdminSessionRow => ({ sessionId: SESSION, expiresAt: later(3600), principal: { principalId, account: '0x' + '1'.repeat(40),
      role: 'VIEWER', state: 'ACTIVE', label: null, createdAt: t0.toISOString(), revokedAt: null } });
    const auth = (readSession: () => Promise<AdminSessionRow | null>, t = token) => authenticateAdmin({ key, store: { readSession }, token: t, domain: origin.domain, now: later(60) });
    expect(await auth(async () => row())).toMatchObject({ sessionId: SESSION, csrf: adminCsrfToken(key, SESSION), principal: { principalId: PRINCIPAL, role: 'VIEWER' } });
    expect(await auth(async () => null)).toBeNull();
    expect(await auth(async () => { throw new Error('connection refused'); })).toBeNull();
    expect(await auth(async () => row('adm_' + 'c'.repeat(26)))).toBeNull();
    let called = false;
    expect(await auth(async () => { called = true; return row(); }, token + 'x')).toBeNull();
    expect(called).toBe(false);
  });
  it('parses one cookie out of a Cookie header', () => {
    expect(cookieValue('a=1; flofi_admin_session=as1.x.y; b=2', 'flofi_admin_session')).toBe('as1.x.y');
    expect(cookieValue('flofi_admin_session_x=1', 'flofi_admin_session')).toBeUndefined();
    expect(cookieValue(null, 'flofi_admin_session')).toBeUndefined();
  });
});
