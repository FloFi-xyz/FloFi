// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: a Vercel Preview build's `main.ts migrate` (`FLOFI_MIGRATE_ON_BUILD=preview`) applies migrations only to a database that
 * holds Preview state alone. Real `node backend/main.ts migrate` processes on loopback PostgreSQL: a database a non-Preview deployment writes
 * to (Production's, by a mistaken Preview `DATABASE_URL`) is refused before anything changes, while the same command without a Preview
 * environment (the Railway pre-deploy) is unchanged.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureTenant, loadMigrations, migrate, SHIPPED_MIGRATIONS, type Database, type Migration, type Queryable } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import { deploymentTenant } from '../src/server/deployment.ts';
import { assertDedicatedPreviewDatabase } from './preview-migration.ts';

const APP = fileURLToPath(new URL('..', import.meta.url));
const PREVIEW = { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'claude/build-admin-001' };
const TENANT = deploymentTenant(PREVIEW), HEAD = SHIPPED_MIGRATIONS.length;
const child = (extra: Record<string, string>) => ({ PATH: process.env.PATH ?? '', NODE_ENV: 'test' as const, ...process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}, ...extra });
const records = (stdout: string) => stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>);
const migrateProcess = (env: Record<string, string>) =>
  promisify(execFile)(process.execPath, ['backend/main.ts', 'migrate'], { cwd: APP, timeout: 90_000, env: child(env) })
    .then(({ stdout }) => ({ code: 0, stdout }), (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }));
const event = (stdout: string, name: string) => records(stdout).find(r => r.event === name);
const versions = async (db: Queryable) => (await db.query<{ version: number }>(`SELECT version FROM schema_migrations ORDER BY version`)).rows.map(r => r.version);
const outcome = (work: Promise<unknown>) => work.then(() => 'DEDICATED', (error: Error) => error.message);

let all: readonly Migration[];
const dropped: TestDatabase[] = [];
beforeAll(async () => { all = await loadMigrations(); });
afterEach(async () => { for (const t of dropped.splice(0)) await t.drop().catch(() => undefined); }, 60_000);
async function database(applied: number): Promise<TestDatabase> {
  const t = await createTestDatabase({ migrated: false });
  dropped.push(t);
  if (applied) await migrate(t.db, all.slice(0, applied));
  return t;
}
/** What a Preview deployment leaves behind: its own tenant and rows under it (the seeded `default` tenant stays empty). */
async function previewState(db: Database) {
  await ensureTenant(db, TENANT);
  await db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ($1, 'wf-preview')`, [TENANT]);
}

describe('BUILD-ADMIN-001 Preview builds never migrate a non-Preview database (PostgreSQL)', () => {
  it('a new database, or one holding Preview state only, is migrated by the Preview build as before', async () => {
    const fresh = await database(0);
    const created = await migrateProcess({ ...PREVIEW, DATABASE_URL: fresh.url });
    expect([created.code, event(created.stdout, 'migrate.applied')]).toEqual([0, expect.objectContaining({ versions: all.map(m => m.version).join(','), schema_version: HEAD })]);

    const preview = await database(HEAD - 1);
    await previewState(preview.db);
    await expect(outcome(assertDedicatedPreviewDatabase(preview.db))).resolves.toBe('DEDICATED');
    const applied = await migrateProcess({ ...PREVIEW, DATABASE_URL: preview.url });
    expect([applied.code, event(applied.stdout, 'migrate.applied')]).toEqual([0, expect.objectContaining({ versions: String(HEAD), schema_version: HEAD })]);
  });

  it('a database with Production state is refused before anything changes; the Railway pre-deploy (no Preview environment) still migrates it', async () => {
    const shared = await database(HEAD - 1);
    await previewState(shared.db);
    await shared.db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ('default', 'wf-production')`);
    // Nothing changes: neither the ledger nor the catalog (the newest migration's tables are not created).
    const tables = async () => (await shared.db.query(`SELECT string_agg(tablename, ',' ORDER BY tablename) AS t FROM pg_tables WHERE schemaname = 'public'`)).rows;
    const before = await versions(shared.db), catalog = await tables();
    const refused = await migrateProcess({ ...PREVIEW, DATABASE_URL: shared.url });
    expect([refused.code, event(refused.stdout, 'backend.failed')])
      .toEqual([1, expect.objectContaining({ command: 'migrate', stage: 'preview_database', error_code: 'PREVIEW_DATABASE_NOT_DEDICATED' })]);
    expect(event(refused.stdout, 'migrate.applied')).toBeUndefined();
    expect(await versions(shared.db)).toEqual(before);
    expect(await tables()).toEqual(catalog);

    // The same command and database outside a Vercel Preview: the production migration path is unchanged.
    const production = await migrateProcess({ DATABASE_URL: shared.url });
    expect([production.code, event(production.stdout, 'migrate.applied')]).toEqual([0, expect.objectContaining({ versions: String(HEAD) })]);
  });

  it('any non-Preview footprint refuses: a row of the seeded tenant in any tenant-scoped table, or another non-Preview tenant', async () => {
    const t = await database(HEAD);
    await previewState(t.db);
    await expect(outcome(assertDedicatedPreviewDatabase(t.db))).resolves.toBe('DEDICATED');
    // A production Vercel deployment with its own TENANT_ID registers that tenant on its first cold start.
    await ensureTenant(t.db, 'flofi');
    await expect(outcome(assertDedicatedPreviewDatabase(t.db))).resolves.toBe('PREVIEW_DATABASE_NOT_DEDICATED');
    await t.db.query(`DELETE FROM tenants WHERE tenant_id = 'flofi'`);
    // The Railway API/worker and production Vercel write under `default`: every tenant-scoped table is checked, not a fixed list.
    const tables = (await t.db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id' AND table_name <> 'tenants'`)).rows.map(r => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(['execution_logs', 'execution_runs', 'workflows', 'admin_settings_versions', 'channel_conversations']));
    await t.db.query(`INSERT INTO admin_settings_versions (tenant_id, setting_key, version, document, created_by) VALUES ('default', 'copilot', 1, '{}'::jsonb, 'cli')`);
    await expect(outcome(assertDedicatedPreviewDatabase(t.db))).resolves.toBe('PREVIEW_DATABASE_NOT_DEDICATED');
  });
});
