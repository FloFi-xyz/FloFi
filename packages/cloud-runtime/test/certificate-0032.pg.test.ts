// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the certified 0032 `single_step_runs`, from its SHA-256-pinned fixture, on disposable PostgreSQL.
 * 0032 follows the optional 0029/0030 (FinOps) and 0031 (position-history purge), all certified for the v28 build, and widens only 0015's
 * `workflow_runs_step_count_check` from 2..8 to 1..8, so the Editor can run one financial card as a one-step user-funded workflow run. Proven here:
 * the exact bytes and certificate; the v28 build serving schema 32 only through this certificate (the previous certificate, which stops at 0031,
 * refuses it); a catalog diff of exactly one changed constraint; every pre-existing workflow-run row surviving; a one-step run refused at schema 31
 * and accepted (and driven through 0015's unchanged trigger) at schema 32, with 0 and 9 steps still refused; a failing 0032 and a lock timeout
 * rolling back completely; and the documented emergency reversal (only while no one-step run exists) restoring the exact schema-31 catalog.
 * Synthetic rows only; the operator command is proven by `apps/reference-dapp/backend/single-step-runs-migrate.pg.test.ts`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, CERTIFIED_FORWARD_MIGRATIONS, loadMigrations, migrate, SHIPPED_MIGRATIONS, type Database,
  type ForwardCompatibilityCertificate, type Migration } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from './pg-harness.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const CERTIFICATE = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
const V28 = SHIPPED_MIGRATIONS.slice(0, 28);
/** The certificate main carried before this build (BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001): 0029–0031 only. A build with it must refuse schema 32. */
const PREVIOUS: ForwardCompatibilityCertificate = { ...CERTIFICATE, migrations: CERTIFICATE.migrations.slice(0, 3) };
const BEFORE = 'CHECK (((step_count >= 2) AND (step_count <= 8)))', AFTER = 'CHECK (((step_count >= 1) AND (step_count <= 8)))';
const HASH = '0x' + '1'.repeat(64), OWNER = '0x' + 'ab'.repeat(20);
const opened: TestDatabase[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(t => t.drop())); });

async function fixture(version: number): Promise<Migration> {
  const identity = CERTIFICATE.migrations.find(m => m.version === version)!;
  const sql = await readFile(new URL(`./fixtures/${String(version).padStart(4, '0')}_${identity.name}.sql`, import.meta.url), 'utf8');
  expect(sha(sql)).toBe(identity.sha256);
  return { ...identity, sql };
}
/** A database exactly at schema 31: the v28 build's history plus the certified 0029–0031, as their own operator commands apply them. */
async function schema31(): Promise<{ t: TestDatabase; v31: Migration[]; m32: Migration }> {
  const t = await createTestDatabase({ migrated: false }); opened.push(t);
  const v31 = [...(await loadMigrations()).slice(0, 28), await fixture(29), await fixture(30), await fixture(31)];
  expect(await migrate(t.db, v31)).toHaveLength(31);
  return { t, v31, m32: await fixture(32) };
}
async function catalog(db: Database) {
  const q = async (sql: string) => (await db.query<{ item: string }>(sql)).rows.map(r => r.item).sort();
  return {
    columns: await q(`SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS item
      FROM information_schema.columns WHERE table_schema = 'public'`),
    constraints: await q(`SELECT conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) || ':' || convalidated AS item FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace`),
    indexes: await q(`SELECT tablename || ':' || indexname || ':' || indexdef AS item FROM pg_indexes WHERE schemaname = 'public'`),
    functions: await q(`SELECT p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(array_to_string(p.proacl, ','), 'default') AS item
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`),
    triggers: await q(`SELECT tgrelid::regclass::text || ':' || tgname || ':' || md5(pg_get_triggerdef(oid)) AS item FROM pg_trigger WHERE NOT tgisinternal`),
    privileges: await q(`SELECT table_name || ':' || grantee || ':' || privilege_type AS item FROM information_schema.role_table_grants WHERE table_schema = 'public'`),
  };
}
const stepCountCheck = async (db: Database) => (await db.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
  WHERE conrelid = 'workflow_runs'::regclass AND conname = 'workflow_runs_step_count_check'`)).rows.map(r => r.def);
const head = async (db: Database) => (await db.query<{ version: number }>('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]!.version;
const failure = (work: Promise<unknown>) => work.then(() => null, (error: Error) => error.message);
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex').slice(0, 26).replace(/[0189]/g, 'a')}`;

/** The parent approval handoff a workflow run needs (0005/0006/0022 columns), for the seeded `default` tenant. */
async function handoff(db: Database): Promise<string> {
  const handoffId = id('apr');
  await db.query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind, requester_id, account_id, client_id, client_name, secret_digest, strategy,
      workflow_hash, engine_version, network_environment, funds_class, plan, status, expires_at)
    VALUES ('default', $1, 'EDITOR_SESSION', $2, NULL, 'flofi-editor', 'Editor', $3, '{}', $4, 'flofi-engine-2', 'MAINNET', 'REAL_FUNDS',
      '{"kind":"SEQUENTIAL"}', 'PENDING', now() + interval '1 hour')`, [handoffId, 'acct_' + 'a'.repeat(32), randomBytes(32), HASH]);
  return handoffId;
}
/** A PENDING workflow run of `steps` steps with its step rows (0015), exactly as the workflow-run store creates one. */
async function run(db: Database, steps: number): Promise<string> {
  const runId = id('wfr');
  await db.query(`INSERT INTO workflow_runs (tenant_id, run_id, handoff_id, requester_kind, requester_ref, owner_namespace, owner_account, wallets, strategy, workflow_hash,
      engine_version, step_count, state, expires_at)
    VALUES ('default', $1, $2, 'EDITOR_SESSION', $3, 'eip155', $4, $5::jsonb, '{}', $6, 'flofi-engine-2', $7, 'PENDING', now() + interval '1 day')`,
  [runId, await handoff(db), 'acct_' + 'a'.repeat(32), OWNER, JSON.stringify({ eip155: OWNER }), HASH, steps]);
  for (let i = 0; i < Math.min(steps, 8); i++)
    await db.query(`INSERT INTO workflow_run_steps (tenant_id, run_id, step_index, state) VALUES ('default', $1, $2, 'PENDING')`, [runId, i]);
  return runId;
}
const snapshot = async (db: Database) => ({ runs: (await db.query('SELECT * FROM workflow_runs ORDER BY run_id')).rows,
  steps: (await db.query('SELECT * FROM workflow_run_steps ORDER BY run_id, step_index')).rows,
  groups: (await db.query('SELECT * FROM workflow_run_groups ORDER BY run_id, group_index')).rows });
/** The emergency reversal exactly as documented (the fenced SQL block of the release document). */
async function reversal(): Promise<string> {
  const doc = await readFile(new URL('../../../docs/deploy/RELEASE-SINGLE-STEP-RUNS-0032.md', import.meta.url), 'utf8');
  const start = doc.indexOf('```sql\n-- Emergency reversal of 0032_single_step_runs');
  expect(start).toBeGreaterThan(0);
  const body = doc.slice(start + '```sql\n'.length, doc.indexOf('\n```', start + 1));
  expect(body.split('\n').filter(line => line.startsWith('ALTER TABLE') || line.startsWith('DELETE'))).toHaveLength(2);
  return body;
}
/** Runs the reversal on its own connection; a refusal leaves that connection's transaction aborted, so it is rolled back. */
async function reverse(t: TestDatabase): Promise<string | null> {
  const connection = t.open(1), sql = await reversal();
  const refused = await failure(connection.query(sql));
  if (refused) await connection.query('ROLLBACK');
  await connection.close();
  return refused;
}

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: certificate for 0032 single_step_runs (v28 build, PostgreSQL)', { timeout: 120_000 }, () => {
  it('certifies the exact fixture bytes after 0029–0031 for the v28 build; 0015 stays immutable and the migration stays a fixture', async () => {
    expect(CERTIFICATE.base).toEqual(V28[27]);
    // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion, intentional): the same certificate was extended with 0033 (its assessment
    // anchor moved to §25, which keeps §24); 0029–0032 keep their exact identities and order (certificate-0033.pg.test.ts).
    expect(CERTIFICATE.migrations.map(m => [m.version, m.name])).toEqual([[29, 'finops_ledger'], [30, 'finops_sync'], [31, 'position_history_purge'],
      [32, 'single_step_runs'], [33, 'workflow_run_purge'], [34, 'developer_project_ownership'], [35, 'studio_integrations']]);
    expect(CERTIFICATE.assessment).toBe('docs/deploy/SCHEMA-COMPATIBILITY.md#27-certificate-0035_studio_integrations');
    expect((await fixture(32)).sha256).toBe('1f388788b8e788fcc412585b38569260acea1e1cb24ec2cab3f2208270e5d14c');
    // 0015, which created the constraint, is immutable and unchanged; 0032 is not shipped by this build.
    expect(SHIPPED_MIGRATIONS.find(m => m.version === 15)!.sha256).toBe('5dfefcf7465d874da5880ae5a082f7f47e28ede51adfdef46dbbe3e3f7ba945f');
    expect(sha(await readFile(new URL('../migrations/0015_workflow_runs.sql', import.meta.url), 'utf8'))).toBe(SHIPPED_MIGRATIONS[14]!.sha256);
    expect(SHIPPED_MIGRATIONS.some(m => m.version === 32 || m.name === 'single_step_runs')).toBe(false);
    for (const certified of CERTIFICATE.migrations) {
      const shipped = SHIPPED_MIGRATIONS.find(m => m.version === certified.version);
      if (shipped) expect(shipped).toEqual(certified);
    }
    // The only statements: the lock timeout and one ALTER TABLE that drops and re-adds the same constraint, widened to 1..8.
    const sql = (await fixture(32)).sql;
    expect(sql.match(/^(CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|SET|TRUNCATE|COMMENT| {2}DROP| {2}ADD)\b[^\n]*/gm)).toEqual([
      "SET LOCAL lock_timeout = '5s';",
      'ALTER TABLE workflow_runs',
      '  DROP CONSTRAINT workflow_runs_step_count_check,',
      '  ADD CONSTRAINT workflow_runs_step_count_check CHECK (step_count BETWEEN 1 AND 8);']);
    expect(sql.split('\n').filter(line => line && !line.startsWith('--'))).toHaveLength(4);
    // 0015 defined exactly the constraint 0032 replaces.
    const original = await readFile(new URL('../migrations/0015_workflow_runs.sql', import.meta.url), 'utf8');
    expect(original).toContain('step_count integer NOT NULL CHECK (step_count BETWEEN 2 AND 8),');
  });

  it('serves schema 32 for the v28 build only through this certificate; the catalog diff is the one constraint; rows survive; reruns change nothing', async () => {
    const { t, v31, m32 } = await schema31();
    // Rows of every shape a pre-0032 build writes: 2, 3 and 8 steps; pending, confirm-each-step and user-funded with a group.
    const two = await run(t.db, 2), three = await run(t.db, 3), eight = await run(t.db, 8);
    await t.db.query(`UPDATE workflow_runs SET mode = 'CONFIRM_EACH_STEP', state = 'RUNNING', version = version + 1 WHERE run_id = $1`, [three]);
    await t.db.query(`UPDATE workflow_runs SET mode = 'USER_FUNDED', state = 'RUNNING', version = version + 1 WHERE run_id = $1`, [two]);
    await t.db.query(`INSERT INTO workflow_run_groups (tenant_id, run_id, group_index, namespace, chain, fee_payer, step_from, step_to, strategy, signing, state)
      VALUES ('default', $1, 0, 'eip155', 'eip155:8453', $2, 0, 1, 'EVM_WALLET_BATCH', 'UPFRONT', 'PLANNED')`, [two, OWNER]);
    expect(eight).toMatch(/^wfr_/);
    const before = await catalog(t.db), rows = await snapshot(t.db);
    expect(await stepCountCheck(t.db)).toEqual([BEFORE]);

    expect(await migrate(t.db, [...v31, m32])).toEqual([32]);
    expect(await migrate(t.db, [...v31, m32])).toEqual([]);
    const after = await catalog(t.db);
    expect({ ...after, constraints: undefined }).toEqual({ ...before, constraints: undefined });
    const added = after.constraints.filter(c => !before.constraints.includes(c)), removed = before.constraints.filter(c => !after.constraints.includes(c));
    expect(removed).toEqual([`workflow_runs:workflow_runs_step_count_check:${BEFORE}:true`]);
    expect(added).toEqual([`workflow_runs:workflow_runs_step_count_check:${AFTER}:true`]);
    expect(await stepCountCheck(t.db)).toEqual([AFTER]);
    expect(await snapshot(t.db)).toEqual(rows);

    // The v28 build serves 32 through this certificate; the previous certificate (0029–0031 only) and a strict check refuse it.
    expect(await assertSchemaCompatible(t.db, V28)).toMatchObject({ version: 32, application: 28,
      forward: CERTIFICATE.migrations.slice(0, 4).map(m => ({ version: m.version })) });
    await expect(assertSchemaCompatible(t.db, V28, [PREVIOUS])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    await expect(assertSchemaCompatible(t.db, V28, [])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    await expect(assertSchemaCurrent(t.db, V28)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    // The v28 runner (its deploy step) never changes a database ahead of it.
    expect(await migrate(t.db, (await loadMigrations()).slice(0, 28))).toEqual([]);
    // An edited 0032 is refused, never re-applied.
    await expect(migrate(t.db, [...v31, { ...m32, sql: m32.sql + '\n', sha256: sha(m32.sql + '\n') }])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    expect(await head(t.db)).toBe(32);
  });

  it('refuses a one-step run at schema 31 and accepts it at schema 32; 0 and 9 steps stay refused; 0015’s trigger keeps a one-step run in bounds', async () => {
    const { t, v31, m32 } = await schema31();
    // Schema 31: the database refuses a one-step run (the Editor keeps its own single-card flow until 0032 is active).
    expect(await failure(run(t.db, 1))).toMatch(/violates check constraint "workflow_runs_step_count_check"/);
    expect(await migrate(t.db, [...v31, m32])).toEqual([32]);
    for (const steps of [0, 9, -1]) expect(await failure(run(t.db, steps)), String(steps)).toMatch(/violates check constraint "workflow_runs_step_count_check"/);
    const single = await run(t.db, 1);
    expect((await t.db.query(`SELECT step_count, current_step, state FROM workflow_runs WHERE run_id = $1`, [single])).rows)
      .toEqual([{ step_count: 1, current_step: 0, state: 'PENDING' }]);
    // One user-funded group covering the single step; the owner's own wallet pays (0023's S1 trigger, unchanged).
    await t.db.query(`UPDATE workflow_runs SET mode = 'USER_FUNDED', state = 'RUNNING', version = version + 1 WHERE run_id = $1`, [single]);
    await t.db.query(`INSERT INTO workflow_run_groups (tenant_id, run_id, group_index, namespace, chain, fee_payer, step_from, step_to, strategy, signing, state)
      VALUES ('default', $1, 0, 'eip155', 'eip155:8453', $2, 0, 0, 'EVM_WALLET_BATCH', 'UPFRONT', 'PLANNED')`, [single, OWNER]);
    // 0015's transition trigger, untouched: the only step is index 0, so current_step can never advance past it.
    expect(await failure(t.db.query(`UPDATE workflow_runs SET current_step = 1, version = version + 1 WHERE run_id = $1`, [single]))).toBe('WORKFLOW_RUN_IMMUTABLE');
    expect(await failure(t.db.query(`UPDATE workflow_runs SET step_count = 2, version = version + 1 WHERE run_id = $1`, [single]))).toBe('WORKFLOW_RUN_IMMUTABLE');
    await t.db.query(`UPDATE workflow_run_steps SET state = 'DELEGATED', version = version + 1 WHERE run_id = $1 AND step_index = 0`, [single]);
    await t.db.query(`UPDATE workflow_run_steps SET state = 'RECONCILED', outcome = '{"status":"RECONCILED"}', strategy = '{}', workflow_hash = $2,
      version = version + 1 WHERE run_id = $1 AND step_index = 0`, [single, HASH]);
    await t.db.query(`UPDATE workflow_runs SET state = 'COMPLETED', completed_at = now(), version = version + 1 WHERE run_id = $1`, [single]);
    expect((await t.db.query(`SELECT step_count, current_step, state FROM workflow_runs WHERE run_id = $1`, [single])).rows)
      .toEqual([{ step_count: 1, current_step: 0, state: 'COMPLETED' }]);
    expect(await failure(t.db.query('DELETE FROM workflow_runs WHERE run_id = $1', [single]))).toBe('WORKFLOW_RUN_RECORD_APPEND_ONLY');
  });

  it('a failing 0032 and a lock timeout roll back completely, leaving the exact schema-31 catalog', async () => {
    const { t, v31, m32 } = await schema31();
    await run(t.db, 2);
    const before = await catalog(t.db), rows = await snapshot(t.db);
    const broken = m32.sql + '\nSELECT 1/0;';
    await expect(migrate(t.db, [...v31, { ...m32, sql: broken, sha256: sha(broken) }])).rejects.toThrow();
    expect(await head(t.db)).toBe(31);
    expect(await catalog(t.db)).toEqual(before);
    // A reader holding workflow_runs in an open transaction: 0032's ALTER waits at most 5 s for ACCESS EXCLUSIVE, then rolls back completely.
    const blocker = t.open(1);
    await blocker.query('BEGIN');
    await blocker.query('SELECT count(*) FROM workflow_runs');
    const started = Date.now();
    await expect(migrate(t.db, [...v31, m32])).rejects.toThrow(/lock timeout|canceling statement/);
    expect(Date.now() - started).toBeLessThan(25_000);
    await blocker.query('ROLLBACK');
    expect(await head(t.db)).toBe(31);
    expect(await catalog(t.db)).toEqual(before);
    expect(await snapshot(t.db)).toEqual(rows);
    expect(await stepCountCheck(t.db)).toEqual([BEFORE]);
    // Retried in a quiet moment, it applies.
    expect(await migrate(t.db, [...v31, m32])).toEqual([32]);
  });

  it('the documented emergency reversal restores the exact schema-31 catalog only while no one-step run exists, and only on 0032 as head', async () => {
    const { t, v31, m32 } = await schema31();
    await run(t.db, 3);
    const before = await catalog(t.db);
    expect(await migrate(t.db, [...v31, m32])).toEqual([32]);
    expect(await reverse(t)).toBeNull();
    expect(await catalog(t.db)).toEqual(before);
    expect(await head(t.db)).toBe(31);
    expect(await stepCountCheck(t.db)).toEqual([BEFORE]);
    // The build before this one (certificate through 0031) serves the database again, and a one-step run is refused again.
    expect(await assertSchemaCompatible(t.db, V28, [PREVIOUS])).toMatchObject({ version: 31, application: 28 });
    expect(await failure(run(t.db, 1))).toMatch(/workflow_runs_step_count_check/);
    // It refuses to run anywhere 0032 is not the newest migration.
    expect(await reverse(t)).toBe('NOT_CERTIFIED_0032_HEAD');
    expect(await catalog(t.db)).toEqual(before);

    // Re-activated, then a one-step run exists: the reversal refuses and changes nothing (runs are never deleted).
    expect(await migrate(t.db, [...v31, m32])).toEqual([32]);
    const single = await run(t.db, 1);
    expect(await reverse(t)).toBe('SINGLE_STEP_RUNS_PRESENT');
    expect(await head(t.db)).toBe(32);
    expect(await stepCountCheck(t.db)).toEqual([AFTER]);
    expect((await t.db.query('SELECT step_count FROM workflow_runs WHERE run_id = $1', [single])).rows).toEqual([{ step_count: 1 }]);
    expect(await assertSchemaCompatible(t.db, V28)).toMatchObject({ version: 32, application: 28 });
  });
});
