// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: schema 21 → 22 against real disposable PostgreSQL. 0022 only widens the two requester-kind
 * CHECK constraints (approval handoffs and workflow runs) for EDITOR_SESSION: every earlier row survives byte for byte, no column changes, the
 * new kind is storable with the 0006 identity rule unchanged, and any other kind is still refused.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertSchemaCurrent, loadMigrations, migrate, SHIPPED_MIGRATIONS, type Database } from '../src/index.js';
import { createTestDatabase } from './pg-harness';

const HASH = '0x' + '1'.repeat(64), OWNER = '0x' + 'ab'.repeat(20), ACCOUNT = 'acct_' + 'c'.repeat(32);
const KINDS = "'MCP_ACCOUNT'::text, 'DEVELOPER_PROJECT'::text, 'CHANNEL_CONVERSATION'::text, 'AUTOMATION_RULE'::text";
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex').slice(0, 26).replace(/[0189]/g, 'a')}`;
const ok = (work: Promise<unknown>) => work.then(() => true, () => false);
/** A PENDING SEQUENTIAL handoff of `kind` (a non-MCP requester: requester_id set, no MCP account or grant unless `account` is given). */
const handoff = (db: Database, kind: string, ref: string | null, account: string | null = null) => {
  const handoffId = id('apr');
  return db.query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind, requester_id, account_id, client_id, client_name, secret_digest, strategy,
      workflow_hash, engine_version, network_environment, funds_class, plan, status, expires_at)
    VALUES ('default', $1, $2, $3, $4, 'flofi-editor', 'FloFi Editor', $5, '{}', $6, 'flofi-engine-2', 'MAINNET', 'REAL_FUNDS', '{"kind":"SEQUENTIAL"}', 'PENDING',
      now() + interval '1 hour')`, [handoffId, kind, ref, account, randomBytes(32), HASH]).then(() => handoffId);
};
const run = (db: Database, handoffId: string, kind: string, ref: string) => db.query(`INSERT INTO workflow_runs (tenant_id, run_id, handoff_id, requester_kind,
    requester_ref, owner_namespace, owner_account, wallets, strategy, workflow_hash, engine_version, step_count, state, expires_at)
  VALUES ('default', $1, $2, $3, $4, 'eip155', $5, '{}', '{}', $6, 'flofi-engine-2', 2, 'PENDING', now() + interval '1 day')`, [id('wfr'), handoffId, kind, ref, OWNER, HASH]);
const definition = async (db: Database, name: string) =>
  (await db.query<{ def: string }>('SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1', [name])).rows.map(row => row.def);
const columns = async (db: Database) => (await db.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
  WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`)).rows;
const snapshot = async (db: Database) => ({ handoffs: (await db.query('SELECT * FROM mcp_handoffs ORDER BY handoff_id')).rows,
  runs: (await db.query('SELECT * FROM workflow_runs ORDER BY run_id')).rows });

describe('Editor requester additive migration (0022)', () => {
  it('widens exactly the two requester-kind checks, keeps every earlier row and column, and stores EDITOR_SESSION handoffs and runs', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      // Pinned to schema 22 so later migrations do not change this test.
      const all = (await loadMigrations()).slice(0, 22), base = all.slice(0, 21);
      expect(all[21]).toMatchObject({ version: 22, name: 'editor_requester', sha256: SHIPPED_MIGRATIONS[21]!.sha256 });
      await migrate(t.db, base);
      // Before 0022 the kind is refused by both tables, exactly as any unknown kind.
      await expect(handoff(t.db, 'EDITOR_SESSION', ACCOUNT)).rejects.toThrow();
      expect(await definition(t.db, 'mcp_handoffs_requester_kind_check')).toEqual([`CHECK ((requester_kind = ANY (ARRAY[${KINDS}])))`]);
      expect(await definition(t.db, 'workflow_runs_requester_kind_check')).toEqual([`CHECK ((requester_kind = ANY (ARRAY[${KINDS}])))`]);
      // Rows of every earlier requester shape, as earlier builds write them.
      const channel = await handoff(t.db, 'CHANNEL_CONVERSATION', 'cnv_editormigrationtest');
      await run(t.db, channel, 'CHANNEL_CONVERSATION', 'cnv_editormigrationtest');
      await handoff(t.db, 'AUTOMATION_RULE', 'aut_' + 'a'.repeat(26));
      const shape = await columns(t.db), rows = await snapshot(t.db);
      expect(await migrate(t.db, all)).toEqual([22]);
      expect(await columns(t.db)).toEqual(shape);
      expect(await snapshot(t.db)).toEqual(rows);
      expect(await assertSchemaCurrent(t.db, SHIPPED_MIGRATIONS.slice(0, 22))).toBe(22);
      expect(await migrate(t.db, all)).toEqual([]);
      const widened = `CHECK ((requester_kind = ANY (ARRAY[${KINDS}, 'EDITOR_SESSION'::text])))`;
      expect(await definition(t.db, 'mcp_handoffs_requester_kind_check')).toEqual([widened]);
      expect(await definition(t.db, 'workflow_runs_requester_kind_check')).toEqual([widened]);
      // The new kind: a handoff and its run. Its requester is the account (requester_id), never an MCP account or grant (0006, unchanged).
      const editor = await handoff(t.db, 'EDITOR_SESSION', ACCOUNT);
      await run(t.db, editor, 'EDITOR_SESSION', ACCOUNT);
      expect((await t.db.query('SELECT requester_kind, requester_ref, account_id, grant_id FROM mcp_handoffs WHERE handoff_id = $1', [editor])).rows)
        .toEqual([{ requester_kind: 'EDITOR_SESSION', requester_ref: ACCOUNT, account_id: null, grant_id: null }]);
      expect(await ok(handoff(t.db, 'EDITOR_SESSION', null))).toBe(false);
      expect(await ok(handoff(t.db, 'EDITOR_SESSION', ACCOUNT, ACCOUNT))).toBe(false);
      expect(await ok(handoff(t.db, 'EDITOR_SESSION', 'Not A Ref'))).toBe(false);
      // Any other kind is still refused by both tables.
      expect(await ok(handoff(t.db, 'EDITOR', ACCOUNT))).toBe(false);
      expect(await ok(run(t.db, editor, 'EDITOR', ACCOUNT))).toBe(false);
      // A run's requester stays immutable (0015's trigger, unchanged).
      expect(await ok(t.db.query(`UPDATE workflow_runs SET requester_kind = 'CHANNEL_CONVERSATION', version = version + 1 WHERE handoff_id = $1`, [editor]))).toBe(false);
    } finally { await t.drop(); }
  });

  it('rolls failed DDL back together with its ledger entry', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const all = await loadMigrations(), next = all[21]!;
      await migrate(t.db, all.slice(0, 21));
      const sql = next.sql + '\nSELECT missing_editor_migration_test_function();\n';
      await expect(migrate(t.db, [...all.slice(0, 21), { ...next, sql, sha256: createHash('sha256').update(sql).digest('hex') }])).rejects.toThrow();
      expect((await t.db.query('SELECT max(version)::int AS version FROM schema_migrations')).rows).toEqual([{ version: 21 }]);
      expect(await definition(t.db, 'mcp_handoffs_requester_kind_check')).toEqual([`CHECK ((requester_kind = ANY (ARRAY[${KINDS}])))`]);
      expect(await definition(t.db, 'workflow_runs_requester_kind_check')).toEqual([`CHECK ((requester_kind = ANY (ARRAY[${KINDS}])))`]);
    } finally { await t.drop(); }
  });
});
