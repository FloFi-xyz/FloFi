// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001: schema 26 → 27 against real disposable PostgreSQL. 0027 adds six tables (nonce-conflict diagnostics;
 * Support text, lookup keys, legal holds, data-subject requests, retention activations) with their own functions, triggers and indexes. Nothing
 * pre-existing changes: every earlier row survives, the audit table stays append-only, a v26 build serves schema 27 only through its certificate,
 * the v26 owner-history purge still deletes a run (its diagnostic row cascades), a lock 0027 cannot get fails and rolls back completely, and a
 * runner applies it exactly once.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, CERTIFIED_FORWARD_MIGRATIONS, loadMigrations, migrate, SHIPPED_MIGRATIONS } from '../src/index.js';
import { createTestDatabase } from './pg-harness';

const NEW_TABLES = ['admin_lookup_keys', 'admin_support_texts', 'execution_nonce_conflicts', 'privacy_legal_holds', 'privacy_requests', 'privacy_retention_activations'];
const NEW_FUNCTIONS = ['admin_lookup_key_transition', 'admin_support_text_guard', 'privacy_legal_hold_transition', 'privacy_request_transition',
  'privacy_retention_activation_transition', 'reject_privacy_truncate'];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Every relation, column, constraint, index, function and trigger in `public`, as text: the schema a build can observe. */
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
const ofNewTable = (item: string) => NEW_TABLES.some(table => item.startsWith(table + '.') || item.startsWith(table + ':'));

describe('Reconciliation & privacy migration (0027)', () => {
  it('is the exact certified bytes, kept as a fixture, and certified for the v26 build', async () => {
    const identity = SHIPPED_MIGRATIONS[26]!;
    expect(identity).toMatchObject({ version: 27, name: 'reconciliation_privacy' });
    expect(sha(await readFile(new URL('./fixtures/0027_reconciliation_privacy.sql', import.meta.url), 'utf8'))).toBe(identity.sha256);
    expect(sha(await readFile(new URL('../migrations/0027_reconciliation_privacy.sql', import.meta.url), 'utf8'))).toBe(identity.sha256);
    expect(CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 26)).toMatchObject({ base: SHIPPED_MIGRATIONS[25], migrations: [identity] });
  });

  it('is purely additive: every pre-existing object and row is unchanged; v26 serves it only by certificate; a runner applies it once', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const all = await loadMigrations(), v26 = all.slice(0, 26);
      await migrate(t.db, v26);
      // Rows a v26 build writes, including append-only audit and a run the owner can later purge.
      await t.db.query(`INSERT INTO tenants (tenant_id) VALUES ('default') ON CONFLICT DO NOTHING`);
      await t.db.query(`INSERT INTO admin_audit_events (tenant_id, actor, kind, outcome, detail) VALUES ('default', 'cli', 'SUPPORT_NOTE', 'OK', '{"text":"legacy"}')`);
      await t.db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ('default', 'wf-1')`);
      await t.db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256)
        VALUES ('default', 'crosschain-universal', 'run-1.jsonl', 'RUN', 1, 1, 3, $1)`, [sha('{}\n')]);
      await t.db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, needs_observation, has_evidence, log_version)
        VALUES ('default', 'run-1', 'crosschain-universal', 'run-1.jsonl', 'wf-1', 'crosschain-universal', 'SUBMISSION_RESULT_UNKNOWN', 'PUBLIC_TESTNET', true, false, 1)`);
      const before = await catalog(t.db);
      const rows = async () => ({ audit: (await t.db.query(`SELECT * FROM admin_audit_events ORDER BY event_id`)).rows,
        runs: (await t.db.query(`SELECT * FROM execution_runs ORDER BY run_id`)).rows });
      const data = await rows();

      // The v27 history (0028 ships on top in Release B and is proven by saved-recipients-migration.pg.test.ts).
      expect(await migrate(t.db, all.slice(0, 27))).toEqual([27]);
      expect(await migrate(t.db, all.slice(0, 27))).toEqual([]);
      const after = await catalog(t.db);
      for (const key of Object.keys(before) as (keyof typeof before)[]) {
        expect(after[key].filter(item => before[key].includes(item))).toEqual(before[key]);       // nothing removed or redefined
        const added = after[key].filter(item => !before[key].includes(item));
        expect(added.filter(item => !ofNewTable(item) && !NEW_FUNCTIONS.some(f => item.startsWith(f + ':')))).toEqual([]); // additions only to new objects
      }
      expect(await rows()).toEqual(data);
      // The v26 build serves schema 27 through its certificate only; the strict check refuses it.
      expect(await assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS.slice(0, 26))).toMatchObject({ version: 27, application: 26 });
      await expect(assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS.slice(0, 26), [])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
      await expect(assertSchemaCurrent(t.db, SHIPPED_MIGRATIONS.slice(0, 26))).rejects.toThrow();
      expect(await assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS.slice(0, 27))).toMatchObject({ version: 27, application: 27, forward: [] });
      // The audit skeleton stays append-only.
      await expect(t.db.query(`UPDATE admin_audit_events SET detail = '{}'`)).rejects.toThrow(/APPEND_ONLY_VIOLATION/);
      for (const table of NEW_TABLES.filter(n => n !== 'execution_nonce_conflicts'))
        await expect(t.db.query(`TRUNCATE ${table}`)).rejects.toThrow(/PRIVACY_TRUNCATE_REFUSED/);
      // A diagnostic row never blocks the v26 owner-history purge of its run: it cascades with the run.
      await t.db.query(`INSERT INTO execution_nonce_conflicts (tenant_id, run_id, attempt_id, flow, chain_id, nonce, classification, evidence_fingerprint, report,
          stable_observations, investigations, first_observed_at, last_checked_at, last_changed_at)
        VALUES ('default', 'run-1', 'run-1.approval.1', 'crosschain-universal', '8453', '60', 'CONFLICTING_TRANSACTION_IDENTIFIED', repeat('a', 64), '{}', 0, 1, now(), now(), now())`);
      // The purge function's own mechanism (0016): an audit row and a transaction-scoped permit, then the protected delete.
      await t.db.transaction(async tx => {
        await tx.query(`INSERT INTO execution_purge_audit (tenant_id, run_id, owner_account, namespace, log_name, log_sha256, log_version, segment_count, journal_count)
          VALUES ('default', 'run-1', '0x${'1'.repeat(40)}', 'crosschain-universal', 'run-1.jsonl', $1, 1, 0, 0)`, [sha('{}\n')]);
        await tx.query(`INSERT INTO execution_purge_permits VALUES ('default', 'run-1', 'crosschain-universal', 'run-1.jsonl', txid_current())`);
        await tx.query(`DELETE FROM execution_runs WHERE run_id = 'run-1'`);
      });
      expect((await t.db.query(`SELECT count(*)::int AS n FROM execution_nonce_conflicts`)).rows).toEqual([{ n: 0 }]);
      // Cross-tenant references are impossible: a diagnostic needs a run of its own tenant.
      await expect(t.db.query(`INSERT INTO execution_nonce_conflicts (tenant_id, run_id, attempt_id, flow, chain_id, nonce, classification, evidence_fingerprint, report,
          stable_observations, investigations, first_observed_at, last_checked_at, last_changed_at)
        VALUES ('default', 'missing', 'x', 'crosschain-universal', '8453', '1', 'CONFLICTING_TRANSACTION_IDENTIFIED', repeat('a', 64), '{}', 0, 1, now(), now(), now())`))
        .rejects.toThrow(/foreign key/);
    } finally { await t.drop(); }
  });

  it('a lock it cannot get within 5 s fails and rolls back completely while v26 keeps serving; a later run applies it', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const all = await loadMigrations();
      await migrate(t.db, all.slice(0, 26));
      const blocker = t.open(1);
      try {
        // A long writer transaction holding an exclusive lock on execution_runs (the new foreign key needs a SHARE ROW EXCLUSIVE lock).
        await blocker.transaction(async tx => {
          await tx.query('LOCK TABLE execution_runs IN ACCESS EXCLUSIVE MODE');
          await expect(migrate(t.db, all.slice(0, 27))).rejects.toThrow();
        });
      } finally { await blocker.close(); }
      expect((await t.db.query('SELECT max(version)::int AS version FROM schema_migrations')).rows).toEqual([{ version: 26 }]);
      expect((await t.db.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])`, [NEW_TABLES])).rows).toEqual([{ n: 0 }]);
      expect(await assertSchemaCurrent(t.db, SHIPPED_MIGRATIONS.slice(0, 26))).toBe(26);
      expect(await migrate(t.db, all.slice(0, 27))).toEqual([27]);
    } finally { await t.drop(); }
  }, 30_000);
});
