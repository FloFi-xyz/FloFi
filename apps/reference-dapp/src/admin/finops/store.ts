// SPDX-License-Identifier: AGPL-3.0-only
import type { Queryable } from '@defi-workflow-engine/cloud-runtime';
import type { AdminHost } from '../host.ts';
import { recordAudit } from '../store.ts';
import type { Entry, LedgerRecord, Period, ScopeId } from './economics.ts';

const RECORD_LIMIT = 1_500;
type RecordRow = { record_id: string; document: Entry; updated_at: Date };

export async function readLedger(host: AdminHost, period: Period) {
  const { rows } = await host.db.query<RecordRow>(`SELECT record_id, document, updated_at FROM (
      SELECT DISTINCT ON (scope_id, environment, source, period_start, period_end) record_id, document, updated_at
      FROM finops_cost_records WHERE tenant_id = $1 AND period_start < $3::date AND period_end > $2::date
      ORDER BY scope_id, environment, source, period_start, period_end, record_id DESC
    ) latest ORDER BY updated_at DESC, record_id DESC LIMIT $4`, [host.tenantId, period.from, period.to, RECORD_LIMIT + 1]);
  const records: LedgerRecord[] = rows.slice(0, RECORD_LIMIT).map(row => ({ ...row.document, id: row.record_id, updatedAt: row.updated_at.toISOString() }));
  return { records, complete: rows.length <= RECORD_LIMIT };
}

export class FinopsConflictError extends Error {
  constructor() { super('FINOPS_PERIOD_CONFLICT'); }
}
export class FinopsSupersededError extends Error {
  constructor() { super('FINOPS_SYNC_SUPERSEDED'); }
}
export function ledgerMissing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === '42P01';
}

async function writeRecord(tx: Queryable, tenantId: string, entry: Entry, replaceId?: string) {
  const { scope, environment, source, period } = entry, serialized = JSON.stringify(entry);
  const columns = [tenantId, scope, environment, source, period.from, period.to, serialized];
  const { rows } = await tx.query<{ id: string; exact: boolean; same: boolean }>(`SELECT DISTINCT ON (period_start, period_end)
      record_id::text AS id, (period_start = $5::date AND period_end = $6::date) AS exact, document = $7::jsonb AS same
    FROM finops_cost_records
    WHERE tenant_id = $1 AND scope_id = $2 AND environment = $3 AND source = $4 AND period_start < $6::date AND period_end > $5::date
    ORDER BY period_start, period_end, record_id DESC LIMIT 2`, columns);
  if (rows.length > 1 || rows.some(row => !row.exact)) throw new FinopsConflictError();
  const current = rows[0];
  if (current?.same) return null;
  if (current && source !== 'PROVIDER_COST' && current.id !== replaceId || replaceId && current?.id !== replaceId) throw new FinopsConflictError();
  const result = await tx.query<{ id: string }>(`INSERT INTO finops_cost_records (tenant_id, scope_id, environment, source, period_start, period_end, document)
    VALUES ($1,$2,$3,$4,$5::date,$6::date,$7::jsonb) RETURNING record_id::text AS id`, columns);
  return result.rows[0]!.id;
}

export type LedgerWrite = { action: 'MANUAL' | 'CSV'; replaceId?: string | undefined }
  | { action: 'SYNC'; period: Period; startedAt: string };

export async function beginBillingSync(host: AdminHost, actor: string, scope: ScopeId) {
  return host.db.transaction(async tx => {
    await tx.query("SET LOCAL lock_timeout = '3s'");
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['flofi-finops:' + host.tenantId]);
    await tx.query('SELECT 1 FROM finops_cost_records LIMIT 0');
    const recent = await tx.query(`SELECT 1 FROM admin_audit_events WHERE tenant_id = $1 AND target = $2
      AND kind = 'ADMIN_FINOPS_SYNC_STARTED' AND at > clock_timestamp() - interval '1 minute' LIMIT 3`, [host.tenantId, scope]);
    if (recent.rowCount >= 3) throw new Error('FINOPS_SYNC_RATE_LIMITED');
    const clock = await tx.query<{ now: string }>('SELECT clock_timestamp()::text AS now');
    await recordAudit(tx, host.tenantId, { actor, kind: 'ADMIN_FINOPS_SYNC_STARTED', outcome: 'OK', target: scope });
    return clock.rows[0]!.now;
  });
}

export async function writeLedger(host: AdminHost, actor: string, entries: readonly Entry[], operation: LedgerWrite) {
  const { action } = operation, replaceId = action === 'SYNC' ? undefined : operation.replaceId;
  return host.db.transaction(async tx => {
    await tx.query("SET LOCAL lock_timeout = '3s'");
    // One short transaction serializes mutation admission within a tenant. It never spans a provider fetch.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['flofi-finops:' + host.tenantId]);
    if (action === 'SYNC') {
      const newer = await tx.query(`SELECT 1 FROM admin_audit_events WHERE tenant_id = $1 AND target = $2
        AND kind = 'ADMIN_FINOPS_SYNC' AND outcome = 'OK' AND (detail->>'startedAt')::timestamptz > $3::timestamptz
        AND detail->>'rangeStart' < $5 AND detail->>'rangeEnd' > $4 LIMIT 1`,
      [host.tenantId, entries[0]!.scope, operation.startedAt, operation.period.from, operation.period.to]);
      if (newer.rowCount) throw new FinopsSupersededError();
    }
    let inserted = 0, lastId: string | null = null;
    for (const entry of entries) {
      const id = await writeRecord(tx, host.tenantId, entry, replaceId);
      if (id !== null) { inserted++; lastId = id; }
    }
    await recordAudit(tx, host.tenantId, { actor, kind: action === 'SYNC' ? 'ADMIN_FINOPS_SYNC' : 'ADMIN_FINOPS_IMPORT', outcome: 'OK',
      target: action === 'SYNC' ? entries[0]!.scope : lastId ? 'finops:' + lastId : 'finops',
      detail: { method: action, inserted, duplicate: entries.length - inserted, changedFrom: replaceId ?? null,
        ...action === 'SYNC' ? { startedAt: operation.startedAt, rangeStart: operation.period.from, rangeEnd: operation.period.to } : {} } });
    return { inserted, duplicate: entries.length - inserted };
  });
}

export async function readSyncState(host: AdminHost) {
  const { rows } = await host.db.query<{ target: string; last_attempt: Date; last_success: Date | null; last_failed: Date | null }>(`SELECT target,
    max(at) AS last_attempt, max(at) FILTER (WHERE outcome = 'OK') AS last_success, max(at) FILTER (WHERE outcome = 'FAILED') AS last_failed
    FROM admin_audit_events WHERE tenant_id = $1 AND kind = 'ADMIN_FINOPS_SYNC' AND target IS NOT NULL GROUP BY target`, [host.tenantId]);
  return rows.map(row => ({ scope: row.target, lastAttempt: row.last_attempt.toISOString(), lastSuccess: row.last_success?.toISOString() ?? null,
    lastFailed: row.last_failed?.toISOString() ?? null }));
}
