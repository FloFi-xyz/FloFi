// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001: the certified 0037 `execution_origins_platform_fees`, from its SHA-256-pinned file, on disposable
 * PostgreSQL. 0037 follows 0029–0036 (all certified for the v28 build) and adds three tables with their own non-SECURITY-DEFINER trigger functions;
 * nothing pre-existing changes. Proven here: the exact bytes and certificate; the v28 build serving schema 37 only through this certificate (the
 * certificate as it stood at 0036 refuses it); the catalog diff (three tables, three functions, three triggers, every pre-existing trigger and
 * function unchanged); origins written once and never updated; corrections append-only; the fee ledger's exactly-once keys, insert states,
 * compare-and-set transitions, immutable fields, "COLLECTED needs transactions" and retention of anything owed; an owner-deleted unstarted run
 * taking its origin with it; a lock timeout rolling 0037 back completely. Synthetic rows only.
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
const PREVIOUS: ForwardCompatibilityCertificate = { ...CERTIFICATE, migrations: CERTIFICATE.migrations.slice(0, 8) };
const opened: TestDatabase[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(t => t.drop())); });

async function forward(version: number): Promise<Migration> {
  const identity = CERTIFICATE.migrations.find(m => m.version === version)!;
  const sql = await readFile(forwardMigrationSqlUrl(identity), 'utf8');
  expect(sha(sql)).toBe(identity.sha256);
  return { ...identity, sql };
}
async function schema36(): Promise<{ t: TestDatabase; chain: Migration[]; m37: Migration }> {
  const t = await createTestDatabase({ migrated: false }); opened.push(t);
  const chain = [...(await loadMigrations()).slice(0, 28)];
  for (let v = 29; v <= 36; v++) chain.push(await forward(v));
  expect(await migrate(t.db, chain)).toHaveLength(36);
  return { t, chain, m37: await forward(37) };
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
/** Deletes a run exactly as the owner's purge procedure does: under a permit of the deleting transaction (0016). */
const purge = (db: Database, runId: string) => db.transaction(async tx => {
  await tx.query(`INSERT INTO execution_purge_audit (tenant_id, run_id, owner_account, namespace, log_name, log_sha256, log_version, segment_count, journal_count)
    VALUES ('default', $1, $2, 'runs', $1, $3, 1, 1, 0)`, [runId, '0x' + 'ab'.repeat(20), HEX('a')]);
  await tx.query(`INSERT INTO execution_purge_permits VALUES ('default', $1, 'runs', $1, txid_current())`, [runId]);
  await tx.query(`DELETE FROM execution_runs WHERE tenant_id = 'default' AND run_id = $1`, [runId]);
});
const LINE = JSON.stringify([{ chainId: 'eip155:1', address: '0x' + 'a0'.repeat(20), decimals: 6, principal: '100000000', fee: '800000' }]);

describe('certificate 0037_execution_origins_platform_fees', () => {
  it('pins 0037 in the base-28 certificate; the v28 build serves schema 37 only through it', async () => {
    expect(CERTIFICATE.migrations.map(m => [m.version, m.name]).at(-1)).toEqual([37, 'execution_origins_platform_fees']);
    expect(CERTIFICATE.assessment).toBe('docs/deploy/SCHEMA-COMPATIBILITY.md#29-certificate-0037_execution_origins_platform_fees');
    const { t, chain, m37 } = await schema36();
    const before = await catalog(t.db);
    expect(await migrate(t.db, [...chain, m37])).toEqual([37]);
    await expect(assertSchemaCompatible(t.db, V28)).resolves.toMatchObject({ version: 37, application: 28 });
    await expect(assertSchemaCompatible(t.db, V28, [PREVIOUS])).rejects.toThrow();
    const after = await catalog(t.db);
    expect(after.tables.filter(x => !before.tables.includes(x))).toEqual(['execution_origin_corrections', 'execution_origins', 'platform_fee_ledger']);
    expect(before.tables.filter(x => !after.tables.includes(x))).toEqual([]);
    expect(before.functions.every(f => after.functions.includes(f))).toBe(true);
    expect(after.functions.length - before.functions.length).toBe(3);
    expect(before.triggers.every(f => after.triggers.includes(f))).toBe(true);
    expect(after.triggers.length - before.triggers.length).toBe(3);
    // No SECURITY DEFINER routine: the least-privilege history-guard fingerprint is unchanged.
    expect(after.definers).toEqual(before.definers);
    expect(await migrate(t.db, [...chain, m37])).toEqual([]);
  });

  it('origins are written once and never updated; corrections are append-only; an owner-deleted run takes its origin with it', async () => {
    const { t, chain, m37 } = await schema36();
    await migrate(t.db, [...chain, m37]);
    await run(t.db, 'run-a');
    await t.db.query(`INSERT INTO execution_origins (tenant_id, run_id, origin, basis, evidence) VALUES ('default', 'run-a', 'web', 'CREATION', 'WEB_APP_SERVER_ACTION')`);
    const second = await t.db.query(`INSERT INTO execution_origins (tenant_id, run_id, origin, basis, evidence) VALUES ('default', 'run-a', 'mcp_chatgpt', 'APPROVAL_BINDING',
      'APPROVAL_RUN_BINDING') ON CONFLICT DO NOTHING`);
    expect(second.rowCount).toBe(0);
    await expect(t.db.query(`UPDATE execution_origins SET origin = 'telegram' WHERE run_id = 'run-a'`)).rejects.toThrow('EXECUTION_ORIGIN_IMMUTABLE');
    await expect(t.db.query(`INSERT INTO execution_origins (tenant_id, run_id, origin, basis, evidence) VALUES ('default', 'nope', 'web', 'CREATION', 'X_Y_Z')`)).rejects.toThrow();
    await expect(t.db.query(`INSERT INTO execution_origins (tenant_id, origin, basis, evidence) VALUES ('default', 'web', 'CREATION', 'X_Y_Z')`)).rejects.toThrow();
    await expect(t.db.query(`INSERT INTO execution_origins (tenant_id, run_id, origin, basis, evidence) VALUES ('default', 'run-a', 'whatsapp', 'CREATION', 'X_Y_Z')`))
      .rejects.toThrow();
    await t.db.query(`INSERT INTO execution_origin_corrections (tenant_id, correction_id, run_id, origin, previous_origin, approval_ref, reason_code)
      VALUES ('default', $1, 'run-a', 'legacy_web', 'web', 'KAN-25', 'OWNER_CONFIRMED')`, ['eoc_' + 'a'.repeat(26)]);
    await expect(t.db.query(`UPDATE execution_origin_corrections SET origin = 'web'`)).rejects.toThrow('EXECUTION_ORIGIN_CORRECTION_APPEND_ONLY');
    // A plain DELETE stays refused by 0016 (unchanged); the owner's purge takes the origin and its corrections with the run.
    await expect(t.db.query(`DELETE FROM execution_runs WHERE run_id = 'run-a'`)).rejects.toThrow('APPEND_ONLY_VIOLATION');
    await purge(t.db, 'run-a');
    expect((await t.db.query('SELECT count(*)::int AS n FROM execution_origins')).rows[0]!.n).toBe(0);
    expect((await t.db.query('SELECT count(*)::int AS n FROM execution_origin_corrections')).rows[0]!.n).toBe(0);
  });

  it('fee ledger: one row per execution, closed insert states, compare-and-set transitions, COLLECTED only with transactions, owed rows retained', async () => {
    const { t, chain, m37 } = await schema36();
    await migrate(t.db, [...chain, m37]);
    await run(t.db, 'run-f', 'RECONCILED');
    const insert = (state: string, lines = LINE, collection: string | null = null) => t.db.query(`INSERT INTO platform_fee_ledger (tenant_id, run_id, policy_id, rate_bps,
      state, lines, network_environment, collection) VALUES ('default', 'run-f', 'flofi-platform-fee/v2-80bps', 80, $1, $2::jsonb, 'MAINNET', $3::jsonb) ON CONFLICT DO NOTHING`,
      [state, lines, collection]);
    await expect(insert('COLLECTED', LINE, JSON.stringify({ transactions: [{ chain: 'eip155:1', hash: '0x' + '1'.repeat(64) }] }))).rejects.toThrow('PLATFORM_FEE_INSERT_INVALID');
    await expect(insert('COLLECTION_PENDING')).rejects.toThrow('PLATFORM_FEE_INSERT_INVALID');
    await expect(insert('DUE', '[]')).rejects.toThrow();
    expect((await insert('DUE')).rowCount).toBe(1);
    expect((await insert('DUE')).rowCount).toBe(0); // exactly once: a duplicate accrual changes nothing
    const move = (to: string, version: number, collection: string | null = null) => t.db.query(`UPDATE platform_fee_ledger SET state = $1, version = $2,
      collection = coalesce($3::jsonb, collection) WHERE run_id = 'run-f'`, [to, version, collection]);
    await expect(move('COLLECTED', 2, JSON.stringify({ transactions: [{ chain: 'eip155:1', hash: '0x' + '1'.repeat(64) }] }))).rejects.toThrow('PLATFORM_FEE_TRANSITION_INVALID');
    await expect(move('COLLECTION_PENDING', 5)).rejects.toThrow('PLATFORM_FEE_LEDGER_IMMUTABLE');
    await expect(t.db.query(`UPDATE platform_fee_ledger SET lines = '[]'::jsonb, version = 2 WHERE run_id = 'run-f'`)).rejects.toThrow();
    await move('COLLECTION_PENDING', 2);
    await expect(move('COLLECTED', 3)).rejects.toThrow(); // never collected without evidence
    await move('COLLECTION_FAILED', 3);
    await move('COLLECTION_PENDING', 4);
    await move('COLLECTED', 5, JSON.stringify({ transactions: [{ chain: 'eip155:1', hash: '0x' + '1'.repeat(64) }] }));
    await expect(move('COLLECTION_PENDING', 6)).rejects.toThrow('PLATFORM_FEE_TRANSITION_INVALID');
    await expect(t.db.query(`DELETE FROM platform_fee_ledger WHERE run_id = 'run-f'`)).rejects.toThrow('PLATFORM_FEE_LEDGER_RETAINED');
    await expect(purge(t.db, 'run-f')).rejects.toThrow('PLATFORM_FEE_LEDGER_RETAINED');
    // A waived row of an unstarted run follows the owner's deletion.
    await run(t.db, 'run-w');
    await t.db.query(`INSERT INTO platform_fee_ledger (tenant_id, run_id, policy_id, rate_bps, state, reason, lines, network_environment)
      VALUES ('default', 'run-w', 'flofi-platform-fee/v2-80bps', 80, 'WAIVED', 'WORKFLOW_CANCELLED', '[]'::jsonb, 'MAINNET')`);
    await purge(t.db, 'run-w');
    expect((await t.db.query(`SELECT count(*)::int AS n FROM platform_fee_ledger WHERE run_id = 'run-w'`)).rows[0]!.n).toBe(0);
  });

  it('a lock timeout rolls 0037 back completely (the database stays at schema 36)', async () => {
    const { t, chain, m37 } = await schema36();
    const before = await catalog(t.db);
    const holder = await t.db.transaction(async tx => {
      await tx.query('LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE');
      return migrate(t.db, [...chain, m37]).then(() => 'applied', (error: Error) => error.message);
    });
    expect(holder).toMatch(/lock timeout|canceling statement/i);
    expect(await catalog(t.db)).toEqual(before);
    expect((await t.db.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0]!.v).toBe(36);
  });

  it('the documented reversal restores the exact schema-36 catalog, only on 0037 as head, and refuses while any fee is recorded', async () => {
    const reversal = await readFile(new URL('../../../docs/deploy/RELEASE-REVENUE-ORIGINS-0037.reversal.sql', import.meta.url), 'utf8');
    const { t, chain, m37 } = await schema36();
    const before = await catalog(t.db);
    await expect(t.db.query(reversal)).rejects.toThrow('NOT_CERTIFIED_0037_HEAD');
    await t.db.query('ROLLBACK').catch(() => undefined);
    await migrate(t.db, [...chain, m37]);
    await run(t.db, 'run-r', 'RECONCILED');
    await t.db.query(`INSERT INTO platform_fee_ledger (tenant_id, run_id, policy_id, rate_bps, state, lines, network_environment)
      VALUES ('default', 'run-r', 'flofi-platform-fee/v2-80bps', 80, 'DUE', $1::jsonb, 'MAINNET')`, [LINE]);
    await expect(t.db.query(reversal)).rejects.toThrow('REVERSAL_REFUSED_FEES_RECORDED');
    await t.db.query('ROLLBACK').catch(() => undefined);
    expect((await t.db.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0]!.v).toBe(37);
    // Owed rows settled elsewhere (here: a disposable database, so the owner removes the test row directly with the trigger off).
    await t.db.query('ALTER TABLE platform_fee_ledger DISABLE TRIGGER platform_fee_transition');
    await t.db.query('DELETE FROM platform_fee_ledger');
    await t.db.query(reversal);
    expect((await t.db.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0]!.v).toBe(36);
    const after = await catalog(t.db);
    expect(after.tables).toEqual(before.tables);
    expect(after.functions).toEqual(before.functions);
    expect(after.triggers).toEqual(before.triggers);
    expect(await migrate(t.db, [...chain, m37])).toEqual([37]);
  });
});
