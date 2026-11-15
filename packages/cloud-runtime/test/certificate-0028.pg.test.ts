// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001, Release A: the v27 build (this repository's shipped history ends at 0027) and the certified 0028
 * `saved_recipients`, from its SHA-256-pinned fixture, on disposable PostgreSQL. Release A ships only the certificate: it must serve schema 27
 * exactly as before and, after 0028 is applied by Release B, serve schema 28 unchanged — every pre-existing object and row unchanged, its own
 * account writes and account deletion (now cascading into saved recipients) still working, its runner never changing a database ahead of it,
 * a lock 0028 cannot get rolling back completely, and the documented emergency reversal restoring the exact v27 catalog. The API, worker,
 * cold starts and Vercel paths across the certificate are proven by `apps/reference-dapp/backend/schema-compatibility.pg.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, CERTIFIED_FORWARD_MIGRATIONS, loadMigrations, migrate, SHIPPED_MIGRATIONS, type Migration } from '../src/index.js';
import { createTestDatabase } from './pg-harness';

const NEW_TABLE = 'flofi_account_recipients';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const CERTIFICATE = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.migrations.some(m => m.name === 'saved_recipients'))!;
/** The v27 build's history (this test stays valid after Release B ships 0028 on top: it always runs the v27 build). */
const V27 = SHIPPED_MIGRATIONS.slice(0, 27);
const v27Files = async () => (await loadMigrations()).slice(0, 27);
const ACCOUNT = 'acct_' + 'a'.repeat(32), OTHER = 'acct_' + 'b'.repeat(32), RECIPIENT = 'rcp_' + 'a'.repeat(26);
const EVM = '0x52908400098527886e0f7030069857d2e4169ee7';
/** The emergency reversal exactly as RELEASE-SAVED-RECIPIENTS-0028.md documents it (one transaction). */
const REVERSAL = `SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF (SELECT max(version) FROM schema_migrations) <> 28 OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 28 AND name = 'saved_recipients'
    AND sha256 = 'ee73e909b6747c47c0bca877c8621d55229348177f0e7c6d68e47000a8fca64f') THEN RAISE EXCEPTION 'NOT_CERTIFIED_0028_HEAD'; END IF;
END $$;
DROP TABLE flofi_account_recipients;
DELETE FROM schema_migrations WHERE version = 28 AND name = 'saved_recipients' AND sha256 = 'ee73e909b6747c47c0bca877c8621d55229348177f0e7c6d68e47000a8fca64f';`;

/** 0028 exactly as Release B will ship it: the fixture's bytes under the certified identity. */
async function certified0028(): Promise<Migration> {
  const sql = await readFile(new URL('./fixtures/0028_saved_recipients.sql', import.meta.url), 'utf8');
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
const ofNew = (item: string) => item.startsWith(NEW_TABLE + '.') || item.startsWith(NEW_TABLE + ':');

describe('Release A: certificate for 0028 saved_recipients (v27 build, PostgreSQL)', () => {
  it('certifies the exact fixture bytes for the v27 build; a build that ships 0028 ships exactly those bytes', async () => {
    expect(V27.at(-1)).toMatchObject({ version: 27, name: 'reconciliation_privacy' });
    expect(CERTIFICATE.base).toEqual(V27[26]);
    expect((await certified0028()).sha256).toBe(CERTIFICATE.migrations[0]!.sha256);
    // Release A ships only through 0027; Release B ships 0028 and it must be the certified identity, byte for byte.
    if (SHIPPED_MIGRATIONS.length === 27) expect((await loadMigrations()).at(-1)).toMatchObject({ version: 27 });
    else expect(SHIPPED_MIGRATIONS[27]).toEqual(CERTIFICATE.migrations[0]);
  });

  it('serves schema 27 unchanged, and schema 28 only through the certificate; 0028 is purely additive; v27 account writes and deletion keep working', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const v27 = await v27Files(), m28 = await certified0028();
      expect(await migrate(t.db, v27)).toHaveLength(27);
      expect(await assertSchemaCompatible(t.db, V27)).toEqual({ version: 27, application: 27, forward: [] });
      await t.db.query(`INSERT INTO tenants (tenant_id) VALUES ('default') ON CONFLICT DO NOTHING`);
      await t.db.query(`INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ('default', $1), ('default', $2)`, [ACCOUNT, OTHER]);
      await t.db.query(`INSERT INTO flofi_account_identities (tenant_id, kind, subject, account_id) VALUES ('default', 'EMAIL', 'ana@example.com', $1)`, [ACCOUNT]);
      await t.db.query(`INSERT INTO flofi_account_wallets (tenant_id, ecosystem, address, account_id, origin, provider, provider_name, export, label)
        VALUES ('default', 'EVM', $1, $2, 'EXTERNAL', 'io.metamask', 'MetaMask', 'NONE', 'MetaMask')`, ['0x' + 'c'.repeat(40), ACCOUNT]);
      const before = await catalog(t.db);
      const rows = async () => ({ accounts: (await t.db.query(`SELECT * FROM flofi_accounts ORDER BY account_id`)).rows,
        identities: (await t.db.query(`SELECT * FROM flofi_account_identities ORDER BY subject`)).rows,
        wallets: (await t.db.query(`SELECT * FROM flofi_account_wallets ORDER BY address`)).rows });
      const data = await rows();

      // Release B applies 0028 (here: the certified bytes, with the same runner).
      expect(await migrate(t.db, [...v27, m28])).toEqual([28]);
      const after = await catalog(t.db);
      for (const key of Object.keys(before) as (keyof typeof before)[]) {
        expect(after[key].filter(item => before[key].includes(item))).toEqual(before[key]);           // nothing removed or redefined
        expect(after[key].filter(item => !before[key].includes(item) && !ofNew(item))).toEqual([]);   // additions only on the new table
      }
      expect(after.functions).toEqual(before.functions);
      expect(after.triggers).toEqual(before.triggers);
      expect(await rows()).toEqual(data);

      // This (v27) build: compatible by certificate only; its runner never changes a database ahead of it.
      expect(await assertSchemaCompatible(t.db, V27)).toEqual({ version: 28, application: 27, forward: CERTIFICATE.migrations });
      await expect(assertSchemaCompatible(t.db, V27, [])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
      await expect(assertSchemaCurrent(t.db, V27)).rejects.toThrow();
      expect(await migrate(t.db, v27)).toEqual([]);
      expect((await t.db.query('SELECT max(version)::int AS v FROM schema_migrations')).rows).toEqual([{ v: 28 }]);

      // v27 account writes keep working on schema 28, and account deletion (the v27 store's DELETE) cascades into saved recipients.
      await t.db.query(`UPDATE flofi_accounts SET onboarding = 'COMPLETED', updated_at = now() WHERE tenant_id = 'default' AND account_id = $1`, [ACCOUNT]);
      await t.db.query(`INSERT INTO flofi_account_recipients (tenant_id, account_id, recipient_id, ecosystem, address, label, label_key)
        VALUES ('default', $1, $2, 'EVM', $3, 'Maria', 'maria'), ('default', $4, $2, 'EVM', $3, 'Maria', 'maria')`, [ACCOUNT, RECIPIENT, EVM, OTHER]);
      const deleted = await t.db.query(`DELETE FROM flofi_accounts WHERE tenant_id = 'default' AND account_id = $1`, [ACCOUNT]);
      expect(deleted.rowCount).toBe(1);
      expect((await t.db.query(`SELECT account_id FROM flofi_account_recipients`)).rows).toEqual([{ account_id: OTHER }]);
      expect((await t.db.query(`SELECT count(*)::int AS n FROM flofi_account_wallets`)).rows).toEqual([{ n: 0 }]);
    } finally { await t.drop(); }
  });

  it('enforces its shape in the database: per-account uniqueness of address and name key, address and label checks, account reference', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      await migrate(t.db, [...await v27Files(), await certified0028()]);
      await t.db.query(`INSERT INTO tenants (tenant_id) VALUES ('default') ON CONFLICT DO NOTHING`);
      await t.db.query(`INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ('default', $1)`, [ACCOUNT]);
      const insert = (id: string, ecosystem: string, address: string, label: string, key: string, account = ACCOUNT) => t.db.query(`INSERT INTO
        flofi_account_recipients (tenant_id, account_id, recipient_id, ecosystem, address, label, label_key) VALUES ('default', $1, $2, $3, $4, $5, $6)`,
      [account, id, ecosystem, address, label, key]);
      const rcp = (c: string) => 'rcp_' + c.repeat(26);
      await insert(rcp('a'), 'EVM', EVM, 'Maria', 'maria');
      await expect(insert(rcp('b'), 'EVM', EVM, 'Other', 'other')).rejects.toMatchObject({ code: '23505', constraint: 'flofi_account_recipients_address' });
      await expect(insert(rcp('b'), 'EVM', '0x' + 'd'.repeat(40), 'María', 'maria')).rejects.toMatchObject({ code: '23505', constraint: 'flofi_account_recipients_label' });
      for (const [ecosystem, address] of [['EVM', EVM.toUpperCase().replace('0X', '0x')], ['EVM', '0x' + '0'.repeat(40)], ['SOLANA', EVM], ['EVM', 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq'],
        ['SOLANA', '1'.repeat(32)], ['BITCOIN', EVM]] as const)
        await expect(insert(rcp('c'), ecosystem, address, 'Bad', 'bad')).rejects.toMatchObject({ code: '23514' });
      for (const [label, key] of [['', 'x'], ['x'.repeat(41), 'x'], ['Line\nbreak', 'line break'], ['Ok', ''], ['Ok', 'k'.repeat(161)]] as const)
        await expect(insert(rcp('d'), 'EVM', '0x' + 'e'.repeat(40), label, key)).rejects.toMatchObject({ code: '23514' });
      await expect(insert('rcp_BAD', 'EVM', '0x' + 'e'.repeat(40), 'Ok', 'ok')).rejects.toMatchObject({ code: '23514' });
      await expect(insert(rcp('e'), 'EVM', '0x' + 'e'.repeat(40), 'Ok', 'ok', OTHER)).rejects.toMatchObject({ code: '23503' });
      await insert(rcp('f'), 'SOLANA', 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq', 'Família Silva', 'familia silva');
      expect((await t.db.query(`SELECT count(*)::int AS n FROM flofi_account_recipients`)).rows).toEqual([{ n: 2 }]);
    } finally { await t.drop(); }
  });

  it('a lock 0028 cannot get within 5 s (an open account write) fails and rolls back completely while schema 27 keeps serving; a later run applies it once', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const v27 = await v27Files(), m28 = await certified0028();
      await migrate(t.db, v27);
      await t.db.query(`INSERT INTO tenants (tenant_id) VALUES ('default') ON CONFLICT DO NOTHING`);
      await t.db.query(`INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ('default', $1)`, [ACCOUNT]);
      const blocker = t.open(1);
      try {
        await blocker.transaction(async tx => {
          // A v27 write transaction still open on flofi_accounts (ROW EXCLUSIVE) conflicts with the foreign key's SHARE ROW EXCLUSIVE.
          await tx.query(`UPDATE flofi_accounts SET updated_at = now() WHERE account_id = $1`, [ACCOUNT]);
          await expect(migrate(t.db, [...v27, m28])).rejects.toThrow();
        });
      } finally { await blocker.close(); }
      expect(await assertSchemaCurrent(t.db, V27)).toBe(27);
      expect((await t.db.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`, [NEW_TABLE])).rows).toEqual([{ n: 0 }]);
      expect(await migrate(t.db, [...v27, m28])).toEqual([28]);
      expect(await migrate(t.db, [...v27, m28])).toEqual([]);
    } finally { await t.drop(); }
  }, 30_000);

  it('the documented emergency reversal restores the exact v27 catalog and ledger, and refuses, unchanged, anything but the certified 0028 as newest', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const v27 = await v27Files(), m28 = await certified0028();
      await migrate(t.db, v27);
      const before = await catalog(t.db);
      await migrate(t.db, [...v27, m28]);
      // A later migration on top: the reversal refuses and changes nothing.
      await t.db.query(`INSERT INTO schema_migrations (version, name, sha256) VALUES (29, 'later', $1)`, ['e'.repeat(64)]);
      await expect(t.db.transaction(tx => tx.query(REVERSAL))).rejects.toThrow('NOT_CERTIFIED_0028_HEAD');
      expect((await t.db.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`, [NEW_TABLE])).rows).toEqual([{ n: 1 }]);
      await t.db.query(`DELETE FROM schema_migrations WHERE version = 29`);
      await t.db.transaction(tx => tx.query(REVERSAL));
      expect(await catalog(t.db)).toEqual(before);
      expect(await assertSchemaCurrent(t.db, V27)).toBe(27);
      // Applying the certified bytes again afterwards works (the reversal leaves no trace behind).
      expect(await migrate(t.db, [...v27, m28])).toEqual([28]);
    } finally { await t.drop(); }
  });
});
