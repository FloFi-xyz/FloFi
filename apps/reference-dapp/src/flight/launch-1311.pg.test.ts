// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 13/11 launch operations on real disposable PostgreSQL (loopback only, its own database): moving unsent Email 3 v2 and English 3/4a/4b/5/6
 * rows to v3 and Portuguese in place (`email-launch-upgrade`), and queuing a HELD Email 6 v5 for active creator invites that have none
 * (`creator-requeue-missing`). A FAKE provider in this process proves FloFi's handling only, never delivery by Resend.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { addressHash, codeFor, linkTokenFor } from './access';
import { createAccessStore, type AccessStore } from './access-store';
import { FLIGHT_DEFAULT_CALENDAR } from './campaign';
import { createEmailDelivery } from './email/delivery';
import { createEmailOutbox, type EmailOutbox } from './email/outbox';
import type { OutgoingEmail } from './email/resend';
import { createFlightStore, type FlightStore } from './store';
import { runFlightCommand } from '../../backend/flight-admin';

let t: TestDatabase, store: FlightStore, access: AccessStore, outbox: EmailOutbox;
const SECRET = randomBytes(32).toString('base64url'); // Per run: no secret-like literal is committed.
const CAL = FLIGHT_DEFAULT_CALENDAR, OPEN = CAL.boardingOpensAt, BEFORE = CAL.listClosesAt - 3 * 86_400_000;
const logger = createLogger({ service: 'flight-launch-1311-test', sink: () => undefined });
const hex = (n: number) => randomBytes(n).toString('hex');
const rows = async (sql: string, values: unknown[] = []) => (await t.db.query<Record<string, unknown>>(sql, values)).rows;
const LIMITS = { daily: 10_000, monthly: 100_000, externalDailyReserve: 0, externalMonthlyReserve: 0 };
function fakeProvider() {
  const sent: OutgoingEmail[] = [];
  return { sent, provider: { async send(email: OutgoingEmail) { sent.push(email); return { kind: 'SENT' as const, providerId: `fake-${hex(4)}` }; },
    async domainStatus(): Promise<'VERIFIED' | 'NOT_VERIFIED' | 'UNKNOWN'> { return 'VERIFIED'; } } };
}
const delivery = (provider: ReturnType<typeof fakeProvider>['provider'], now: () => number) => createEmailDelivery({ db: t.db, tenantId: 'default',
  calendar: CAL, secret: SECRET, origin: 'https://flofi.xyz', provider, outbox, store, access, logger, now, sleep: async () => undefined, perSecond: 50, batchSize: 100 });
/** A legacy outbox row exactly as the earlier release left it (the scheduler or a card issue wrote it, before this change). */
async function legacy(template: string, version: number, language: 'EN' | 'PT', recipient: string, extra: { entryId?: string; batchKey?: string } = {}) {
  const emailId = `fem_${hex(16)}`;
  await t.db.query(`INSERT INTO flight_emails (tenant_id, email_id, dedupe_key, template, template_version, category, recipient, language, trigger, batch_key,
    entry_id, not_before, expires_at, next_attempt_at) VALUES ('default', $1, $2, $3, $4, 'CAMPAIGN', $5, $6, 'group_opened', $7, $8, $9, $9::timestamptz + interval '7 days', $9)`,
  [emailId, template === 'GROUP_BOARDING' && extra.entryId ? `boarding:${extra.entryId}` : `legacy:${emailId.slice(4)}`, template, version, recipient, language, extra.batchKey ?? null, extra.entryId ?? null, new Date(OPEN).toISOString()]);
  return emailId;
}
async function joined(email: string, language: 'EN' | 'PT') {
  await store.joinList({ email, language, flight: 'FIRST', client: null, now: BEFORE });
  await t.db.query(`UPDATE flight_emails SET state = 'SENT', sent_at = $2, reserved_at = $2, attempts = 1 WHERE recipient = $1 AND template = 'LIST_CONFIRMATION'`,
    [email, new Date(BEFORE)]);
  return (await rows('SELECT entry_id FROM flight_list_entries WHERE email = $1', [email]))[0]!.entry_id as string;
}
/** A row without what the upgrade (version, language) or a concurrent lease (state, attempts, reservation, lease) may change. */
const CHANGING = ['template_version', 'language', 'updated_at', 'state', 'attempts', 'first_attempt_at', 'reserved_at', 'lease_token', 'lease_until'];
const stable = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !CHANGING.includes(key)));
const snapshot = (ids: string[]) => rows('SELECT * FROM flight_emails WHERE email_id = ANY($1::text[]) ORDER BY email_id', [ids]);

beforeAll(async () => {
  t = await createTestDatabase();
  store = createFlightStore({ db: t.db, tenantId: 'default' }, CAL);
  access = createAccessStore({ db: t.db, tenantId: 'default' }, SECRET);
  outbox = createEmailOutbox({ db: t.db, tenantId: 'default' }, LIMITS);
});
afterAll(async () => { await t?.drop(); });

describe('email-launch-upgrade: unsent Email 3 v2 and English launch emails move to v3 / Portuguese in place', () => {
  const eligible: string[] = [], untouchable: string[] = [];
  let enEntry = '', cardId = '';
  beforeAll(async () => {
    // 3 English and 2 Portuguese Email 3 v2 rows never attempted (the production case: 22 EN + 26 PT), one English card 4a v2.
    for (let i = 0; i < 5; i++) {
      const email = `wait-${i}@flofi-test.dev`, entry = await joined(email, i < 3 ? 'EN' : 'PT');
      if (i === 0) enEntry = entry;
      eligible.push(await legacy('GROUP_BOARDING', 2, i < 3 ? 'EN' : 'PT', email, { entryId: entry, batchKey: 'group-0' }));
    }
    cardId = await legacy('CARD_FOUNDING', 2, 'EN', 'card-en@flofi-test.dev');
    eligible.push(cardId);
    // Rows that must never change: sent, in flight, unknown outcome, held, attempted, reserved, already current and cancelled.
    const states: [string, string][] = [['SENT', 'sent'], ['SENDING', 'sending'], ['UNKNOWN', 'unknown'], ['HELD', 'held'], ['PENDING', 'attempted'],
      ['PENDING', 'reserved'], ['CANCELLED', 'cancelled']];
    for (const [state, label] of states) {
      const email = `keep-${label}@flofi-test.dev`, entry = await joined(email, 'EN');
      const id = await legacy('GROUP_BOARDING', 2, 'EN', email, { entryId: entry, batchKey: 'group-0' });
      const at = new Date(OPEN);
      await t.db.query(`UPDATE flight_emails SET state = $2,
        attempts = CASE WHEN $3 IN ('sent', 'sending', 'unknown', 'attempted') THEN 1 ELSE 0 END,
        first_attempt_at = CASE WHEN $3 IN ('sent', 'sending', 'unknown', 'attempted') THEN $4::timestamptz END,
        reserved_at = CASE WHEN $3 IN ('sent', 'sending', 'unknown', 'reserved') THEN $4::timestamptz END,
        lease_token = CASE WHEN $3 = 'sending' THEN $5 END, lease_until = CASE WHEN $3 = 'sending' THEN $4::timestamptz + interval '1 day' END,
        sent_at = CASE WHEN $3 = 'sent' THEN $4::timestamptz END, provider_id = CASE WHEN $3 = 'sent' THEN 'prov-1' END,
        status_reason = CASE WHEN $3 = 'held' THEN 'QUOTA_DAILY' WHEN $3 = 'attempted' THEN 'PROVIDER_RATE_LIMITED' END WHERE email_id = $1`,
      [id, state, label, at, hex(16)]);
      untouchable.push(id);
    }
    untouchable.push(await legacy('GROUP_BOARDING', 3, 'PT', 'current@flofi-test.dev'));
  });

  it('dry-run counts and lists exactly the never-attempted PENDING rows and changes nothing', async () => {
    const all = [...eligible, ...untouchable], before = await snapshot(all);
    const dry = await outbox.upgradeLaunchPending(OPEN);
    expect(dry).toMatchObject({ dryRun: true, eligible: eligible.length, codeVersions: { GROUP_BOARDING: 3, CREATOR_INVITE: 5, CARD_FOUNDING: 2 } });
    expect(dry.planned.map(p => p.emailId).sort()).toEqual([...eligible].sort());
    expect(dry.planned.find(p => p.emailId === cardId)).toEqual({ emailId: cardId, template: 'CARD_FOUNDING', from: { version: 2, language: 'EN' }, to: { version: 2, language: 'PT' } });
    expect(dry.skipped).toEqual(expect.arrayContaining([
      { template: 'GROUP_BOARDING', state: 'SENT', reason: 'ATTEMPTED', emails: 1 }, { template: 'GROUP_BOARDING', state: 'SENDING', reason: 'ATTEMPTED', emails: 1 },
      { template: 'GROUP_BOARDING', state: 'UNKNOWN', reason: 'ATTEMPTED', emails: 1 }, { template: 'GROUP_BOARDING', state: 'HELD', reason: 'NOT_PENDING', emails: 1 },
      { template: 'GROUP_BOARDING', state: 'PENDING', reason: 'ATTEMPTED', emails: 1 }, { template: 'GROUP_BOARDING', state: 'PENDING', reason: 'RESERVED', emails: 1 }]));
    expect(dry.before).toContainEqual({ template: 'GROUP_BOARDING', version: 2, language: 'EN', state: 'PENDING', emails: 5 }); // 3 + attempted + reserved
    expect(await snapshot(all)).toEqual(before);
    // The CLI prints the same dry-run (no flag: never applies).
    expect(await runFlightCommand('email-launch-upgrade', {}, store, OPEN, { outbox, entryOf: async () => null, revoke: null, sendDue: { disabled: 'TEST' } }))
      .toMatchObject({ dryRun: true, eligible: eligible.length });
  });

  it('refuses apply while campaign email runs or without the deployed-worker confirmation', async () => {
    const before = await snapshot(eligible);
    await expect(outbox.upgradeLaunchPending(OPEN, { apply: true, workerDeployed: true })).rejects.toThrow('FLIGHT_UPGRADE_REQUIRES_PAUSED_CAMPAIGN');
    await outbox.setPaused(true, 'launch 1311 upgrade');
    await expect(outbox.upgradeLaunchPending(OPEN, { apply: true })).rejects.toThrow('FLIGHT_UPGRADE_WORKER_DEPLOY_UNCONFIRMED');
    const ctx = { outbox, entryOf: async () => null, revoke: null, sendDue: { disabled: 'TEST' } };
    await expect(runFlightCommand('email-launch-upgrade', { apply: true }, store, OPEN, ctx)).rejects.toThrow('FLIGHT_UPGRADE_WORKER_DEPLOY_UNCONFIRMED');
    expect(await snapshot(eligible)).toEqual(before);
  });

  it('applies once under concurrent runs and a concurrent lease, keeps every key and link, never touches the rest, and is idempotent', async () => {
    const all = [...eligible, ...untouchable], before = await snapshot(all), kept = await snapshot(untouchable);
    const count = Number((await rows('SELECT count(*)::int AS n FROM flight_emails'))[0]!.n);
    // Two operators at once plus a worker leasing (an older worker that ignored the pause would lease with campaign: true). The lease
    // reserves Email 3's whole batch; the upgrade and the lease share the quota lock, so each row is either upgraded first or reserved first.
    const [a, b, leased] = await Promise.all([outbox.upgradeLaunchPending(OPEN, { apply: true, workerDeployed: true }),
      outbox.upgradeLaunchPending(OPEN, { apply: true, workerDeployed: true }), outbox.lease(OPEN, { max: 1, campaign: true })]);
    const updated = [...a.updatedIds, ...b.updatedIds];
    expect(new Set(updated).size).toBe(updated.length); // never twice
    expect(updated.length).toBeGreaterThan(0);
    expect(Number((await rows('SELECT count(*)::int AS n FROM flight_emails'))[0]!.n)).toBe(count); // no new row: no duplicate
    const after = await snapshot(all), leasedIds = leased.map(r => r.emailId);
    for (const row of after.filter(r => eligible.includes(r.email_id as string))) {
      const old = before.find(r => r.email_id === row.email_id)!;
      expect(stable(row)).toEqual(stable(old)); // email_id, dedupe_key, recipient, not_before, expires_at, entry/pass/invite links, batch, created_at
      if (updated.includes(row.email_id as string)) expect(row).toMatchObject({ language: 'PT', template_version: row.template === 'GROUP_BOARDING' ? 3 : 2 });
      else {
        // Reserved or leased by the worker before the upgrade: left exactly as it was enqueued (it may reach the provider as v2).
        expect(row).toMatchObject({ language: old.language, template_version: old.template_version });
        expect(row.reserved_at !== null || leasedIds.includes(row.email_id as string)).toBe(true);
      }
    }
    // The upgrade never touched them (the concurrent lease may reserve a pending row of Email 3's batch: that is the worker, not the upgrade).
    const keptNow = await snapshot(untouchable);
    for (const row of keptNow) expect(row).toMatchObject({ template_version: kept.find(k => k.email_id === row.email_id)!.template_version,
      language: kept.find(k => k.email_id === row.email_id)!.language });
    for (const index of [0, 1, 3, 6]) expect(keptNow.find(r => r.email_id === untouchable[index])).toEqual(kept.find(r => r.email_id === untouchable[index]));
    // Test only: put every eligible row back as never sent. A re-run upgrades exactly the ones the lease kept, and then finds nothing.
    await t.db.query(`UPDATE flight_emails SET state = 'PENDING', attempts = 0, first_attempt_at = NULL, reserved_at = NULL, lease_token = NULL,
      lease_until = NULL WHERE email_id = ANY($1::text[])`, [eligible]);
    const again = await outbox.upgradeLaunchPending(OPEN, { apply: true, workerDeployed: true });
    expect(again.updated).toBe(eligible.length - updated.length);
    const last = await outbox.upgradeLaunchPending(OPEN, { apply: true, workerDeployed: true });
    expect(last).toMatchObject({ eligible: 0, updated: 0 });
    expect(last.after).toContainEqual({ template: 'GROUP_BOARDING', version: 3, language: 'PT', state: 'PENDING', emails: 6 });
    expect(last.after).toContainEqual({ template: 'CARD_FOUNDING', version: 2, language: 'PT', state: 'PENDING', emails: 1 });
  });

  it('after resume, an English waitlist entry gets the Portuguese v3 Email 3 under its original id: same link and code seeds, delay note', async () => {
    await outbox.setPaused(false, null);
    const id = eligible[0]!, fake = fakeProvider();
    await delivery(fake.provider, () => OPEN + 1000).cycle();
    const sent = fake.sent.find(e => e.idempotencyKey === id)!;
    expect(sent.subject).toBe('Seu grupo está embarcando ✈️');
    expect(sent.html).toContain(`https://flofi.xyz/board/access?l=pt#t=${linkTokenFor(SECRET, id)}`);
    expect(sent.text).toContain(codeFor(SECRET, id));
    expect(sent.text).toContain('Atrasamos um dia para corrigir alguns erros antes de abrir. Obrigado pela paciência.');
    expect(await rows('SELECT entry_id FROM flight_access_tokens WHERE entry_id = $1', [enEntry])).toHaveLength(1);
    // Rows that had already gone further were never re-versioned: a retry (same key) carries the payload it was enqueued with.
    expect(await rows('SELECT DISTINCT template_version, language FROM flight_emails WHERE email_id = ANY($1::text[]) AND email_id <> $2',
      [untouchable, untouchable[untouchable.length - 1]])).toEqual([{ template_version: 2, language: 'EN' }]);
    expect(fake.sent.some(e => e.idempotencyKey === untouchable[0])).toBe(false); // SENT is never sent again
  });
});

describe('creator-requeue-missing: a HELD Email 6 v5 for active creator invites with no Email 6, reusing their codes', () => {
  const ctx = () => ({ outbox, entryOf: async () => null, revoke: null, sendDue: { disabled: 'TEST' } as const });
  let codes: Record<string, string> = {};
  beforeAll(async () => {
    await t.db.query(`UPDATE flight_emails SET state = 'CANCELLED', reserved_at = NULL, lease_token = NULL, lease_until = NULL WHERE state IN ('PENDING', 'HELD', 'UNKNOWN', 'SENDING')`);
    const make = async (label: string) => (await store.inviteCreator({ email: `guest-${label}@flofi-test.dev`, language: 'EN', sendAt: BEFORE, now: BEFORE })).code;
    codes = { missing1: await make('missing1'), missing2: await make('missing2'), sent: await make('sent'), queued: await make('queued'),
      revoked: await make('revoked'), suppressed: await make('suppressed'), waitlist: await make('waitlist') };
    // Their earlier Email 6 rows: cancelled (expired at the old opening) for the missing ones; one was sent; one is still queued.
    await t.db.query(`UPDATE flight_emails SET state = 'CANCELLED', status_reason = 'EXPIRED' WHERE template = 'CREATOR_INVITE' AND recipient <> 'guest-queued@flofi-test.dev'`);
    await t.db.query(`UPDATE flight_emails SET state = 'SENT', sent_at = $1, reserved_at = $1, attempts = 1, status_reason = NULL WHERE recipient = 'guest-sent@flofi-test.dev'`, [new Date(BEFORE)]);
    await t.db.query(`UPDATE flight_invites SET revoked_at = $1 WHERE recipient = 'guest-revoked@flofi-test.dev'`, [new Date(BEFORE)]);
    await outbox.suppress(addressHash('guest-suppressed@flofi-test.dev'), 'OPERATOR');
    // An invited guest who is also on the waiting list.
    await joined('guest-waitlist@flofi-test.dev', 'PT');
  });

  it('dry-run reports each invite by status and the guest/waitlist overlap, and creates nothing', async () => {
    const invites = await rows('SELECT * FROM flight_invites ORDER BY code'), emails = await rows('SELECT * FROM flight_emails ORDER BY email_id');
    const dry = await runFlightCommand('creator-requeue-missing', {}, store, OPEN, ctx());
    expect(dry).toMatchObject({ dryRun: true, version: 5, batch: 'creators-v5', eligible: 3,
      invites: { MISSING: 3, EMAIL6_SENT: 1, EMAIL6_QUEUED: 1, REVOKED: 1, SUPPRESSED: 1 } });
    expect(JSON.stringify(dry)).not.toMatch(/guest-[a-z0-9]+@/); // masked only
    expect(await rows('SELECT * FROM flight_invites ORDER BY code')).toEqual(invites);
    expect(await rows('SELECT * FROM flight_emails ORDER BY email_id')).toEqual(emails);
    const overlap = await outbox.guestWaitlistOverlap();
    expect(overlap).toEqual([{ to: 'g***@flofi-test.dev', groupBoardingEmailId: null, groupBoardingState: null }]);
  });

  it('apply enqueues HELD Portuguese v5 rows once (concurrent runs too), reuses codes, creates no invite, and sends only after release', async () => {
    const inviteCount = (await rows('SELECT count(*)::int AS n FROM flight_invites'))[0]!.n;
    const [a, b] = await Promise.all([outbox.enqueueMissingCreatorInvites(OPEN, { apply: true }), outbox.enqueueMissingCreatorInvites(OPEN, { apply: true })]);
    expect(a.enqueued + b.enqueued).toBe(3);
    expect((await rows('SELECT count(*)::int AS n FROM flight_invites'))[0]!.n).toBe(inviteCount);
    const queued = await rows(`SELECT invite_code, state, status_reason, batch_key, language, template_version, recipient, expires_at FROM flight_emails
      WHERE trigger = 'creator_requeued' ORDER BY recipient`);
    expect(queued.map(r => r.invite_code)).toEqual([codes.missing1, codes.missing2, codes.waitlist]);
    for (const row of queued) expect(row).toMatchObject({ state: 'HELD', status_reason: 'OPERATOR_REVIEW', batch_key: 'creators-v5', language: 'PT', template_version: 5 });
    expect(await outbox.enqueueMissingCreatorInvites(OPEN, { apply: true })).toMatchObject({ eligible: 0, enqueued: 0 });
    // The old held-version path cannot add a second v5 row for the same code: same dedupe key.
    expect((await rows(`SELECT count(*)::int AS n FROM flight_emails WHERE template = 'CREATOR_INVITE' AND template_version = 5 AND invite_code = $1
      AND state <> 'CANCELLED'`, [codes.missing1]))[0]!.n).toBe(1);
    // Nothing automatic: a running worker leaves them held.
    const requeued = (await rows(`SELECT email_id FROM flight_emails WHERE trigger = 'creator_requeued'`)).map(r => r.email_id as string);
    const idle = fakeProvider();
    await delivery(idle.provider, () => OPEN + 2000).cycle();
    expect(idle.sent.filter(e => requeued.includes(e.idempotencyKey))).toEqual([]);
    expect(await rows(`SELECT DISTINCT state FROM flight_emails WHERE trigger = 'creator_requeued'`)).toEqual([{ state: 'HELD' }]);
    // The operator's release sends exactly those three, in Portuguese, with their existing codes.
    expect(await runFlightCommand('email-release', { batch: 'creators-v5' }, store, OPEN + 3000, ctx())).toEqual({ released: 3 });
    const fake = fakeProvider();
    await delivery(fake.provider, () => OPEN + 4000).cycle();
    const guests = fake.sent.filter(e => requeued.includes(e.idempotencyKey));
    expect(guests.map(e => e.to).sort()).toEqual(['guest-missing1@flofi-test.dev', 'guest-missing2@flofi-test.dev', 'guest-waitlist@flofi-test.dev']);
    for (const email of guests) {
      expect(email.subject).toBe('Seu convite para o beta da FloFi ✈️');
      expect(email.text).toContain('EMBARQUE = ABERTO');
      expect(email.text).toContain(codes[email.to.slice(6, email.to.indexOf('@'))]!);
    }
  });
});
