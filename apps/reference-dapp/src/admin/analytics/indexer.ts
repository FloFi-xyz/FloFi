// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: fills `admin_run_facts` (migration 0012) from canonical run records — off the execution path. It runs only when an
 * administrator opens analytics (small, time-bounded batches) or from the operator CLI (`admin-cli index`), reads run logs without
 * locking them, and writes only the derived cache. Executions never read it; deleting it only costs a re-index.
 *
 * Only runs that started executing are indexed (an attempt past PREPARED/CANCELLED, evidence, or a composition). Composition records
 * are indexed first: they name their step runs, which are then marked `composition_of` so they are counted inside the composition. A
 * composition created before the range is still (re)indexed while it grows, so a step run inside the range is never counted on its own.
 * A record that cannot be read or has no recognizable workflow is stored as UNINDEXABLE with a closed code and reported, never guessed.
 *
 * Ranged reads use the existing (tenant_id, updated_at) index of `execution_runs` (migration 0012 adds no index there): a projection row is
 * written with updated_at = created_at and only moves updated_at forward, so every run created (or composition grown) since `from` was
 * updated since then; the hour of slack absorbs transaction-start skew between concurrent writers.
 */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { COMPOSITION_FLOWS } from './classify.ts';
import { lastRecordLine, recordFacts } from './actions.ts';

export const INDEXER_VERSION = 1;
const FULL_READ_LIMIT = 8 * 1024 * 1024;
const COMPOSITIONS = [...COMPOSITION_FLOWS];
export type IndexSummary = { readonly indexed: number; readonly unindexable: number; readonly pending: number; readonly budgetExhausted: boolean };
export type IndexOptions = { readonly from?: Date | null; readonly to?: Date | null; readonly limit: number; readonly budgetMs: number; readonly now?: () => number };

const CANDIDATES = `FROM execution_runs r LEFT JOIN admin_run_facts f ON f.tenant_id = r.tenant_id AND f.run_id = r.run_id
  WHERE r.tenant_id = $1 AND ($2::timestamptz IS NULL OR (r.updated_at >= $2::timestamptz - interval '1 hour' AND (r.created_at >= $2 OR r.flow = ANY($5::text[]))))
    AND ($3::timestamptz IS NULL OR r.created_at < $3)
    AND (r.has_evidence OR r.flow = ANY($5::text[]) OR EXISTS (SELECT 1 FROM execution_attempts a WHERE a.tenant_id = r.tenant_id AND a.run_id = r.run_id
      AND a.state NOT IN ('PREPARED', 'CANCELLED')))
    AND (f.run_id IS NULL OR f.indexer_version < $4 OR (r.flow = ANY($5::text[]) AND f.indexed_log_version < r.log_version))`;

async function readRecord(db: Database, tenantId: string, namespace: string, name: string): Promise<unknown> {
  const last = await db.query<{ bytes: Buffer }>(`SELECT bytes FROM execution_log_segments WHERE tenant_id = $1 AND namespace = $2 AND name = $3
    ORDER BY seq DESC LIMIT 1`, [tenantId, namespace, name]);
  if (!last.rows[0]) throw new Error('RUN_LOG_MISSING');
  try { return lastRecordLine(new Uint8Array(last.rows[0].bytes)); } catch { /* a segment that does not end a record: read the whole log */ }
  const size = await db.query<{ byte_length: number }>(`SELECT byte_length FROM execution_logs WHERE tenant_id = $1 AND namespace = $2 AND name = $3`, [tenantId, namespace, name]);
  if ((size.rows[0]?.byte_length ?? Infinity) > FULL_READ_LIMIT) throw new Error('RUN_LOG_TOO_LARGE');
  const all = await db.query<{ bytes: Buffer }>(`SELECT bytes FROM execution_log_segments WHERE tenant_id = $1 AND namespace = $2 AND name = $3 ORDER BY seq`,
    [tenantId, namespace, name]);
  try { return lastRecordLine(new Uint8Array(Buffer.concat(all.rows.map(row => row.bytes)))); } catch { throw new Error('RUN_RECORD_UNREADABLE'); }
}

export async function indexRunFacts(db: Database, tenantId: string, options: IndexOptions): Promise<IndexSummary> {
  const now = options.now ?? (() => Date.now()), started = now();
  const args = [tenantId, options.from ?? null, options.to ?? null, INDEXER_VERSION, COMPOSITIONS];
  const { rows } = await db.query<{ run_id: string; flow: string; namespace: string; log_name: string; log_version: string }>(`SELECT r.run_id, r.flow, r.namespace,
    r.log_name, r.log_version::text AS log_version ${CANDIDATES} ORDER BY (r.flow = ANY($5::text[])) DESC, r.created_at DESC, r.run_id LIMIT $6`, [...args, options.limit]);
  let indexed = 0, unindexable = 0, budgetExhausted = false;
  for (const run of rows) {
    if (now() - started > options.budgetMs) { budgetExhausted = true; break; }
    let facts: ReturnType<typeof recordFacts>;
    try { facts = recordFacts(run.flow, await readRecord(db, tenantId, run.namespace, run.log_name)); }
    catch (error) { facts = { ok: false, code: error instanceof Error && /^RUN_[A-Z_]+$/.test(error.message) ? error.message : 'RUN_RECORD_UNREADABLE' }; }
    await db.query(`INSERT INTO admin_run_facts (tenant_id, run_id, indexer_version, indexed_log_version, state, code, actions, skipped_nodes)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      ON CONFLICT (tenant_id, run_id) DO UPDATE SET indexer_version = EXCLUDED.indexer_version, indexed_log_version = EXCLUDED.indexed_log_version,
        state = EXCLUDED.state, code = EXCLUDED.code, actions = EXCLUDED.actions, skipped_nodes = EXCLUDED.skipped_nodes, indexed_at = now()`,
    [tenantId, run.run_id, INDEXER_VERSION, run.log_version, facts.ok ? 'INDEXED' : 'UNINDEXABLE', facts.ok ? null : facts.code, JSON.stringify(facts.ok ? facts.actions : []),
      facts.ok ? facts.skipped : 0]);
    if (facts.ok && facts.children.length) {
      // Step runs of a composition: counted inside it. Their own record is not needed for that, so an empty fact suffices.
      await db.query(`INSERT INTO admin_run_facts (tenant_id, run_id, indexer_version, indexed_log_version, state, composition_of)
          SELECT r.tenant_id, r.run_id, $3, r.log_version, 'INDEXED', $4 FROM execution_runs r WHERE r.tenant_id = $1 AND r.run_id = ANY($2::text[])
        ON CONFLICT (tenant_id, run_id) DO UPDATE SET composition_of = EXCLUDED.composition_of`, [tenantId, facts.children, INDEXER_VERSION, run.run_id]);
    }
    if (facts.ok) indexed++; else unindexable++;
  }
  const pending = Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n ${CANDIDATES}`, args)).rows[0]?.n ?? 0);
  return { indexed, unindexable, pending, budgetExhausted };
}
