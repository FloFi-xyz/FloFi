// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the `single-step-runs-migrate` operator command on REAL disposable PostgreSQL. It refuses every
 * schema below 31 and never applies the optional 0029/0030/0031 itself (each keeps its own owner-run command); on exact schema 31 it applies only
 * the certified 0032 from its SHA-256-pinned fixture — in-process and through the real `backend/admin-cli.ts` process on the migration connection;
 * a rerun applies nothing, and the 0029, 0030 and 0031 commands apply nothing on schema 32. The schema proofs of 0032 itself are in
 * `packages/cloud-runtime/test/certificate-0032.pg.test.ts`.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, migrate, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import { runAdminCommand } from '../src/admin/cli-commands.ts';

const CERTIFICATE = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
const cwd = fileURLToPath(new URL('..', import.meta.url));
/** The real operator CLI on plain Node, with only the migration connection set (DATABASE_URL is deliberately absent). */
const cli = (args: string[], env: Record<string, string>) => promisify(execFile)(process.execPath, ['backend/admin-cli.ts', ...args],
  { cwd, timeout: 90_000, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env } })
  .then(r => ({ code: 0, stdout: r.stdout, stderr: r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

let t: TestDatabase | undefined;
afterEach(async () => { await t?.drop(); t = undefined; });

it('applies only the certified 0032 on exact schema 31; refuses below 31; reruns and the earlier commands apply nothing', { timeout: 180_000 }, async () => {
  // Schema 28 explicitly (the shipped history), whatever FLOFI_TEST_CERTIFIED_AHEAD says: this test walks the operator procedure from the start.
  t = await createTestDatabase({ migrated: false });
  expect(await migrate(t.db)).toHaveLength(28);
  const db = t.db, run = (command: Parameters<typeof runAdminCommand>[0]) => runAdminCommand(command, {}, db, 'default');
  const head = async () => (await db.query<{ version: number }>('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]!.version;
  const stepCount = async () => (await db.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'workflow_runs'::regclass AND conname = 'workflow_runs_step_count_check'`)).rows.map(r => r.def);

  // Below 31 the command refuses and changes nothing; the optional 0029–0031 are applied only by their own commands.
  await expect(run('single-step-runs-migrate')).rejects.toThrow('SINGLE_STEP_RUNS_REQUIRES_SCHEMA_31');
  expect(await head()).toBe(28);
  expect(await run('finops-migrate')).toEqual({ applied: [29] });
  await expect(run('single-step-runs-migrate')).rejects.toThrow('SINGLE_STEP_RUNS_REQUIRES_SCHEMA_31');
  expect(await head()).toBe(29);
  expect(await run('finops-sync-migrate')).toEqual({ applied: [30] });
  // The real CLI process: a fixed code on stderr, exit code 1, nothing applied.
  expect(await cli(['single-step-runs-migrate', '--tenant', 'default'], { DATABASE_MIGRATION_URL: t.url }))
    .toMatchObject({ code: 1, stdout: '', stderr: 'SINGLE_STEP_RUNS_REQUIRES_SCHEMA_31\n' });
  expect(await head()).toBe(30);
  expect(await run('position-purge-migrate')).toEqual({ applied: [31] });
  expect(await stepCount()).toEqual(['CHECK (((step_count >= 2) AND (step_count <= 8)))']);

  // Exact schema 31: the real CLI applies only 0032 (fixture digest checked against the certificate) on the migration connection.
  const applied = await cli(['single-step-runs-migrate', '--tenant', 'default'], { DATABASE_MIGRATION_URL: t.url });
  expect(applied).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(applied.stdout)).toEqual({ tenantId: 'default', applied: [32] });
  expect(await stepCount()).toEqual(['CHECK (((step_count >= 1) AND (step_count <= 8)))']);
  expect((await db.query('SELECT version, name, sha256 FROM schema_migrations WHERE version >= 29 ORDER BY version')).rows).toEqual(CERTIFICATE.migrations.map(m => ({ ...m })));
  expect(CERTIFICATE.migrations.at(-1)).toEqual({ version: 32, name: 'single_step_runs', sha256: '1f388788b8e788fcc412585b38569260acea1e1cb24ec2cab3f2208270e5d14c' });

  // A rerun, and every earlier operator command on schema 32, verifies the ledger and applies nothing; so does the ordinary deployment migration.
  expect(await run('single-step-runs-migrate')).toEqual({ applied: [] });
  expect(await run('position-purge-migrate')).toEqual({ applied: [] });
  expect(await run('finops-sync-migrate')).toEqual({ applied: [] });
  expect(await run('finops-migrate')).toEqual({ applied: [] });
  expect(await migrate(db)).toEqual([]);
  expect(JSON.parse((await cli(['single-step-runs-migrate', '--tenant', 'default'], { DATABASE_MIGRATION_URL: t.url })).stdout)).toEqual({ tenantId: 'default', applied: [] });
  expect(await head()).toBe(32);

  // This build serves schema 32 through its certificate; a build carrying only the previous certificate (0029–0031) refuses it.
  expect(await assertSchemaCompatible(db, SHIPPED_MIGRATIONS)).toMatchObject({ version: 32, application: 28 });
  const previous = CERTIFIED_FORWARD_MIGRATIONS.map(c => c === CERTIFICATE ? { ...c, migrations: c.migrations.slice(0, 3) } : c);
  await expect(assertSchemaCompatible(db, SHIPPED_MIGRATIONS, previous)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
});
