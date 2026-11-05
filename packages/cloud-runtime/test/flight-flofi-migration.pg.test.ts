// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: schema 19 → 20 against real disposable PostgreSQL. 0020 adds eight flight_* tables and changes nothing that
 * exists: every pre-existing column and row survives, a version-19 build accepts schema 20 only through its certificate, and a failure
 * rolls the whole migration back with its ledger entry.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, CERTIFIED_FORWARD_MIGRATIONS, loadMigrations, migrate, SHIPPED_MIGRATIONS } from '../src/index.js';
import { createTestDatabase } from './pg-harness';

const NEW_TABLES = ['flight_batches', 'flight_daily_events', 'flight_invites', 'flight_issuance', 'flight_join_attempts', 'flight_list_entries', 'flight_passes',
  'flight_simulations'];

describe('Flight FloFi additive migration (0020)', () => {
  it('cold starts under the exact v19 certificate and keeps every pre-existing column and account row', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      // Pinned to schema 20 so later migrations do not change this test.
      const all = (await loadMigrations()).slice(0, 20), base = all.slice(0, 19);
      expect(all[19]).toMatchObject({ version: 20, name: 'flight_flofi', sha256: SHIPPED_MIGRATIONS[19]!.sha256 });
      await migrate(t.db, base);
      await t.db.query(`INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ('default', 'acct_' || repeat('b', 32))`);
      await t.db.query(`INSERT INTO flofi_account_identities (tenant_id, kind, subject, account_id, label)
        VALUES ('default', 'EMAIL', 'ana@example.com', 'acct_' || repeat('b', 32), 'ana@example.com')`);
      const columns = async () => (await t.db.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name NOT LIKE 'flight\\_%' ORDER BY table_name, ordinal_position`)).rows;
      const accounts = async () => (await t.db.query('SELECT * FROM flofi_accounts ORDER BY account_id')).rows;
      // Every pre-existing relation, index, user trigger and rule, by name: 0020 adds none of them and changes none.
      const catalogue = async () => (await t.db.query(`SELECT c.relkind::text AS kind, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname NOT LIKE 'flight\\_%' UNION ALL SELECT 'trigger', tgname FROM pg_trigger WHERE NOT tgisinternal
        UNION ALL SELECT 'rule', rulename FROM pg_rules WHERE schemaname = 'public' ORDER BY 1, 2`)).rows;
      const shape = await columns(), rows = await accounts(), objects = await catalogue();
      expect(await migrate(t.db, all)).toEqual([20]);
      expect(await columns()).toEqual(shape);
      expect(await accounts()).toEqual(rows);
      expect(await catalogue()).toEqual(objects);
      expect((await t.db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'flight\\_%' ORDER BY table_name`))
        .rows.map(row => (row as { table_name: string }).table_name)).toEqual(NEW_TABLES);
      expect(await assertSchemaCurrent(t.db, SHIPPED_MIGRATIONS.slice(0, 20))).toBe(20);
      expect(await migrate(t.db, all)).toEqual([]);
      // A v19 build (Release A) accepts schema 20 only through its certificate.
      expect(await assertSchemaCompatible(t.open(1), SHIPPED_MIGRATIONS.slice(0, 19))).toMatchObject({ version: 20, application: 19, forward: [SHIPPED_MIGRATIONS[19]] });
      await expect(assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS.slice(0, 19), CERTIFIED_FORWARD_MIGRATIONS.filter(c => c.base.version !== 19)))
        .rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
      // A version-19 build that deletes an account (account deletion, a plain DELETE) still succeeds, and the new tables follow it: the
      // pass and the simulation evidence go, the invites the pass gave out stay usable and unlinked, the invite it used stays used.
      const account = 'acct_' + 'b'.repeat(32), pass = 'flp_' + 'c'.repeat(32);
      await t.db.query(`INSERT INTO flight_passes (tenant_id, pass_id, account_id, origin, boarding_no, founding_seat, route, run_id)
        VALUES ('default', $1, $2, 'INVITE', 1, 1, '{}', 'run-1')`, [pass, account]);
      await t.db.query(`INSERT INTO flight_simulations (tenant_id, account_id, run_id, flow, workflow_id, revision, route) VALUES ('default', $1, 'run-1', 'jupiter-swap', 'wf', 1, '{}')`,
        [account]);
      await t.db.query(`INSERT INTO flight_invites (tenant_id, code, issuer, issuer_pass_id) VALUES ('default', 'FLF-AAAA-AAAA', 'FOUNDING', $1)`, [pass]);
      await t.db.query(`INSERT INTO flight_invites (tenant_id, code, issuer, redeemed_by, redeemed_at) VALUES ('default', 'FLF-BBBB-BBBB', 'CREATOR', $1, now())`, [account]);
      await t.db.query(`DELETE FROM flofi_accounts WHERE account_id = $1`, [account]);
      expect((await t.db.query(`SELECT (SELECT count(*) FROM flight_passes)::int AS passes, (SELECT count(*) FROM flight_simulations)::int AS simulations`)).rows)
        .toEqual([{ passes: 0, simulations: 0 }]);
      expect((await t.db.query(`SELECT code, issuer_pass_id, redeemed_by, redeemed_at IS NOT NULL AS used FROM flight_invites ORDER BY code`)).rows).toEqual([
        { code: 'FLF-AAAA-AAAA', issuer_pass_id: null, redeemed_by: null, used: false }, { code: 'FLF-BBBB-BBBB', issuer_pass_id: null, redeemed_by: null, used: true }]);
    } finally { await t.drop(); }
  });

  it('rolls failed DDL back together with its ledger entry', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const all = await loadMigrations(), next = all[19]!;
      await migrate(t.db, all.slice(0, 19));
      const sql = next.sql + '\nSELECT missing_flight_migration_test_function();\n';
      await expect(migrate(t.db, [...all.slice(0, 19), { ...next, sql, sha256: createHash('sha256').update(sql).digest('hex') }])).rejects.toThrow();
      expect((await t.db.query('SELECT max(version)::int AS version FROM schema_migrations')).rows).toEqual([{ version: 19 }]);
      expect((await t.db.query("SELECT to_regclass('public.flight_passes') AS relation")).rows).toEqual([{ relation: null }]);
    } finally { await t.drop(); }
  });
});
