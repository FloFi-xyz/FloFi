// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Disposable PostgreSQL databases for `*.pg.test.ts`. TEST_DATABASE_URL must point at a LOOPBACK server; each
 * call creates a fresh uniquely named database and drops it afterwards. These suites never run against a
 * remote host, so they cannot touch a shared or production database.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CERTIFIED_FORWARD_MIGRATIONS, createDatabase, loadMigrations, migrate, SHIPPED_MIGRATIONS, type Database, type Migration } from '../src/index.js';

/**
 * Release certification only (BUILD-CHAT-E2E-001), never set in CI: FLOFI_TEST_CERTIFIED_AHEAD=1 migrates every test database one certified
 * release ahead (this build's migrations, then the forward migrations its certificate names, from their SHA-256-pinned `fixtures/`), so this
 * build's own suites show that it serves the schema it is certified for. Fails closed when the build has no certificate or a fixture differs.
 */
async function certifiedAhead(): Promise<readonly Migration[]> {
  const head = JSON.stringify(SHIPPED_MIGRATIONS.at(-1));
  const certificate = CERTIFIED_FORWARD_MIGRATIONS.find(c => JSON.stringify(c.base) === head);
  if (!certificate) throw new Error('NO_CERTIFIED_FORWARD_MIGRATION');
  const ahead = await Promise.all(certificate.migrations.map(async ({ version, name, sha256 }) => {
    const sql = await readFile(new URL(`./fixtures/${String(version).padStart(4, '0')}_${name}.sql`, import.meta.url), 'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== sha256) throw new Error('CERTIFIED_FIXTURE_MISMATCH');
    return { version, name, sql, sha256 };
  }));
  return [...await loadMigrations(), ...ahead];
}

export function testDatabaseUrl(): URL {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error('TEST_DATABASE_URL is required for *.pg.test.ts (a loopback PostgreSQL server)');
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) throw new Error('TEST_DATABASE_NOT_LOOPBACK');
  return url;
}
export type TestDatabase = { readonly url: string; readonly db: Database; readonly open: (max?: number) => Database; readonly drop: () => Promise<void> };
export async function createTestDatabase(options: { migrated?: boolean } = {}): Promise<TestDatabase> {
  const base = testDatabaseUrl(), name = `flofi_test_${randomBytes(6).toString('hex')}`;
  const admin = createDatabase({ connectionString: base.toString(), maxConnections: 1 });
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.close(); }
  const url = new URL(base.toString()); url.pathname = '/' + name;
  const opened: Database[] = [];
  const open = (max = 10) => { const db = createDatabase({ connectionString: url.toString(), maxConnections: max }); opened.push(db); return db; };
  const db = open();
  if (options.migrated !== false) await migrate(db, process.env.FLOFI_TEST_CERTIFIED_AHEAD === '1' ? await certifiedAhead() : undefined);
  return {
    url: url.toString(), db, open,
    async drop() {
      await Promise.allSettled(opened.map(d => d.close()));
      const cleanup = createDatabase({ connectionString: base.toString(), maxConnections: 1 });
      try { await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await cleanup.close(); }
    },
  };
}
export const bytes = (text: string) => new TextEncoder().encode(text);
export const text = (value: Uint8Array | null) => value === null ? null : new TextDecoder().decode(value);
