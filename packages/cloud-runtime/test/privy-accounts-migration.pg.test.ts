// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: schema 18 → 19 against real disposable PostgreSQL. 0019 only widens four CHECK constraints: every 0018 row
 * (Turnkey wallets and organizations included) survives byte for byte, Privy identities and Privy-managed wallets become storable, and
 * the safety rules of 0018 still hold.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, CERTIFIED_FORWARD_MIGRATIONS, loadMigrations, migrate, SHIPPED_MIGRATIONS } from '../src/index.js';
import { createTestDatabase } from './pg-harness';

const ACCOUNT = "'acct_' || repeat('a', 32)";
const snapshot = async (db: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => ({
  accounts: (await db.query('SELECT * FROM flofi_accounts ORDER BY account_id')).rows,
  identities: (await db.query('SELECT * FROM flofi_account_identities ORDER BY kind, subject')).rows,
  wallets: (await db.query('SELECT * FROM flofi_account_wallets ORDER BY ecosystem, address')).rows,
});

describe('Privy accounts additive migration (0019)', () => {
  it('cold starts under the exact v18 certificate, keeps every 0018 row and changes no column', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      // Pinned to schema 19 so later migrations do not change this test.
      const all = (await loadMigrations()).slice(0, 19), base = all.slice(0, 18);
      expect(all[18]).toMatchObject({ version: 19, name: 'privy_accounts', sha256: SHIPPED_MIGRATIONS[18]!.sha256 });
      await migrate(t.db, base);
      // A Turnkey-era account exactly as 0018 stores it: organization, identities, a generated and an imported managed wallet, an external one.
      await t.db.query(`INSERT INTO flofi_accounts (tenant_id, account_id, wallet_provider, wallet_organization, wallet_user, wallet_login)
        VALUES ('default', ${ACCOUNT}, 'turnkey', 'org-12345678', 'user-12345678', 'EMAIL')`);
      await t.db.query(`INSERT INTO flofi_account_identities (tenant_id, kind, subject, account_id, label) VALUES
        ('default', 'EMAIL', 'ana@example.com', ${ACCOUNT}, 'ana@example.com'), ('default', 'GOOGLE', '1234567890', ${ACCOUNT}, NULL)`);
      await t.db.query(`INSERT INTO flofi_account_wallets (tenant_id, account_id, ecosystem, address, origin, provider, provider_name, provider_resource, export, label) VALUES
        ('default', ${ACCOUNT}, 'EVM', '0x' || repeat('3', 40), 'GENERATED', 'turnkey', 'FloFi wallet', 'wallet-12345678', 'RECOVERY_PHRASE', 'EVM wallet'),
        ('default', ${ACCOUNT}, 'SOLANA', '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', 'IMPORTED', 'turnkey', 'FloFi wallet', 'key-12345678', 'PRIVATE_KEY', 'Imported'),
        ('default', ${ACCOUNT}, 'EVM', '0x' || repeat('4', 40), 'EXTERNAL', 'io.metamask', 'MetaMask', NULL, 'NONE', 'MetaMask')`);
      const columns = async () => (await t.db.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema='public' ORDER BY table_name, ordinal_position`)).rows;
      const shape = await columns(), rows = await snapshot(t.db);
      expect(await migrate(t.db, all)).toEqual([19]);
      expect(await columns()).toEqual(shape);
      expect(await snapshot(t.db)).toEqual(rows);
      expect(await assertSchemaCurrent(t.db, SHIPPED_MIGRATIONS.slice(0, 19))).toBe(19);
      expect(await migrate(t.db, all)).toEqual([]);
      // A v18 build (Release A) accepts schema 19 only through its certificate.
      expect(await assertSchemaCompatible(t.open(1), SHIPPED_MIGRATIONS.slice(0, 18))).toMatchObject({ version: 19, application: 18, forward: [SHIPPED_MIGRATIONS[18]] });
      await expect(assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS.slice(0, 18), CERTIFIED_FORWARD_MIGRATIONS.filter(c => c.base.version !== 18)))
        .rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    } finally { await t.drop(); }
  });

  it('stores Privy identities and Privy-managed wallets and still refuses unsafe rows', async () => {
    const t = await createTestDatabase();
    try {
      await t.db.query(`INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ('default', ${ACCOUNT})`);
      const identity = (kind: string, subject: string) => t.db.query(`INSERT INTO flofi_account_identities (tenant_id, kind, subject, account_id)
        VALUES ('default', '${kind}', '${subject}', ${ACCOUNT})`);
      await identity('PRIVY', 'did:privy:cm4ab12cd34ef56gh78ij90kl');
      for (const subject of ['did:privy:', 'did:privy:short', 'privy:cm4ab12cd34ef56gh78ij90kl', 'did:privy:cm4ab12cd34ef56gh78ij90kl;drop', 'DID:PRIVY:cm4ab12cd34ef56gh78ij90kl']) {
        await expect(identity('PRIVY', subject)).rejects.toThrow();
      }
      // The Privy DID shape is only accepted for kind PRIVY.
      await expect(identity('GOOGLE', 'did:privy:cm4ab12cd34ef56gh78ij90kz')).rejects.toThrow();
      const wallet = (values: string) => t.db.query(`INSERT INTO flofi_account_wallets (tenant_id, account_id, ecosystem, address, origin, provider, provider_name,
        provider_resource, export, label) VALUES ('default', ${ACCOUNT}, ${values})`);
      // Privy: a generated or imported wallet exports a private key; the Privy wallet id is optional.
      await wallet("'EVM', '0x' || repeat('5', 40), 'GENERATED', 'privy', 'FloFi wallet', 'privywallet12345678', 'PRIVATE_KEY', 'EVM wallet'");
      await wallet("'SOLANA', '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', 'IMPORTED', 'privy', 'FloFi wallet', NULL, 'PRIVATE_KEY', 'Imported'");
      // A Privy wallet never claims a recovery phrase; a Turnkey generated wallet still must; a Turnkey wallet still needs its resource.
      await expect(wallet("'EVM', '0x' || repeat('6', 40), 'IMPORTED', 'privy', 'FloFi wallet', NULL, 'RECOVERY_PHRASE', 'Imported'")).rejects.toThrow();
      await expect(wallet("'EVM', '0x' || repeat('7', 40), 'GENERATED', 'turnkey', 'FloFi wallet', 'wallet-12345678', 'PRIVATE_KEY', 'EVM wallet'")).rejects.toThrow();
      await expect(wallet("'EVM', '0x' || repeat('8', 40), 'GENERATED', 'turnkey', 'FloFi wallet', NULL, 'RECOVERY_PHRASE', 'EVM wallet'")).rejects.toThrow();
      // Any other managed provider is refused, and external wallets are still never exportable.
      await expect(wallet("'EVM', '0x' || repeat('9', 40), 'GENERATED', 'other', 'FloFi wallet', 'wallet-12345678', 'PRIVATE_KEY', 'EVM wallet'")).rejects.toThrow();
      await expect(wallet("'EVM', '0x' || repeat('a', 40), 'EXTERNAL', 'privy', 'Wallet', NULL, 'PRIVATE_KEY', 'Wallet'")).rejects.toThrow();
      const columns = (await t.db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'flofi_account%'`)).rows
        .map(row => String((row as { column_name: string }).column_name));
      expect(columns.filter(name => /key|seed|mnemonic|secret|password|token|otp|phrase/i.test(name))).toEqual([]);
    } finally { await t.drop(); }
  });

  it('rolls failed DDL back together with its ledger entry', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const all = await loadMigrations(), next = all[18]!;
      await migrate(t.db, all.slice(0, 18));
      const sql = next.sql + '\nSELECT missing_privy_migration_test_function();\n';
      await expect(migrate(t.db, [...all.slice(0, 18), { ...next, sql, sha256: createHash('sha256').update(sql).digest('hex') }])).rejects.toThrow();
      expect((await t.db.query('SELECT max(version)::int AS version FROM schema_migrations')).rows).toEqual([{ version: 18 }]);
      expect((await t.db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='flofi_account_identities_kind_check'")).rows)
        .toEqual([{ def: "CHECK ((kind = ANY (ARRAY['GOOGLE'::text, 'APPLE'::text, 'EMAIL'::text, 'EIP155'::text, 'SOLANA'::text])))" }]);
    } finally { await t.drop(); }
  });
});
