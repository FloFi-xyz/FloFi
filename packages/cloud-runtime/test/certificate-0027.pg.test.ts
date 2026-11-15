// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001, Release A: the v26 build (this repository's shipped history ends at 0026) and the certified
 * 0027 `reconciliation_privacy`, from its SHA-256-pinned fixture, on disposable PostgreSQL. Release A ships only the certificate: it must
 * serve schema 26 exactly as before and, after 0027 is applied by Release B, serve schema 27 unchanged — every pre-existing object and row
 * unchanged, its own writes (audit events, runs, the 0016 purge mechanism) still working, its runner never changing a database ahead of it,
 * and a lock 0027 cannot get rolling back completely. The API, worker, cold starts and Vercel paths across the certificate are proven by
 * `apps/reference-dapp/backend/schema-compatibility.pg.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, CERTIFIED_FORWARD_MIGRATIONS, loadMigrations, migrate, SHIPPED_MIGRATIONS, type Migration } from '../src/index.js';
import { createTestDatabase } from './pg-harness';

const NEW_TABLES = ['admin_lookup_keys', 'admin_support_texts', 'execution_nonce_conflicts', 'privacy_legal_holds', 'privacy_requests', 'privacy_retention_activations'];
const NEW_FUNCTIONS = ['admin_lookup_key_transition', 'admin_support_text_guard', 'privacy_legal_hold_transition', 'privacy_request_transition',
  'privacy_retention_activation_transition', 'reject_privacy_truncate'];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const CERTIFICATE = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.migrations.some(m => m.name === 'reconciliation_privacy'))!;
/** The v26 build's history (this test stays valid after Release B ships 0027 on top: it always runs the v26 build). */
const V26 = SHIPPED_MIGRATIONS.slice(0, 26);
const v26Files = async () => (await loadMigrations()).slice(0, 26);

/** 0027 exactly as Release B will ship it: the fixture's bytes under the certified identity. */
async function certified0027(): Promise<Migration> {
  const sql = await readFile(new URL('./fixtures/0027_reconciliation_privacy.sql', import.meta.url), 'utf8');
  return { ...CERTIFICATE.migrations[0]!, sql, sha256: sha(sql) };
}
async function catalog(db: { query: <T>(sql: string) => Promise<{ rows: T[] }> }) {
  const q = async (sql: string) => (await db.query<{ item: string }>(sql)).rows.map(r => r.item).sort();
  return {
    columns: await q(`SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS item
      FROM information_schema.columns WHERE table_schema = 'public'`),
    constraints: await q(`SELECT conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) AS item FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace`),
    indexes: await q(`SELECT tablename || ':' || indexname || ':' || indexdef AS item FROM pg_indexes WHERE schemaname = 'public'`),
    functions: await q(`SELECT p.proname || ':' || md5(pg_get_functiondef(p.oid)) AS item FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`),
    triggers: await q(`SELECT tgrelid::regclass::text || ':' || tgname || ':' || md5(pg_get_triggerdef(oid)) AS item FROM pg_trigger WHERE NOT tgisinternal`),
  };
}
const ofNew = (item: string) => NEW_TABLES.some(t => item.startsWith(t + '.') || item.startsWith(t + ':')) || NEW_FUNCTIONS.some(f => item.startsWith(f + ':'));

describe('Release A: certificate for 0027 reconciliation_privacy (v26 build, PostgreSQL)', () => {
  it('certifies the exact fixture bytes for the v26 build; a build that ships 0027 ships exactly those bytes', async () => {
    expect(V26.at(-1)).toMatchObject({ version: 26, name: 'flight_early_list' });
    expect(CERTIFICATE.base).toEqual(V26[25]);
    expect((await certified0027()).sha256).toBe(CERTIFICATE.migrations[0]!.sha256);
    // Release A ships only through 0026; Release B ships 0027 and it must be the certified identity, byte for byte.
    if (SHIPPED_MIGRATIONS.length === 26) expect((await loadMigrations()).at(-1)).toMatchObject({ version: 26 });
    else expect(SHIPPED_MIGRATIONS[26]).toEqual(CERTIFICATE.migrations[0]);
  });

  it('serves schema 26 unchanged, and schema 27 only through the certificate; 0027 is purely additive; v26 writes and purges keep working', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const v26 = await v26Files(), m27 = await certified0027();
      expect(await migrate(t.db, v26)).toHaveLength(26);
      expect(await assertSchemaCompatible(t.db, V26)).toEqual({ version: 26, application: 26, forward: [] });
      await t.db.query(`INSERT INTO tenants (tenant_id) VALUES ('default') ON CONFLICT DO NOTHING`);
      await t.db.query(`INSERT INTO admin_audit_events (tenant_id, actor, kind, outcome, detail) VALUES ('default', 'cli', 'SUPPORT_NOTE', 'OK', '{"text":"v26 note"}')`);
      await t.db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ('default', 'wf-1')`);
      await t.db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256)
        VALUES ('default', 'crosschain-universal', 'run-1.jsonl', 'RUN', 1, 1, 3, $1)`, [sha('{}\n')]);
      await t.db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, needs_observation, has_evidence, log_version)
        VALUES ('default', 'run-1', 'crosschain-universal', 'run-1.jsonl', 'wf-1', 'crosschain-universal', 'SUBMISSION_RESULT_UNKNOWN', 'PUBLIC_TESTNET', true, false, 1)`);
      const before = await catalog(t.db);
      const rows = async () => ({ audit: (await t.db.query(`SELECT * FROM admin_audit_events ORDER BY event_id`)).rows,
        runs: (await t.db.query(`SELECT * FROM execution_runs ORDER BY run_id`)).rows });
      const data = await rows();

      // Release B applies 0027 (here: the certified bytes, with the same runner).
      expect(await migrate(t.db, [...v26, m27])).toEqual([27]);
      const after = await catalog(t.db);
      for (const key of Object.keys(before) as (keyof typeof before)[]) {
        expect(after[key].filter(item => before[key].includes(item))).toEqual(before[key]);           // nothing removed or redefined
        expect(after[key].filter(item => !before[key].includes(item) && !ofNew(item))).toEqual([]);   // additions only on new objects
      }
      expect(await rows()).toEqual(data);

      // This (v26) build: compatible by certificate only; its runner never changes a database ahead of it.
      expect(await assertSchemaCompatible(t.db, V26)).toEqual({ version: 27, application: 26, forward: CERTIFICATE.migrations });
      await expect(assertSchemaCompatible(t.db, V26, [])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
      await expect(assertSchemaCurrent(t.db, V26)).rejects.toThrow();
      expect(await migrate(t.db, v26)).toEqual([]);
      expect((await t.db.query('SELECT max(version)::int AS v FROM schema_migrations')).rows).toEqual([{ v: 27 }]);

      // v26 writes keep working on schema 27: append-only audit, new runs, and the 0016 purge mechanism (which cascades a 0027 diagnostic row).
      await t.db.query(`INSERT INTO admin_audit_events (tenant_id, actor, kind, outcome, detail) VALUES ('default', 'cli', 'SUPPORT_NOTE', 'OK', '{"text":"after 27"}')`);
      await expect(t.db.query(`UPDATE admin_audit_events SET detail = '{}'`)).rejects.toThrow(/APPEND_ONLY_VIOLATION/);
      await t.db.query(`INSERT INTO execution_nonce_conflicts (tenant_id, run_id, attempt_id, flow, chain_id, nonce, classification, evidence_fingerprint, report,
          stable_observations, investigations, first_observed_at, last_checked_at, last_changed_at)
        VALUES ('default', 'run-1', 'run-1.approval.1', 'crosschain-universal', '8453', '60', 'CONFLICTING_TRANSACTION_IDENTIFIED', repeat('a', 64), '{}', 0, 1, now(), now(), now())`);
      await t.db.transaction(async tx => {
        await tx.query(`INSERT INTO execution_purge_audit (tenant_id, run_id, owner_account, namespace, log_name, log_sha256, log_version, segment_count, journal_count)
          VALUES ('default', 'run-1', '0x${'1'.repeat(40)}', 'crosschain-universal', 'run-1.jsonl', $1, 1, 0, 0)`, [sha('{}\n')]);
        await tx.query(`INSERT INTO execution_purge_permits VALUES ('default', 'run-1', 'crosschain-universal', 'run-1.jsonl', txid_current())`);
        await tx.query(`DELETE FROM execution_runs WHERE run_id = 'run-1'`);
      });
      expect((await t.db.query(`SELECT count(*)::int AS n FROM execution_nonce_conflicts`)).rows).toEqual([{ n: 0 }]);
    } finally { await t.drop(); }
  });

  it('a lock 0027 cannot get within 5 s fails and rolls back completely while schema 26 keeps serving; a later run applies it once', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const v26 = await v26Files(), m27 = await certified0027();
      await migrate(t.db, v26);
      const blocker = t.open(1);
      try {
        await blocker.transaction(async tx => {
          await tx.query('LOCK TABLE execution_runs IN ACCESS EXCLUSIVE MODE');
          await expect(migrate(t.db, [...v26, m27])).rejects.toThrow();
        });
      } finally { await blocker.close(); }
      expect(await assertSchemaCurrent(t.db, V26)).toBe(26);
      expect((await t.db.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])`, [NEW_TABLES])).rows).toEqual([{ n: 0 }]);
      expect(await migrate(t.db, [...v26, m27])).toEqual([27]);
      expect(await migrate(t.db, [...v26, m27])).toEqual([]);
    } finally { await t.drop(); }
  }, 30_000);
});
