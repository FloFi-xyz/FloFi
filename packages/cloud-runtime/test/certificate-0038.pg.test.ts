// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (completion): the certified 0038 `platform_fee_authorizations`, from its SHA-256-pinned file, on
 * disposable PostgreSQL. 0038 follows 0029–0037 (all certified for the v28 build) and adds one table with its own non-SECURITY-DEFINER trigger
 * function; nothing pre-existing changes. Proven here: the exact bytes and certificate; the v28 build serving schema 38 only through this
 * certificate (the certificate as it stood at 0037 refuses it); the catalog diff (one table, one function, one trigger, every pre-existing trigger
 * and function unchanged, no SECURITY DEFINER); one authorization per execution, written once, never updated; FEEABLE only with lines; an
 * owner-deleted unstarted run taking its authorization with it; a lock timeout rolling 0038 back completely. Synthetic rows only.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, forwardMigrationSqlUrl, loadMigrations, migrate, SHIPPED_MIGRATIONS, type Database,
  type ForwardCompatibilityCertificate, type Migration } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from './pg-harness.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const CERTIFICATE = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
const V28 = SHIPPED_MIGRATIONS.slice(0, 28);
const PREVIOUS: ForwardCompatibilityCertificate = { ...CERTIFICATE, migrations: CERTIFICATE.migrations.slice(0, 9) };
const opened: TestDatabase[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(t => t.drop())); });

async function forward(version: number): Promise<Migration> {
  const identity = CERTIFICATE.migrations.find(m => m.version === version)!;
  const sql = await readFile(forwardMigrationSqlUrl(identity), 'utf8');
  expect(sha(sql)).toBe(identity.sha256);
  return { ...identity, sql };
}
async function schema37(): Promise<{ t: TestDatabase; chain: Migration[]; m38: Migration }> {
  const t = await createTestDatabase({ migrated: false }); opened.push(t);
  const chain = [...(await loadMigrations()).slice(0, 28)];
  for (let v = 29; v <= 37; v++) chain.push(await forward(v));
  expect(await migrate(t.db, chain)).toHaveLength(37);
  return { t, chain, m38: await forward(38) };
}
const q = async (db: Database, sql: string) => (await db.query<{ item: string }>(sql)).rows.map(r => r.item).sort();
const catalog = async (db: Database) => ({
  tables: await q(db, `SELECT tablename AS item FROM pg_tables WHERE schemaname = 'public'`),
  functions: await q(db, `SELECT p.proname || ':' || md5(pg_get_functiondef(p.oid)) AS item FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')`),
  triggers: await q(db, `SELECT c.relname || '.' || t.tgname || ':' || md5(pg_get_triggerdef(t.oid)) AS item FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal`),
  definers: await q(db, `SELECT p.proname AS item FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef`),
});
const HEX = (c: string) => c.repeat(64);
async function run(db: Database, runId: string, status = 'PREPARED') {
  await db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ('default', $1) ON CONFLICT DO NOTHING`, ['wf-' + runId]);
  await db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256)
    VALUES ('default', 'runs', $1, 'RUN', 1, 1, 10, $2)`, [runId, HEX('a')]);
  await db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, needs_observation, has_evidence, log_version)
    VALUES ('default', $1, 'runs', $1, $2, 'ethereum-swap', $3, 'PUBLIC_MAINNET', false, false, 1)`, [runId, 'wf-' + runId, status]);
}
const purge = (db: Database, runId: string) => db.transaction(async tx => {
  await tx.query(`INSERT INTO execution_purge_audit (tenant_id, run_id, owner_account, namespace, log_name, log_sha256, log_version, segment_count, journal_count)
    VALUES ('default', $1, $2, 'runs', $1, $3, 1, 1, 0)`, [runId, '0x' + 'ab'.repeat(20), HEX('a')]);
  await tx.query(`INSERT INTO execution_purge_permits VALUES ('default', $1, 'runs', $1, txid_current())`, [runId]);
  await tx.query(`DELETE FROM execution_runs WHERE tenant_id = 'default' AND run_id = $1`, [runId]);
});
const LINE = JSON.stringify([{ chainId: 'eip155:1', address: '0x' + 'a0'.repeat(20), decimals: 6, principal: '100000000', fee: '800000' }]);
const insert = (db: Database, runId: string, status: string, lines: string) => db.query(`INSERT INTO platform_fee_authorizations (tenant_id, run_id, policy_id,
  rate_bps, status, lines, basis_sha256, workflow_hash) VALUES ('default', $1, 'flofi-platform-fee/v2-80bps', 80, $2, $3::jsonb, $4, $5) ON CONFLICT DO NOTHING`,
  [runId, status, lines, 'b'.repeat(64), '0x' + 'c'.repeat(64)]);

describe('certificate 0038_platform_fee_authorizations', () => {
  it('pins 0038 in the base-28 certificate; the v28 build serves schema 38 only through it', async () => {
    expect(CERTIFICATE.migrations.map(m => [m.version, m.name]).at(-1)).toEqual([38, 'platform_fee_authorizations']);
    expect(CERTIFICATE.assessment).toBe('docs/deploy/SCHEMA-COMPATIBILITY.md#30-certificate-0038_platform_fee_authorizations');
    const { t, chain, m38 } = await schema37();
    const before = await catalog(t.db);
    expect(await migrate(t.db, [...chain, m38])).toEqual([38]);
    await expect(assertSchemaCompatible(t.db, V28)).resolves.toMatchObject({ version: 38, application: 28 });
    await expect(assertSchemaCompatible(t.db, V28, [PREVIOUS])).rejects.toThrow();
    const after = await catalog(t.db);
    expect(after.tables.filter(x => !before.tables.includes(x))).toEqual(['platform_fee_authorizations']);
    expect(before.tables.filter(x => !after.tables.includes(x))).toEqual([]);
    expect(before.functions.every(f => after.functions.includes(f))).toBe(true);
    expect(after.functions.length - before.functions.length).toBe(1);
    expect(before.triggers.every(f => after.triggers.includes(f))).toBe(true);
    expect(after.triggers.length - before.triggers.length).toBe(1);
    expect(after.definers).toEqual(before.definers);
    expect(await migrate(t.db, [...chain, m38])).toEqual([]);
  });

  it('one authorization per execution, written once and never updated; FEEABLE only with lines; a purged run takes it with it', async () => {
    const { t, chain, m38 } = await schema37();
    await migrate(t.db, [...chain, m38]);
    await run(t.db, 'run-a');
    await expect(insert(t.db, 'run-a', 'FEEABLE', '[]')).rejects.toThrow();
    await expect(insert(t.db, 'run-a', 'NOT_APPLICABLE', LINE)).rejects.toThrow();
    await expect(insert(t.db, 'nope', 'FEEABLE', LINE)).rejects.toThrow();
    expect((await insert(t.db, 'run-a', 'FEEABLE', LINE)).rowCount).toBe(1);
    expect((await insert(t.db, 'run-a', 'NOT_APPLICABLE', '[]')).rowCount).toBe(0);
    await expect(t.db.query(`UPDATE platform_fee_authorizations SET rate_bps = 10 WHERE run_id = 'run-a'`)).rejects.toThrow('PLATFORM_FEE_AUTHORIZATION_IMMUTABLE');
    await expect(t.db.query(`INSERT INTO platform_fee_authorizations (tenant_id, policy_id, rate_bps, status, lines, basis_sha256, workflow_hash)
      VALUES ('default', 'flofi-platform-fee/v2-80bps', 80, 'NOT_APPLICABLE', '[]', $1, $2)`, ['b'.repeat(64), '0x' + 'c'.repeat(64)])).rejects.toThrow();
    // A plain DELETE stays refused by 0016 (unchanged); the owner's purge of an unstarted run takes its authorization with it.
    await expect(t.db.query(`DELETE FROM execution_runs WHERE run_id = 'run-a'`)).rejects.toThrow('APPEND_ONLY_VIOLATION');
    await purge(t.db, 'run-a');
    expect((await t.db.query('SELECT count(*)::int AS n FROM platform_fee_authorizations')).rows[0]!.n).toBe(0);
  });

  it('a lock timeout rolls 0038 back completely', async () => {
    const { t, chain, m38 } = await schema37();
    const holder = t.open(1);
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE execution_runs IN ACCESS EXCLUSIVE MODE');
      await expect(migrate(t.db, [...chain, m38])).rejects.toThrow();
      await holder.query('ROLLBACK');
    } finally { await holder.close(); }
    expect((await t.db.query(`SELECT to_regclass('public.platform_fee_authorizations') IS NULL AS absent`)).rows[0]!.absent).toBe(true);
    expect((await t.db.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0]!.v).toBe(37);
    expect(await migrate(t.db, [...chain, m38])).toEqual([38]);
  });
});
