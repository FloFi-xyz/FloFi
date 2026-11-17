// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (P0) on real disposable PostgreSQL (loopback only): "send me a link and a code" from an address that
 * already boarded (or that a FloFi account already claimed) answers with the sign-in method of the account that holds it — never a link, a
 * code or a token, never a claim — under essential-mail rules that still honour suppressions, once per address per day, with its own small cap,
 * its own copy version, and the same public answer as every other address. A FAKE provider in this process records what would be sent.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { ACCESS_LIMITS, ACCESS_RECOVERY_VERSION, addressHash } from './access';
import { createAccessStore, type AccessStore } from './access-store';
import { FLIGHT_DEFAULT_CALENDAR } from './campaign';
import { createEmailDelivery } from './email/delivery';
import { createEmailOutbox, enqueueEmail } from './email/outbox';
import type { OutgoingEmail, SendOutcome } from './email/resend';
import { entryHolder } from './entry-holder';
import { createFlightStore, type FlightStore } from './store';

const SECRET = randomBytes(32).toString('base64url');
const CAL = FLIGHT_DEFAULT_CALENDAR, BOARDING = CAL.boardingOpensAt + 60_000;
let t: TestDatabase, store: FlightStore, access: AccessStore;
const hex = (n: number) => randomBytes(n).toString('hex');
const logger = createLogger({ service: 'flight-recovery-test', sink: () => undefined });
const rows = async (sql: string, values: unknown[] = []) => (await t.db.query<Record<string, unknown>>(sql, values)).rows;
const request = (email: string, now = BOARDING, client: string | null = hex(32)) => access.requestAccess({ email, language: 'EN', client, now, groupOpen: () => true });

/** A listed address whose account boarded (claimed by link, pass issued): the account signs in with a wallet. */
async function boarded(email: string, seat: number | null = 1): Promise<string> {
  await store.joinList({ email, language: 'EN', flight: 'FIRST', client: null, now: CAL.listClosesAt - 86_400_000 });
  await t.db.query("DELETE FROM flight_emails WHERE recipient = $1 AND trigger = 'list_join'", [email]); // its list confirmation is not under test
  const accountId = `acct_${hex(16)}`, entry = (await rows('SELECT entry_id FROM flight_list_entries WHERE email = $1', [email]))[0]!.entry_id;
  await t.db.query('INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ($1, $2)', ['default', accountId]);
  await t.db.query(`INSERT INTO flofi_account_identities (tenant_id, kind, subject, account_id) VALUES ('default', 'EIP155', $1, $2), ('default', 'PRIVY', $3, $2)`,
    [`0x${hex(20)}`, accountId, `did:privy:cm${hex(10)}`]);
  await t.db.query(`INSERT INTO flight_access_claims (tenant_id, entry_id, account_id, claimed_at) VALUES ('default', $1, $2, now())`, [entry, accountId]);
  const number = Number((await rows("SELECT coalesce(max(boarding_no), 0) + 1 AS n FROM flight_passes WHERE tenant_id = 'default'"))[0]!.n);
  await t.db.query(`INSERT INTO flight_passes (tenant_id, pass_id, account_id, origin, boarding_no, founding_seat, route, run_id) VALUES ('default', $1, $2, 'LIST', $3, $4,
    '{"from":"BASE","to":"BASE","steps":[{"action":"Swap","detail":"Base"}],"stepCount":1,"networkCount":1}', 'seeded')`, [`flp_${hex(16)}`, accountId, number, seat]);
  await t.db.query("UPDATE flight_list_entries SET boarded_at = now() WHERE entry_id = $1", [entry]);
  return accountId;
}
function fakeProvider(script: (email: OutgoingEmail) => SendOutcome = () => ({ kind: 'SENT', providerId: `fake-${hex(4)}` })) {
  const sent: OutgoingEmail[] = [];
  return { sent, provider: { async send(email: OutgoingEmail) { sent.push(email); return script(email); }, async domainStatus(): Promise<'VERIFIED' | 'NOT_VERIFIED' | 'UNKNOWN'> { return 'VERIFIED'; } } };
}
const deliver = (provider: ReturnType<typeof fakeProvider>['provider'], now = BOARDING + 5_000) => createEmailDelivery({ db: t.db, tenantId: 'default', calendar: CAL,
  secret: SECRET, origin: 'https://flofi.xyz', provider, outbox: createEmailOutbox({ db: t.db, tenantId: 'default' }), store, access, logger, now: () => now,
  sleep: async () => undefined, perSecond: 50, batchSize: 50 }).cycle();

beforeAll(async () => {
  t = await createTestDatabase();
  store = createFlightStore({ db: t.db, tenantId: 'default' }, CAL);
  access = createAccessStore({ db: t.db, tenantId: 'default' }, SECRET);
});
afterAll(async () => { await t?.drop(); });
beforeEach(async () => { await t.db.query("DELETE FROM flight_emails WHERE tenant_id = 'default'"); await t.db.query("DELETE FROM flight_access_attempts WHERE tenant_id = 'default'"); });

describe('boarding recovery: "send me a link" from an address that already boarded', () => {
  it('emails the sign-in method of the account that holds the pass — never a link, a code or a claim — and answers like any address', async () => {
    const owner = await boarded('owner@flofi-test.dev', 1);
    expect(await request('owner@flofi-test.dev')).toBe('OK');
    expect(await request('nobody@flofi-test.dev')).toBe('OK');
    expect(await rows("SELECT template, template_version, category, trigger, dedupe_key, recipient FROM flight_emails WHERE tenant_id = 'default'")).toEqual([
      { template: 'ACCESS_REQUESTED', template_version: ACCESS_RECOVERY_VERSION, category: 'ESSENTIAL', trigger: 'access_recovery',
        dedupe_key: expect.stringMatching(/^recovery:fle_[0-9a-f]{32}:\d{8}$/), recipient: 'owner@flofi-test.dev' }]);
    const fake = fakeProvider();
    await deliver(fake.provider);
    expect(fake.sent).toHaveLength(1);
    const sent = fake.sent[0]!;
    expect(sent.subject).toBe('You already boarded Flight FloFi ✈️');
    expect(sent.text).toContain('This email address already boarded Flight FloFi, as Founding Member #001.');
    expect(sent.text).toMatch(/Web3 wallet · 0x[0-9a-f]{4}…[0-9a-f]{4}/);
    expect(sent.text).toContain('https://flofi.xyz/login');
    // Nothing that could open or bind anything: no access link, no code, no token, no full address.
    expect(`${sent.html}\n${sent.text}`).not.toMatch(/\/board\/access|#t=|\b\d{6}\b|0x[0-9a-f]{40}|did:privy/);
    expect(await rows('SELECT count(*)::int AS n FROM flight_access_tokens')).toEqual([{ n: 0 }]);
    expect((await rows('SELECT account_id FROM flight_access_claims WHERE account_id = $1', [owner])).length).toBe(1);
  });

  it('goes out once per address per day, honours every suppression, and has its own cap that never uses up access emails', async () => {
    await boarded('daily@flofi-test.dev', 2);
    await request('daily@flofi-test.dev'); await request('daily@flofi-test.dev', BOARDING + 2 * 3_600_000);
    expect(await rows("SELECT count(*)::int AS n FROM flight_emails WHERE recipient = 'daily@flofi-test.dev'")).toEqual([{ n: 1 }]);
    // Unsubscribed: it holds no credential, so suppressing it never blocks boarding — and nothing is sent.
    await boarded('quiet@flofi-test.dev', 3);
    await createEmailOutbox({ db: t.db, tenantId: 'default' }).suppress(addressHash('quiet@flofi-test.dev'), 'UNSUBSCRIBED');
    expect(await request('quiet@flofi-test.dev')).toBe('OK');
    expect(await rows("SELECT count(*)::int AS n FROM flight_emails WHERE recipient = 'quiet@flofi-test.dev'")).toEqual([{ n: 0 }]);
    // The daily cap of recovery answers (one used above), while a listed address still waiting to board keeps getting its access email.
    for (let index = 0; index < ACCESS_LIMITS.recoveryEmailsPerDay + 1; index++) { await boarded(`many${index}@flofi-test.dev`, null); await request(`many${index}@flofi-test.dev`); }
    expect(await rows("SELECT count(*)::int AS n FROM flight_emails WHERE trigger = 'access_recovery'")).toEqual([{ n: ACCESS_LIMITS.recoveryEmailsPerDay }]);
    await store.joinList({ email: 'waiting@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: CAL.listClosesAt - 86_400_000 });
    expect(await request('waiting@flofi-test.dev')).toBe('OK');
    expect(await rows("SELECT trigger FROM flight_emails WHERE recipient = 'waiting@flofi-test.dev' AND trigger <> 'list_join'")).toEqual([{ trigger: 'access_requested' }]);
  });

  it('one sender can queue at most two recovery answers per hour, so the daily cap is no lever for a single client', async () => {
    const client = hex(32);
    for (let index = 0; index < 3; index++) { await boarded(`one-client${index}@flofi-test.dev`, null); expect(await request(`one-client${index}@flofi-test.dev`, BOARDING, client)).toBe('OK'); }
    expect(await rows("SELECT count(*)::int AS n FROM flight_emails WHERE trigger = 'access_recovery'")).toEqual([{ n: ACCESS_LIMITS.recoveryPerClientHour }]);
    // Another sender is unaffected.
    await boarded('other-client@flofi-test.dev', null); await request('other-client@flofi-test.dev');
    expect(await rows("SELECT count(*)::int AS n FROM flight_emails WHERE trigger = 'access_recovery'")).toEqual([{ n: ACCESS_LIMITS.recoveryPerClientHour + 1 }]);
  });

  it('answers a claimed-but-not-boarded address with its account\'s method too (its code could only be refused there)', async () => {
    await store.joinList({ email: 'claimed@flofi-test.dev', language: 'PT', flight: 'FIRST', client: null, now: CAL.listClosesAt - 86_400_000 });
    await t.db.query("DELETE FROM flight_emails WHERE trigger = 'list_join'");
    const entry = (await rows("SELECT entry_id FROM flight_list_entries WHERE email = 'claimed@flofi-test.dev'"))[0]!.entry_id;
    const accountId = `acct_${hex(16)}`;
    await t.db.query('INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ($1, $2)', ['default', accountId]);
    await t.db.query(`INSERT INTO flofi_account_identities (tenant_id, kind, subject, account_id, label) VALUES ('default', 'GOOGLE', 'g-claimed', $1, 'claimed@gmail.com')`, [accountId]);
    await t.db.query(`INSERT INTO flight_access_claims (tenant_id, entry_id, account_id, claimed_at) VALUES ('default', $1, $2, now())`, [entry, accountId]);
    expect(await entryHolder(t.db, 'default', 'claimed@flofi-test.dev')).toMatchObject({ boarded: false, claimed: true, accountId });
    await request('claimed@flofi-test.dev');
    const fake = fakeProvider();
    await deliver(fake.provider);
    expect(fake.sent[0]!.subject).toBe('Você já embarcou no Flight FloFi ✈️');
    expect(fake.sent[0]!.text).toContain('Google · c***@gmail.com');
  });

  it('sends only its own copy version, cancels a suppressed address at send time, and never re-renders after an unknown outcome', async () => {
    await boarded('versions@flofi-test.dev', 4);
    const entry = (await rows("SELECT entry_id FROM flight_list_entries WHERE email = 'versions@flofi-test.dev'"))[0]!.entry_id as string;
    await enqueueEmail(t.db, 'default', { template: 'ACCESS_REQUESTED', templateVersion: 2, recipient: 'versions@flofi-test.dev', language: 'EN', trigger: 'access_recovery',
      dedupeKey: `recovery:${entry}:test-version`, notBefore: BOARDING, expiresAt: BOARDING + 3_600_000, entryId: entry });
    await deliver(fakeProvider().provider);
    expect(await rows("SELECT state, status_reason FROM flight_emails WHERE dedupe_key LIKE '%test-version'")).toEqual([{ state: 'HELD', status_reason: 'TEMPLATE_VERSION_REVIEW' }]);
    await request('versions@flofi-test.dev');
    await createEmailOutbox({ db: t.db, tenantId: 'default' }).suppress(addressHash('versions@flofi-test.dev'), 'OPERATOR');
    await deliver(fakeProvider().provider);
    expect(await rows("SELECT state, status_reason FROM flight_emails WHERE recipient = 'versions@flofi-test.dev' AND template_version = $1", [ACCESS_RECOVERY_VERSION]))
      .toEqual([{ state: 'CANCELLED', status_reason: 'UNSUBSCRIBED' }]);
    await boarded('unknown@flofi-test.dev', 5);
    await request('unknown@flofi-test.dev');
    await deliver(fakeProvider(() => ({ kind: 'UNKNOWN', code: 'PROVIDER_TIMEOUT' })).provider);
    // Held durably: kept reserved (it may have been sent), never expired or re-rendered by a later cycle.
    const held = "SELECT state, status_reason, reserved_at IS NOT NULL AS reserved FROM flight_emails WHERE recipient = 'unknown@flofi-test.dev'";
    expect(await rows(held)).toEqual([{ state: 'HELD', status_reason: 'UNRESOLVED_OUTCOME', reserved: true }]);
    const later = fakeProvider();
    await deliver(later.provider, BOARDING + 2 * 3_600_000);
    expect(later.sent).toEqual([]);
    expect(await rows(held)).toEqual([{ state: 'HELD', status_reason: 'UNRESOLVED_OUTCOME', reserved: true }]);
  });

  it('names no account when none can be told apart: a boarded address whose account was deleted gets the general guidance', async () => {
    const accountId = await boarded('gone@flofi-test.dev', 6);
    await t.db.query('DELETE FROM flofi_accounts WHERE account_id = $1', [accountId]);
    expect(await entryHolder(t.db, 'default', 'gone@flofi-test.dev')).toMatchObject({ boarded: true, claimed: false, accountId: null });
    await request('gone@flofi-test.dev');
    const fake = fakeProvider();
    await deliver(fake.provider);
    expect(fake.sent[0]!.text).toContain('The same sign-in method you used when you boarded.');
    expect(fake.sent[0]!.text).not.toContain('Founding Member');
  });
});
