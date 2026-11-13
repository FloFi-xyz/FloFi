// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: the Flight FloFi email outbox (migration 0024 `flight_emails`) and its quota. Every intended email is a row
 * written in the same transaction as the event that causes it (a list join, a card issued) or by the scheduler (Email 2, Email 3), deduplicated
 * by `dedupe_key`, so retries, restarts and concurrent workers never enqueue or send twice.
 *
 * Quota (Resend free plan: 100 a day, 3,000 a month; configurable): before an email is leased its send is RESERVED under a per-tenant advisory
 * lock, counting every reservation of the day and the month that is pending, in flight, sent or of unknown outcome. Concurrent workers
 * therefore never exceed the budget. A campaign batch (`batch_key`: Email 2, an Email 3 group) is reserved WHOLE or not at all: if it does
 * not fit, every email of the batch is HELD with the limit it hits, so a batch is never sent partially by surprise. Nothing upgrades a plan.
 * Emails sent outside FloFi also spend the provider's quota: `externalReserve` keeps room for them, and the internal count is never presented
 * as the provider's (see the runbook's reconciliation step).
 *
 * Nothing here logs or returns an address: operator views mask recipients.
 */
import { randomBytes } from 'node:crypto';
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { emailLanguage, LAUNCH_LANGUAGE, TEMPLATE_CATEGORY, TEMPLATE_VERSIONS, type EmailLanguage, type EmailTemplate } from './templates.ts';

export type EmailState = 'PENDING' | 'SENDING' | 'SENT' | 'UNKNOWN' | 'HELD' | 'FAILED' | 'CANCELLED';
export type EmailLimits = { readonly daily: number; readonly monthly: number; readonly externalDailyReserve: number; readonly externalMonthlyReserve: number };
/** Daily sends kept for ESSENTIAL emails (a boarding link a person asked for): campaign email never takes the last ones. */
export const ESSENTIAL_DAILY_RESERVE = 5;
/** Holds after the provider may already have sent the email: released only by id, after the operator checked the provider's log. */
const POSSIBLY_SENT = ['UNRESOLVED_OUTCOME', 'PROVIDER_IDEMPOTENCY_BODY_CHANGED', 'PROVIDER_CONFLICT', 'TEMPLATE_VERSION_REVIEW'];
export const DEFAULT_EMAIL_LIMITS: EmailLimits = Object.freeze({ daily: 100, monthly: 3000, externalDailyReserve: 0, externalMonthlyReserve: 0 });
/** Leases, retries and the provider's idempotency window. */
export const OUTBOX = {
  leaseMs: 2 * 60_000, maxAttempts: 8, unknownRetryMs: 5 * 60_000,
  // Resend keeps an idempotency key 24 hours: an unknown outcome is retried with the same key only well inside that window.
  idempotencyWindowMs: 23 * 60 * 60_000, settledRetentionDays: 90,
} as const;
const QUOTA_LOCK_CLASS = 734_003_222; // Advisory lock class (int4): one quota reservation at a time per tenant.

export type EmailRow = {
  readonly emailId: string; readonly template: EmailTemplate; readonly templateVersion: number; readonly category: 'CAMPAIGN' | 'ESSENTIAL';
  readonly recipient: string; readonly language: EmailLanguage; readonly trigger: string; readonly batchKey: string | null;
  readonly entryId: string | null; readonly passId: string | null; readonly inviteCode: string | null; readonly state: EmailState;
  readonly attempts: number; readonly leaseToken: string | null; readonly createdAt: string; readonly firstAttemptAt: string | null;
  /** The state before this lease: an UNKNOWN email may already have been delivered, so it must never fall back to PENDING. */
  readonly previousState?: EmailState;
};
type Row = { email_id: string; template: EmailTemplate; template_version: number; category: 'CAMPAIGN' | 'ESSENTIAL'; recipient: string; language: EmailLanguage;
  trigger: string; batch_key: string | null; entry_id: string | null; pass_id: string | null; invite_code: string | null; state: EmailState; attempts: number;
  lease_token: string | null; created_at: Date; first_attempt_at: Date | null; reserved_at: Date | null; next_attempt_at: Date };
const rowOf = (row: Row): EmailRow => ({ emailId: row.email_id, template: row.template, templateVersion: row.template_version, category: row.category,
  recipient: row.recipient, language: row.language, trigger: row.trigger, batchKey: row.batch_key, entryId: row.entry_id, passId: row.pass_id,
  inviteCode: row.invite_code, state: row.state, attempts: row.attempts, leaseToken: row.lease_token, createdAt: row.created_at.toISOString(),
  firstAttemptAt: row.first_attempt_at?.toISOString() ?? null });
const COLUMNS = `email_id, template, template_version, category, recipient, language, trigger, batch_key, entry_id, pass_id, invite_code, state, attempts,
  lease_token, created_at, first_attempt_at, reserved_at, next_attempt_at`;
const at = (ms: number) => new Date(ms).toISOString();
const newEmailId = () => `fem_${randomBytes(16).toString('hex')}`;
/** The SQL form of `addressHash` (access.ts), so suppressions can be matched inside the database. */
const SQL_ADDRESS_HASH = (column: string) => `encode(sha256(convert_to('flofi-flight-address-v1:' || ${column}, 'UTF8')), 'hex')`;
/** "a***@gmail.com": what an operator view shows of an address. */
export const maskAddress = (email: string) => { const [user = '', domain = ''] = email.split('@'); return `${user.slice(0, 1)}***@${domain}`; };

export type EnqueueInput = {
  readonly template: EmailTemplate; readonly recipient: string; readonly language: EmailLanguage; readonly trigger: string; readonly dedupeKey: string;
  readonly notBefore: number; readonly expiresAt?: number | null; readonly batchKey?: string | null; readonly entryId?: string | null;
  readonly passId?: string | null; readonly inviteCode?: string | null;
};
/** Enqueue one email in the caller's transaction (in its template's launch language, if any); false when its `dedupeKey` was already enqueued (never twice). */
export async function enqueueEmail(q: Queryable, tenantId: string, input: EnqueueInput): Promise<boolean> {
  const inserted = await q.query(`INSERT INTO flight_emails (tenant_id, email_id, dedupe_key, template, template_version, category, recipient, language, trigger,
    batch_key, entry_id, pass_id, invite_code, not_before, expires_at, next_attempt_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $14)
    ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`, [tenantId, newEmailId(), input.dedupeKey, input.template, TEMPLATE_VERSIONS[input.template],
    TEMPLATE_CATEGORY[input.template], input.recipient.trim().toLowerCase(), emailLanguage(input.template, input.language), input.trigger, input.batchKey ?? null, input.entryId ?? null,
    input.passId ?? null, input.inviteCode ?? null, at(input.notBefore), input.expiresAt ? at(input.expiresAt) : null]);
  return inserted.rowCount > 0;
}

export type Usage = { readonly day: number; readonly month: number };
export type Settlement =
  | { readonly kind: 'SENT'; readonly providerId: string }
  | { readonly kind: 'UNKNOWN'; readonly code: string }
  | { readonly kind: 'RETRY'; readonly code: string; readonly delayMs: number }
  | { readonly kind: 'HELD'; readonly code: string }
  | { readonly kind: 'FAILED'; readonly code: string }
  | { readonly kind: 'CANCELLED'; readonly code: string };

export function createEmailOutbox(host: { readonly db: Database; readonly tenantId: string }, limits: EmailLimits = DEFAULT_EMAIL_LIMITS) {
  const { db, tenantId } = host;
  const dailyLimit = Math.max(0, limits.daily - limits.externalDailyReserve), monthlyLimit = Math.max(0, limits.monthly - limits.externalMonthlyReserve);

  /** Reservations that count against the provider's quota: this UTC day and this UTC month. */
  async function usage(now: number, q: Queryable = db): Promise<Usage> {
    const row = (await q.query<{ day: string; month: string }>(`SELECT
      count(*) FILTER (WHERE reserved_at >= date_trunc('day', $2::timestamptz, 'UTC') AND reserved_at < date_trunc('day', $2::timestamptz, 'UTC') + interval '1 day') AS day,
      count(*) AS month
      FROM flight_emails WHERE tenant_id = $1 AND reserved_at >= date_trunc('month', $2::timestamptz, 'UTC')
        AND reserved_at < date_trunc('month', $2::timestamptz, 'UTC') + interval '1 month'
        AND (state IN ('PENDING', 'SENDING', 'SENT', 'UNKNOWN') OR state = 'HELD')`, [tenantId, at(now)])).rows[0]!;
    return { day: Number(row.day), month: Number(row.month) };
  }

  async function control(q: Queryable = db) {
    await q.query('INSERT INTO flight_email_control (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);
    const row = (await q.query<{ paused: boolean; paused_reason: string | null; blocked_until: Date | null; blocked_reason: string | null }>(
      'SELECT paused, paused_reason, blocked_until, blocked_reason FROM flight_email_control WHERE tenant_id = $1', [tenantId])).rows[0]!;
    return { paused: row.paused, pausedReason: row.paused_reason, blockedUntil: row.blocked_until?.toISOString() ?? null, blockedReason: row.blocked_reason };
  }
  /** The operator's switch: campaign email paused (ESSENTIAL access emails still go out) or resumed. The product is never affected. */
  async function setPaused(paused: boolean, reason: string | null): Promise<void> {
    await control();
    await db.query('UPDATE flight_email_control SET paused = $2, paused_reason = $3, updated_at = clock_timestamp() WHERE tenant_id = $1', [tenantId, paused, paused ? reason : null]);
  }
  /** A provider stop (quota, configuration): no email is leased until `until` (null: until an operator clears it). */
  async function block(until: number | null, reason: string, q: Queryable = db): Promise<void> {
    await control(q);
    await q.query(`UPDATE flight_email_control SET blocked_until = $2, blocked_reason = $3, updated_at = clock_timestamp() WHERE tenant_id = $1`,
      [tenantId, until === null ? 'infinity' : at(until), reason]);
  }
  async function clearBlock(): Promise<void> {
    await control();
    await db.query('UPDATE flight_email_control SET blocked_until = NULL, blocked_reason = NULL, updated_at = clock_timestamp() WHERE tenant_id = $1', [tenantId]);
  }

  /**
   * Housekeeping before each cycle: a lease that expired while SENDING becomes UNKNOWN (the process may have reached the provider: it is
   * retried with the same idempotency key, never assumed unsent); a pending or held email past its validity is CANCELLED (EXPIRED); a
   * pending or held CAMPAIGN email to a suppressed address is CANCELLED (UNSUBSCRIBED).
   */
  async function housekeeping(now: number): Promise<{ readonly recovered: number; readonly expired: number; readonly suppressed: number }> {
    return db.transaction(async tx => {
      const recovered = (await tx.query(`UPDATE flight_emails SET state = 'UNKNOWN', lease_token = NULL, lease_until = NULL, status_reason = 'LEASE_EXPIRED',
        next_attempt_at = $2, updated_at = clock_timestamp() WHERE tenant_id = $1 AND state = 'SENDING' AND lease_until < $2
        AND (template <> 'CREATOR_INVITE' OR template_version = $3)`, [tenantId, at(now), TEMPLATE_VERSIONS.CREATOR_INVITE])).rowCount;
      // Retired guest copy must never reach the provider. Hold only pending/held rows;
      // leave SENT, SENDING and UNKNOWN rows byte-for-byte intact for operator reconciliation.
      await tx.query(`UPDATE flight_emails SET state = 'HELD', status_reason = 'TEMPLATE_VERSION_REVIEW', updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND template = 'CREATOR_INVITE' AND template_version <> $2 AND state IN ('PENDING', 'HELD')`,
      [tenantId, TEMPLATE_VERSIONS.CREATOR_INVITE]);
      return {
      recovered,
      expired: (await tx.query(`UPDATE flight_emails SET state = 'CANCELLED', status_reason = 'EXPIRED', reserved_at = NULL, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND state IN ('PENDING', 'HELD') AND expires_at IS NOT NULL AND expires_at <= $2
        AND (status_reason IS NULL OR NOT (status_reason = ANY($3::text[])))`, [tenantId, at(now), POSSIBLY_SENT])).rowCount,
      suppressed: (await tx.query(`UPDATE flight_emails e SET state = 'CANCELLED', status_reason = 'UNSUBSCRIBED', reserved_at = NULL, updated_at = clock_timestamp()
        FROM flight_email_suppressions s WHERE e.tenant_id = $1 AND s.tenant_id = e.tenant_id AND e.state IN ('PENDING', 'HELD') AND e.category = 'CAMPAIGN'
        AND (e.status_reason IS NULL OR NOT (e.status_reason = ANY($2::text[])))
        AND s.address_hash = ${SQL_ADDRESS_HASH('e.recipient')}`, [tenantId, POSSIBLY_SENT])).rowCount,
      };
    });
  }

  /**
   * Lease up to `max` due emails for sending, reserving quota atomically. `campaign: false` leases only ESSENTIAL emails (campaign paused).
   * Returns the leased rows; rows that cannot fit the budget are HELD (with QUOTA_DAILY / QUOTA_MONTHLY) instead.
   */
  async function lease(now: number, options: { readonly max: number; readonly campaign: boolean }): Promise<EmailRow[]> {
    return db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [QUOTA_LOCK_CLASS, tenantId]);
      const used = { ...await usage(now, tx) };
      const due = (await tx.query<Row>(`SELECT ${COLUMNS} FROM flight_emails WHERE tenant_id = $1 AND next_attempt_at <= $2
        AND ((state = 'PENDING' AND not_before <= $2) OR state = 'UNKNOWN') AND ($3::boolean OR category = 'ESSENTIAL')
        AND NOT (template = 'CREATOR_INVITE' AND template_version <> $5 AND state = 'UNKNOWN')
        ORDER BY (category = 'ESSENTIAL') DESC, next_attempt_at, created_at LIMIT $4 FOR UPDATE SKIP LOCKED`, [tenantId, at(now), options.campaign, options.max, TEMPLATE_VERSIONS.CREATOR_INVITE])).rows;
      const leased: EmailRow[] = [], heldBatches = new Set<string>();
      // Campaign email leaves room for the access emails people ask for.
      const campaignDay = Math.max(0, dailyLimit - Math.min(ESSENTIAL_DAILY_RESERVE, Math.floor(dailyLimit / 20)));
      const dayLimit = (row: Row) => row.category === 'ESSENTIAL' ? dailyLimit : campaignDay;
      for (const row of due) {
        if (row.template === 'CREATOR_INVITE' && row.template_version !== TEMPLATE_VERSIONS.CREATOR_INVITE) {
          await settleRow(tx, row.email_id, null, { kind: 'HELD', code: 'TEMPLATE_VERSION_REVIEW' }, now);
          continue;
        }
        if (row.batch_key && heldBatches.has(row.batch_key)) continue;
        if (row.state === 'UNKNOWN') {
          // Already reserved; retrying the same idempotency key cannot send twice — but only inside the provider's 24-hour window.
          if (!row.first_attempt_at || now - row.first_attempt_at.getTime() > OUTBOX.idempotencyWindowMs || row.attempts >= OUTBOX.maxAttempts) {
            await settleRow(tx, row.email_id, null, { kind: 'HELD', code: 'UNRESOLVED_OUTCOME' }, now);
            continue;
          }
        } else if (!row.reserved_at) {
          if (row.batch_key) {
            // A batch is reserved whole: every pending, unreserved email of the batch that is due now.
            const pending = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM flight_emails WHERE tenant_id = $1 AND batch_key = $2 AND state = 'PENDING'
              AND reserved_at IS NULL AND not_before <= $3`, [tenantId, row.batch_key, at(now)])).rows[0]!.n);
            const limit = used.day + pending > dayLimit(row) ? 'QUOTA_DAILY' : used.month + pending > monthlyLimit ? 'QUOTA_MONTHLY' : null;
            if (limit) {
              await tx.query(`UPDATE flight_emails SET state = 'HELD', status_reason = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND batch_key = $2
                AND state = 'PENDING' AND reserved_at IS NULL`, [tenantId, row.batch_key, limit]);
              heldBatches.add(row.batch_key);
              continue;
            }
            await tx.query(`UPDATE flight_emails SET reserved_at = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND batch_key = $2 AND state = 'PENDING'
              AND reserved_at IS NULL AND not_before <= $3`, [tenantId, row.batch_key, at(now)]);
            used.day += pending; used.month += pending;
          } else {
            const limit = used.day + 1 > dayLimit(row) ? 'QUOTA_DAILY' : used.month + 1 > monthlyLimit ? 'QUOTA_MONTHLY' : null;
            if (limit) { await settleRow(tx, row.email_id, null, { kind: 'HELD', code: limit }, now); continue; }
            await tx.query('UPDATE flight_emails SET reserved_at = $3 WHERE tenant_id = $1 AND email_id = $2', [tenantId, row.email_id, at(now)]);
            used.day += 1; used.month += 1;
          }
        }
        if (row.attempts >= OUTBOX.maxAttempts) { await settleRow(tx, row.email_id, null, { kind: 'HELD', code: 'ATTEMPTS_EXHAUSTED' }, now); continue; }
        const token = randomBytes(16).toString('hex');
        const updated = (await tx.query<Row>(`UPDATE flight_emails SET state = 'SENDING', lease_token = $3, lease_until = $4, attempts = attempts + 1,
          first_attempt_at = coalesce(first_attempt_at, $5), reserved_at = coalesce(reserved_at, $5), updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND email_id = $2 RETURNING ${COLUMNS}`, [tenantId, row.email_id, token, at(now + OUTBOX.leaseMs), at(now)])).rows[0]!;
        leased.push({ ...rowOf(updated), previousState: row.state });
      }
      return leased;
    });
  }

  async function settleRow(q: Queryable, emailId: string, leaseToken: string | null, settlement: Settlement, now: number): Promise<boolean> {
    const sets: Record<Settlement['kind'], string> = {
      SENT: `state = 'SENT', sent_at = $3, provider_id = $4, status_reason = NULL`,
      UNKNOWN: `state = 'UNKNOWN', status_reason = $4, next_attempt_at = $3::timestamptz + make_interval(secs => $6::double precision / 1000)`,
      RETRY: `state = 'PENDING', status_reason = $4, next_attempt_at = $3::timestamptz + make_interval(secs => $6::double precision / 1000)`,
      // A hold after a provider call that may have sent the email keeps its reservation (it may have spent the provider's quota).
      HELD: `state = 'HELD', status_reason = $4, reserved_at = CASE WHEN $4 IN ('UNRESOLVED_OUTCOME', 'PROVIDER_IDEMPOTENCY_BODY_CHANGED', 'PROVIDER_CONFLICT', 'TEMPLATE_VERSION_REVIEW')
        THEN reserved_at ELSE NULL END`,
      FAILED: `state = 'FAILED', status_reason = $4, reserved_at = NULL`,
      CANCELLED: `state = 'CANCELLED', status_reason = $4, reserved_at = NULL`,
    };
    const value = settlement.kind === 'SENT' ? settlement.providerId : settlement.code;
    const delay = settlement.kind === 'RETRY' ? settlement.delayMs : settlement.kind === 'UNKNOWN' ? OUTBOX.unknownRetryMs : 0;
    // Fenced by the lease: a worker whose lease expired (and whose email was recovered or re-leased) cannot overwrite what happened since.
    const result = await q.query<{ template: EmailTemplate; entry_id: string | null }>(`UPDATE flight_emails SET ${sets[settlement.kind]}, lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp()
      WHERE tenant_id = $1 AND email_id = $2 AND ($5::text IS NULL OR (state = 'SENDING' AND lease_token = $5)) AND $6::double precision >= 0
        AND $3::timestamptz IS NOT NULL RETURNING template, entry_id`,
    [tenantId, emailId, at(now), value, leaseToken, delay]);
    if (result.rowCount && settlement.kind === 'SENT' && result.rows[0]?.template === 'EARLY_LIST') await q.query(
      'UPDATE flight_early_list_imports SET email0_sent_at = coalesce(email0_sent_at, $3) WHERE tenant_id = $1 AND entry_id = $2',
      [tenantId, result.rows[0].entry_id, at(now)]);
    return result.rowCount === 1;
  }
  /** Settle a leased email (fenced by its lease: a worker whose lease expired cannot overwrite what happened since). */
  const settle = (row: EmailRow, settlement: Settlement, now: number) => db.transaction(tx => settleRow(tx, row.emailId, row.leaseToken ?? 'none', settlement, now));

  // The scheduler: idempotent inserts, safe to run on every cycle of every worker.
  /** Email 2 for every beta-list entry that has not boarded, from `eveAt` until boarding opens. */
  async function scheduleEve(now: number, eveAt: number, boardingOpensAt: number): Promise<number> {
    if (now < eveAt || now >= boardingOpensAt) return 0;
    return (await db.query(`INSERT INTO flight_emails (tenant_id, email_id, dedupe_key, template, template_version, category, recipient, language, trigger, batch_key,
      entry_id, not_before, expires_at, next_attempt_at)
      SELECT e.tenant_id, 'fem_' || replace(gen_random_uuid()::text, '-', ''), 'eve:' || e.entry_id, 'EVE', $2, 'CAMPAIGN', e.email, e.language, 'eve_schedule', 'eve',
        e.entry_id, $3, $4, $3
      FROM flight_list_entries e WHERE e.tenant_id = $1 AND e.flight = 'FIRST' AND e.boarded_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM flight_early_list_imports i WHERE i.tenant_id = e.tenant_id AND i.entry_id = e.entry_id AND NOT i.campaign_consent)
        AND NOT EXISTS (SELECT 1 FROM flight_email_suppressions s WHERE s.tenant_id = e.tenant_id AND s.address_hash = ${SQL_ADDRESS_HASH('e.email')})
      ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`, [tenantId, TEMPLATE_VERSIONS.EVE, at(eveAt), at(boardingOpensAt)])).rowCount;
  }
  /**
   * Email 3 for every beta-list entry whose group is open (its group's `opens_at`, or boarding opening for an entry with no group) and that
   * has not boarded. One batch per group (`group-<n>`; `group-0` for entries without a group). Valid seven days after it is enqueued.
   * Enqueued in the template's launch language (Portuguese), not the entry's stored locale.
   */
  async function scheduleBoarding(now: number, boardingOpensAt: number): Promise<number> {
    if (now < boardingOpensAt) return 0;
    return (await db.query(`INSERT INTO flight_emails (tenant_id, email_id, dedupe_key, template, template_version, category, recipient, language, trigger, batch_key,
      entry_id, not_before, expires_at, next_attempt_at)
      SELECT e.tenant_id, 'fem_' || replace(gen_random_uuid()::text, '-', ''), 'boarding:' || e.entry_id, 'GROUP_BOARDING', $2, 'CAMPAIGN', e.email, coalesce($5::text, e.language),
        'group_opened', 'group-' || coalesce(e.batch_no, 0), e.entry_id, $3, $3::timestamptz + interval '7 days', $3
      FROM flight_list_entries e LEFT JOIN flight_batches b ON b.tenant_id = e.tenant_id AND b.batch_no = e.batch_no
      WHERE e.tenant_id = $1 AND e.flight = 'FIRST' AND e.boarded_at IS NULL AND greatest(coalesce(b.opens_at, $4::timestamptz), $4::timestamptz) <= $3
        AND NOT EXISTS (SELECT 1 FROM flight_early_list_imports i WHERE i.tenant_id = e.tenant_id AND i.entry_id = e.entry_id AND NOT i.campaign_consent)
        AND NOT EXISTS (SELECT 1 FROM flight_email_suppressions s WHERE s.tenant_id = e.tenant_id AND s.address_hash = ${SQL_ADDRESS_HASH('e.email')})
      ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`, [tenantId, TEMPLATE_VERSIONS.GROUP_BOARDING, at(now), at(boardingOpensAt), LAUNCH_LANGUAGE.GROUP_BOARDING ?? null])).rowCount;
  }
  /** Email 1 once for every beta-list entry that never got one (entries from before the outbox existed). Operator command only. */
  async function backfillConfirmations(now: number, listClosesAt: number): Promise<number> {
    if (now >= listClosesAt) return 0;
    return (await db.query(`INSERT INTO flight_emails (tenant_id, email_id, dedupe_key, template, template_version, category, recipient, language, trigger, batch_key,
      entry_id, not_before, expires_at, next_attempt_at)
      SELECT e.tenant_id, 'fem_' || replace(gen_random_uuid()::text, '-', ''), 'list:' || e.entry_id, 'LIST_CONFIRMATION', $2, 'CAMPAIGN', e.email, e.language,
        'backfill', 'list-backfill', e.entry_id, $3, $4, $3
      FROM flight_list_entries e WHERE e.tenant_id = $1 AND e.flight = 'FIRST' AND e.boarded_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM flight_early_list_imports i WHERE i.tenant_id = e.tenant_id AND i.entry_id = e.entry_id AND NOT i.campaign_consent)
        AND NOT EXISTS (SELECT 1 FROM flight_email_suppressions s WHERE s.tenant_id = e.tenant_id AND s.address_hash = ${SQL_ADDRESS_HASH('e.email')})
      ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`, [tenantId, TEMPLATE_VERSIONS.LIST_CONFIRMATION, at(now), at(listClosesAt)])).rowCount;
  }

  /**
   * Email 0 is operator-triggered only. Reserve it durably with its outbox row, once even after settled rows are pruned.
   * Recipients are split into quota-sized batch keys so a list larger than the campaign day budget can still send the
   * portion that fits, instead of holding every message behind one indivisible `early-list` reservation.
   */
  async function scheduleEarlyList(now: number, sendAt: number, boardingOpensAt: number): Promise<number> {
    if (!Number.isFinite(sendAt) || sendAt >= boardingOpensAt || now >= boardingOpensAt) throw new Error('FLIGHT_EMAIL0_WINDOW_CLOSED');
    const campaignDay = Math.max(1, dailyLimit - Math.min(ESSENTIAL_DAILY_RESERVE, Math.floor(dailyLimit / 20)));
    return db.transaction(async tx => {
      const entries = (await tx.query<{ entry_id: string; email: string; language: 'EN' | 'PT' }>(`SELECT e.entry_id, e.email, e.language
        FROM flight_early_list_imports i JOIN flight_list_entries e ON e.tenant_id = i.tenant_id AND e.entry_id = i.entry_id
        WHERE i.tenant_id = $1 AND i.campaign_consent AND i.email0_enqueued_at IS NULL AND e.flight = 'FIRST'
          AND NOT EXISTS (SELECT 1 FROM flight_early_list_imports i WHERE i.tenant_id = e.tenant_id AND i.entry_id = e.entry_id AND NOT i.campaign_consent)
        AND NOT EXISTS (SELECT 1 FROM flight_email_suppressions s WHERE s.tenant_id = e.tenant_id AND s.address_hash = ${SQL_ADDRESS_HASH('e.email')})
        ORDER BY e.joined_at, e.entry_id FOR UPDATE OF i`, [tenantId])).rows;
      let enqueued = 0;
      for (const [index, entry] of entries.entries()) {
        const batchKey = `early-list-${Math.floor(index / campaignDay)}`;
        if (await enqueueEmail(tx, tenantId, { template: 'EARLY_LIST', recipient: entry.email, language: entry.language, trigger: 'google_forms_import',
          dedupeKey: `early:${entry.entry_id}`, notBefore: sendAt, expiresAt: boardingOpensAt, entryId: entry.entry_id, batchKey })) enqueued++;
        await tx.query('UPDATE flight_early_list_imports SET email0_enqueued_at = $3 WHERE tenant_id = $1 AND entry_id = $2', [tenantId, entry.entry_id, at(now)]);
      }
      return enqueued;
    });
  }

  // Suppressions.
  async function suppress(addressHash: string, reason: 'UNSUBSCRIBED' | 'PROVIDER_REJECTED' | 'OPERATOR', q: Queryable = db): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(addressHash)) throw new Error('FLIGHT_ADDRESS_HASH_INVALID');
    await q.query(`INSERT INTO flight_email_suppressions (tenant_id, address_hash, reason) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, address_hash) DO NOTHING`,
      [tenantId, addressHash, reason]);
  }
  async function isSuppressed(addressHash: string, q: Queryable = db): Promise<boolean> {
    return (await q.query('SELECT 1 FROM flight_email_suppressions WHERE tenant_id = $1 AND address_hash = $2', [tenantId, addressHash])).rowCount > 0;
  }
  /**
   * One-click unsubscribe: the address digest carried (signed) in the email's link stops campaign email to it, and pending campaign email
   * to it is cancelled. Works whether or not the email's own record still exists (pruned, erased).
   */
  async function unsubscribe(addressHash: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(addressHash)) throw new Error('FLIGHT_ADDRESS_HASH_INVALID');
    await db.transaction(async tx => {
      await tx.query(`INSERT INTO flight_email_suppressions (tenant_id, address_hash, reason) VALUES ($1, $2, 'UNSUBSCRIBED') ON CONFLICT (tenant_id, address_hash) DO NOTHING`,
        [tenantId, addressHash]);
      await tx.query(`UPDATE flight_emails SET state = 'CANCELLED', status_reason = 'UNSUBSCRIBED', reserved_at = NULL, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND category = 'CAMPAIGN' AND state IN ('PENDING', 'HELD') AND ${SQL_ADDRESS_HASH('recipient')} = $2`, [tenantId, addressHash]);
    });
  }

  // Operator commands (backend/flight-admin.ts). Never reachable from a browser; recipients are masked.
  /** Counts by template and state, held emails by reason and batch, and this period's reservations against the configured limits. */
  async function status(now: number) {
    const states = (await db.query<{ template: string; state: string; n: string }>(`SELECT template, state, count(*) AS n FROM flight_emails WHERE tenant_id = $1
      GROUP BY template, state ORDER BY template, state`, [tenantId])).rows.map(r => ({ template: r.template, state: r.state, emails: Number(r.n) }));
    const held = (await db.query<{ batch_key: string | null; status_reason: string | null; template: string; n: string }>(`SELECT batch_key, status_reason, template, count(*) AS n
      FROM flight_emails WHERE tenant_id = $1 AND state IN ('HELD', 'UNKNOWN') GROUP BY batch_key, status_reason, template ORDER BY 4 DESC`, [tenantId])).rows
      .map(r => ({ batch: r.batch_key, reason: r.status_reason, template: r.template, emails: Number(r.n) }));
    return { usage: await usage(now), limits: { daily: dailyLimit, monthly: monthlyLimit, configured: limits }, control: await control(), states, held,
      note: 'Counts reservations made by FloFi only; emails sent outside FloFi (tests, other tools) also spend the provider quota. Reconcile with the Resend dashboard before a large send.' };
  }
  async function listAttention(limit = 50) {
    return (await db.query<Row & { status_reason: string | null }>(`SELECT ${COLUMNS}, status_reason FROM flight_emails WHERE tenant_id = $1 AND state IN ('HELD', 'UNKNOWN', 'FAILED')
      ORDER BY updated_at DESC LIMIT $2`, [tenantId, Math.min(500, Math.max(1, limit))])).rows
      .map(r => ({ emailId: r.email_id, template: r.template, state: r.state, reason: r.status_reason, batch: r.batch_key, attempts: r.attempts, to: maskAddress(r.recipient) }));
  }
  /**
   * Release held emails back to sending (the team decided: quota raised, next day, provider fixed). `max` releases only that many of a batch
   * (oldest first): an explicit, operator-chosen partial send. An UNRESOLVED_OUTCOME email is never released by a filter, only by its id
   * after the operator checked the provider's log (it may already have been delivered); the same for an idempotency conflict.
   */
  async function release(filter: { readonly emailId?: string; readonly batchKey?: string; readonly reason?: string; readonly max?: number }, now: number): Promise<number> {
    const max = filter.max ?? 1_000_000;
    if (!Number.isSafeInteger(max) || max < 1) throw new Error('FLIGHT_RELEASE_MAX_INVALID');
    if (!filter.emailId && !filter.batchKey && !filter.reason) throw new Error('FLIGHT_RELEASE_FILTER_REQUIRED');
    return (await db.query(`UPDATE flight_emails SET state = 'PENDING', status_reason = NULL, reserved_at = NULL, next_attempt_at = $2,
      attempts = CASE WHEN status_reason IN ('ATTEMPTS_EXHAUSTED', 'UNRESOLVED_OUTCOME', 'PROVIDER_IDEMPOTENCY_BODY_CHANGED', 'PROVIDER_CONFLICT') THEN 0 ELSE attempts END,
      first_attempt_at = CASE WHEN status_reason = 'UNRESOLVED_OUTCOME' THEN NULL ELSE first_attempt_at END, updated_at = clock_timestamp()
      WHERE tenant_id = $1 AND email_id IN (SELECT email_id FROM flight_emails WHERE tenant_id = $1 AND state = 'HELD'
        AND ($3::text IS NULL OR email_id = $3) AND ($4::text IS NULL OR batch_key = $4) AND ($5::text IS NULL OR status_reason = $5)
        AND ($3::text IS NOT NULL OR status_reason IS NULL OR NOT (status_reason = ANY($7::text[])))
        ORDER BY created_at, email_id LIMIT $6)`, [tenantId, at(now), filter.emailId ?? null, filter.batchKey ?? null, filter.reason ?? null, max, POSSIBLY_SENT])).rowCount;
  }
  /** Cancel pending or held emails (a postponed campaign, a mistaken batch). Sent, in-flight and unknown emails are never touched. */
  async function cancel(filter: { readonly emailId?: string; readonly batchKey?: string; readonly template?: EmailTemplate }): Promise<number> {
    if (!filter.emailId && !filter.batchKey && !filter.template) throw new Error('FLIGHT_CANCEL_FILTER_REQUIRED');
    return (await db.query(`UPDATE flight_emails SET state = 'CANCELLED', status_reason = 'OPERATOR', reserved_at = NULL, updated_at = clock_timestamp()
      WHERE tenant_id = $1 AND state IN ('PENDING', 'HELD') AND ($2::text IS NULL OR email_id = $2) AND ($3::text IS NULL OR batch_key = $3)
      AND ($4::text IS NULL OR template = $4) AND (status_reason IS NULL OR NOT (status_reason = ANY($5::text[])))`,
    [tenantId, filter.emailId ?? null, filter.batchKey ?? null, filter.template ?? null, POSSIBLY_SENT])).rowCount;
  }
  /** An UNKNOWN or held email the operator confirmed in the provider's log as delivered: recorded as SENT, never sent again. */
  async function markDelivered(emailId: string, providerId: string, now: number): Promise<boolean> {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(providerId)) throw new Error('FLIGHT_PROVIDER_ID_INVALID');
    return db.transaction(async tx => {
      const result = await tx.query<{ template: EmailTemplate; entry_id: string | null }>(`UPDATE flight_emails SET state = 'SENT', sent_at = $3, provider_id = $4,
        status_reason = 'OPERATOR_CONFIRMED', lease_token = NULL, lease_until = NULL, reserved_at = coalesce(reserved_at, $3), updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND email_id = $2 AND state IN ('UNKNOWN', 'HELD') RETURNING template, entry_id`, [tenantId, emailId, at(now), providerId]);
      if (result.rowCount && result.rows[0]?.template === 'EARLY_LIST') await tx.query(
        'UPDATE flight_early_list_imports SET email0_sent_at = coalesce(email0_sent_at, $3) WHERE tenant_id = $1 AND entry_id = $2', [tenantId, result.rows[0].entry_id, at(now)]);
      return result.rowCount === 1;
    });
  }
  /** Retention: settled emails (with their address) are deleted 90 days after they settled. */
  async function prune(now: number): Promise<number> {
    return (await db.query(`DELETE FROM flight_emails WHERE tenant_id = $1 AND state IN ('SENT', 'FAILED', 'CANCELLED') AND updated_at < $2::timestamptz - make_interval(days => $3)`,
      [tenantId, at(now), OUTBOX.settledRetentionDays])).rowCount;
  }

  /**
   * Controlled replacement for unsent CREATOR_INVITE rows held as TEMPLATE_VERSION_REVIEW.
   * Preserves the original invite code and recipient. Never touches SENT. Never upgrades UNKNOWN
   * (it may already have reached the provider). Never bulk-releases retired TEST copy.
   */
  async function supersedeCreatorTemplates(now: number, boardingOpensAt: number, options: { readonly max?: number; readonly apply?: boolean } = {}): Promise<{
    readonly eligible: number; readonly superseded: number; readonly skippedUnknown: number; readonly skippedSent: number;
  }> {
    const max = options.max ?? 1_000;
    if (!Number.isSafeInteger(max) || max < 1) throw new Error('FLIGHT_SUPERSEDE_MAX_INVALID');
    return db.transaction(async tx => {
      const unknownOrSent = (await tx.query<{ state: string; n: string }>(`SELECT state, count(*)::text AS n FROM flight_emails
        WHERE tenant_id = $1 AND template = 'CREATOR_INVITE' AND template_version <> $2 AND state IN ('UNKNOWN', 'SENT')
        GROUP BY state`, [tenantId, TEMPLATE_VERSIONS.CREATOR_INVITE])).rows;
      let skippedUnknown = 0, skippedSent = 0;
      for (const row of unknownOrSent) {
        if (row.state === 'UNKNOWN') skippedUnknown = Number(row.n);
        if (row.state === 'SENT') skippedSent = Number(row.n);
      }
      const held = (await tx.query<{ email_id: string; recipient: string; language: EmailLanguage; invite_code: string | null;
        reserved_at: Date | null; first_attempt_at: Date | null; attempts: number }>(`SELECT email_id, recipient, language, invite_code, reserved_at, first_attempt_at, attempts
        FROM flight_emails WHERE tenant_id = $1 AND template = 'CREATOR_INVITE' AND template_version <> $2
          AND state = 'HELD' AND status_reason = 'TEMPLATE_VERSION_REVIEW'
          AND reserved_at IS NULL AND first_attempt_at IS NULL AND attempts = 0 AND invite_code IS NOT NULL
        ORDER BY created_at, email_id LIMIT $3 FOR UPDATE`, [tenantId, TEMPLATE_VERSIONS.CREATOR_INVITE, max])).rows;
      if (!options.apply) return { eligible: held.length, superseded: 0, skippedUnknown, skippedSent };
      let superseded = 0;
      for (const row of held) {
        await tx.query(`UPDATE flight_emails SET state = 'CANCELLED', status_reason = 'TEMPLATE_SUPERSEDED', reserved_at = NULL, updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND email_id = $2 AND state = 'HELD' AND status_reason = 'TEMPLATE_VERSION_REVIEW'`, [tenantId, row.email_id]);
        if (await enqueueEmail(tx, tenantId, {
          template: 'CREATOR_INVITE', recipient: row.recipient, language: row.language, trigger: 'creator_template_superseded',
          dedupeKey: `creator-v${TEMPLATE_VERSIONS.CREATOR_INVITE}:${row.invite_code!.toLowerCase()}`, notBefore: now,
          expiresAt: boardingOpensAt, inviteCode: row.invite_code, batchKey: null,
        })) superseded++;
      }
      return { eligible: held.length, superseded, skippedUnknown, skippedSent };
    });
  }

  return { usage, control, setPaused, block, clearBlock, housekeeping, lease, settle, scheduleEve, scheduleBoarding, backfillConfirmations, scheduleEarlyList, suppress, isSuppressed,
    unsubscribe, status, listAttention, release, cancel, markDelivered, prune, supersedeCreatorTemplates, limits: { daily: dailyLimit, monthly: monthlyLimit } };
}
export type EmailOutbox = ReturnType<typeof createEmailOutbox>;

/** The deployment's limits: `FLOFI_EMAIL_DAILY_LIMIT`, `FLOFI_EMAIL_MONTHLY_LIMIT` and room kept for email sent outside FloFi. */
export function emailLimitsFrom(env: Readonly<Record<string, string | undefined>>): EmailLimits {
  const read = (name: string, fallback: number, max: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`FLIGHT_EMAIL_LIMIT_INVALID:${name}`);
    return value;
  };
  return { daily: read('FLOFI_EMAIL_DAILY_LIMIT', DEFAULT_EMAIL_LIMITS.daily, 1_000_000), monthly: read('FLOFI_EMAIL_MONTHLY_LIMIT', DEFAULT_EMAIL_LIMITS.monthly, 10_000_000),
    externalDailyReserve: read('FLOFI_EMAIL_EXTERNAL_DAILY_RESERVE', 0, 1_000_000), externalMonthlyReserve: read('FLOFI_EMAIL_EXTERNAL_MONTHLY_RESERVE', 0, 10_000_000) };
}
