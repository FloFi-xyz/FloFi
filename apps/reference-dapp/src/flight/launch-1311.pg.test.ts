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
    expect(leased).toEqual([]); // the pause is re-read under the quota lock: no campaign email is leased meanwhile
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
    expect(sent.html).toContain('>Estamos começando, e queremos testar com você.</div>');
    for (const part of ['A FloFi está começando, e este é o primeiro voo. Atrasamos um dia para corrigir alguns erros antes de abrir.',
      'Queremos entender, com quem usa DeFi de verdade, onde a FloFi já ajuda e onde ainda deixa a desejar. A sua opinião agora vale muito.',
      'O que dá para testar hoje', 'Comece com valores pequenos: é mainnet, com dinheiro de verdade.', 'Depois de testar: Responda este e-mail contando como foi'])
      expect(sent.text).toContain(part);
    expect(await rows('SELECT entry_id FROM flight_access_tokens WHERE entry_id = $1', [enEntry])).toHaveLength(1);
    // Rows that had already gone further were never re-versioned: a retry (same key) carries the payload it was enqueued with.
    expect(await rows('SELECT DISTINCT template_version, language FROM flight_emails WHERE email_id = ANY($1::text[]) AND email_id <> $2',
      [untouchable, untouchable[untouchable.length - 1]])).toEqual([{ template_version: 2, language: 'EN' }]);
    expect(fake.sent.some(e => e.idempotencyKey === untouchable[0])).toBe(false); // SENT is never sent again
  });
});

describe('email-launch-upgrade never changes a row that may have reached the provider', () => {
  it('lists a released UNRESOLVED_OUTCOME row by id and leaves it alone unless the operator includes released rows', async () => {
    const entry = await joined('released@flofi-test.dev', 'EN');
    const id = await legacy('GROUP_BOARDING', 2, 'EN', 'released@flofi-test.dev', { entryId: entry, batchKey: 'group-9' });
    // Attempted (outcome unknown), then held as UNRESOLVED_OUTCOME, then released by id after the operator checked Resend: attempts,
    // first attempt and reservation are reset, exactly like a never-attempted row, but next_attempt_at moved.
    await t.db.query(`UPDATE flight_emails SET state = 'HELD', status_reason = 'UNRESOLVED_OUTCOME', attempts = 1, first_attempt_at = $2, reserved_at = $2
      WHERE email_id = $1`, [id, new Date(OPEN)]);
    expect(await outbox.release({ emailId: id }, OPEN + 60_000)).toBe(1);
    expect((await rows('SELECT state, attempts, first_attempt_at, reserved_at FROM flight_emails WHERE email_id = $1', [id]))[0])
      .toEqual({ state: 'PENDING', attempts: 0, first_attempt_at: null, reserved_at: null });
    const dry = await outbox.upgradeLaunchPending(OPEN + 60_000);
    expect(dry.planned.map(p => p.emailId)).not.toContain(id);
    expect(dry.releasedPendingIds).toEqual([id]);
    expect(dry.skipped).toContainEqual({ template: 'GROUP_BOARDING', state: 'PENDING', reason: 'RELEASED_OR_RETRIED', emails: 1 });
    await outbox.setPaused(true, 'launch 1311 upgrade');
    expect((await outbox.upgradeLaunchPending(OPEN + 60_000, { apply: true, workerDeployed: true })).updatedIds).not.toContain(id);
    expect((await rows('SELECT template_version, language FROM flight_emails WHERE email_id = $1', [id]))[0]).toEqual({ template_version: 2, language: 'EN' });
    // Only an explicit opt-in (after checking the id in the Resend log) moves it.
    const opted = await outbox.upgradeLaunchPending(OPEN + 60_000, { apply: true, workerDeployed: true, includeReleased: true });
    expect(opted.updatedIds).toEqual([id]);
    await outbox.setPaused(false, null);
  });
});

describe('creator-requeue-missing: a HELD Email 6 v5 for active creator invites with no Email 6, reusing their codes', () => {
  const ctx = () => ({ outbox, entryOf: async () => null, revoke: null, sendDue: { disabled: 'TEST' } as const });
  let codes: Record<string, string> = {};
  beforeAll(async () => {
    await t.db.query(`UPDATE flight_emails SET state = 'CANCELLED', reserved_at = NULL, lease_token = NULL, lease_until = NULL WHERE state IN ('PENDING', 'HELD', 'UNKNOWN', 'SENDING')`);
    const make = async (label: string) => (await store.inviteCreator({ email: `guest-${label}@flofi-test.dev`, language: 'EN', sendAt: BEFORE, now: BEFORE })).code;
    codes = { missing1: await make('missing1'), missing2: await make('missing2'), sent: await make('sent'), queued: await make('queued'),
      revoked: await make('revoked'), suppressed: await make('suppressed'), waitlist: await make('waitlist'), redeemed: await make('redeemed'),
      opcancel: await make('opcancel'), failed: await make('failed'), expired: await make('expired') };
    // Their earlier Email 6 rows: cancelled (expired at the old opening) for the missing ones; one was sent; one is still queued.
    await t.db.query(`UPDATE flight_emails SET state = 'CANCELLED', status_reason = 'EXPIRED' WHERE template = 'CREATOR_INVITE' AND recipient <> 'guest-queued@flofi-test.dev'`);
    await t.db.query(`UPDATE flight_emails SET state = 'SENT', sent_at = $1, reserved_at = $1, attempts = 1, status_reason = NULL WHERE recipient = 'guest-sent@flofi-test.dev'`, [new Date(BEFORE)]);
    await t.db.query(`UPDATE flight_invites SET revoked_at = $1 WHERE recipient = 'guest-revoked@flofi-test.dev'`, [new Date(BEFORE)]);
    // Deliberately stopped earlier: cancelled by the operator, rejected by the provider. And one invite that expired.
    await t.db.query(`UPDATE flight_emails SET status_reason = 'OPERATOR' WHERE recipient = 'guest-opcancel@flofi-test.dev'`);
    await t.db.query(`UPDATE flight_emails SET state = 'FAILED', status_reason = 'PROVIDER_REJECTED' WHERE recipient = 'guest-failed@flofi-test.dev'`);
    await t.db.query(`UPDATE flight_invites SET expires_at = $1 WHERE recipient = 'guest-expired@flofi-test.dev'`, [new Date(OPEN - 1000)]);
    await joined('guest-expired@flofi-test.dev', 'PT'); // on the waiting list too, but the invite no longer works
    await outbox.suppress(addressHash('guest-suppressed@flofi-test.dev'), 'OPERATOR');
    // An invited guest who is also on the waiting list.
    await joined('guest-waitlist@flofi-test.dev', 'PT');
  });

  it('dry-run reports each invite by status and the guest/waitlist overlap, and creates nothing', async () => {
    const invites = await rows('SELECT * FROM flight_invites ORDER BY code'), emails = await rows('SELECT * FROM flight_emails ORDER BY email_id');
    const dry = await runFlightCommand('creator-requeue-missing', {}, store, OPEN, ctx());
    expect(dry).toMatchObject({ dryRun: true, version: 5, batch: 'creators-v5', eligible: 4,
      invites: { MISSING: 4, EMAIL6_SENT: 1, EMAIL6_QUEUED: 1, REVOKED: 1, SUPPRESSED: 1, EMAIL6_STOPPED: 1, EMAIL6_OPERATOR_CANCELLED: 1, EXPIRED: 1 } });
    expect(await runFlightCommand('creator-requeue-missing', { 'include-operator-cancelled': true }, store, OPEN, ctx())).toMatchObject({ eligible: 5 });
    expect(JSON.stringify(dry)).not.toMatch(/guest-[a-z0-9]+@/); // masked only
    expect(await rows('SELECT * FROM flight_invites ORDER BY code')).toEqual(invites);
    expect(await rows('SELECT * FROM flight_emails ORDER BY email_id')).toEqual(emails);
    // Only the active invite counts: the expired guest on the list is not reported.
    expect(await outbox.guestWaitlistOverlap(OPEN)).toEqual([{ to: 'g***@flofi-test.dev', groupBoardingEmailId: null, groupBoardingState: null }]);
  });

  it('apply enqueues HELD Portuguese v5 rows once (concurrent runs too), reuses codes, creates no invite, and sends only after release', async () => {
    const inviteCount = (await rows('SELECT count(*)::int AS n FROM flight_invites'))[0]!.n;
    const [a, b] = await Promise.all([outbox.enqueueMissingCreatorInvites(OPEN, { apply: true }), outbox.enqueueMissingCreatorInvites(OPEN, { apply: true })]);
    expect(a.enqueued + b.enqueued).toBe(4);
    expect((await rows('SELECT count(*)::int AS n FROM flight_invites'))[0]!.n).toBe(inviteCount);
    const queued = await rows(`SELECT invite_code, state, status_reason, batch_key, language, template_version, recipient, expires_at FROM flight_emails
      WHERE trigger = 'creator_requeued' ORDER BY recipient`);
    expect(queued.map(r => r.invite_code)).toEqual([codes.missing1, codes.missing2, codes.redeemed, codes.waitlist]);
    for (const row of queued) expect(row).toMatchObject({ state: 'HELD', status_reason: 'OPERATOR_REVIEW', batch_key: 'creators-v5', language: 'PT', template_version: 5 });
    expect(await outbox.enqueueMissingCreatorInvites(OPEN, { apply: true })).toMatchObject({ eligible: 0, enqueued: 0 });
    expect(await outbox.enqueueMissingCreatorInvites(OPEN, { includeOperatorCancelled: true })).toMatchObject({ eligible: 1 }); // only on request
    // The old held-version path cannot add a second v5 row for the same code: same dedupe key.
    expect((await rows(`SELECT count(*)::int AS n FROM flight_emails WHERE template = 'CREATOR_INVITE' AND template_version = 5 AND invite_code = $1
      AND state <> 'CANCELLED'`, [codes.missing1]))[0]!.n).toBe(1);
    // Nothing automatic: a running worker leaves them held.
    const requeued = (await rows(`SELECT email_id FROM flight_emails WHERE trigger = 'creator_requeued'`)).map(r => r.email_id as string);
    const idle = fakeProvider();
    await delivery(idle.provider, () => OPEN + 2000).cycle();
    expect(idle.sent.filter(e => requeued.includes(e.idempotencyKey))).toEqual([]);
    expect(await rows(`SELECT DISTINCT state FROM flight_emails WHERE trigger = 'creator_requeued'`)).toEqual([{ state: 'HELD' }]);
    // A guest who redeems the code before the release is already on board: their Email 6 is cancelled, never sent.
    await t.db.query(`UPDATE flight_invites SET redeemed_at = $1 WHERE code = $2`, [new Date(OPEN + 2500), codes.redeemed]);
    // The operator's release sends exactly the other three, in Portuguese, with their existing codes.
    expect(await runFlightCommand('email-release', { batch: 'creators-v5' }, store, OPEN + 3000, ctx())).toEqual({ released: 4 });
    const fake = fakeProvider();
    await delivery(fake.provider, () => OPEN + 4000).cycle();
    const guests = fake.sent.filter(e => requeued.includes(e.idempotencyKey));
    expect(guests.map(e => e.to).sort()).toEqual(['guest-missing1@flofi-test.dev', 'guest-missing2@flofi-test.dev', 'guest-waitlist@flofi-test.dev']);
    expect(await rows(`SELECT state, status_reason FROM flight_emails WHERE trigger = 'creator_requeued' AND invite_code = $1`, [codes.redeemed]))
      .toEqual([{ state: 'CANCELLED', status_reason: 'INVITE_REDEEMED' }]);
    for (const email of guests) {
      expect(email.subject).toBe('Seu convite para o beta da FloFi ✈️');
      expect(email.text).toContain('EMBARQUE = ABERTO');
      expect(email.text).toContain(codes[email.to.slice(6, email.to.indexOf('@'))]!);
    }
  });
});

describe('13/11 release: only Email 3 goes out; Email 6 and every other campaign email stay held; access emails keep working', () => {
  it('holds the pending 4a cards, Email 6 and Email 5, then resume sends only Email 3 (the invited guest on the list included) and essential email', async () => {
    await t.db.query(`UPDATE flight_emails SET state = 'CANCELLED', reserved_at = NULL, lease_token = NULL, lease_until = NULL WHERE state IN ('PENDING', 'HELD', 'UNKNOWN', 'SENDING')`);
    await outbox.setPaused(true, 'launch 1311');
    // The waiting list's Email 3 (one of them an invited guest), two pending 4a cards, an Email 6 v5 still queued, an Email 5, and an
    // access email a person asked for (ESSENTIAL).
    const listed: string[] = [];
    for (const label of ['a', 'b', 'guest']) {
      const email = `release-${label}@flofi-test.dev`, entry = await joined(email, 'EN');
      listed.push(await legacy('GROUP_BOARDING', 2, label === 'b' ? 'PT' : 'EN', email, { entryId: entry, batchKey: 'group-1' }));
    }
    const invite = await store.inviteCreator({ email: 'release-guest@flofi-test.dev', language: 'PT', sendAt: BEFORE, now: BEFORE });
    const inviteBefore = await rows('SELECT * FROM flight_invites WHERE code = $1', [invite.code]);
    const others = [await legacy('CARD_FOUNDING', 2, 'EN', 'release-card1@flofi-test.dev'), await legacy('CARD_FOUNDING', 2, 'PT', 'release-card2@flofi-test.dev'),
      await legacy('NEXT_FLIGHT', 2, 'EN', 'release-next@flofi-test.dev'),
      (await rows(`SELECT email_id FROM flight_emails WHERE template = 'CREATOR_INVITE' AND invite_code = $1`, [invite.code]))[0]!.email_id as string];
    const essential = `fem_${hex(16)}`, essentialEntry = await joined('release-access@flofi-test.dev', 'PT');
    await t.db.query(`INSERT INTO flight_emails (tenant_id, email_id, dedupe_key, template, template_version, category, recipient, language, trigger, entry_id,
      not_before, next_attempt_at) VALUES ('default', $1, $2, 'ACCESS_REQUESTED', 2, 'ESSENTIAL', 'release-access@flofi-test.dev', 'PT', 'access_requested', $3, $4, $4)`,
    [essential, `access:${essential.slice(4)}`, essentialEntry, new Date(OPEN)]);
    // Upgrade Email 3 to the final v3 in Portuguese first.
    expect((await outbox.upgradeLaunchPending(OPEN, { apply: true, workerDeployed: true })).updatedIds).toEqual(expect.arrayContaining(listed));
    // Dry-run, then hold everything but Email 3.
    const ctx = { outbox, entryOf: async () => null, revoke: null, sendDue: { disabled: 'TEST' } as const };
    const dry = await runFlightCommand('email-hold-campaign', { keep: 'GROUP_BOARDING' }, store, OPEN, ctx);
    expect(dry).toMatchObject({ dryRun: true, toHold: 4, toHoldByTemplate: { CARD_FOUNDING: 2, NEXT_FLIGHT: 1, CREATOR_INVITE: 1 },
      stillPending: { GROUP_BOARDING: 3, ACCESS_REQUESTED: 1 } });
    expect((dry.toHoldIds as string[]).sort()).toEqual([...others].sort());
    expect(await rows(`SELECT DISTINCT state FROM flight_emails WHERE email_id = ANY($1::text[])`, [others])).toEqual([{ state: 'PENDING' }]);
    await expect(runFlightCommand('email-hold-campaign', { apply: true }, store, OPEN, ctx)).rejects.toThrow('ARGUMENT_REQUIRED: --keep');
    expect(await runFlightCommand('email-hold-campaign', { keep: 'GROUP_BOARDING', apply: true }, store, OPEN, ctx)).toMatchObject({ held: 4 });
    expect(await runFlightCommand('email-hold-campaign', { keep: 'GROUP_BOARDING', apply: true }, store, OPEN, ctx)).toMatchObject({ toHold: 0, held: 0 });
    // 09:00: resume. One cycle sends Email 3 (all in Portuguese, the guest included) and the access email, nothing else.
    await outbox.setPaused(false, null);
    const fake = fakeProvider();
    await delivery(fake.provider, () => OPEN + 5000).cycle();
    const sentIds = fake.sent.map(e => e.idempotencyKey);
    expect(sentIds).toEqual(expect.arrayContaining([...listed, essential]));
    // Anything else sent is an Email 3 the worker scheduled at opening for another list entry: never a held template.
    expect(await rows(`SELECT DISTINCT template FROM flight_emails WHERE email_id = ANY($1::text[]) ORDER BY 1`, [sentIds]))
      .toEqual([{ template: 'ACCESS_REQUESTED' }, { template: 'GROUP_BOARDING' }]);
    expect(sentIds.some(id => others.includes(id))).toBe(false);
    for (const email of fake.sent.filter(e => listed.includes(e.idempotencyKey))) {
      expect(email.subject).toBe('Seu grupo está embarcando ✈️');
      expect(email.text).toContain('O que dá para testar hoje');
    }
    expect(fake.sent.some(e => e.subject.startsWith('Seu convite'))).toBe(false); // no Email 6
    expect(await rows(`SELECT DISTINCT state, status_reason FROM flight_emails WHERE email_id = ANY($1::text[])`, [others]))
      .toEqual([{ state: 'HELD', status_reason: 'OPERATOR_HOLD' }]);
    // The guest keeps the invite and the list entry; access by the Email 3 link stays theirs.
    expect(await rows('SELECT * FROM flight_invites WHERE code = $1', [invite.code])).toEqual(inviteBefore);
    expect(await rows(`SELECT boarded_at FROM flight_list_entries WHERE email = 'release-guest@flofi-test.dev'`)).toEqual([{ boarded_at: null }]);
    // Later, by the team's decision: release only the 4a cards; Email 6 stays held.
    expect(await runFlightCommand('email-release', { reason: 'OPERATOR_HOLD', template: 'CARD_FOUNDING' }, store, OPEN + 6000, ctx)).toEqual({ released: 2 });
    expect(await rows(`SELECT state FROM flight_emails WHERE email_id = $1`, [others[3]])).toEqual([{ state: 'HELD' }]);
  });
});
