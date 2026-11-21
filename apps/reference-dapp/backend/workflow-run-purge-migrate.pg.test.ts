// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): the `workflow-run-purge-migrate` operator command on REAL disposable PostgreSQL.
 * It refuses every schema below 32 and never applies the optional 0029–0032 itself (each keeps its own owner-run command); on exact schema 32 it
 * applies only the certified 0033 from its SHA-256-pinned fixture — in-process and through the real `backend/admin-cli.ts` process on the migration
 * connection; a rerun applies nothing, and the 0029–0032 commands apply nothing on schema 33. The schema proofs of 0033 itself are in
 * `packages/cloud-runtime/test/certificate-0033.pg.test.ts`; owner deletion under it in `backend/owner-history.pg.test.ts`.
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

it('applies only the certified 0033 on exact schema 32; refuses below 32; reruns and the earlier commands apply nothing', { timeout: 180_000 }, async () => {
  // Schema 28 explicitly (the shipped history), whatever FLOFI_TEST_CERTIFIED_AHEAD says: this test walks the operator procedure from the start.
  t = await createTestDatabase({ migrated: false });
  expect(await migrate(t.db)).toHaveLength(28);
  const db = t.db, run = (command: Parameters<typeof runAdminCommand>[0]) => runAdminCommand(command, {}, db, 'default');
  const head = async () => (await db.query<{ version: number }>('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]!.version;
  const purgeFunction = async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'purge_unsubmitted_workflow_run'`)).rows[0]!.n;

  // Below 32 the command refuses and changes nothing; the optional 0029–0032 are applied only by their own commands.
  await expect(run('workflow-run-purge-migrate')).rejects.toThrow('WORKFLOW_RUN_PURGE_REQUIRES_SCHEMA_32');
  expect(await head()).toBe(28);
  expect(await run('finops-migrate')).toEqual({ applied: [29] });
  expect(await run('finops-sync-migrate')).toEqual({ applied: [30] });
  expect(await run('position-purge-migrate')).toEqual({ applied: [31] });
  await expect(run('workflow-run-purge-migrate')).rejects.toThrow('WORKFLOW_RUN_PURGE_REQUIRES_SCHEMA_32');
  // The real CLI process: a fixed code on stderr, exit code 1, nothing applied.
  expect(await cli(['workflow-run-purge-migrate', '--tenant', 'default'], { DATABASE_MIGRATION_URL: t.url }))
    .toMatchObject({ code: 1, stdout: '', stderr: 'WORKFLOW_RUN_PURGE_REQUIRES_SCHEMA_32\n' });
  expect(await head()).toBe(31);
  expect(await run('single-step-runs-migrate')).toEqual({ applied: [32] });
  expect(await purgeFunction()).toBe(0);

  // Exact schema 32: the real CLI applies only 0033 (fixture digest checked against the certificate) on the migration connection.
  const applied = await cli(['workflow-run-purge-migrate', '--tenant', 'default'], { DATABASE_MIGRATION_URL: t.url });
  expect(applied).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(applied.stdout)).toEqual({ tenantId: 'default', applied: [33] });
  expect(await purgeFunction()).toBe(1);
  expect((await db.query('SELECT version, name, sha256 FROM schema_migrations WHERE version >= 29 ORDER BY version')).rows).toEqual(CERTIFICATE.migrations.map(m => ({ ...m })));
  expect(CERTIFICATE.migrations.at(-1)).toEqual({ version: 33, name: 'workflow_run_purge', sha256: '26b8a6dbf15dddbca24924e10bf8748748691c400fcb0c70e1d63038607be2c2' });

  // A rerun, and every earlier operator command on schema 33, verifies the ledger and applies nothing; so does the ordinary deployment migration.
  expect(await run('workflow-run-purge-migrate')).toEqual({ applied: [] });
  expect(await run('single-step-runs-migrate')).toEqual({ applied: [] });
  expect(await run('position-purge-migrate')).toEqual({ applied: [] });
  expect(await run('finops-sync-migrate')).toEqual({ applied: [] });
  expect(await run('finops-migrate')).toEqual({ applied: [] });
  expect(await migrate(db)).toEqual([]);
  expect(JSON.parse((await cli(['workflow-run-purge-migrate', '--tenant', 'default'], { DATABASE_MIGRATION_URL: t.url })).stdout)).toEqual({ tenantId: 'default', applied: [] });
  expect(await head()).toBe(33);

  // This build serves schema 33 through its certificate; a build carrying only the previous certificate (0029–0032) refuses it.
  expect(await assertSchemaCompatible(db, SHIPPED_MIGRATIONS)).toMatchObject({ version: 33, application: 28 });
  const previous = CERTIFIED_FORWARD_MIGRATIONS.map(c => c === CERTIFICATE ? { ...c, migrations: c.migrations.slice(0, 4) } : c);
  await expect(assertSchemaCompatible(db, SHIPPED_MIGRATIONS, previous)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
});
