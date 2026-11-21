// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CLOUD-PARITY-001 Playwright global setup for the embedded-runtime suites: creates and migrates the disposable LOOPBACK database
 * the embedded runtime uses for this run, and drops it afterwards. It never connects to a non-loopback server.
 *
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the single-card profile only (FLOFI_E2E_SINGLE_CARD) runs on the schema an operator release
 * leaves: this build's shipped migrations, then — while `single_step_runs` is not shipped — this build's certified forward migrations up to and
 * including `single_step_runs` (today 0029–0032; nothing after it), from the certified fixtures, each verified against the certificate's SHA-256
 * before anything is applied. The build then serves a certified-ahead schema (checked below), and the Editor offers one financial card its
 * one-confirmation run (`singleStepRunsSupported`). Every other profile keeps the shipped schema.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, createDatabase, loadMigrations, migrate, type Migration,
  type MigrationIdentity } from '@defi-workflow-engine/cloud-runtime';

const SINGLE_STEP_RUNS = 'single_step_runs';
const same = (a: MigrationIdentity | undefined, b: MigrationIdentity | undefined) =>
  Boolean(a && b && a.version === b.version && a.name === b.name && a.sha256 === b.sha256);

/**
 * The migrations that leave a database with `single_step_runs`: the shipped ones, plus — only while it is not shipped — this build's certified
 * forward migrations up to and including it, read from the SHA-256-pinned fixtures. Fails closed when the build carries no such certificate or a
 * fixture differs from it.
 */
async function throughSingleStepRuns(): Promise<{ readonly migrations: readonly Migration[]; readonly target: MigrationIdentity }> {
  const shipped = await loadMigrations();
  const own = shipped.find(m => m.name === SINGLE_STEP_RUNS);
  if (own) return { migrations: shipped, target: own };
  const certificates = CERTIFIED_FORWARD_MIGRATIONS.filter(c => same(c.base, shipped.at(-1)));
  const certified = certificates.length === 1 ? certificates[0]!.migrations : [];
  const through = certified.findIndex(m => m.name === SINGLE_STEP_RUNS);
  if (through < 0) throw new Error('SINGLE_CARD_E2E_SINGLE_STEP_RUNS_NOT_CERTIFIED');
  const forward = await Promise.all(certified.slice(0, through + 1).map(async ({ version, name, sha256 }) => {
    const sql = await readFile(new URL(`../../../packages/cloud-runtime/test/fixtures/${String(version).padStart(4, '0')}_${name}.sql`, import.meta.url), 'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== sha256) throw new Error('SINGLE_CARD_E2E_CERTIFIED_FIXTURE_MISMATCH');
    return { version, name, sql, sha256 };
  }));
  return { migrations: [...shipped, ...forward], target: certified[through]! };
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
      const { migrations, target: singleStepRuns } = await throughSingleStepRuns();
      await migrate(db, migrations);
      // What the app server checks when it starts: this build serves the database (exact, or certified-ahead by its own certificate), and the
      // ledger holds `single_step_runs` with exactly the identity the Editor's single-card gate compares.
      await assertSchemaCompatible(db);
      const row = (await db.query<MigrationIdentity>('SELECT version, name, sha256 FROM schema_migrations WHERE name = $1', [SINGLE_STEP_RUNS])).rows[0];
      if (!same(row ? { version: Number(row.version), name: row.name, sha256: row.sha256 } : undefined, singleStepRuns))
        throw new Error('SINGLE_CARD_E2E_SINGLE_STEP_RUNS_NOT_APPLIED');
    } else await migrate(db);
  } finally { await db.close(); }
  return async () => { await run(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); };
}
