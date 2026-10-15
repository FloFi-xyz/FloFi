// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the admin API end to end against PostgreSQL, through the same handlers the routes serve. A verified wallet is not an
 * administrator until the operator CLI grants it; sessions are server-side (sign-out and revocation end access at once); every mutation
 * needs a same-origin JSON POST with the session's CSRF token; a challenge opens at most one session; refusals are audited without an
 * address.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestWallet } from '../../../../packages/reference-reconciler/test/test-wallet.ts';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { runAdminCommand } from './cli-commands.ts';
import { adminConfig } from './config.ts';
import { adminMutation, handleAdminChallenge, handleAdminSignIn, handleAdminSignOut, json, type AdminHttpOptions } from './http.ts';
import { adminCsrfToken, readAdminSession } from './session.ts';
import { authenticateAdmin } from './guard.ts';
import { createAdminStore } from './store.ts';

const ORIGIN = 'https://admin.flofi.example', DOMAIN = 'admin.flofi.example';
const env = { FLOFI_ADMIN: 'enabled', FLOFI_ADMIN_SESSION_SECRET: randomBytes(32).toString('hex') };
const key = (() => { const c = adminConfig(env); if (!c.enabled) throw new Error(c.code); return c.key; })();
let t: TestDatabase;
const clock = new Date('2026-10-14T12:00:00.000Z');
const options = (): AdminHttpOptions => ({ env, host: { db: t.db, tenantId: 'default' }, now: () => clock });

type Jar = Map<string, string>;
function remember(jar: Jar, response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';'), index = pair!.indexOf('=');
    const name = pair!.slice(0, index), value = pair!.slice(index + 1);
    if (/Max-Age=0/.test(header) || value === '') jar.delete(name); else jar.set(name, value);
    expect(header).toMatch(/; Path=\/admin; Max-Age=\d+; HttpOnly; SameSite=Strict; Secure$/);
  }
}
function post(path: string, body: unknown, jar: Jar, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { host: DOMAIN, 'x-forwarded-proto': 'https', origin: ORIGIN,
    'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers } });
}
async function signIn(wallet: ReturnType<typeof createTestWallet>, jar: Jar = new Map()) {
  const challenge = await handleAdminChallenge(post('/admin/api/session/challenge', { address: wallet.address, chainId: 8453 }, jar), options());
  remember(jar, challenge);
  const { message } = await challenge.json() as { message: string };
  const signature = wallet.signMessage(message), challengeCookie = jar.get('flofi_admin_challenge');
  const response = await handleAdminSignIn(post('/admin/api/session', { address: wallet.address, chainId: 8453, signature }, jar), options());
  remember(jar, response);
  return { jar, response, body: await response.json() as Record<string, unknown>, replay: { signature, challengeCookie } };
}
const audit = async () => (await t.db.query<{ actor: string; kind: string; outcome: string; code: string | null; target: string | null; detail: unknown }>(
  `SELECT actor, kind, outcome, code, target, detail FROM admin_audit_events ORDER BY event_id`)).rows;

beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

describe('BUILD-ADMIN-001 admin API (PostgreSQL)', () => {
  it('is absent unless enabled, and unavailable without storage', async () => {
    const jar: Jar = new Map();
    expect((await handleAdminChallenge(post('/admin/api/session/challenge', {}, jar), { ...options(), env: {} })).status).toBe(404);
    const unavailable = await handleAdminChallenge(post('/admin/api/session/challenge', {}, jar), { ...options(), host: { code: 'ADMIN_STORE_NOT_CONFIGURED' } });
    expect([unavailable.status, await unavailable.json()]).toEqual([503, { ok: false, code: 'ADMIN_STORE_NOT_CONFIGURED' }]);
  });

  it('a verified wallet without a grant is refused, audited without its address', async () => {
    const wallet = createTestWallet();
    const { response, body, jar } = await signIn(wallet);
    expect([response.status, body]).toEqual([403, { ok: false, code: 'ADMIN_NOT_GRANTED' }]);
    expect(jar.has('flofi_admin_session')).toBe(false);
    expect(jar.has('flofi_admin_challenge')).toBe(false);
    const events = await audit();
    expect(events.at(-1)).toEqual({ actor: 'anonymous', kind: 'ADMIN_SIGN_IN', outcome: 'REFUSED', code: 'ADMIN_NOT_GRANTED', target: null, detail: null });
    expect(JSON.stringify(events)).not.toContain(wallet.address.slice(2));
  });

  it('refuses sign-in requests that are cross-origin, not JSON or signed by another wallet', async () => {
    const wallet = createTestWallet(), jar: Jar = new Map();
    for (const headers of [{ origin: 'https://evil.example' }, { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await handleAdminChallenge(post('/admin/api/session/challenge', { address: wallet.address, chainId: 8453 }, jar, headers), options());
      expect(response.status).toBe(403);
    }
    const challenge = await handleAdminChallenge(post('/admin/api/session/challenge', { address: wallet.address, chainId: 8453 }, jar), options());
    remember(jar, challenge);
    const { message } = await challenge.json() as { message: string };
    const forged = await handleAdminSignIn(post('/admin/api/session', { address: wallet.address, chainId: 8453, signature: createTestWallet().signMessage(message) }, jar), options());
    expect([forged.status, await forged.json()]).toEqual([401, { ok: false, code: 'WALLET_SIGNATURE_INVALID' }]);
  });

  it('granted by the operator CLI: signs in, reads, signs out; the session ends server-side', async () => {
    const wallet = createTestWallet();
    const { principal } = await runAdminCommand('grant', { wallet: wallet.address.toUpperCase().replace('0X', '0x'), role: 'VIEWER', label: 'Ops viewer' }, t.db, 'default') as
      { principal: { principalId: string; account: string; role: string } };
    expect(principal).toMatchObject({ account: wallet.address, role: 'VIEWER' });
    await expect(runAdminCommand('grant', { wallet: wallet.address, role: 'OPERATOR' }, t.db, 'default')).rejects.toThrow('ADMIN_PRINCIPAL_EXISTS');

    const { response, body, jar, replay } = await signIn(wallet);
    expect([response.status, body]).toEqual([200, { ok: true, role: 'VIEWER', expiresAt: '2026-10-14T16:00:00.000Z' }]);
    const token = jar.get('flofi_admin_session')!;
    const reference = readAdminSession(key, token, clock, DOMAIN)!;
    expect(reference.principalId).toBe(principal.principalId);
    const store = createAdminStore(t.db, 'default');
    const context = await authenticateAdmin({ key, store, token, domain: DOMAIN, now: clock });
    expect(context).toMatchObject({ principal: { principalId: principal.principalId, role: 'VIEWER' }, csrf: adminCsrfToken(key, reference.sessionId) });

    // The same challenge and signature can never open a second session.
    const replayJar: Jar = new Map([['flofi_admin_challenge', replay.challengeCookie!]]);
    const again = await handleAdminSignIn(post('/admin/api/session', { address: wallet.address, chainId: 8453, signature: replay.signature }, replayJar), options());
    expect([again.status, await again.json()]).toEqual([401, { ok: false, code: 'ADMIN_SIGN_IN_CHALLENGE_USED' }]);

    // Mutations need the CSRF token; a viewer cannot write.
    const noCsrf = await handleAdminSignOut(post('/admin/api/session/end', {}, jar), options());
    expect([noCsrf.status, await noCsrf.json()]).toEqual([403, { ok: false, code: 'ADMIN_CSRF_INVALID' }]);
    const write = await adminMutation(post('/admin/api/settings/copilot', {}, jar, { 'x-flofi-admin-csrf': context!.csrf }), options(), 'write');
    expect(write instanceof Response && [write.status, await write.json()]).toEqual([403, { ok: false, code: 'ADMIN_ROLE_INSUFFICIENT' }]);
    const read = await adminMutation(post('/admin/api/x', {}, jar, { 'x-flofi-admin-csrf': context!.csrf }), options(), 'read');
    expect(read instanceof Response).toBe(false);

    const out = await handleAdminSignOut(post('/admin/api/session/end', {}, jar, { 'x-flofi-admin-csrf': context!.csrf }), options());
    expect(out.status).toBe(200);
    remember(jar, out);
    expect(jar.has('flofi_admin_session')).toBe(false);
    // Even a copy of the old cookie is now worthless.
    expect(await authenticateAdmin({ key, store, token, domain: DOMAIN, now: clock })).toBeNull();
    const stale = await handleAdminSignOut(post('/admin/api/session/end', {}, new Map([['flofi_admin_session', token]]), { 'x-flofi-admin-csrf': context!.csrf }), options());
    expect([stale.status, await stale.json()]).toEqual([401, { ok: false, code: 'ADMIN_SESSION_REQUIRED' }]);

    const events = await audit();
    expect(events.filter(e => e.target === principal.principalId).map(e => [e.kind, e.outcome])).toEqual([['ADMIN_PRINCIPAL_GRANTED', 'OK'], ['ADMIN_SIGN_IN', 'OK'],
      ['ADMIN_SIGN_OUT', 'OK']]);
    expect(events).toContainEqual({ actor: principal.principalId, kind: 'ADMIN_PERMISSION_DENIED', outcome: 'REFUSED', code: 'ADMIN_ROLE_INSUFFICIENT',
      target: ':admin:api:settings:copilot', detail: null });
  });

  it('revoking a grant ends its live sessions immediately; sessions also expire', async () => {
    const wallet = createTestWallet();
    const { principal } = await runAdminCommand('grant', { wallet: wallet.address, role: 'OPERATOR' }, t.db, 'default') as { principal: { principalId: string } };
    const { jar } = await signIn(wallet);
    const token = jar.get('flofi_admin_session')!, store = createAdminStore(t.db, 'default');
    expect(await authenticateAdmin({ key, store, token, domain: DOMAIN, now: clock })).not.toBeNull();
    expect(await authenticateAdmin({ key, store, token, domain: DOMAIN, now: new Date(clock.getTime() + 4 * 3600_000 + 1000) })).toBeNull();
    await runAdminCommand('revoke', { principal: principal.principalId }, t.db, 'default');
    expect(await authenticateAdmin({ key, store, token, domain: DOMAIN, now: clock })).toBeNull();
    expect((await t.db.query(`SELECT end_reason FROM admin_sessions WHERE principal_id = $1`, [principal.principalId])).rows).toEqual([{ end_reason: 'PRINCIPAL_REVOKED' }]);
    const again = await signIn(wallet);
    expect(again.body).toEqual({ ok: false, code: 'ADMIN_NOT_GRANTED' });
    // A new grant for the same wallet is a new principal; the old session stays dead.
    await runAdminCommand('grant', { wallet: wallet.address, role: 'VIEWER' }, t.db, 'default');
    expect(await authenticateAdmin({ key, store, token, domain: DOMAIN, now: clock })).toBeNull();
    expect((await signIn(wallet)).body).toMatchObject({ ok: true, role: 'VIEWER' });
  });

  it('end-sessions signs every administrator out; list and audit expose ids and codes only', async () => {
    const wallet = createTestWallet();
    await runAdminCommand('grant', { wallet: wallet.address, role: 'VIEWER' }, t.db, 'default');
    const { jar } = await signIn(wallet);
    const store = createAdminStore(t.db, 'default');
    const ended = await runAdminCommand('end-sessions', {}, t.db, 'default') as { sessionsEnded: number };
    expect(ended.sessionsEnded).toBeGreaterThanOrEqual(1);
    expect(await authenticateAdmin({ key, store, token: jar.get('flofi_admin_session'), domain: DOMAIN, now: clock })).toBeNull();
    const listed = await runAdminCommand('list', {}, t.db, 'default') as { principals: { account: string; state: string }[] };
    expect(listed.principals.some(p => p.account === wallet.address && p.state === 'ACTIVE')).toBe(true);
    const events = await runAdminCommand('audit', { limit: '5' }, t.db, 'default') as { events: { kind: string }[] };
    expect(events.events[0]!.kind).toBe('ADMIN_SESSIONS_REVOKED');
    await expect(runAdminCommand('grant', { wallet: 'nope', role: 'VIEWER' }, t.db, 'default')).rejects.toThrow('WALLET_ADDRESS_INVALID');
    await expect(runAdminCommand('grant', { wallet: wallet.address, role: 'ROOT' }, t.db, 'default')).rejects.toThrow('ADMIN_ROLE_INVALID');
    await expect(runAdminCommand('audit', { limit: '0' }, t.db, 'default')).rejects.toThrow('LIMIT_INVALID');
  });

  it('json() responses are never cached or indexed', async () => {
    const response = json(200, { ok: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});
