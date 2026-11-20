// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import type { Queryable } from '@defi-workflow-engine/cloud-runtime';
import type { AdminHost } from '../host.ts';
import { recordAudit } from '../store.ts';
import { isoDay, type Entry, type Period, type ScopeId } from './economics.ts';
import { ledgerMissing, writeRecord } from './store.ts';

export const FINANCIAL_PROVIDER_IDS = ['neon', 'railway', 'vercel', 'openai', 'anthropic', 'circleci', 'resend', 'alchemy'] as const;
export type FinancialProviderId = (typeof FINANCIAL_PROVIDER_IDS)[number];
export const isFinancialProviderId = (value: unknown): value is FinancialProviderId =>
  FINANCIAL_PROVIDER_IDS.some(id => value === id);

export type FinancialMeter = {
  readonly scope: ScopeId;
  readonly environment: Entry['environment'];
  readonly project: string;
  readonly service: string;
  readonly metric: string;
  readonly unit: string;
  readonly amount: string;
  readonly period: Period;
  readonly basis?: string;
};
export type FinancialSyncResult =
  | { readonly kind: 'COMPLETE'; readonly entries: readonly Entry[]; readonly meters: readonly FinancialMeter[];
    readonly coverage: 'FULL' | 'PARTIAL' | 'UNAVAILABLE'; readonly limitations: readonly string[] }
  | { readonly kind: 'WAIT'; readonly checkpoint: string; readonly retryAfterMs: number };
type Snapshot = Extract<FinancialSyncResult, { kind: 'COMPLETE' }>;
type FinancialCoverage = { period: Period; collectedAt: string; quality: Snapshot['coverage']; limitations: string[]; meterCount: number };
export type FinancialProviderState = {
  id: FinancialProviderId; configured: boolean; lastAttempt: string | null; lastSuccess: string | null;
  nextSync: string | null; errorCode: string | null; active: boolean; coverage: readonly FinancialCoverage[];
};

const MAX_ATTEMPTS = 5, MAX_POLLS = 20;
const SECOND = 1_000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE;
const providerFailure = 'FINOPS_PROVIDER_UNAVAILABLE';
/** Refusals of the credential itself, not of a period: they replace the provider's status even when a historical period met them, and any
 * later answer from the provider (a historical result or an accepted export) clears them. */
const ACCOUNT_CODES: ReadonlySet<string> = new Set(['FINOPS_PROVIDER_AUTH_REQUIRED', 'FINOPS_PROVIDER_ACCESS_DENIED', 'FINOPS_PROVIDER_FORBIDDEN',
  'FINOPS_PROVIDER_NOT_ENTITLED', 'FINOPS_PROVIDER_SCOPE_MISMATCH', 'FINOPS_PROVIDER_NOT_CONFIGURED']);
/** A coverage gap never replaces a snapshot that holds data. */
const GAP_UPSERT = `INSERT INTO finops_sync_snapshots AS snapshot (tenant_id, provider, period_start, period_end, quality, limitations, meter_count, meters)`;
const GAP_CONFLICT = `ON CONFLICT (tenant_id, provider, period_start) DO UPDATE SET period_end = EXCLUDED.period_end,
  limitations = EXCLUDED.limitations, collected_at = EXCLUDED.collected_at WHERE snapshot.quality = 'UNAVAILABLE'`;
const noSchema = () => new Error('FINOPS_SYNC_SCHEMA_REQUIRED');
const iso = (date: Date | null) => date?.toISOString() ?? null;
const month = (at: Date, offset: number) => isoDay(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + offset, 1)));

/**
 * Initial backfill walks the current month and two closed months. Refreshes
 * recompute the current month to catch credits and corrections, plus the
 * previous billing month once a week and once right after it closes. On day one there are no closed current days.
 */
export function financialSyncPeriods(now: Date, previousReview: Date | null): { period: Period; historical: boolean }[] {
  const current = month(now, 0), today = isoDay(now);
  const periods = current < today ? [{ period: { from: current, to: today }, historical: false }] : [];
  // Also right after a month closes: its last days were never collected as closed days of the current month.
  if (previousReview === null || now.getTime() - previousReview.getTime() >= 7 * 24 * HOUR || isoDay(previousReview) < current) {
    periods.push({ period: { from: month(now, -1), to: current }, historical: true });
  }
  if (previousReview === null) periods.push({ period: { from: month(now, -2), to: month(now, -1) }, historical: true });
  return periods;
}
type PlannedPeriod = ReturnType<typeof financialSyncPeriods>[number];
type JobRow = {
  provider: FinancialProviderId; attempts: number; polls: number; checkpoint: string | null; periods: PlannedPeriod[];
  historical_review_at: Date | null; cycle_started_at: Date | null; lease_token: string | null; now: Date;
};
export type FinancialSyncLease = {
  id: FinancialProviderId; token: string; checkpoint: string | null; attempts: number; polls: number; startedAt: Date; plans: PlannedPeriod[];
};

export async function configureFinancialSync(host: AdminHost, enabled: readonly FinancialProviderId[]): Promise<boolean> {
  try {
    await host.db.query(`INSERT INTO finops_sync_jobs AS current (tenant_id, provider, configured)
      SELECT $1, provider, provider = ANY($3::text[]) FROM unnest($2::text[]) AS provider ORDER BY provider
      ON CONFLICT (tenant_id, provider) DO UPDATE SET configured = EXCLUDED.configured,
        next_run_at = CASE WHEN EXCLUDED.configured THEN clock_timestamp() ELSE current.next_run_at END,
        -- A removed credential ends its cycle: a later credential starts a fresh plan, never the old export or periods.
        cycle_started_at = CASE WHEN EXCLUDED.configured THEN current.cycle_started_at END,
        periods = CASE WHEN EXCLUDED.configured THEN current.periods ELSE '[]' END,
        checkpoint = CASE WHEN EXCLUDED.configured THEN current.checkpoint END,
        attempts = CASE WHEN EXCLUDED.configured THEN current.attempts ELSE 0 END,
        polls = CASE WHEN EXCLUDED.configured THEN current.polls ELSE 0 END,
        lease_token = CASE WHEN EXCLUDED.configured THEN current.lease_token END,
        lease_expires_at = CASE WHEN EXCLUDED.configured THEN current.lease_expires_at END,
        last_error = CASE WHEN EXCLUDED.configured THEN current.last_error END
      WHERE current.configured <> EXCLUDED.configured`, [host.tenantId, FINANCIAL_PROVIDER_IDS, enabled]);
    return true;
  } catch (error) {
    if (ledgerMissing(error)) return false;
    throw error;
  }
}

export async function queueFinancialSync(host: AdminHost, actor: string, requested: FinancialProviderId | 'all') {
  try {
    return await host.db.transaction(async tx => {
      const { rows: configured } = await tx.query<{ provider: FinancialProviderId }>(`SELECT provider FROM finops_sync_jobs
        WHERE tenant_id = $1 AND configured AND ($2 = 'all' OR provider = $2) ORDER BY provider FOR UPDATE`, [host.tenantId, requested]);
      if (requested !== 'all' && !configured.length) throw new Error('FINOPS_PROVIDER_NOT_CONFIGURED');
      const { rows: admitted } = await tx.query<{ provider: FinancialProviderId }>(`UPDATE finops_sync_jobs SET
        next_run_at = clock_timestamp(), requested_at = clock_timestamp()
        WHERE tenant_id = $1 AND provider = ANY($2::text[]) AND lease_token IS NULL AND cycle_started_at IS NULL AND next_run_at > clock_timestamp()
          AND (requested_at IS NULL OR requested_at <= clock_timestamp() - interval '5 minutes')
          AND (last_attempt_at IS NULL OR last_attempt_at <= clock_timestamp() - interval '5 minutes')
        RETURNING provider`, [host.tenantId, configured.map(row => row.provider)]);
      const queued = admitted.map(row => row.provider).sort();
      const deferred = configured.map(row => row.provider).filter(provider => !queued.includes(provider));
      if (queued.length) await recordAudit(tx, host.tenantId, { actor, kind: 'ADMIN_FINOPS_SYNC_REQUESTED', outcome: 'OK', target: requested,
        detail: { queued: queued.length, deferred: deferred.length } });
      return { queued, deferred };
    });
  } catch (error) {
    if (ledgerMissing(error)) throw noSchema();
    throw error;
  }
}

/** Claim only billing work. The row lock never spans provider I/O. */
export async function claimFinancialSync(host: AdminHost, enabled: readonly FinancialProviderId[], hours: number): Promise<FinancialSyncLease | null> {
  return host.db.transaction(async tx => {
    await tx.query("SET LOCAL lock_timeout = '750ms'");
    // Abandoned leases end the cycle. A historical period records the failure as its coverage gap and keeps the current status.
    await tx.query(`${GAP_UPSERT} SELECT tenant_id, provider, (periods #>> '{0,period,from}')::date, (periods #>> '{0,period,to}')::date,
        'UNAVAILABLE', ARRAY[$3::text], 0, '[]'::jsonb FROM finops_sync_jobs
      WHERE tenant_id = $1 AND provider = ANY($2::text[]) AND lease_expires_at <= clock_timestamp() AND attempts >= $4
        AND periods #>> '{0,historical}' = 'true' ${GAP_CONFLICT}`, [host.tenantId, enabled, providerFailure, MAX_ATTEMPTS - 1]);
    await tx.query(`UPDATE finops_sync_jobs SET lease_token = NULL, lease_expires_at = NULL,
      next_run_at = clock_timestamp() + $3 * interval '1 hour', cycle_started_at = NULL, periods = '[]', checkpoint = NULL,
      attempts = 0, polls = 0, last_error = CASE WHEN periods #>> '{0,historical}' = 'true' THEN last_error ELSE $4 END
      WHERE tenant_id = $1 AND provider = ANY($2::text[]) AND lease_expires_at <= clock_timestamp() AND attempts >= $5`,
    [host.tenantId, enabled, hours, providerFailure, MAX_ATTEMPTS - 1]);
    const { rows: [job] } = await tx.query<JobRow>(`SELECT provider, attempts, polls, checkpoint, periods, historical_review_at, cycle_started_at,
      lease_token, clock_timestamp() AS now FROM finops_sync_jobs WHERE tenant_id = $1 AND configured AND provider = ANY($2::text[])
        AND next_run_at <= clock_timestamp() AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
      ORDER BY next_run_at, provider LIMIT 1 FOR UPDATE SKIP LOCKED`, [host.tenantId, enabled]);
    if (!job) return null;
    const plans = job.cycle_started_at ? job.periods : financialSyncPeriods(job.now, job.historical_review_at);
    if (plans.length === 0) {
      await tx.query(`UPDATE finops_sync_jobs SET next_run_at = (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + interval '1 day'
        WHERE tenant_id = $1 AND provider = $2`, [host.tenantId, job.provider]);
      return null;
    }
    const token = randomUUID(), attempts = job.attempts + Number(job.lease_token !== null);
    await tx.query(`UPDATE finops_sync_jobs SET lease_token = $3, lease_expires_at = clock_timestamp() + interval '90 seconds', attempts = $4,
      last_attempt_at = clock_timestamp(), cycle_started_at = COALESCE(cycle_started_at, clock_timestamp()), periods = $5::jsonb
      WHERE tenant_id = $1 AND provider = $2`, [host.tenantId, job.provider, token, attempts, JSON.stringify(plans)]);
    return { id: job.provider, token, attempts, polls: job.polls, checkpoint: job.checkpoint, plans, startedAt: job.cycle_started_at ?? job.now };
  });
}

async function owned(tx: Queryable, host: AdminHost, lease: FinancialSyncLease) {
  await tx.query("SET LOCAL lock_timeout = '750ms'");
  await tx.query("SET LOCAL statement_timeout = '5s'");
  const { rowCount } = await tx.query(`SELECT 1 FROM finops_sync_jobs WHERE tenant_id = $1 AND provider = $2 AND configured
    AND lease_token = $3 AND lease_expires_at > clock_timestamp() FOR UPDATE`, [host.tenantId, lease.id, lease.token]);
  return rowCount === 1;
}

export async function waitFinancialSync(host: AdminHost, lease: FinancialSyncLease, checkpoint: string, retryAfterMs: number, hours: number) {
  if (lease.polls >= MAX_POLLS) return failFinancialSync(host, lease, 'FINOPS_PROVIDER_POLL_LIMIT', hours, false);
  return host.db.transaction(async tx => {
    if (!await owned(tx, host, lease)) return false;
    await tx.query(`UPDATE finops_sync_jobs SET lease_token = NULL, lease_expires_at = NULL,
      next_run_at = clock_timestamp() + $3 * interval '1 millisecond', checkpoint = $4, polls = polls + 1,
      last_error = CASE WHEN NOT $5 OR last_error = ANY($6::text[]) THEN NULL ELSE last_error END
      WHERE tenant_id = $1 AND provider = $2`, [host.tenantId, lease.id, Math.max(10 * SECOND, Math.min(30 * MINUTE, retryAfterMs)), checkpoint,
      lease.plans[0]?.historical === true, [...ACCOUNT_CODES]]);
    return true;
  });
}

export async function failFinancialSync(host: AdminHost, lease: FinancialSyncLease, code: string, hours: number, retryable: boolean) {
  const attempts = lease.attempts + 1, retry = retryable && attempts < MAX_ATTEMPTS;
  const delay = retry ? Math.min(30 * MINUTE, MINUTE * 2 ** (attempts - 1)) : hours * HOUR;
  const [planned] = lease.plans, historical = planned?.historical === true;
  return host.db.transaction(async tx => {
    if (!await owned(tx, host, lease)) return false;
    // A historical period's final failure is its coverage gap, with the code, so a failed read is never less visible than an empty one.
    if (historical && !retry) {
      await tx.query(`${GAP_UPSERT} VALUES ($1, $2, $3::date, $4::date, 'UNAVAILABLE', ARRAY[$5::text], 0, '[]'::jsonb) ${GAP_CONFLICT}`,
        [host.tenantId, lease.id, planned.period.from, planned.period.to, code]);
    }
    await tx.query(`UPDATE finops_sync_jobs SET lease_token = NULL, lease_expires_at = NULL,
      next_run_at = clock_timestamp() + $3 * interval '1 millisecond', last_error = CASE WHEN $6 THEN last_error ELSE $4 END,
      attempts = CASE WHEN $5 THEN attempts + 1 ELSE 0 END,
      polls = CASE WHEN $5 THEN polls ELSE 0 END, checkpoint = CASE WHEN $5 THEN checkpoint ELSE NULL END,
      periods = CASE WHEN $5 THEN periods ELSE '[]' END, cycle_started_at = CASE WHEN $5 THEN cycle_started_at ELSE NULL END
      WHERE tenant_id = $1 AND provider = $2`, [host.tenantId, lease.id, delay, code, retry, historical && !ACCOUNT_CODES.has(code)]);
    return true;
  });
}

/** CAS-fenced ledger append, meter snapshot, and checkpoint advancement. All succeed or roll back together. */
export async function finishFinancialSync(host: AdminHost, lease: FinancialSyncLease, result: Snapshot, hours: number) {
  const [planned, ...remaining] = lease.plans;
  if (!planned) throw new Error('FINOPS_SYNC_PLAN_INVALID');
  const scopes = [...new Set(result.entries.map(entry => entry.scope))];
  return host.db.transaction(async tx => {
    if (!await owned(tx, host, lease)) return false;
    if (scopes.length) {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['flofi-finops:' + host.tenantId]);
      const { rowCount } = await tx.query(`SELECT 1 FROM admin_audit_events WHERE tenant_id = $1 AND target = ANY($2::text[])
        AND kind = 'ADMIN_FINOPS_SYNC' AND outcome = 'OK' AND (detail->>'startedAt')::timestamptz > $3
        AND detail->>'rangeStart' < $5 AND detail->>'rangeEnd' > $4 LIMIT 1`,
      [host.tenantId, scopes, lease.startedAt, planned.period.from, planned.period.to]);
      if (rowCount) throw new Error('FINOPS_SYNC_SUPERSEDED');
      for (const entry of result.entries) await writeRecord(tx, host.tenantId, entry);
      for (const scope of scopes) await recordAudit(tx, host.tenantId, { actor: 'cli', kind: 'ADMIN_FINOPS_SYNC', outcome: 'OK', target: scope,
        detail: { method: 'AUTOMATIC', startedAt: lease.startedAt.toISOString(), rangeStart: planned.period.from, rangeEnd: planned.period.to } });
    }
    await tx.query(`INSERT INTO finops_sync_snapshots AS snapshot (tenant_id, provider, period_start, period_end, quality, limitations, meter_count, meters)
      VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8::jsonb) ON CONFLICT (tenant_id, provider, period_start) DO UPDATE SET
        period_end = EXCLUDED.period_end, quality = EXCLUDED.quality, limitations = EXCLUDED.limitations, meter_count = EXCLUDED.meter_count, meters = EXCLUDED.meters,
        collected_at = EXCLUDED.collected_at
      WHERE EXCLUDED.quality <> 'UNAVAILABLE' OR snapshot.quality = 'UNAVAILABLE'`,
    [host.tenantId, lease.id, planned.period.from, planned.period.to, result.coverage, result.limitations, result.meters.length, JSON.stringify(result.meters)]);
    const completedCycle = remaining.length === 0;
    const historicalComplete = planned.historical && !remaining.some(period => period.historical);
    await tx.query(`UPDATE finops_sync_jobs SET lease_token = NULL, lease_expires_at = NULL,
      next_run_at = clock_timestamp() + $3 * interval '1 hour', checkpoint = NULL, attempts = 0, polls = 0, periods = $4::jsonb,
      cycle_started_at = CASE WHEN $5 THEN NULL ELSE cycle_started_at END,
      last_success_at = CASE WHEN $6 THEN clock_timestamp() ELSE last_success_at END,
      historical_review_at = CASE WHEN $7 THEN clock_timestamp() ELSE historical_review_at END,
      last_error = CASE WHEN $6 THEN NULL WHEN NOT $8 AND NOT $9 THEN 'FINOPS_PROVIDER_NO_DATA'
        WHEN last_error = ANY($10::text[]) THEN NULL ELSE last_error END
      WHERE tenant_id = $1 AND provider = $2`,
    [host.tenantId, lease.id, completedCycle ? hours : 0, JSON.stringify(remaining), completedCycle,
      !planned.historical && result.coverage !== 'UNAVAILABLE', historicalComplete, result.coverage !== 'UNAVAILABLE', planned.historical,
      [...ACCOUNT_CODES]]);
    return true;
  });
}

export async function readFinancialSync(host: AdminHost): Promise<{ available: boolean; providers: FinancialProviderState[] }> {
  type State = { provider: FinancialProviderId; configured: boolean; last_attempt_at: Date | null; last_success_at: Date | null;
    next_run_at: Date; last_error: string | null; active: boolean };
  type Coverage = { provider: FinancialProviderId; from: string; to: string; collected_at: Date; quality: FinancialCoverage['quality'];
    limitations: string[]; meter_count: number };
  try {
    const { rows } = await host.db.query<State>(`SELECT provider, configured, last_attempt_at, last_success_at, next_run_at, last_error,
      (configured AND (cycle_started_at IS NOT NULL OR COALESCE(lease_expires_at > clock_timestamp(), FALSE))) AS active
      FROM finops_sync_jobs WHERE tenant_id = $1`, [host.tenantId]);
    const { rows: coverage } = await host.db.query<Coverage>(`SELECT j.provider, s.period_start::text AS "from", s.period_end::text AS "to",
      s.collected_at, s.quality, s.limitations, s.meter_count FROM finops_sync_jobs j CROSS JOIN LATERAL (
        SELECT period_start, period_end, collected_at, quality, limitations, meter_count
        FROM finops_sync_snapshots WHERE tenant_id = $1 AND provider = j.provider ORDER BY period_start DESC LIMIT 24
      ) s WHERE j.tenant_id = $1 ORDER BY j.provider, s.period_start DESC`, [host.tenantId]);
    return { available: true, providers: FINANCIAL_PROVIDER_IDS.map(id => {
      const state = rows.find(row => row.provider === id);
      return { id, configured: state?.configured ?? false, active: state?.active ?? false, lastAttempt: iso(state?.last_attempt_at ?? null),
        lastSuccess: iso(state?.last_success_at ?? null), nextSync: state?.configured ? iso(state.next_run_at) : null, errorCode: state?.last_error ?? null,
        coverage: coverage.filter(row => row.provider === id).map(row => ({ period: { from: row.from, to: row.to },
          collectedAt: row.collected_at.toISOString(), quality: row.quality, limitations: row.limitations, meterCount: row.meter_count })) };
    }) };
  } catch (error) {
    if (ledgerMissing(error)) return { available: false, providers: [] };
    throw error;
  }
}

export async function readFinancialMeters(host: AdminHost, provider: FinancialProviderId, periodStart: string): Promise<readonly FinancialMeter[]> {
  try {
    const { rows } = await host.db.query<{ meters: FinancialMeter[] }>(`SELECT meters FROM finops_sync_snapshots
      WHERE tenant_id = $1 AND provider = $2 AND period_start = $3::date`, [host.tenantId, provider, periodStart]);
    return rows[0]?.meters ?? [];
  } catch (error) {
    if (ledgerMissing(error)) return [];
    throw error;
  }
}
