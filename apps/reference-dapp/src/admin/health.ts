// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: operational health from what the console can actually observe — the shared PostgreSQL state (schema, durable work
 * queue, observation backlog, automation scheduler activity) and, in the remote topology, the Railway API's public readiness endpoint.
 * Worker liveness is inferred from durable activity (completed work items, evaluations); the console has no other channel to the worker
 * and says so. No secret, token or address is read or returned.
 */
import { schemaCompatibilityState, schemaLedgerMissing, SHIPPED_MIGRATIONS, type MigrationIdentity, type SchemaCompatibilityState } from '@defi-workflow-engine/cloud-runtime';
import type { AdminHost } from './host.ts';
import { loadExecutionAttention, type AttentionCounts, type ExecutionAttention } from './support/lifecycle.ts';

type Env = Readonly<Record<string, string | undefined>>;
type Probe<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };
export const schemaHealthLabels: Record<SchemaCompatibilityState, string> = {
  exact: 'Exact schema',
  'certified-ahead': 'Certified compatible schema ahead',
  behind: 'Database schema behind this build',
  'uncertified-ahead': 'Uncertified schema ahead',
  'invalid-history': 'Invalid migration history',
  unavailable: 'Database unavailable',
};
export const schemaHealthy = (state: SchemaCompatibilityState) => state === 'exact' || state === 'certified-ahead';
export type HealthReport = {
  readonly checkedAt: string;
  readonly database: Probe<{ readonly latencyMs: number; readonly appliedMigrations: number; readonly shippedMigrations: number; readonly tenantId: string;
    readonly schema: SchemaCompatibilityState }>;
  readonly api: { readonly topology: 'remote' | 'embedded-or-local'; readonly readiness: Probe<{ readonly status: number; readonly latencyMs: number }> | null };
  readonly queue: Probe<{ readonly ready: number; readonly overdue: number; readonly oldestOverdueSeconds: number | null; readonly leased: number; readonly expiredLeases: number;
    readonly done24h: number; readonly dead24h: number; readonly lastCompletedAt: string | null; readonly byKind: readonly { readonly kind: string; readonly ready: number; readonly dead24h: number }[] }>;
  /**
   * Execution attention from the shared lifecycle model (`support/lifecycle.ts`) — the same figures Support & Recovery, Workflows and the
   * Overview show. `flagged` is the raw `attention_required` total (historical flags included); `attention` separates active, under
   * investigation, historical and verified-resolved runs. `truncated`: more candidates than classified, so lifecycle counts are lower bounds.
   */
  readonly runs: Probe<{ readonly observing: number; readonly oldestObservationSeconds: number | null; readonly flagged: number; readonly attention: AttentionCounts;
    readonly truncated: boolean; readonly notesOk: boolean }>;
  readonly scheduler: Probe<{ readonly installed: boolean; readonly lastEvaluationAt: string | null; readonly overdueRules: number }>;
  readonly incidents: readonly { readonly kind: string; readonly code: string; readonly at: string; readonly run: string | null }[];
  readonly incidentsAvailable: boolean;
};
const CODE = /^[A-Z][A-Z0-9_]{2,80}/;
const failed = (error: unknown): { ok: false; code: string } => ({ ok: false, code: error instanceof Error && CODE.test(error.message) ? error.message.match(CODE)![0] : 'QUERY_FAILED' });
const seconds = (value: Date | null, now: Date) => value ? Math.max(0, Math.round((now.getTime() - value.getTime()) / 1000)) : null;

export async function apiReadiness(env: Env, fetchImpl: typeof fetch = fetch): Promise<HealthReport['api']> {
  const base = env.API_BASE_URL?.trim();
  if (!base) return { topology: 'embedded-or-local', readiness: null };
  let url: URL;
  try { url = new URL('/readyz', base); } catch { return { topology: 'remote', readiness: { ok: false, code: 'API_BASE_URL_INVALID' } }; }
  const started = performance.now();
  try {
    const response = await fetchImpl(url, { method: 'GET', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(3_000) });
    await response.body?.cancel().catch(() => undefined);
    const latencyMs = Math.round(performance.now() - started);
    return { topology: 'remote', readiness: response.ok ? { ok: true, value: { status: response.status, latencyMs } } : { ok: false, code: `API_NOT_READY_${response.status}` } };
  } catch (error) {
    return { topology: 'remote', readiness: { ok: false, code: error instanceof Error && error.name === 'TimeoutError' ? 'API_TIMEOUT' : 'API_UNREACHABLE' } };
  }
}

export async function healthReport(env: Env, host: AdminHost, now: Date, fetchImpl: typeof fetch = fetch,
  shared?: Promise<ExecutionAttention | null>): Promise<HealthReport> {
  const { db, tenantId } = host, day = new Date(now.getTime() - 86_400_000);
  const api = apiReadiness(env, fetchImpl);
  const database = (async (): Promise<HealthReport['database']> => {
    const started = performance.now();
    try {
      const { rows } = await db.query<MigrationIdentity>('SELECT version, name, sha256 FROM schema_migrations ORDER BY version');
      return { ok: true, value: { latencyMs: Math.round(performance.now() - started), appliedMigrations: rows.length,
        shippedMigrations: SHIPPED_MIGRATIONS.length, tenantId, schema: schemaCompatibilityState(rows) } };
    } catch (error) {
      if (schemaLedgerMissing(error))
        return { ok: true, value: { latencyMs: Math.round(performance.now() - started), appliedMigrations: 0, shippedMigrations: SHIPPED_MIGRATIONS.length, tenantId, schema: 'behind' } };
      return { ok: false, code: 'DATABASE_UNAVAILABLE' };
    }
  })();
  const queue = (async (): Promise<HealthReport['queue']> => {
    try {
      const [summary, byKind] = await Promise.all([
        db.query<{ ready: number; overdue: number; oldest: Date | null; leased: number; expired: number; done: number; dead: number; last: Date | null }>(`SELECT
            count(*) FILTER (WHERE state = 'READY')::int AS ready,
            count(*) FILTER (WHERE state = 'READY' AND available_at < $2::timestamptz - interval '5 minutes')::int AS overdue,
            min(available_at) FILTER (WHERE state = 'READY' AND available_at < $2::timestamptz - interval '5 minutes') AS oldest,
            count(*) FILTER (WHERE state = 'LEASED')::int AS leased,
            count(*) FILTER (WHERE state = 'LEASED' AND lease_expires_at < $2::timestamptz)::int AS expired,
            count(*) FILTER (WHERE state = 'DONE' AND completed_at >= $3)::int AS done,
            count(*) FILTER (WHERE state = 'DEAD' AND completed_at >= $3)::int AS dead,
            max(completed_at) AS last
          FROM work_items WHERE tenant_id = $1 AND (state IN ('READY', 'LEASED') OR completed_at >= $3)`, [tenantId, now, day]),
        db.query<{ kind: string; ready: number; dead: number }>(`SELECT kind, count(*) FILTER (WHERE state = 'READY')::int AS ready,
            count(*) FILTER (WHERE state = 'DEAD')::int AS dead FROM work_items WHERE tenant_id = $1 AND (state IN ('READY', 'LEASED') OR completed_at >= $2)
          GROUP BY kind ORDER BY kind`, [tenantId, day]),
      ]);
      const row = summary.rows[0]!;
      return { ok: true, value: { ready: row.ready, overdue: row.overdue, oldestOverdueSeconds: seconds(row.oldest, now), leased: row.leased, expiredLeases: row.expired,
        done24h: row.done, dead24h: row.dead, lastCompletedAt: row.last?.toISOString() ?? null,
        byKind: byKind.rows.map(r => ({ kind: r.kind, ready: r.ready, dead24h: r.dead })) } };
    } catch (error) { return failed(error); }
  })();
  const runs = (async (): Promise<HealthReport['runs']> => {
    try {
      // With a shared read, use exactly it (never a second, possibly different snapshot); without one, read here.
      const a = shared ? await shared : await loadExecutionAttention(db, tenantId, now);
      if (!a) return { ok: false, code: 'EXECUTION_ATTENTION_UNAVAILABLE' };
      return { ok: true, value: { observing: a.observingTotal, oldestObservationSeconds: a.oldestObservationSeconds, flagged: a.flaggedTotal,
        attention: a.counts, truncated: a.truncated, notesOk: a.notesOk } };
    } catch (error) { return failed(error); }
  })();
  const scheduler = (async (): Promise<HealthReport['scheduler']> => {
    try {
      const present = (await db.query<{ ok: boolean }>(`SELECT to_regclass('public.automation_evaluations') IS NOT NULL AS ok`)).rows[0]?.ok === true;
      if (!present) return { ok: true, value: { installed: false, lastEvaluationAt: null, overdueRules: 0 } };
      const [last, overdue] = await Promise.all([
        db.query<{ at: Date | null }>(`SELECT max(at) AS at FROM automation_evaluations WHERE tenant_id = $1 AND at >= $2`, [tenantId, new Date(now.getTime() - 30 * 86_400_000)]),
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM automation_rules WHERE tenant_id = $1 AND state = 'ACTIVE' AND next_evaluation_at < $2::timestamptz - interval '5 minutes'`,
          [tenantId, now]),
      ]);
      return { ok: true, value: { installed: true, lastEvaluationAt: last.rows[0]?.at?.toISOString() ?? null, overdueRules: overdue.rows[0]?.n ?? 0 } };
    } catch (error) { return failed(error); }
  })();
  const incidents = (async () => {
    try {
      const { rows } = await db.query<{ kind: string; last_error: string | null; completed_at: Date; run_id: string | null }>(`SELECT kind, last_error, completed_at, run_id
        FROM work_items WHERE tenant_id = $1 AND state = 'DEAD' ORDER BY completed_at DESC LIMIT 20`, [tenantId]);
      return rows.map(row => ({ kind: row.kind, code: row.last_error && CODE.test(row.last_error) ? row.last_error.match(CODE)![0] : 'UNCLASSIFIED_ERROR',
        at: row.completed_at.toISOString(), run: row.run_id ? row.run_id.slice(0, 18) : null }));
    } catch { return null; }
  })();
  const history = await incidents;
  return { checkedAt: now.toISOString(), database: await database, api: await api, queue: await queue, runs: await runs,
    scheduler: await scheduler, incidents: history ?? [], incidentsAvailable: history !== null };
}
