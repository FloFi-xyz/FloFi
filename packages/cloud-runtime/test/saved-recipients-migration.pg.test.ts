// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001 Release B: schema 27 → 28 against real disposable PostgreSQL. 0028 adds one table, `flofi_account_recipients`
 * (an account's saved names for public addresses), with the indexes of its own keys and a foreign key to `flofi_accounts ON DELETE CASCADE`.
 * Nothing pre-existing changes: every earlier row survives, a v27 build serves schema 28 only through its certificate, account deletion cascades,
 * a lock 0028 cannot get fails and rolls back completely, a runner applies it exactly once, and the controlled Neon procedure documented in
 * RELEASE-SAVED-RECIPIENTS-0028.md (read from the document itself) produces exactly the catalog `migrate` produces and refuses a second run.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, CERTIFIED_FORWARD_MIGRATIONS, loadMigrations, migrate, SHIPPED_MIGRATIONS } from '../src/index.js';
import { createTestDatabase } from './pg-harness';

const NEW_TABLE = 'flofi_account_recipients';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const ACCOUNT = 'acct_' + 'a'.repeat(32), OTHER = 'acct_' + 'b'.repeat(32);
const EVM = '0x52908400098527886e0f7030069857d2e4169ee7', SOL = 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq';

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
const ofNew = (item: string) => item.startsWith(NEW_TABLE + '.') || item.startsWith(NEW_TABLE + ':');
/** The controlled Neon procedure exactly as the release document gives it, with its `\i` line replaced by the shipped file. */
async function documentedProcedure(): Promise<string> {
  const doc = await readFile(new URL('../../../docs/deploy/RELEASE-SAVED-RECIPIENTS-0028.md', import.meta.url), 'utf8');
  // The fenced SQL block holding the ledger guard. It sits inside a numbered list item, so each line is indented like its opening fence.
  const fenced = [...doc.matchAll(/^( *)```sql\n([\s\S]*?)\n\1```/gm)].find(match => match[2]!.includes("RAISE EXCEPTION 'LEDGER_NOT_EXACTLY_V27'"));
  const indent = fenced?.[1] ?? '';
  const block = fenced?.[2]!.split('\n').map(line => line.startsWith(indent) ? line.slice(indent.length) : line).join('\n');
  if (!block || !block.startsWith('BEGIN;') || !block.trimEnd().endsWith('COMMIT;')) throw new Error('documented procedure not found');
  const file = await readFile(new URL('../migrations/0028_saved_recipients.sql', import.meta.url), 'utf8');
  const include = /^\s*-- \\i packages\/cloud-runtime\/migrations\/0028_saved_recipients\.sql.*$/m;
  if (!include.test(block)) throw new Error('documented procedure has no include line');
  return block.replace(include, () => file);
}

describe('Saved recipients migration (0028)', () => {
  it('ships the exact certified bytes, kept as a fixture, and the v27 certificate names it', async () => {
    const identity = SHIPPED_MIGRATIONS[27]!;
    expect(identity).toEqual({ version: 28, name: 'saved_recipients', sha256: 'ee73e909b6747c47c0bca877c8621d55229348177f0e7c6d68e47000a8fca64f' });
    expect(sha(await readFile(new URL('./fixtures/0028_saved_recipients.sql', import.meta.url), 'utf8'))).toBe(identity.sha256);
    expect(sha(await readFile(new URL('../migrations/0028_saved_recipients.sql', import.meta.url), 'utf8'))).toBe(identity.sha256);
    expect(CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 27)).toMatchObject({ base: SHIPPED_MIGRATIONS[26], migrations: [identity] });
  });

  it('is purely additive: every pre-existing object and row is unchanged; v27 serves it only by certificate; a runner applies it once', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const all = await loadMigrations();
      expect(all.at(-1)).toMatchObject({ version: 28, name: 'saved_recipients' });
      await migrate(t.db, all.slice(0, 27));
      // Rows a v27 build writes: accounts with a sign-in identity and a saved wallet.
      await t.db.query(`INSERT INTO tenants (tenant_id) VALUES ('default') ON CONFLICT DO NOTHING`);
      await t.db.query(`INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ('default', $1), ('default', $2)`, [ACCOUNT, OTHER]);
      await t.db.query(`INSERT INTO flofi_account_identities (tenant_id, kind, subject, account_id) VALUES ('default', 'EMAIL', 'ana@example.com', $1)`, [ACCOUNT]);
      const before = await catalog(t.db);
      const rows = async () => ({ accounts: (await t.db.query(`SELECT * FROM flofi_accounts ORDER BY account_id`)).rows,
        identities: (await t.db.query(`SELECT * FROM flofi_account_identities ORDER BY subject`)).rows });
      const data = await rows();

      expect(await migrate(t.db, all)).toEqual([28]);
      expect(await migrate(t.db, all)).toEqual([]);
      const after = await catalog(t.db);
      for (const key of Object.keys(before) as (keyof typeof before)[]) {
        expect(after[key].filter(item => before[key].includes(item))).toEqual(before[key]);   // nothing removed or redefined
        expect(after[key].filter(item => !before[key].includes(item)).filter(item => !ofNew(item))).toEqual([]); // additions only on the new table
      }
      expect(await rows()).toEqual(data);
      // The v27 build serves schema 28 through its certificate only; the strict check refuses it.
      expect(await assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS.slice(0, 27))).toMatchObject({ version: 28, application: 27 });
      await expect(assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS.slice(0, 27), [])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
      await expect(assertSchemaCurrent(t.db, SHIPPED_MIGRATIONS.slice(0, 27))).rejects.toThrow();
      expect(await assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS)).toMatchObject({ version: 28, application: 28, forward: [] });
      expect(await assertSchemaCurrent(t.db, SHIPPED_MIGRATIONS)).toBe(28);
      // Its own rules: one record per address and per name in an account; another account may save the same address; deletion cascades.
      const insert = (id: string, account: string, ecosystem: string, address: string, label: string) => t.db.query(`INSERT INTO ${NEW_TABLE}
        (tenant_id, account_id, recipient_id, ecosystem, address, label, label_key) VALUES ('default', $1, $2, $3, $4, $5, lower($5))`, [account, id, ecosystem, address, label]);
      await insert('rcp_' + 'a'.repeat(26), ACCOUNT, 'EVM', EVM, 'Ana');
      await insert('rcp_' + 'b'.repeat(26), ACCOUNT, 'SOLANA', SOL, 'Mae');
      await insert('rcp_' + 'c'.repeat(26), OTHER, 'EVM', EVM, 'Ana');
      await expect(insert('rcp_' + 'd'.repeat(26), ACCOUNT, 'EVM', EVM, 'Outra')).rejects.toThrow(/flofi_account_recipients_address/);
      await expect(insert('rcp_' + 'e'.repeat(26), ACCOUNT, 'EVM', '0x' + '1'.repeat(40), 'ana')).rejects.toThrow(/flofi_account_recipients_label/);
      await expect(insert('rcp_' + 'f'.repeat(26), ACCOUNT, 'EVM', '0x' + '0'.repeat(40), 'Zero')).rejects.toThrow(/check/i);
      await t.db.query(`DELETE FROM flofi_accounts WHERE account_id = $1`, [ACCOUNT]);
      expect((await t.db.query(`SELECT account_id, count(*)::int AS n FROM ${NEW_TABLE} GROUP BY account_id`)).rows).toEqual([{ account_id: OTHER, n: 1 }]);
    } finally { await t.drop(); }
  });

  it('a lock it cannot get within 5 s fails and rolls back completely while v27 keeps serving; a later run applies it', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const all = await loadMigrations();
      await migrate(t.db, all.slice(0, 27));
      const blocker = t.open(1);
      try {
        // A writer holding an exclusive lock on flofi_accounts (the new foreign key needs SHARE ROW EXCLUSIVE on it).
        await blocker.transaction(async tx => {
          await tx.query('LOCK TABLE flofi_accounts IN ACCESS EXCLUSIVE MODE');
          await expect(migrate(t.db, all)).rejects.toThrow();
        });
      } finally { await blocker.close(); }
      expect((await t.db.query('SELECT max(version)::int AS version FROM schema_migrations')).rows).toEqual([{ version: 27 }]);
      expect((await t.db.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`, [NEW_TABLE])).rows).toEqual([{ n: 0 }]);
      expect(await assertSchemaCurrent(t.db, SHIPPED_MIGRATIONS.slice(0, 27))).toBe(27);
      expect(await migrate(t.db, all)).toEqual([28]);
    } finally { await t.drop(); }
  }, 30_000);

  it('rehearsal: the documented controlled Neon procedure equals `migrate` exactly, and a second run stops at its guard', async () => {
    const procedure = await documentedProcedure();
    const byRunner = await createTestDatabase({ migrated: false }), byProcedure = await createTestDatabase({ migrated: false });
    try {
      const all = await loadMigrations();
      await migrate(byRunner.db, all.slice(0, 27));
      await migrate(byProcedure.db, all.slice(0, 27));
      expect(await migrate(byRunner.db, all)).toEqual([28]);
      await byProcedure.db.query(procedure);
      expect(await catalog(byProcedure.db)).toEqual(await catalog(byRunner.db));
      const ledger = async (db: typeof byRunner.db) => (await db.query(`SELECT version, name, sha256 FROM schema_migrations ORDER BY version`)).rows;
      expect(await ledger(byProcedure.db)).toEqual(await ledger(byRunner.db));
      expect(await assertSchemaCurrent(byProcedure.db, SHIPPED_MIGRATIONS)).toBe(28);
      // A second run refuses at the ledger guard and changes nothing; the runner has nothing left to apply. (On its own connection: a refused
      // multi-statement transaction leaves that connection aborted until it rolls back.)
      const second = byProcedure.open(1);
      try {
        await expect(second.query(procedure)).rejects.toThrow(/LEDGER_NOT_EXACTLY_V27/);
        await second.query('ROLLBACK');
      } finally { await second.close(); }
      expect(await ledger(byProcedure.db)).toEqual(await ledger(byRunner.db));
      expect(await migrate(byProcedure.db, all)).toEqual([]);
    } finally { await byRunner.drop(); await byProcedure.drop(); }
  }, 60_000);
});
