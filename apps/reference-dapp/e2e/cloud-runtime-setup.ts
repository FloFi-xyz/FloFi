// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CLOUD-PARITY-001 Playwright global setup for the embedded-runtime suites: creates and migrates the disposable LOOPBACK database
 * the embedded runtime uses for this run, and drops it afterwards. It never connects to a non-loopback server.
 *
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the single-card profile only (FLOFI_E2E_SINGLE_CARD) runs on the schema an operator release
 * leaves: this build's shipped migrations, then — while they are not shipped — this build's certified forward migrations up to and including
 * `single_step_runs` and `workflow_run_purge` (today 0029–0033: single-card runs start only where an attempt the wallet rejected can also be
 * deleted from History), from the certified fixtures, each verified against the certificate's SHA-256 before anything is applied. The build then
 * serves a certified-ahead schema (checked below), and the Editor offers one financial card its one-confirmation run (`singleStepRunsSupported`).
 * Every other profile keeps the shipped schema.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, createDatabase, loadMigrations, migrate, type Migration,
  type MigrationIdentity } from '@defi-workflow-engine/cloud-runtime';

/** The migrations single-card runs need (`singleStepRunsSupported`): one-step runs (0032) and the History deletion of a rejected attempt (0033). */
const SINGLE_CARD_MIGRATIONS = ['single_step_runs', 'workflow_run_purge'] as const;
const same = (a: MigrationIdentity | undefined, b: MigrationIdentity | undefined) =>
  Boolean(a && b && a.version === b.version && a.name === b.name && a.sha256 === b.sha256);

/**
 * The migrations that leave a database with every one of `SINGLE_CARD_MIGRATIONS`: the shipped ones, plus — for those not shipped — this build's
 * certified forward migrations up to and including the last of them, read from the SHA-256-pinned fixtures. Fails closed when the build carries no
 * such certificate or a fixture differs from it.
 */
async function throughSingleCardMigrations(): Promise<{ readonly migrations: readonly Migration[]; readonly targets: readonly MigrationIdentity[] }> {
  const shipped = await loadMigrations();
  const certificates = CERTIFIED_FORWARD_MIGRATIONS.filter(c => same(c.base, shipped.at(-1)));
  const certified = certificates.length === 1 ? certificates[0]!.migrations : [];
  const targets = SINGLE_CARD_MIGRATIONS.map(name => shipped.find(m => m.name === name) ?? certified.find(m => m.name === name));
  if (targets.some(m => !m)) throw new Error('SINGLE_CARD_E2E_SINGLE_STEP_RUNS_NOT_CERTIFIED');
  const through = Math.max(-1, ...SINGLE_CARD_MIGRATIONS.map(name => certified.findIndex(m => m.name === name)));
  const forward = await Promise.all(certified.slice(0, through + 1).map(async ({ version, name, sha256 }) => {
    const sql = await readFile(new URL(`../../../packages/cloud-runtime/test/fixtures/${String(version).padStart(4, '0')}_${name}.sql`, import.meta.url), 'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== sha256) throw new Error('SINGLE_CARD_E2E_CERTIFIED_FIXTURE_MISMATCH');
    return { version, name, sql, sha256 };
  }));
  return { migrations: [...shipped, ...forward], targets: targets as MigrationIdentity[] };
}

export default async function setup(): Promise<() => Promise<void>> {
  const target = new URL(process.env.FLOFI_E2E_DATABASE_URL ?? '');
  const name = target.pathname.slice(1);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !/^flofi_e2e_[0-9a-z_]{1,40}$/.test(name)) throw new Error('CLOUD_RUNTIME_E2E_DATABASE_REFUSED');
  const admin = new URL(target.href); admin.pathname = '/postgres';
  const run = async (sql: string) => { const db = createDatabase({ connectionString: admin.href, maxConnections: 1 }); try { await db.query(sql); } finally { await db.close(); } };
  await run(`CREATE DATABASE ${name}`);
  const db = createDatabase({ connectionString: target.href, maxConnections: 1 });
  try {
    if (process.env.FLOFI_E2E_SINGLE_CARD === 'MOCKED_LOOPBACK_ONLY') {
      const { migrations, targets } = await throughSingleCardMigrations();
      await migrate(db, migrations);
      // What the app server checks when it starts: this build serves the database (exact, or certified-ahead by its own certificate), and the
      // ledger holds `single_step_runs` and `workflow_run_purge` with exactly the identities the Editor's single-card gate compares.
      await assertSchemaCompatible(db);
      for (const target of targets) {
        const row = (await db.query<MigrationIdentity>('SELECT version, name, sha256 FROM schema_migrations WHERE name = $1', [target.name])).rows[0];
        if (!same(row ? { version: Number(row.version), name: row.name, sha256: row.sha256 } : undefined, target))
          throw new Error('SINGLE_CARD_E2E_SINGLE_STEP_RUNS_NOT_APPLIED');
      }
    } else await migrate(db);
  } finally { await db.close(); }
  return async () => { await run(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); };
}
