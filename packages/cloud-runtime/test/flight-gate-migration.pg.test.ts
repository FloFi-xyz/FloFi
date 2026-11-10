// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, loadMigrations, migrate, SHIPPED_MIGRATIONS } from '../src/index.js';
import { createTestDatabase } from './pg-harness';

describe('Flight beta gate migrations 0025–0026 (disposable PostgreSQL)', () => {
  it('pins the exact compatibility fixtures and requires a prior v24 compatibility release', async () => {
    const certificate = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 24)!;
    expect(certificate.migrations).toEqual(SHIPPED_MIGRATIONS.slice(24, 26));
    for (const identity of certificate.migrations) {
      const sql = await readFile(new URL(`./fixtures/${String(identity.version).padStart(4, '0')}_${identity.name}.sql`, import.meta.url));
      expect(createHash('sha256').update(sql).digest('hex')).toBe(identity.sha256);
    }
    const t = await createTestDatabase({ migrated: false });
    try {
      const migrations = await loadMigrations();
      await migrate(t.db, migrations.slice(0, 24));
      await t.db.query(`INSERT INTO flight_invites (tenant_id, code, issuer) VALUES ('default', 'FLF-ABCD-EFGH', 'CREATOR')`);
      await t.db.query(`INSERT INTO flight_list_entries (tenant_id, entry_id, email, flight, language, notice, joined_at)
        VALUES ('default', 'fle_' || repeat('a', 32), 'original@example.com', 'FIRST', 'PT', 'original-notice', '2026-10-01T12:00:00Z')`);
      const before = (await t.db.query(`SELECT entry_id, email, flight, language, notice, joined_at FROM flight_list_entries`)).rows;
      expect(await migrate(t.db, migrations)).toEqual([25, 26]);
      expect((await t.db.query(`SELECT entry_id, email, flight, language, notice, joined_at FROM flight_list_entries`)).rows).toEqual(before);
      expect((await t.db.query(`SELECT code, redeemed_at, expires_at, revoked_at FROM flight_invites`)).rows)
        .toEqual([{ code: 'FLF-ABCD-EFGH', redeemed_at: null, expires_at: null, revoked_at: null }]);
      // Old writers name their columns and retain compatibility; legacy invitations do not expire retroactively.
      await t.db.query(`INSERT INTO flight_invites (tenant_id, code, issuer) VALUES ('default', 'FLF-JKMN-PQRS', 'CREATOR')`);
      expect(await assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS.slice(0, 24)))
        .toEqual({ version: 26, application: 24, forward: certificate.migrations });
      await expect(assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS.slice(0, 24), []))
        .rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
      expect(await migrate(t.db, migrations)).toEqual([]);
    } finally { await t.drop(); }
  });

  it('rolls back every 0026 change when its final table cannot be created', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      const migrations = await loadMigrations();
      await migrate(t.db, migrations.slice(0, 25));
      await t.db.query('CREATE TABLE flight_early_list_imports (conflict int)');
      await expect(migrate(t.db, migrations)).rejects.toThrow();
      expect((await t.db.query('SELECT max(version)::int AS version FROM schema_migrations')).rows).toEqual([{ version: 25 }]);
      expect((await t.db.query(`SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'flight_invites' AND column_name IN ('expires_at', 'revoked_at')`)).rows).toEqual([{ n: 0 }]);
      const check = (await t.db.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'flight_emails_template_check'`)).rows[0]!.definition;
      expect(check).not.toContain('EARLY_LIST');
    } finally { await t.drop(); }
  });
});
