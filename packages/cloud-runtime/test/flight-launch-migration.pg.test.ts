// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: schema 23 → 24 against real disposable PostgreSQL. 0024 adds seven flight_* tables, three nullable columns
 * and two partial unique indexes: every pre-existing row survives unchanged, a v23 build's own writes (passes and invites without the new
 * columns) keep working on schema 24, a version-23 build accepts schema 24 only through its certificate, and a failure rolls the whole
 * migration back with its ledger entry.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, CERTIFIED_FORWARD_MIGRATIONS, loadMigrations, migrate, SHIPPED_MIGRATIONS } from '../src/index.js';
import { createTestDatabase } from './pg-harness';

const NEW_TABLES = ['flight_access_attempts', 'flight_access_claims', 'flight_access_sessions', 'flight_access_tokens', 'flight_email_control',
  'flight_email_suppressions', 'flight_emails'];

describe('Flight FloFi launch migration (0024)', () => {
  it('is the exact certified bytes, kept as a fixture', async () => {
    const sql = await readFile(new URL('./fixtures/0024_flight_launch.sql', import.meta.url), 'utf8');
    const identity = SHIPPED_MIGRATIONS[23]!;
    expect(identity).toMatchObject({ version: 24, name: 'flight_launch' });
    expect(createHash('sha256').update(sql).digest('hex')).toBe(identity.sha256);
    expect(CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 23)?.migrations).toEqual([identity]);
  });

  it('adds only its tables, columns and indexes; every earlier row survives; v23 writes still work; a v23 build serves it only by certificate', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const all = (await loadMigrations()).slice(0, 24), base = all.slice(0, 23);
      expect(all[23]).toMatchObject({ version: 24, name: 'flight_launch', sha256: SHIPPED_MIGRATIONS[23]!.sha256 });
      await migrate(t.db, base);
      // Rows a v23 build writes: an account, a list entry, a pass and its invites, a creator invite.
      const account = 'acct_' + 'b'.repeat(32), pass = 'flp_' + 'c'.repeat(32);
      await t.db.query(`INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ('default', $1)`, [account]);
      await t.db.query(`INSERT INTO flight_list_entries (tenant_id, entry_id, email, flight, language, notice) VALUES ('default', 'fle_' || repeat('a', 32),
        'ana@example.com', 'FIRST', 'EN', '2026-11-05')`);
      await t.db.query(`INSERT INTO flight_passes (tenant_id, pass_id, account_id, origin, boarding_no, founding_seat, route, run_id)
        VALUES ('default', $1, $2, 'LIST', 1, 1, '{}', 'run-1')`, [pass, account]);
      await t.db.query(`INSERT INTO flight_invites (tenant_id, code, issuer, issuer_pass_id) VALUES ('default', 'FLF-AAAA-BBBB', 'FOUNDING', $1)`, [pass]);
      const snapshot = async () => (await t.db.query(`SELECT
        (SELECT json_agg(to_jsonb(p) - 'public_id' - 'removed_at' ORDER BY pass_id) FROM flight_passes p) AS passes,
        (SELECT json_agg(to_jsonb(i) - 'recipient' ORDER BY code) FROM flight_invites i) AS invites,
        (SELECT json_agg(to_jsonb(e) ORDER BY entry_id) FROM flight_list_entries e) AS entries,
        (SELECT json_agg(to_jsonb(a) ORDER BY account_id) FROM flofi_accounts a) AS accounts`)).rows[0];
      const columns = async () => (await t.db.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name NOT IN ('flight_passes', 'flight_invites') AND table_name NOT IN (${NEW_TABLES.map(n => `'${n}'`).join(',')})
        ORDER BY table_name, ordinal_position`)).rows;
      const before = await snapshot(), shape = await columns();
      expect(await migrate(t.db, all)).toEqual([24]);
      expect(await snapshot()).toEqual(before);
      expect(await columns()).toEqual(shape);
      expect((await t.db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[]) ORDER BY table_name`,
        [NEW_TABLES])).rows.map(row => (row as { table_name: string }).table_name)).toEqual([...NEW_TABLES].sort());
      expect((await t.db.query(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name IN ('flight_passes', 'flight_invites')
        AND column_name IN ('public_id', 'removed_at', 'recipient') ORDER BY column_name`)).rows)
        .toEqual([{ column_name: 'public_id', is_nullable: 'YES' }, { column_name: 'recipient', is_nullable: 'YES' }, { column_name: 'removed_at', is_nullable: 'YES' }]);
      // A v23 build's INSERTs (they name their columns, without the new ones) still work on schema 24.
      const second = 'acct_' + 'd'.repeat(32);
      await t.db.query(`INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ('default', $1)`, [second]);
      await t.db.query(`INSERT INTO flight_passes (tenant_id, pass_id, account_id, origin, boarding_no, founding_seat, handle, public, route, run_id, departed_at)
        VALUES ('default', 'flp_' || repeat('e', 32), $1, 'INVITE', 2, 2, NULL, false, '{}', 'run-2', now())`, [second]);
      await t.db.query(`INSERT INTO flight_invites (tenant_id, code, issuer, created_at) VALUES ('default', 'FLF-CCCC-DDDD', 'CREATOR', now())`);
      // The new constraints: a public id is 12 base32 letters, unique per tenant; a recipient is a lower-case address, one invite each.
      await expect(t.db.query(`UPDATE flight_passes SET public_id = 'NOT-VALID' WHERE pass_id = $1`, [pass])).rejects.toThrow();
      await t.db.query(`UPDATE flight_passes SET public_id = 'abcdefghijkl' WHERE pass_id = $1`, [pass]);
      await expect(t.db.query(`UPDATE flight_passes SET public_id = 'abcdefghijkl' WHERE account_id = $1`, [second])).rejects.toThrow();
      await expect(t.db.query(`UPDATE flight_invites SET recipient = 'Ana@Example.com' WHERE code = 'FLF-CCCC-DDDD'`)).rejects.toThrow();
      // The outbox's lease invariant and its reservation rule are enforced by the table itself.
      await expect(t.db.query(`INSERT INTO flight_emails (tenant_id, email_id, dedupe_key, template, template_version, category, recipient, language, trigger,
        state, not_before, next_attempt_at) VALUES ('default', 'fem_' || repeat('1', 32), 'k', 'EVE', 1, 'CAMPAIGN', 'a@b.cd', 'EN', 'test', 'SENDING', now(), now())`)).rejects.toThrow();
      expect(await assertSchemaCurrent(t.db, SHIPPED_MIGRATIONS.slice(0, 24))).toBe(24);
      expect(await migrate(t.db, all)).toEqual([]);
      // A v23 build (Release A) accepts schema 24 only through its certificate.
      expect(await assertSchemaCompatible(t.open(1), SHIPPED_MIGRATIONS.slice(0, 23))).toMatchObject({ version: 24, application: 23, forward: [SHIPPED_MIGRATIONS[23]] });
      await expect(assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS.slice(0, 23), CERTIFIED_FORWARD_MIGRATIONS.filter(c => c.base.version !== 23)))
        .rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
      // Deleting an account (as a v23 build does) cascades to its claim; deleting a list entry cascades to its tokens, sessions and emails.
      await t.db.query(`INSERT INTO flight_access_claims (tenant_id, entry_id, account_id) VALUES ('default', 'fle_' || repeat('a', 32), $1)`, [account]);
      await t.db.query(`DELETE FROM flofi_accounts WHERE account_id = $1`, [account]);
      expect((await t.db.query('SELECT count(*)::int AS n FROM flight_access_claims')).rows).toEqual([{ n: 0 }]);
    } finally { await t.drop(); }
  });

  it('rolls back completely when it fails part-way', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const all = (await loadMigrations()).slice(0, 24);
      await migrate(t.db, all.slice(0, 23));
      // A conflicting object makes the last statement of 0024 fail: nothing of it may remain, and the ledger stays at 23.
      await t.db.query('CREATE TABLE flight_email_control (x int)');
      await expect(migrate(t.db, all)).rejects.toThrow();
      expect((await t.db.query(`SELECT max(version)::int AS v FROM schema_migrations`)).rows).toEqual([{ v: 23 }]);
      expect((await t.db.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('flight_emails', 'flight_access_tokens')`)).rows).toEqual([{ n: 0 }]);
      expect((await t.db.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'flight_passes' AND column_name = 'public_id'`)).rows).toEqual([{ n: 0 }]);
    } finally { await t.drop(); }
  });
});
