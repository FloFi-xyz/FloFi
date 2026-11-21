// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CLOUD-PARITY-001 Playwright global setup for the embedded-runtime suites: creates and migrates the disposable LOOPBACK database
 * the embedded runtime uses for this run, and drops it afterwards. It never connects to a non-loopback server.
 *
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the MOCKED user-funded profile (FLOFI_USER_FUNDED_E2E) runs on the schema an operator release
 * leaves: this build's shipped migrations, then every forward migration of this build's certificate (0029–0032, the last one `single_step_runs`)
 * from the certified fixtures, each verified against the certificate's SHA-256 before anything is applied. The build then serves a
 * certified-ahead schema (checked below), and the Editor offers one financial card its one-confirmation run (`singleStepRunsSupported`).
 * Every other profile keeps the shipped schema.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, createDatabase, loadMigrations, migrate, type Migration } from '@defi-workflow-engine/cloud-runtime';

const same = (a: { version: number; name: string; sha256: string } | undefined, b: { version: number; name: string; sha256: string } | undefined) =>
  Boolean(a && b && a.version === b.version && a.name === b.name && a.sha256 === b.sha256);

/** The shipped migrations followed by this build's certified forward migrations, read from the SHA-256-pinned fixtures (fails closed). */
async function certifiedAhead(): Promise<{ readonly migrations: readonly Migration[]; readonly forward: readonly Migration[] }> {
  const shipped = await loadMigrations();
  const certificates = CERTIFIED_FORWARD_MIGRATIONS.filter(c => same(c.base, shipped.at(-1)));
  if (certificates.length !== 1) throw new Error('USER_FUNDED_E2E_CERTIFICATE_MISSING');
  const forward = await Promise.all(certificates[0]!.migrations.map(async ({ version, name, sha256 }) => {
    const sql = await readFile(new URL(`../../../packages/cloud-runtime/test/fixtures/${String(version).padStart(4, '0')}_${name}.sql`, import.meta.url), 'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== sha256) throw new Error('USER_FUNDED_E2E_CERTIFIED_FIXTURE_MISMATCH');
    return { version, name, sql, sha256 };
  }));
  if (forward.at(-1)?.name !== 'single_step_runs') throw new Error('USER_FUNDED_E2E_SINGLE_STEP_RUNS_NOT_CERTIFIED');
  return { migrations: [...shipped, ...forward], forward };
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
    if (process.env.FLOFI_USER_FUNDED_E2E === 'MOCKED_LOOPBACK_ONLY') {
      const ahead = await certifiedAhead();
      await migrate(db, ahead.migrations);
      // What the app server checks at start: this build serves the database only as certified-ahead, exactly at the certificate's identities.
      const compatibility = await assertSchemaCompatible(db);
      if (compatibility.forward.length !== ahead.forward.length || !ahead.forward.every((m, index) => same(m, compatibility.forward[index])))
        throw new Error('USER_FUNDED_E2E_SCHEMA_NOT_CERTIFIED_AHEAD');
    } else await migrate(db);
  } finally { await db.close(); }
  return async () => { await run(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); };
}
