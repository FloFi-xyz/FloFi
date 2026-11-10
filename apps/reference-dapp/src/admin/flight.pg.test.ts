// SPDX-License-Identifier: AGPL-3.0-only
/** Read-only Flight Admin against disposable loopback PostgreSQL. No production data or provider calls. */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createTestWallet } from '../../../../packages/reference-reconciler/test/test-wallet.ts';
import { adminConfig } from './config';
import { handleAdminChallenge, handleAdminSignIn, type AdminHttpOptions } from './http';
import { handleFlightEntries, handleFlightSummary } from './flight-http';
import { createFlightAdminStore, flightAdminFilters, type FlightAdminEntries, type FlightAdminSummary } from './flight';
import { adminCsrfToken, readAdminSession } from './session';
import { createAdminStore } from './store';
import { FLIGHT_DEFAULT_CALENDAR } from '../flight/campaign';

const ORIGIN = 'https://flofi.example', DOMAIN = 'flofi.example';
const env = { FLOFI_ADMIN: 'enabled', FLOFI_ADMIN_SESSION_SECRET: randomBytes(32).toString('hex') };
const config = adminConfig(env);
if (!config.enabled) throw new Error(config.code);
const key = config.key, clock = new Date(FLIGHT_DEFAULT_CALENDAR.boardingOpensAt + 30 * 60_000);
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
let t: TestDatabase;
type Auth = { cookie: string; csrf: string; principalId: string };
let operator: Auth, viewer: Auth;
const options = (tenantId = 'default'): AdminHttpOptions => ({ env, host: { db: t.db, tenantId }, now: () => clock });
function request(method: 'GET' | 'POST', path: string, body: unknown = {}, auth?: Auth, extra: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/admin/api/flight${path}`, { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    headers: { host: DOMAIN, 'x-forwarded-proto': 'https', origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
      ...(auth ? { cookie: auth.cookie, 'x-flofi-admin-csrf': auth.csrf } : {}), ...extra } });
}
async function signIn(role: 'OPERATOR' | 'VIEWER', tenant = 'default'): Promise<Auth> {
  const wallet = createTestWallet(), store = createAdminStore(t.db, tenant);
  const principal = await store.grant({ account: wallet.address, role, label: null });
  const shape = { host: DOMAIN, 'x-forwarded-proto': 'https', origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  const challenge = await handleAdminChallenge(new Request(`${ORIGIN}/admin/api/session/challenge`, { method: 'POST', headers: shape,
    body: JSON.stringify({ address: wallet.address, chainId: 8453 }) }), options(tenant));
  const { message } = await challenge.json() as { message: string };
  const cookie = challenge.headers.getSetCookie().map(h => h.split(';')[0]).join('; ');
  const response = await handleAdminSignIn(new Request(`${ORIGIN}/admin/api/session`, { method: 'POST', headers: { ...shape, cookie },
    body: JSON.stringify({ address: wallet.address, chainId: 8453, signature: wallet.signMessage(message) }) }), options(tenant));
  expect(response.status).toBe(200);
  const session = response.headers.getSetCookie().find(h => h.startsWith('flofi_admin_session='))!.split(';')[0]!;
  const reference = readAdminSession(key, session.slice(session.indexOf('=') + 1), clock, DOMAIN)!;
  return { cookie: session, csrf: adminCsrfToken(key, reference.sessionId), principalId: principal.principalId };
}
const list = async (filters: unknown = {}, auth = operator, opts = options()) => {
  const response = await handleFlightEntries(request('POST', '/entries', filters, auth), opts);
  return { response, body: await response.json() as { ok: boolean; entries: FlightAdminEntries; code?: string } };
};

beforeAll(async () => {
  t = await createTestDatabase();
  operator = await signIn('OPERATOR'); viewer = await signIn('VIEWER');
  await t.db.query('INSERT INTO tenants (tenant_id) VALUES ($1)', ['other-flight']);
  const accounts = [id('acct'), id('acct'), id('acct')];
  for (const account of accounts) await t.db.query('INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ($1,$2)', ['default', account]);
  for (const group of [1, 2]) await t.db.query('INSERT INTO flight_batches (tenant_id,batch_no,opens_at) VALUES ($1,$2,$3)',
    ['default', group, new Date(clock.getTime() + (group === 1 ? 60 : -60) * 60_000)]);
  const entries = [
    { email: 'alpha@example.test', flight: 'FIRST', language: 'PT', group: 1, hours: 72, boarded: false },
    { email: 'beta@example.test', flight: 'FIRST', language: 'EN', group: null, hours: 1, boarded: false },
    { email: 'gamma@example.test', flight: 'FIRST', language: 'PT', group: 2, hours: 2, boarded: true },
    { email: 'delta@example.test', flight: 'NEXT', language: 'EN', group: null, hours: 48, boarded: true },
    { email: '%_@example.test', flight: 'FIRST', language: 'EN', group: null, hours: 72, boarded: false },
    { email: '=cmd@example.test', flight: 'NEXT', language: 'PT', group: null, hours: 48, boarded: false },
  ];
  const entryIds: string[] = [];
  for (const e of entries) {
    const entryId = id('fle'); entryIds.push(entryId);
    await t.db.query(`INSERT INTO flight_list_entries (tenant_id,entry_id,email,flight,language,notice,batch_no,joined_at,boarded_at)
      VALUES ($1,$2,$3,$4,$5,'2026-11-09',$6,$7,$8)`, ['default', entryId, e.email, e.flight, e.language, e.group,
      new Date(clock.getTime() - e.hours * 60 * 60_000), e.boarded ? clock : null]);
  }
  await t.db.query(`INSERT INTO flight_list_entries (tenant_id,entry_id,email,flight,language,notice,joined_at)
    VALUES ('other-flight',$1,'secret@other.test','FIRST','EN','2026-11-09',$2)`, [id('fle'), clock]);
  for (const [index, account] of [[1, accounts[0]], [2, accounts[1]]] as const) await t.db.query(
    'INSERT INTO flight_access_claims (tenant_id,entry_id,account_id) VALUES ($1,$2,$3)', ['default', entryIds[index], account]);
  const founding = id('flp'), passenger = id('flp');
  for (const [passId, account, boarding, seat] of [[founding, accounts[1], 1, 1], [passenger, accounts[2], 2, null]] as const) await t.db.query(
    `INSERT INTO flight_passes (tenant_id,pass_id,account_id,origin,boarding_no,founding_seat,route,run_id,departed_at)
      VALUES ('default',$1,$2,'LIST',$3,$4,'{}'::jsonb,'test-run',$5)`, [passId, account, boarding, seat, clock]);
  await t.db.query(`INSERT INTO flight_issuance (tenant_id,boarded,founding) VALUES ('default',2,1)`);
  await t.db.query(`INSERT INTO flight_invites (tenant_id,code,issuer,issuer_pass_id,redeemed_by,redeemed_at)
    VALUES ('default','FLF-2345-6789','FOUNDING',$1,$2,$3)`, [founding, accounts[0], clock]);
  await t.db.query(`INSERT INTO flight_invites (tenant_id,code,issuer,recipient) VALUES ('default','FLF-ABCD-EFGH','CREATOR','alpha@example.test')`);
  for (const [index, template, state, pass] of [[0, 'EVE', 'HELD', null], [1, 'GROUP_BOARDING', 'SENT', null], [2, 'CARD_FOUNDING', 'PENDING', founding],
    [3, 'CARD_PASSENGER', 'UNKNOWN', passenger], [4, 'LIST_CONFIRMATION', 'FAILED', null], [5, 'NEXT_FLIGHT', 'CANCELLED', null]] as const) {
    await t.db.query(`INSERT INTO flight_emails (tenant_id,email_id,dedupe_key,template,template_version,category,recipient,language,trigger,entry_id,pass_id,
      state,not_before,next_attempt_at,reserved_at,sent_at,created_at) VALUES ('default',$1,$2,$3,1,'CAMPAIGN',$4,$5,'test',$6,$7,$8,$9,$9,$10,$11,$9)`,
      [id('fem'), `test:${index}`, template, entries[index]!.email, entries[index]!.language, entryIds[index], pass, state, clock,
        state === 'SENT' || state === 'UNKNOWN' ? clock : null, state === 'SENT' ? clock : null]);
  }
});
afterAll(async () => { await t?.drop(); });

describe('Flight Admin authorization and privacy (PostgreSQL)', () => {
  it('requires the existing live administrative session for every route; ordinary user cookies do not grant access', async () => {
    for (const cookie of ['', 'flofi_session=ordinary-user-session']) {
      const headers = { cookie };
      expect((await handleFlightSummary(request('GET', '', {}, undefined, headers), options())).status).toBe(401);
      expect((await handleFlightEntries(request('POST', '/entries', {}, undefined, headers), options())).status).toBe(401);
      expect((await handleFlightEntries(request('POST', '/export', {}, undefined, headers), options(), true)).status).toBe(401);
    }
    expect((await handleFlightSummary(request('GET', ''), { ...options(), env: {} })).status).toBe(404);
    const expired = { ...options(), now: () => new Date(clock.getTime() + 5 * 60 * 60_000) };
    expect((await handleFlightEntries(request('POST', '/entries', {}, operator), expired)).status).toBe(401);
  });
  it('allows VIEWER aggregates, blocks PII list and export at the server, and audits refusals', async () => {
    const summary = await handleFlightSummary(request('GET', '', {}, viewer), options());
    expect(summary.status).toBe(200);
    const text = await summary.text(); expect(text).not.toContain('@');
    for (const csv of [false, true]) {
      const response = await handleFlightEntries(request('POST', csv ? '/export' : '/entries', {}, viewer), options(), csv);
      expect(response.status).toBe(403); expect(await response.text()).not.toContain('@');
    }
    const denied = (await t.db.query(`SELECT count(*)::int AS n FROM admin_audit_events WHERE actor = $1 AND kind = 'ADMIN_PERMISSION_DENIED'`, [viewer.principalId])).rows;
    expect(denied).toEqual([{ n: 2 }]);
  });
  it('checks same-origin JSON and CSRF on PII reads/exports and makes all responses private', async () => {
    for (const csv of [false, true]) for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' },
      { 'x-flofi-admin-csrf': 'invalid' }, { 'content-type': 'text/plain' }]) {
      const response = await handleFlightEntries(request('POST', csv ? '/export' : '/entries', {}, operator, headers), options(), csv);
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
    expect((await handleFlightEntries(request('GET', '/entries', {}, operator), options())).status).toBe(405);
    expect((await list({ pageSize: 1000 })).response.status).toBe(400);
  });
  it('refuses a revoked session immediately', async () => {
    const revoked = await signIn('OPERATOR');
    await createAdminStore(t.db, 'default').revoke(revoked.principalId);
    expect((await list({}, revoked)).response.status).toBe(401);
  });
  it('does not let a valid session cross tenants', async () => {
    const other = await signIn('OPERATOR', 'other-flight');
    expect((await list({}, operator, options('other-flight'))).response.status).toBe(401);
    const result = await list({}, other, options('other-flight'));
    expect(result.body.entries.total).toBe(1);
    expect(result.body.entries.rows.map(r => r.email)).toEqual(['secret@other.test']);
    expect((await list()).body.entries.rows.map(r => r.email)).not.toContain('secret@other.test');
  });
});

describe('Flight Admin real projections and read-only exports (PostgreSQL)', () => {
  it('uses the issuance ledger, existing outbox states and actual language/group/day counters', async () => {
    const response = await handleFlightSummary(request('GET', '', {}, operator), options());
    const { summary } = await response.json() as { summary: FlightAdminSummary };
    expect(summary).toMatchObject({ first: 4, next: 2, last24Hours: 2, listBoarded: 2, listAwaiting: 4, listEligible: 2,
      boarded: 2, foundingIssued: 1, foundingAvailable: 99, passengerIssued: 1, delivered: null });
    const beforeBoarding = await createFlightAdminStore({ db: t.db, tenantId: 'default' }, FLIGHT_DEFAULT_CALENDAR)
      .summary(FLIGHT_DEFAULT_CALENDAR.boardingOpensAt - 1);
    expect(beforeBoarding).toMatchObject({ listBoarded: 2, listAwaiting: 4, listEligible: 0 });
    expect(summary.languages).toEqual([{ language: 'EN', entries: 3 }, { language: 'PT', entries: 3 }]);
    expect(summary.daily.at(-1)?.cumulative).toBe(6);
    expect(summary.groups).toContainEqual({ flight: 'FIRST', group: 1, entries: 1, opensAt: new Date(clock.getTime() + 60 * 60_000).toISOString() });
    expect(summary.emails).toContainEqual({ template: 'GROUP_BOARDING', state: 'SENT', emails: 1 });
    expect(summary.emails).toContainEqual({ template: 'CARD_PASSENGER', state: 'UNKNOWN', emails: 1 });
    expect(summary.invites).toEqual([{ issuer: 'CREATOR', issued: 1, used: 0 }, { issuer: 'FOUNDING', issued: 1, used: 1 }]);
    // Deleted cards never return issued seat capacity to the campaign.
    await t.db.query(`UPDATE flight_issuance SET boarded=3, founding=2 WHERE tenant_id='default'`);
    expect(await createFlightAdminStore({ db: t.db, tenantId: 'default' }, FLIGHT_DEFAULT_CALENDAR).summary(clock.getTime()))
      .toMatchObject({ foundingIssued: 2, foundingAvailable: 98, passengerIssued: 1, boarded: 3, listAwaiting: 4, listEligible: 2 });
    await t.db.query(`UPDATE flight_issuance SET boarded=2, founding=1 WHERE tenant_id='default'`);
  });
  it('paginates and sorts stably on the server and supports literal search, UTC dates and combinable filters', async () => {
    const first = (await list({ pageSize: 2, page: 1 })).body.entries, second = (await list({ pageSize: 2, page: 2 })).body.entries;
    expect(first.total).toBe(6); expect(first.rows).toHaveLength(2); expect(second.rows).toHaveLength(2);
    expect(new Set([...first.rows, ...second.rows].map(r => r.entryId)).size).toBe(4);
    const all = (await list({ sort: 'asc', pageSize: 100 })).body.entries.rows;
    expect(all.map(r => r.joinedAt)).toEqual([...all.map(r => r.joinedAt)].sort());
    expect((await list({ search: 'BETA@EXAMPLE' })).body.entries.rows.map(r => r.email)).toEqual(['beta@example.test']);
    expect((await list({ search: '%_' })).body.entries.rows.map(r => r.email)).toEqual(['%_@example.test']);
    const filtered = (await list({ flight: 'FIRST', language: 'PT', group: 1, status: 'WAITING' })).body.entries;
    expect(filtered.total).toBe(1); expect(filtered.rows[0]).toMatchObject({ email: 'alpha@example.test', boarding: 'WAITING', access: 'INVITE_ISSUED' });
    expect((await list({ group: 'NONE', status: 'ELIGIBLE' })).body.entries.total).toBe(2);
    const today = clock.toISOString().slice(0, 10);
    expect((await list({ from: today, to: today })).body.entries.total).toBe(2);
    expect((await list({ page: 10 })).body.entries.rows).toEqual([]);
  });
  it('shows proved access and actual card associations without revealing access material', async () => {
    const result = (await list()).body.entries.rows;
    expect(result.find(r => r.email === 'beta@example.test')).toMatchObject({ access: 'INVITE_REDEEMED', boarding: 'ELIGIBLE', lastEmail: { template: 'GROUP_BOARDING', state: 'SENT' }, card: null });
    expect(result.find(r => r.email === 'gamma@example.test')).toMatchObject({ card: 'FOUNDING', boarding: 'BOARDED', access: 'CLAIMED' });
    expect(result.find(r => r.email === 'delta@example.test')).toMatchObject({ card: 'PASSENGER', boarding: 'BOARDED' });
    const body = JSON.stringify(result);
    for (const forbidden of ['FLF-', 'acct_', 'fat_', 'token', 'provider_id']) expect(body).not.toContain(forbidden);
  });
  it('keeps a claimed entry separate from another account card sent to the same verified email', async () => {
    const emailId = id('fem');
    await t.db.query(`INSERT INTO flight_emails (tenant_id,email_id,dedupe_key,template,template_version,category,recipient,language,trigger,pass_id,state,not_before,next_attempt_at)
      SELECT 'default',$1,$1,'CARD_PASSENGER',1,'ESSENTIAL','beta@example.test','EN','test',pass_id,'PENDING',$2,$2
      FROM flight_passes WHERE tenant_id='default' AND founding_seat IS NULL`, [emailId, clock]);
    try {
      expect((await list({ search: 'beta@example.test' })).body.entries.rows[0]).toMatchObject({ boarding: 'ELIGIBLE', card: null });
    } finally { await t.db.query('DELETE FROM flight_emails WHERE tenant_id=$1 AND email_id=$2', ['default', emailId]); }
  });
  it('exports the full filtered result independent of pagination, neutralizes formulas and preserves every campaign record', async () => {
    const snapshot = async () => JSON.stringify((await t.db.query(`SELECT * FROM flight_emails ORDER BY email_id`)).rows);
    const before = await snapshot();
    const response = await handleFlightEntries(request('POST', '/export', { language: 'PT', page: 99, pageSize: 1 }, operator), options(), true);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const csv = await response.text();
    expect(csv).toContain('alpha@example.test'); expect(csv).toContain('gamma@example.test'); expect(csv).toContain("'=cmd@example.test");
    expect(csv).not.toContain('beta@example.test'); expect(csv).not.toContain('secret@other.test'); expect(csv).not.toContain('FLF-');
    expect(await snapshot()).toBe(before);
    const events = (await t.db.query<{ kind: string; detail: Record<string, unknown> }>(`SELECT kind, detail FROM admin_audit_events WHERE kind IN ('ADMIN_FLIGHT_VIEWED','ADMIN_FLIGHT_EXPORTED')`)).rows;
    expect(events.some(e => e.kind === 'ADMIN_FLIGHT_EXPORTED' && e.detail.rows === 3)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('@'); expect(JSON.stringify(events)).not.toContain('beta');
  });
  it('fails closed when the mandatory sensitive-view audit cannot be persisted', async () => {
    const db: Database = { ...t.db, query: async (sql, values) => {
      if (sql.includes('INSERT INTO admin_audit_events')) throw new Error('test audit unavailable');
      return t.db.query(sql, values);
    } };
    const response = await handleFlightEntries(request('POST', '/entries', { search: 'beta' }, operator), { ...options(), host: { db, tenantId: 'default' } });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('@');
  });
  it('exports cannot silently truncate oversized filtered results', async () => {
    await t.db.query(`INSERT INTO flight_list_entries (tenant_id,entry_id,email,flight,language,notice,joined_at)
      SELECT 'default', 'fle_' || md5(i::text), 'large' || i || '@example.test', 'NEXT', 'EN', '2026-11-09', $1 FROM generate_series(1,10001) i`, [clock]);
    const response = await handleFlightEntries(request('POST', '/export', { search: 'large' }, operator), options(), true);
    expect(response.status).toBe(413); expect(await response.json()).toEqual({ ok: false, code: 'ADMIN_FLIGHT_EXPORT_TOO_LARGE' });
    expect((await createFlightAdminStore({ db: t.db, tenantId: 'default' }, FLIGHT_DEFAULT_CALENDAR).entries(flightAdminFilters({ search: 'large', pageSize: 25 }), clock.getTime())).rows).toHaveLength(25);
  });
});
