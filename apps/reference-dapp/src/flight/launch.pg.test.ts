// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001 on real disposable PostgreSQL (loopback only): the email outbox and its quota under concurrent workers,
 * every provider outcome (a FAKE provider in this process: it proves FloFi's handling, never delivery by Resend), scheduling of Email 2 and
 * Email 3, unsubscribe, access links and codes (scanner, expiry, single use, brute force, another device, account takeover), invites that
 * never propagate, the creators' TEST card, card public ids and card emails. Test data only, in a database created and dropped here.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@defi-workflow-engine/cloud-runtime';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { ACCESS_LINK_MS, ACCESS_SESSION_MS, addressHash, CODE_MAX_ATTEMPTS, codeFor, linkTokenFor } from './access';
import { createAccessStore, type AccessStore } from './access-store';
import { FLIGHT_DEFAULT_CALENDAR, flightRoute } from './campaign';
import { createEmailDelivery } from './email/delivery';
import { createEmailOutbox, type EmailOutbox } from './email/outbox';
import type { OutgoingEmail, SendOutcome } from './email/resend';
import { createFlightStore, type FlightStore } from './store';

type Node = SemanticWorkflow['nodes'][number];
const SECRET = randomBytes(32).toString('base64url'); // Per run: no secret-like literal is committed.
const CAL = FLIGHT_DEFAULT_CALENDAR;
const BEFORE = CAL.listClosesAt - 3 * 86_400_000, BOARDING = CAL.boardingOpensAt + 60_000;
let t: TestDatabase, store: FlightStore, access: AccessStore;
const hex = (n: number) => randomBytes(n).toString('hex');
const logger = createLogger({ service: 'flight-launch-test', sink: () => undefined });
const node = (actionType: string, chainId: string, protocols: string[]): Node => ({ nodeId: 'n1', actionType, actionSchemaVersion: '1.0.0', chainId, requiredCapabilities: [],
  adapterConstraints: { adapters: [], protocols }, inputs: [], expectedOutputs: [], dependencies: [], userConstraints: [], failurePolicy: 'HALT',
  requiredAuthorizationClass: 'WALLET', lockedParameters: [], editableBounds: [] } as unknown as Node);
const swap = [node('asset.swap.exact-input', 'eip155:8453', ['uniswap'])];

async function newAccount(): Promise<string> {
  const accountId = `acct_${hex(16)}`;
  await t.db.query('INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ($1, $2)', ['default', accountId]);
  return accountId;
}
const simulate = (accountId: string, workflowId: string, now = BOARDING) =>
  store.recordSimulation({ accountId, runId: `run-${hex(6)}`, flow: 'swap', workflowId, revision: 1, route: flightRoute(swap)!, now });
const rows = async (sql: string, values: unknown[] = []) => (await t.db.query<Record<string, unknown>>(sql, values)).rows;
async function emailsOf(recipient: string) {
  return rows(`SELECT template, state, status_reason, attempts, provider_id FROM flight_emails WHERE recipient = $1 ORDER BY created_at`, [recipient]);
}

/** A fake provider: records every request and answers what the test scripts (never a network call). */
function fakeProvider(script: (email: OutgoingEmail, call: number) => SendOutcome = () => ({ kind: 'SENT', providerId: `fake-${hex(4)}` })) {
  const sent: OutgoingEmail[] = [];
  return { sent, provider: { async send(email: OutgoingEmail) { sent.push(email); return script(email, sent.length); }, async domainStatus(): Promise<'VERIFIED' | 'NOT_VERIFIED' | 'UNKNOWN'> { return 'VERIFIED'; } } };
}
function delivery(outbox: EmailOutbox, provider: ReturnType<typeof fakeProvider>['provider'], now: () => number, extra: { domainAttested?: boolean } = {}) {
  return createEmailDelivery({ db: t.db, tenantId: 'default', calendar: CAL, secret: SECRET, origin: 'https://flofi.xyz', provider, outbox, store, access, logger,
    now, sleep: async () => undefined, perSecond: 50, batchSize: 50, ...extra });
}

beforeAll(async () => {
  t = await createTestDatabase();
  store = createFlightStore({ db: t.db, tenantId: 'default' }, CAL);
  access = createAccessStore({ db: t.db, tenantId: 'default' }, SECRET);
});
afterAll(async () => { await t?.drop(); });

describe('list sign-up emails', () => {
  it('enqueues Email 1 once per new beta-list address, Email 5 for the next flight, nothing for a repeat; consent and validity are the route’s', async () => {
    await store.joinList({ email: 'one@flofi-test.dev', language: 'PT', flight: 'FIRST', client: null, now: BEFORE });
    await store.joinList({ email: 'one@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE + 1000 });
    await store.joinList({ email: 'next@flofi-test.dev', language: 'EN', flight: 'NEXT', client: null, now: BEFORE });
    expect(await emailsOf('one@flofi-test.dev')).toEqual([{ template: 'LIST_CONFIRMATION', state: 'PENDING', status_reason: null, attempts: 0, provider_id: null }]);
    expect((await rows(`SELECT language FROM flight_emails WHERE recipient = 'one@flofi-test.dev'`))[0]).toEqual({ language: 'PT' });
    expect((await emailsOf('next@flofi-test.dev')).map(e => e.template)).toEqual(['NEXT_FLIGHT']);
    const outbox = createEmailOutbox({ db: t.db, tenantId: 'default' }), fake = fakeProvider();
    const report = await delivery(outbox, fake.provider, () => BEFORE + 5000).cycle();
    expect(report.sent).toBeGreaterThanOrEqual(2);
    const pt = fake.sent.find(e => e.to === 'one@flofi-test.dev')!;
    expect(pt.subject).toBe('Você está na lista beta da FloFi ✈️');
    expect(pt.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // Sent once: a second cycle sends nothing again.
    const again = await delivery(outbox, fake.provider, () => BEFORE + 60_000).cycle();
    expect(fake.sent.filter(e => e.to === 'one@flofi-test.dev')).toHaveLength(1);
    expect(again.sent).toBe(0);
    expect((await emailsOf('one@flofi-test.dev'))[0]).toMatchObject({ state: 'SENT', attempts: 1 });
  });
});

describe('quota and delivery outcomes', () => {
  it('reserves the daily quota atomically across concurrent workers and holds what does not fit, without losing it', async () => {
    const limits = { daily: 5, monthly: 3000, externalDailyReserve: 0, externalMonthlyReserve: 0 };
    const now = BEFORE - 86_400_000;
    for (let i = 0; i < 9; i++) await store.joinList({ email: `quota${i}@flofi-test.dev`, language: 'EN', flight: 'FIRST', client: null, now });
    // Emails already reserved today count (the earlier test's sends happened on another day).
    const workers = Array.from({ length: 4 }, () => createEmailOutbox({ db: t.open(4), tenantId: 'default' }, limits));
    const leased = (await Promise.all(workers.map(outbox => outbox.lease(now + 1000, { max: 10, campaign: true })))).flat();
    expect(leased).toHaveLength(5);
    expect(new Set(leased.map(e => e.emailId)).size).toBe(5);
    const held = await rows(`SELECT count(*)::int AS n FROM flight_emails WHERE recipient LIKE 'quota%' AND state = 'HELD' AND status_reason = 'QUOTA_DAILY'`);
    expect(held).toEqual([{ n: 4 }]);
    const outbox = workers[0]!;
    expect((await outbox.status(now + 1000)).usage.day).toBe(5);
    // The team decides (next day, or a higher limit): released, they go out; nothing was lost or sent twice.
    for (const row of leased) await outbox.settle(row, { kind: 'SENT', providerId: 'p' }, now + 2000);
    // (Two days later: a day with no other reservation, so all four fit.)
    expect(await outbox.release({ reason: 'QUOTA_DAILY' }, now + 2 * 86_400_000)).toBe(4);
    expect((await outbox.lease(now + 2 * 86_400_000 + 1000, { max: 10, campaign: true })).length).toBe(4);
  });

  it('holds a whole batch that does not fit instead of sending part of it; an operator may release an explicit block', async () => {
    const day = BEFORE - 2 * 86_400_000, limits = { daily: 3, monthly: 3000, externalDailyReserve: 0, externalMonthlyReserve: 0 };
    const outbox = createEmailOutbox({ db: t.db, tenantId: 'default' }, limits);
    await t.db.query(`UPDATE flight_emails SET state = 'CANCELLED', reserved_at = NULL, lease_token = NULL, lease_until = NULL WHERE state IN ('PENDING', 'HELD', 'UNKNOWN', 'SENDING')`);
    for (let i = 0; i < 5; i++) await t.db.query(`INSERT INTO flight_emails (tenant_id, email_id, dedupe_key, template, template_version, category, recipient, language, trigger,
      batch_key, not_before, next_attempt_at) VALUES ('default', $1, $2, 'EVE', 1, 'CAMPAIGN', $3, 'EN', 'test', 'batch-test', $4, $4)`,
    [`fem_${hex(16)}`, `batch-test:${i}`, `batch${i}@flofi-test.dev`, new Date(day).toISOString()]);
    expect(await outbox.lease(day, { max: 10, campaign: true })).toHaveLength(0);
    expect(await rows(`SELECT state, status_reason, count(*)::int AS n FROM flight_emails WHERE batch_key = 'batch-test' GROUP BY 1, 2`))
      .toEqual([{ state: 'HELD', status_reason: 'QUOTA_DAILY', n: 5 }]);
    expect((await outbox.status(day)).held).toContainEqual({ batch: 'batch-test', reason: 'QUOTA_DAILY', template: 'EVE', emails: 5 });
    // The operator chooses to send 3 today: exactly those, never more.
    expect(await outbox.release({ batchKey: 'batch-test', max: 3 }, day)).toBe(3);
    expect(await outbox.lease(day + 1, { max: 10, campaign: true })).toHaveLength(3);
    expect(await outbox.cancel({ batchKey: 'batch-test' })).toBe(2);
  });

  it('never assumes a timeout was not sent: retries with the same idempotency key, recovers a crashed worker, holds when unresolved', async () => {
    const day = BEFORE - 4 * 86_400_000, outbox = createEmailOutbox({ db: t.db, tenantId: 'default' });
    await t.db.query(`UPDATE flight_emails SET state = 'CANCELLED', reserved_at = NULL, lease_token = NULL, lease_until = NULL WHERE state IN ('PENDING', 'HELD', 'UNKNOWN', 'SENDING')`);
    await store.joinList({ email: 'timeout@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: day });
    const timeout = fakeProvider(() => ({ kind: 'UNKNOWN', code: 'PROVIDER_TIMEOUT' }));
    await delivery(outbox, timeout.provider, () => day + 1000).cycle();
    expect(await emailsOf('timeout@flofi-test.dev')).toEqual([{ template: 'LIST_CONFIRMATION', state: 'UNKNOWN', status_reason: 'PROVIDER_TIMEOUT', attempts: 1, provider_id: null }]);
    const ok = fakeProvider();
    await delivery(outbox, ok.provider, () => day + 10 * 60_000).cycle();
    // The retry carries the same key and the same body: the provider deduplicates it, never two emails.
    expect(ok.sent[0]!.idempotencyKey).toBe(timeout.sent[0]!.idempotencyKey);
    expect(ok.sent[0]!.html).toBe(timeout.sent[0]!.html);
    expect((await emailsOf('timeout@flofi-test.dev'))[0]).toMatchObject({ state: 'SENT', attempts: 2 });
    // A worker that dies after leasing: the lease expires, the email becomes UNKNOWN (it may have reached the provider), then is retried.
    await store.joinList({ email: 'crash@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: day });
    const [crashed] = (await outbox.lease(day + 20 * 60_000, { max: 50, campaign: true })).filter(e => e.recipient === 'crash@flofi-test.dev');
    expect(crashed).toBeDefined();
    await outbox.housekeeping(day + 30 * 60_000);
    expect((await emailsOf('crash@flofi-test.dev'))[0]).toMatchObject({ state: 'UNKNOWN', status_reason: 'LEASE_EXPIRED' });
    // The crashed worker's late settlement is fenced off by its lost lease.
    expect(await outbox.settle(crashed!, { kind: 'FAILED', code: 'LATE' }, day + 31 * 60_000)).toBe(false);
    // Past the provider's 24-hour idempotency window an unknown outcome is held for an operator, never resent blindly.
    await t.db.query(`UPDATE flight_emails SET state = 'CANCELLED', reserved_at = NULL WHERE state = 'PENDING'`);
    expect(await outbox.lease(day + 25 * 3_600_000, { max: 50, campaign: true })).toEqual([]);
    expect((await emailsOf('crash@flofi-test.dev'))[0]).toMatchObject({ state: 'HELD', status_reason: 'UNRESOLVED_OUTCOME' });
    expect(await outbox.release({ reason: 'UNRESOLVED_OUTCOME' }, day)).toBe(0);
  });

  it('stops on the provider’s own quota or key error, retries a rate limit later, fails a rejected email, and pauses campaign email on demand', async () => {
    const day = BEFORE - 6 * 86_400_000, outbox = createEmailOutbox({ db: t.db, tenantId: 'default' });
    await t.db.query(`UPDATE flight_emails SET state = 'CANCELLED', reserved_at = NULL, lease_token = NULL, lease_until = NULL WHERE state IN ('PENDING', 'HELD', 'UNKNOWN', 'SENDING')`);
    for (let i = 0; i < 3; i++) await store.joinList({ email: `provider${i}@flofi-test.dev`, language: 'EN', flight: 'FIRST', client: null, now: day });
    const quota = fakeProvider(() => ({ kind: 'QUOTA', code: 'PROVIDER_QUOTA_DAILY' }));
    const report = await delivery(outbox, quota.provider, () => day + 1000).cycle();
    expect(quota.sent).toHaveLength(1);
    expect(report).toMatchObject({ held: 1, retried: 2 });
    expect((await outbox.control()).blockedReason).toBe('PROVIDER_QUOTA_DAILY');
    expect(await delivery(outbox, fakeProvider().provider, () => day + 2000).cycle()).toMatchObject({ skipped: 'PROVIDER_QUOTA_DAILY', leased: 0 });
    await outbox.clearBlock();
    const rejected = fakeProvider(() => ({ kind: 'REJECTED', code: 'PROVIDER_VALIDATION' }));
    await delivery(outbox, rejected.provider, () => day + 5 * 60_000).cycle();
    expect((await rows(`SELECT state FROM flight_emails WHERE recipient LIKE 'provider%' AND state = 'FAILED'`)).length).toBe(2);
    const limited = fakeProvider(() => ({ kind: 'RETRY', code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 2000 }));
    await outbox.release({ reason: 'PROVIDER_QUOTA_DAILY' }, day + 6 * 60_000);
    await delivery(outbox, limited.provider, () => day + 6 * 60_000).cycle();
    expect((await rows(`SELECT state, status_reason FROM flight_emails WHERE recipient LIKE 'provider%' AND state = 'PENDING'`))[0]).toEqual({ state: 'PENDING', status_reason: 'PROVIDER_RATE_LIMITED' });
    // Paused: campaign email waits (not lost); an access email the person asked for still goes out.
    await outbox.setPaused(true, 'incident drill');
    expect((await delivery(outbox, fakeProvider().provider, () => day + 10 * 60_000).cycle()).leased).toBe(0);
    await outbox.setPaused(false, null);
    expect((await delivery(outbox, fakeProvider().provider, () => day + 10 * 60_000).cycle()).sent).toBe(1);
  });

  it('never bulk-releases an email the provider may already have sent, and keeps counting its reservation', async () => {
    const day = BEFORE - 8 * 86_400_000, outbox = createEmailOutbox({ db: t.db, tenantId: 'default' });
    await t.db.query(`UPDATE flight_emails SET state = 'CANCELLED', reserved_at = NULL, lease_token = NULL, lease_until = NULL WHERE state IN ('PENDING', 'HELD', 'UNKNOWN', 'SENDING')`);
    await store.joinList({ email: 'conflict@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: day });
    const conflict = fakeProvider(() => ({ kind: 'CONFLICT', code: 'PROVIDER_IDEMPOTENCY_BODY_CHANGED' }));
    await delivery(outbox, conflict.provider, () => day + 1000).cycle();
    expect((await emailsOf('conflict@flofi-test.dev'))[0]).toMatchObject({ state: 'HELD', status_reason: 'PROVIDER_IDEMPOTENCY_BODY_CHANGED' });
    expect((await outbox.usage(day + 2000)).day).toBe(1);
    expect(await outbox.release({ reason: 'PROVIDER_IDEMPOTENCY_BODY_CHANGED' }, day + 3000)).toBe(0);
    const [held] = await rows(`SELECT email_id FROM flight_emails WHERE recipient = 'conflict@flofi-test.dev'`);
    expect(await outbox.markDelivered(held!.email_id as string, 'resend-checked', day + 4000)).toBe(true);
    expect((await emailsOf('conflict@flofi-test.dev'))[0]).toMatchObject({ state: 'SENT' });
  });

  it('an email of unknown outcome caught in a provider stop stays UNKNOWN and is held after 24 hours, never resent blindly', async () => {
    const day = BEFORE - 12 * 86_400_000, outbox = createEmailOutbox({ db: t.db, tenantId: 'default' });
    await t.db.query(`UPDATE flight_emails SET state = 'CANCELLED', reserved_at = NULL, lease_token = NULL, lease_until = NULL WHERE state IN ('PENDING', 'HELD', 'UNKNOWN', 'SENDING')`);
    await outbox.clearBlock();
    await store.joinList({ email: 'unk1@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: day });
    await delivery(outbox, fakeProvider(() => ({ kind: 'UNKNOWN', code: 'PROVIDER_TIMEOUT' })).provider, () => day).cycle();
    await store.joinList({ email: 'unk0@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: day + 5 * 60_000 });
    // The next cycle: the fresh email hits the provider's quota first, the unknown one is caught by the stop.
    await t.db.query(`UPDATE flight_emails SET next_attempt_at = $1 WHERE recipient = 'unk1@flofi-test.dev'`, [new Date(day + 7 * 60_000).toISOString()]);
    await delivery(outbox, fakeProvider(() => ({ kind: 'QUOTA', code: 'PROVIDER_QUOTA_MONTHLY' })).provider, () => day + 6 * 60_000).cycle();
    expect((await emailsOf('unk1@flofi-test.dev'))[0]).toMatchObject({ state: 'UNKNOWN' });
    await outbox.clearBlock();
    expect((await outbox.lease(day + 26 * 3_600_000, { max: 50, campaign: true })).some(e => e.recipient === 'unk1@flofi-test.dev')).toBe(false);
    expect((await emailsOf('unk1@flofi-test.dev'))[0]).toMatchObject({ state: 'HELD', status_reason: 'UNRESOLVED_OUTCOME' });
    // Expiry and bulk cancel leave a possibly-sent hold for the operator.
    expect(await outbox.cancel({ template: 'LIST_CONFIRMATION' })).toBeGreaterThanOrEqual(0);
    expect((await emailsOf('unk1@flofi-test.dev'))[0]).toMatchObject({ state: 'HELD', status_reason: 'UNRESOLVED_OUTCOME' });
  });

  it('prunes settled emails after 90 days and expired access records from the delivery cycle (no page visit needed)', async () => {
    const old = BEFORE - 200 * 86_400_000, outbox = createEmailOutbox({ db: t.db, tenantId: 'default' });
    await t.db.query(`INSERT INTO flight_emails (tenant_id, email_id, dedupe_key, template, template_version, category, recipient, language, trigger, state, not_before,
      next_attempt_at, reserved_at, sent_at, updated_at) VALUES ('default', $1, $2, 'EVE', 1, 'CAMPAIGN', 'old@flofi-test.dev', 'EN', 'test', 'SENT', $3, $3, $3, $3, $3)`,
    [`fem_${hex(16)}`, `old:${hex(4)}`, new Date(old).toISOString()]);
    await t.db.query(`INSERT INTO flight_access_attempts (tenant_id, kind, subject, attempted_at) VALUES ('default', 'CODE_CLIENT', $1, $2)`, ['a'.repeat(64), new Date(old).toISOString()]);
    await delivery(outbox, fakeProvider().provider, () => BEFORE - 9 * 86_400_000).cycle();
    expect(await rows(`SELECT count(*)::int AS n FROM flight_emails WHERE recipient = 'old@flofi-test.dev'`)).toEqual([{ n: 0 }]);
    expect(await rows(`SELECT count(*)::int AS n FROM flight_access_attempts WHERE attempted_at < $1`, [new Date(BEFORE - 100 * 86_400_000).toISOString()])).toEqual([{ n: 0 }]);
  });

  it('does not send while the domain is not verified on the provider account', async () => {
    const outbox = createEmailOutbox({ db: t.db, tenantId: 'default' });
    await outbox.clearBlock();
    const unverified = { ...fakeProvider().provider, domainStatus: async () => 'NOT_VERIFIED' as const };
    expect(await delivery(outbox, unverified, () => BOARDING).cycle()).toMatchObject({ skipped: 'DOMAIN_NOT_VERIFIED', leased: 0 });
  });
});

describe('scheduled campaign emails and unsubscribe', () => {
  it('schedules Email 2 at 20:00 BRT the evening before (not before), skips unsubscribed and boarded addresses, and expires at boarding', async () => {
    const outbox = createEmailOutbox({ db: t.db, tenantId: 'default' });
    await t.db.query(`UPDATE flight_emails SET state = 'CANCELLED', reserved_at = NULL, lease_token = NULL, lease_until = NULL WHERE state IN ('PENDING', 'HELD', 'UNKNOWN', 'SENDING')`);
    await store.joinList({ email: 'eve-out@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    await outbox.suppress(addressHash('eve-out@flofi-test.dev'), 'UNSUBSCRIBED');
    expect(await outbox.scheduleEve(CAL.eveEmailAt - 1, CAL.eveEmailAt, CAL.boardingOpensAt)).toBe(0);
    const scheduled = await outbox.scheduleEve(CAL.eveEmailAt, CAL.eveEmailAt, CAL.boardingOpensAt);
    expect(scheduled).toBeGreaterThan(0);
    expect(await outbox.scheduleEve(CAL.eveEmailAt + 60_000, CAL.eveEmailAt, CAL.boardingOpensAt)).toBe(0); // Idempotent: re-runs and restarts enqueue nothing.
    expect((await emailsOf('eve-out@flofi-test.dev')).some(e => e.template === 'EVE')).toBe(false);
    // Not sent by boarding time: cancelled as expired, never sent late.
    await outbox.housekeeping(CAL.boardingOpensAt + 1);
    expect((await rows(`SELECT count(*)::int AS n FROM flight_emails WHERE template = 'EVE' AND state = 'PENDING'`))).toEqual([{ n: 0 }]);
  });

  it('one-click unsubscribe cancels pending campaign email to the address and blocks future ones', async () => {
    const outbox = createEmailOutbox({ db: t.db, tenantId: 'default' });
    await store.joinList({ email: 'bye@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE + 5 * 86_400_000 });
    await outbox.unsubscribe(addressHash('bye@flofi-test.dev'));
    expect((await emailsOf('bye@flofi-test.dev'))[0]).toMatchObject({ state: 'CANCELLED', status_reason: 'UNSUBSCRIBED' });
    expect(await outbox.isSuppressed(addressHash('bye@flofi-test.dev'))).toBe(true);
    // The opt-out does not depend on the email's record: after erasure the digest still suppresses (and erasure keeps it).
    await store.eraseEmail('bye@flofi-test.dev');
    expect(await outbox.isSuppressed(addressHash('bye@flofi-test.dev'))).toBe(true);
    await outbox.unsubscribe(addressHash('gone@flofi-test.dev'));
    expect(await outbox.isSuppressed(addressHash('gone@flofi-test.dev'))).toBe(true);
  });
});

describe('access by link and code', () => {
  let entryId: string, emailId: string;
  beforeAll(async () => {
    await store.joinList({ email: 'board@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    entryId = (await rows(`SELECT entry_id FROM flight_list_entries WHERE email = 'board@flofi-test.dev'`))[0]!.entry_id as string;
  });

  it('schedules Email 3 when the group opens, with a link and a code that only the email carries (only digests stored)', async () => {
    const outbox = createEmailOutbox({ db: t.db, tenantId: 'default' });
    await t.db.query(`UPDATE flight_emails SET state = 'CANCELLED', reserved_at = NULL, lease_token = NULL, lease_until = NULL WHERE state IN ('PENDING', 'HELD', 'UNKNOWN', 'SENDING')`);
    expect(await outbox.scheduleBoarding(CAL.boardingOpensAt - 1, CAL.boardingOpensAt)).toBe(0);
    expect(await outbox.scheduleBoarding(BOARDING, CAL.boardingOpensAt)).toBeGreaterThan(0);
    const fake = fakeProvider();
    await delivery(createEmailOutbox({ db: t.db, tenantId: 'default' }, { daily: 10_000, monthly: 100_000, externalDailyReserve: 0, externalMonthlyReserve: 0 }),
      fake.provider, () => BOARDING).cycle();
    const sent = fake.sent.find(e => e.to === 'board@flofi-test.dev')!;
    emailId = sent.idempotencyKey;
    expect(sent.subject).toBe('Your group is boarding ✈️');
    expect(sent.html).toContain(`https://flofi.xyz/board/access?l=en#t=${linkTokenFor(SECRET, emailId)}`);
    expect(sent.text).toContain(codeFor(SECRET, emailId));
    const stored = JSON.stringify(await rows(`SELECT * FROM flight_access_tokens WHERE entry_id = $1`, [entryId]));
    expect(stored).not.toContain(linkTokenFor(SECRET, emailId));
    expect(stored).not.toContain(`"${codeFor(SECRET, emailId)}"`);
  });

  it('opening the link consumes nothing; Continue binds the entry to the signed-in account once; replay, expiry and garbage are refused', async () => {
    const link = linkTokenFor(SECRET, emailId), person = await newAccount();
    // A scanner or preview only opens the page: the token row is untouched.
    expect((await rows(`SELECT consumed_at FROM flight_access_tokens WHERE entry_id = $1`, [entryId]))[0]).toEqual({ consumed_at: null });
    expect(await access.consumeLink({ token: 'x'.repeat(43), accountId: person, client: null, now: BOARDING })).toEqual({ status: 'INVALID' });
    expect(await access.consumeLink({ token: link, accountId: person, client: null, now: BOARDING + ACCESS_LINK_MS + 1 })).toEqual({ status: 'EXPIRED' });
    expect(await access.consumeLink({ token: link, accountId: person, client: '203.0.113.7', now: BOARDING })).toEqual({ status: 'CLAIMED' });
    expect(await access.consumeLink({ token: link, accountId: person, client: '203.0.113.7', now: BOARDING })).toEqual({ status: 'USED' });
    // The proven entry makes the account eligible (a wallet-only login has no verified email of its own); nothing else changed.
    expect((await store.account({ accountId: person, emails: [], now: BOARDING })).access).toEqual({ kind: 'eligible', origin: 'LIST' });
    expect(await rows(`SELECT count(*)::int AS n FROM flofi_accounts WHERE account_id = $1`, [person])).toEqual([{ n: 1 }]);
    // The card then marks the claimed entry boarded and goes to the proven address.
    await simulate(person, 'wf-claimed');
    const issued = await store.issuePass({ accountId: person, emails: [], workflowId: 'wf-claimed', handle: null, public: false, now: BOARDING });
    expect(issued).toMatchObject({ ok: true, issued: true, pass: { origin: 'LIST' } });
    expect((await emailsOf('board@flofi-test.dev')).map(e => e.template)).toContain(issued.ok && issued.pass.foundingSeat ? 'CARD_FOUNDING' : 'CARD_PASSENGER');
    expect((await rows(`SELECT boarded_at IS NOT NULL AS boarded FROM flight_list_entries WHERE entry_id = $1`, [entryId]))[0]).toEqual({ boarded: true });
  });

  it('a code on another device: proves the address before sign-in (browser session), then binds on sign-in; never an account takeover', async () => {
    await store.joinList({ email: 'device@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    const entry = (await rows(`SELECT entry_id FROM flight_list_entries WHERE email = 'device@flofi-test.dev'`))[0]!.entry_id as string;
    const id = `fem_${hex(16)}`, token = await access.issueToken({ emailId: id, entryId: entry, codeMs: 15 * 60_000, now: BOARDING });
    const wrong = token.code === '000000' ? '111111' : '000000';
    expect(await access.consumeCode({ email: 'device@flofi-test.dev', code: wrong, accountId: null, client: '198.51.100.1', now: BOARDING })).toEqual({ status: 'INVALID' });
    // An unknown address answers exactly like a wrong code (no enumeration).
    expect(await access.consumeCode({ email: 'nobody@flofi-test.dev', code: token.code, accountId: null, client: '198.51.100.1', now: BOARDING })).toEqual({ status: 'INVALID' });
    const session = await access.consumeCode({ email: 'device@flofi-test.dev', code: token.code, accountId: null, client: '198.51.100.1', now: BOARDING });
    expect(session.status).toBe('SESSION');
    const secret = (session as { session: string }).session;
    expect(JSON.stringify(await rows(`SELECT * FROM flight_access_sessions`))).not.toContain(secret);
    // Somebody else's account cannot take an entry already bound to another account.
    const owner = await newAccount(), intruder = await newAccount();
    expect(await access.bindSession({ session: secret, accountId: owner, now: BOARDING })).toBe('CLAIMED');
    expect(await access.bindSession({ session: secret, accountId: intruder, now: BOARDING })).toBe('NONE'); // A session binds once.
    const id2 = `fem_${hex(16)}`, again = await access.issueToken({ emailId: id2, entryId: entry, codeMs: 15 * 60_000, now: BOARDING });
    expect(await access.consumeLink({ token: linkTokenFor(SECRET, id2), accountId: intruder, client: null, now: BOARDING })).toEqual({ status: 'CLAIMED_ELSEWHERE' });
    // The refused attempt left the token unused (the owner can still use it).
    expect(await access.consumeCode({ email: 'device@flofi-test.dev', code: again.code, accountId: owner, client: null, now: BOARDING })).toEqual({ status: 'CLAIMED' });
    // An account that already holds an entry cannot take a second one.
    await store.joinList({ email: 'second@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    const entry2 = (await rows(`SELECT entry_id FROM flight_list_entries WHERE email = 'second@flofi-test.dev'`))[0]!.entry_id as string;
    const id3 = `fem_${hex(16)}`;
    await access.issueToken({ emailId: id3, entryId: entry2, codeMs: 15 * 60_000, now: BOARDING });
    expect(await access.consumeLink({ token: linkTokenFor(SECRET, id3), accountId: owner, client: null, now: BOARDING })).toEqual({ status: 'ACCOUNT_HAS_OTHER_ENTRY' });
  });

  it('persists verified-email boarding access for later wallet sessions, without binding during an account read or permitting a second account', async () => {
    const email = 'recurring@flofi-test.dev', owner = await newAccount(), other = await newAccount();
    await store.joinList({ email, language: 'PT', flight: 'FIRST', client: null, now: BEFORE });
    const input = { accountId: owner, emails: [email], now: BOARDING };
    expect((await store.account(input)).access).toEqual({ kind: 'eligible', origin: 'LIST' });
    expect(await rows('SELECT count(*)::int AS n FROM flight_access_claims WHERE account_id = $1', [owner])).toEqual([{ n: 0 }]);
    // Only the explicit Board now handler calls this method with the server's verified identities.
    expect(await store.claimVerifiedEntry(input)).toBe('CLAIMED');
    expect(await store.claimVerifiedEntry(input)).toBe('CLAIMED');
    expect(await store.claimVerifiedEntry({ accountId: other, emails: [email], now: BOARDING })).toBe('CLAIMED_ELSEWHERE');
    // A new request/device needs only the same authenticated account, even without an email identity in that session.
    expect((await store.account({ accountId: owner, emails: [], now: BOARDING })).access).toEqual({ kind: 'eligible', origin: 'LIST' });
    expect((await store.account({ accountId: other, emails: [email], now: BOARDING })).access.kind).toBe('not_listed');
    await simulate(other, 'wf-denied-recurring');
    expect(await store.issuePass({ accountId: other, emails: [email], workflowId: 'wf-denied-recurring', handle: null, public: false, now: BOARDING }))
      .toEqual({ ok: false, code: 'FLIGHT_NOT_ELIGIBLE' });
    await simulate(owner, 'wf-recurring');
    const issued = await store.issuePass({ accountId: owner, emails: [], workflowId: 'wf-recurring', handle: null, public: false, now: BOARDING });
    expect(issued).toMatchObject({ ok: true, issued: true });
    const repeated = await store.issuePass({ accountId: owner, emails: [], workflowId: null, handle: null, public: false, now: BOARDING + 60_000 });
    expect(repeated).toMatchObject({ ok: true, issued: false });
    expect(repeated.ok && issued.ok && repeated.pass.passId).toBe(issued.ok && issued.pass.passId);
    expect((await rows('SELECT language FROM flight_emails WHERE recipient = $1 AND template IN (\'CARD_FOUNDING\', \'CARD_PASSENGER\')', [email])))
      .toEqual([{ language: 'PT' }]);
  });

  it('a claimed link cannot be bypassed using another account with the same verified address; an expired pending session grants nothing', async () => {
    const email = 'claimed-owner@flofi-test.dev', owner = await newAccount(), other = await newAccount();
    await store.joinList({ email, language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    const entry = (await rows('SELECT entry_id FROM flight_list_entries WHERE email = $1', [email]))[0]!.entry_id as string;
    const id = `fem_${hex(16)}`;
    const token = await access.issueToken({ emailId: id, entryId: entry, codeMs: 15 * 60_000, now: BOARDING });
    const pending = await access.consumeLink({ token: token.link, accountId: null, client: null, now: BOARDING });
    expect(pending.status).toBe('SESSION');
    expect(await access.bindSession({ session: (pending as { session: string }).session, accountId: other, now: BOARDING + ACCESS_SESSION_MS })).toBe('NONE');
    expect((await store.account({ accountId: other, emails: [], now: BOARDING })).access.kind).toBe('not_listed');
    const next = await access.issueToken({ emailId: `fem_${hex(16)}`, entryId: entry, codeMs: 15 * 60_000, now: BOARDING });
    expect(await access.consumeLink({ token: next.link, accountId: owner, client: null, now: BOARDING })).toEqual({ status: 'CLAIMED' });
    expect((await store.account({ accountId: other, emails: [email], now: BOARDING })).access.kind).toBe('not_listed');
    expect(await access.consumeCode({ email, code: next.code, accountId: other, client: null, now: BOARDING })).toEqual({ status: 'INVALID' });
  });

  it('serializes a link claim against another account boarding on the verified address', async () => {
    const email = 'claim-race@flofi-test.dev', owner = await newAccount(), other = await newAccount();
    await store.joinList({ email, language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    const entry = (await rows('SELECT entry_id FROM flight_list_entries WHERE email = $1', [email]))[0]!.entry_id as string;
    const token = await access.issueToken({ emailId: `fem_${hex(16)}`, entryId: entry, codeMs: 15 * 60_000, now: BOARDING });
    await simulate(other, 'wf-race');
    const [claim, pass] = await Promise.all([
      access.consumeLink({ token: token.link, accountId: owner, client: null, now: BOARDING }),
      store.issuePass({ accountId: other, emails: [email], workflowId: 'wf-race', handle: null, public: false, now: BOARDING }),
    ]);
    expect(claim.status === 'CLAIMED' && pass.ok).toBe(false);
    if (claim.status === 'CLAIMED') expect(pass).toEqual({ ok: false, code: 'FLIGHT_NOT_ELIGIBLE' });
    else { expect(claim.status).toBe('BOARDED'); expect(pass).toMatchObject({ ok: true, issued: true }); }
  });

  it('shows the masked address before Continue, refuses an entry that already boarded, and never lets a test-flight simulation issue a numbered card', async () => {
    await store.joinList({ email: 'peek@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    const entry = (await rows(`SELECT entry_id FROM flight_list_entries WHERE email = 'peek@flofi-test.dev'`))[0]!.entry_id as string;
    const id = `fem_${hex(16)}`;
    await access.issueToken({ emailId: id, entryId: entry, codeMs: 15 * 60_000, now: BOARDING });
    expect(await access.peekLink({ token: linkTokenFor(SECRET, id), client: null, now: BOARDING })).toEqual({ address: 'p***@flofi-test.dev' });
    expect(await access.peekLink({ token: 'x'.repeat(43), client: null, now: BOARDING })).toBe('INVALID');
    // The entry boards (its owner signed in with that verified email): the still-unused link can no longer bind it to anyone.
    const owner = await newAccount();
    await simulate(owner, 'wf-peek');
    expect(await store.issuePass({ accountId: owner, emails: ['peek@flofi-test.dev'], workflowId: 'wf-peek', handle: null, public: false, now: BOARDING })).toMatchObject({ ok: true });
    const other = await newAccount();
    expect(await access.consumeLink({ token: linkTokenFor(SECRET, id), accountId: other, client: null, now: BOARDING })).toEqual({ status: 'BOARDED' });
    expect(await access.peekLink({ token: linkTokenFor(SECRET, id), client: null, now: BOARDING })).toBe('INVALID');
    // A creator's test-flight evidence (before boarding) never issues a real card at boarding, even inside its two-hour window.
    const [code] = await store.issueCreatorInvites(1, BEFORE);
    const creator = await newAccount();
    expect(await store.redeemInvite({ accountId: creator, code: code!, now: CAL.boardingOpensAt - 30 * 60_000 })).toBe('REDEEMED');
    await simulate(creator, 'wf-early', CAL.boardingOpensAt - 30 * 60_000);
    expect(await store.issuePass({ accountId: creator, emails: [], workflowId: 'wf-early', handle: null, public: false, now: CAL.boardingOpensAt + 60_000 }))
      .toEqual({ ok: false, code: 'FLIGHT_SIMULATION_NOT_FOUND' });
  });

  it('a browser session never binds an entry that boarded in the meantime', async () => {
    await store.joinList({ email: 'shared@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    const entry = (await rows(`SELECT entry_id FROM flight_list_entries WHERE email = 'shared@flofi-test.dev'`))[0]!.entry_id as string;
    const id = `fem_${hex(16)}`, token = await access.issueToken({ emailId: id, entryId: entry, codeMs: 15 * 60_000, now: BOARDING });
    const pending = await access.consumeCode({ email: 'shared@flofi-test.dev', code: token.code, accountId: null, client: null, now: BOARDING });
    expect(pending.status).toBe('SESSION');
    const owner = await newAccount();
    await simulate(owner, 'wf-shared');
    expect(await store.issuePass({ accountId: owner, emails: ['shared@flofi-test.dev'], workflowId: 'wf-shared', handle: null, public: false, now: BOARDING })).toMatchObject({ ok: true });
    const stranger = await newAccount();
    expect(await access.bindSession({ session: (pending as { session: string }).session, accountId: stranger, now: BOARDING })).toBe('NONE');
    expect(await rows(`SELECT count(*)::int AS n FROM flight_access_claims WHERE account_id = $1`, [stranger])).toEqual([{ n: 0 }]);
  });

  it('limits brute force: a code dies after 5 wrong tries, and tries per address and per client are limited', async () => {
    await store.joinList({ email: 'brute@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    const entry = (await rows(`SELECT entry_id FROM flight_list_entries WHERE email = 'brute@flofi-test.dev'`))[0]!.entry_id as string;
    const id = `fem_${hex(16)}`, token = await access.issueToken({ emailId: id, entryId: entry, codeMs: 15 * 60_000, now: BOARDING });
    const wrong = (n: number) => String((Number(token.code) + 1 + n) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i++)
      expect((await access.consumeCode({ email: 'brute@flofi-test.dev', code: wrong(i), accountId: null, client: `192.0.2.${i}`, now: BOARDING + i })).status).not.toBe('SESSION');
    // Now even the right code is refused (rate limited per address, and the code itself is spent).
    expect((await access.consumeCode({ email: 'brute@flofi-test.dev', code: token.code, accountId: null, client: '192.0.2.99', now: BOARDING + 10 })).status).toBe('RATE_LIMITED');
    expect((await access.consumeCode({ email: 'brute@flofi-test.dev', code: token.code, accountId: null, client: '192.0.2.99', now: BOARDING + 2 * 3_600_000 })).status).toBe('INVALID');
    // A code past its time is refused too.
    const late = `fem_${hex(16)}`, lateToken = await access.issueToken({ emailId: late, entryId: entry, codeMs: 15 * 60_000, now: BOARDING });
    expect((await access.consumeCode({ email: 'brute@flofi-test.dev', code: lateToken.code, accountId: null, client: null, now: BOARDING + 3 * 3_600_000 + 16 * 60_000 })).status).toBe('INVALID');
  });

  it('a link request answers the same for anyone and sends only to a listed address whose group is open (rate limited per address)', async () => {
    const open = () => true, closed = () => false;
    expect(await access.requestAccess({ email: 'stranger@flofi-test.dev', language: 'EN', client: null, now: BOARDING, groupOpen: open })).toBe('OK');
    expect(await emailsOf('stranger@flofi-test.dev')).toEqual([]);
    await store.joinList({ email: 'later@flofi-test.dev', language: 'PT', flight: 'FIRST', client: null, now: BEFORE });
    expect(await access.requestAccess({ email: 'later@flofi-test.dev', language: 'PT', client: null, now: BOARDING, groupOpen: closed })).toBe('OK');
    expect((await emailsOf('later@flofi-test.dev')).map(e => e.template)).toEqual(['LIST_CONFIRMATION']);
    // Repeated requests in one hour collapse into one queued email (and at most 3 are counted per address and hour).
    // Opening recovery on an English page must not change a Portuguese subscriber's email language.
    for (let i = 0; i < 5; i++) expect(await access.requestAccess({ email: 'later@flofi-test.dev', language: 'EN', client: null, now: BOARDING + i, groupOpen: open })).toBe('OK');
    expect((await emailsOf('later@flofi-test.dev')).filter(e => e.template === 'ACCESS_REQUESTED')).toHaveLength(1);
    expect(await rows(`SELECT language FROM flight_emails WHERE recipient = 'later@flofi-test.dev' AND template = 'ACCESS_REQUESTED'`)).toEqual([{ language: 'PT' }]);
    expect(await access.requestAccess({ email: 'later@flofi-test.dev', language: 'PT', client: null, now: BOARDING + 2 * 3_600_000, groupOpen: open })).toBe('OK');
    expect((await emailsOf('later@flofi-test.dev')).filter(e => e.template === 'ACCESS_REQUESTED')).toHaveLength(2);
    // A tenant-wide daily cap keeps requests from spending the email quota (the answer stays the same).
    await t.db.query(`INSERT INTO flight_emails (tenant_id, email_id, dedupe_key, template, template_version, category, recipient, language, trigger, not_before, next_attempt_at, created_at)
      SELECT 'default', 'fem_' || md5('cap' || g), 'cap:' || g, 'ACCESS_REQUESTED', 1, 'ESSENTIAL', 'cap' || g || '@flofi-test.dev', 'EN', 'access_requested', $1, $1, $1
      FROM generate_series(1, 30) g`, [new Date(BOARDING + 2 * 3_600_000).toISOString()]);
    expect(await access.requestAccess({ email: 'later@flofi-test.dev', language: 'PT', client: null, now: BOARDING + 4 * 3_600_000, groupOpen: open })).toBe('OK');
    expect((await emailsOf('later@flofi-test.dev')).filter(e => e.template === 'ACCESS_REQUESTED')).toHaveLength(2);
    await t.db.query(`DELETE FROM flight_emails WHERE dedupe_key LIKE 'cap:%'`);
    expect((await rows(`SELECT category FROM flight_emails WHERE recipient = 'later@flofi-test.dev' AND template = 'ACCESS_REQUESTED' LIMIT 1`))[0]).toEqual({ category: 'ESSENTIAL' });
  });
});

describe('invites, creators and cards', () => {
  it('a creator invite is addressed, traceable, sent once; the code redeems once; the test flight shows a TEST card that is never stored', async () => {
    const first = await store.inviteCreator({ email: 'creator@flofi-test.dev', language: 'PT', sendAt: Date.parse('2026-11-10T10:00:00-03:00'), now: BEFORE });
    const again = await store.inviteCreator({ email: 'creator@flofi-test.dev', language: 'PT', sendAt: BEFORE, now: BEFORE });
    expect(again).toEqual({ code: first.code, created: false });
    expect((await emailsOf('creator@flofi-test.dev')).map(e => e.template)).toEqual(['CREATOR_INVITE']);
    const creator = await newAccount(), other = await newAccount(), test = CAL.creatorsOpenAt + 60_000;
    expect(await store.redeemInvite({ accountId: creator, code: first.code, now: test })).toBe('REDEEMED');
    expect(await store.redeemInvite({ accountId: other, code: first.code, now: test })).toBe('INVITE_USED');
    expect((await store.account({ accountId: creator, emails: [], now: test })).access.kind).toBe('test_flight');
    await simulate(creator, 'wf-test', test);
    const view = await store.account({ accountId: creator, emails: [], now: test });
    expect(view.testPass).toMatchObject({ test: true, departedAt: new Date(CAL.boardingOpensAt).toISOString() });
    expect(await rows(`SELECT count(*)::int AS n FROM flight_passes WHERE account_id = $1`, [creator])).toEqual([{ n: 0 }]);
    // Outside the window: no test card, no pass; at 9:00 on the 12th the creator boards for real like everyone.
    expect((await store.account({ accountId: creator, emails: [], now: CAL.creatorsOpenAt + 5 * 3_600_000 })).access.kind).toBe('not_yet');
    await simulate(creator, 'wf-real', BOARDING);
    const real = await store.issuePass({ accountId: creator, emails: [], workflowId: 'wf-real', handle: null, public: false, now: BOARDING });
    expect(real).toMatchObject({ ok: true, issued: true, pass: { origin: 'CREATOR' } });
    // A creator invite's recipient is not proven to be who redeemed it (codes can be forwarded): a wallet-only account gets no card email
    // there; the card stays in the account. Invited people get no invites.
    expect((await emailsOf('creator@flofi-test.dev')).some(e => String(e.template).startsWith('CARD_'))).toBe(false);
    expect((await store.account({ accountId: creator, emails: [], now: BOARDING })).invites).toEqual([]);
  });

  it('gives each card a random public link that shows only the card; a taken-down card disappears; old cards get an id on first view', async () => {
    const holder = await newAccount();
    await store.joinList({ email: 'card@flofi-test.dev', language: 'EN', flight: 'FIRST', client: null, now: BEFORE });
    await simulate(holder, 'wf-card');
    const issued = await store.issuePass({ accountId: holder, emails: ['card@flofi-test.dev'], workflowId: 'wf-card', handle: 'card_holder', public: false, now: BOARDING });
    if (!issued.ok) throw new Error('not issued');
    const publicId = issued.pass.publicId!;
    expect(publicId).toMatch(/^[a-z2-7]{12}$/);
    const card = await store.publicCard(publicId);
    expect(Object.keys(card!).sort()).toEqual(['departedAt', 'founding', 'handle', 'publicId', 'route', 'seat']);
    expect(JSON.stringify(card)).not.toContain('card@flofi-test.dev');
    expect(JSON.stringify(card)).not.toContain(holder);
    expect(await store.publicCard('aaaaaaaaaaaa')).toBeNull();
    expect(await store.removeCard(publicId, BOARDING)).toBe(true);
    expect(await store.publicCard(publicId)).toBeNull();
    // A card issued before 0024 (no public id) gets one the first time its holder opens /board.
    const old = await newAccount();
    await t.db.query(`INSERT INTO flight_passes (tenant_id, pass_id, account_id, origin, boarding_no, route, run_id) VALUES ('default', $1, $2, 'LIST', 90000, $3, 'r')`,
      [`flp_${hex(16)}`, old, JSON.stringify(flightRoute(swap))]);
    expect((await store.ensurePublicId(old))?.publicId).toMatch(/^[a-z2-7]{12}$/);
  });

  it('renders the card emails from the card itself and cancels them if the card is gone', async () => {
    const outbox = createEmailOutbox({ db: t.db, tenantId: 'default' }, { daily: 10_000, monthly: 100_000, externalDailyReserve: 0, externalMonthlyReserve: 0 });
    const fake = fakeProvider();
    await delivery(outbox, fake.provider, () => BOARDING + 60_000).cycle();
    const cardEmail = fake.sent.find(e => /Founding Member #|boarding card/.test(e.subject) && e.to === 'board@flofi-test.dev');
    expect(cardEmail?.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/flofi\.xyz\/api\/board\/unsubscribe\?t=fem_[0-9a-f]{32}\.[0-9a-f]{64}\.[A-Za-z0-9_-]{22}>$/);
    expect(cardEmail?.attachments?.[0]?.path).toMatch(/^https:\/\/flofi\.xyz\/card\/[a-z2-7]{12}\/image\?download=1$/);
    expect((await emailsOf('card@flofi-test.dev')).find(e => String(e.template).startsWith('CARD_'))).toMatchObject({ state: 'CANCELLED', status_reason: 'CARD_GONE' });
  });

  it('erasure removes an address from lists, outbox and invite addressing; the end of the beta purges outbox and access records', async () => {
    expect(await store.eraseEmail('creator@flofi-test.dev')).toBe(true);
    expect(await emailsOf('creator@flofi-test.dev')).toEqual([]);
    expect(await rows(`SELECT count(*)::int AS n FROM flight_invites WHERE recipient = 'creator@flofi-test.dev'`)).toEqual([{ n: 0 }]);
    await store.purgeLists();
    expect(await rows(`SELECT (SELECT count(*) FROM flight_emails)::int AS emails, (SELECT count(*) FROM flight_access_tokens)::int AS tokens,
      (SELECT count(*) FROM flight_access_claims)::int AS claims, (SELECT count(*) FROM flight_access_attempts)::int AS attempts`))
      .toEqual([{ emails: 0, tokens: 0, claims: 0, attempts: 0 }]);
  });
});
