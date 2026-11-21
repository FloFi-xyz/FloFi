// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): the certified 0033 `workflow_run_purge`, from its SHA-256-pinned fixture, on
 * disposable PostgreSQL. 0033 follows 0029–0032 (all certified for the v28 build) and adds a tombstone, a private permit table and the checked
 * procedure `purge_unsubmitted_workflow_run`, and redefines only the body of 0015's `workflow_run_append_only` (the same refusal; a DELETE passes
 * only under that procedure's permit). Proven here: the exact bytes, statements and certificate; the v28 build serving schema 33 only through
 * this certificate (the previous certificate, which stops at 0032, refuses it); the exact catalog diff (two tables with their constraints and
 * indexes, one trigger on the tombstone, one new and one redefined function, every pre-existing trigger unchanged); every pre-existing row
 * surviving; plain DELETE on each workflow-run table and UPDATE of an event still refused with 0015's error; a permit of another transaction or
 * another run unlocking nothing; no permit left behind; a failing 0033 and a lock timeout rolling back completely; and the documented reversal
 * restoring the exact schema-32 catalog only while no attempt was deleted, only on 0033 as head (the 0032 reversal refuses while 0033 is
 * head). With a separate runtime role holding production's default privileges, the runtime-role provisioning file
 * (`docs/deploy/RELEASE-WORKFLOW-RUN-PURGE-0033.runtime-privileges.sql`) and its documented verification: without it the runtime role can forge a
 * permit and delete any run's rows and cannot call the procedure; with it, neither, and the procedure deletes as the runtime role. Synthetic rows
 * only; the owner-facing behaviour is proven by `apps/reference-dapp/backend/owner-history.pg.test.ts` and the operator command by
 * `apps/reference-dapp/backend/workflow-run-purge-migrate.pg.test.ts`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, CERTIFIED_FORWARD_MIGRATIONS, createDatabase, loadMigrations, migrate, SHIPPED_MIGRATIONS,
  type Database, type ForwardCompatibilityCertificate, type Migration } from '../src/index.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './pg-harness.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const CERTIFICATE = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
const V28 = SHIPPED_MIGRATIONS.slice(0, 28);
/** The certificate before this change (0029–0032). A build carrying only it must refuse schema 33. */
const PREVIOUS: ForwardCompatibilityCertificate = { ...CERTIFICATE, migrations: CERTIFICATE.migrations.slice(0, 4) };
const SHA_0033 = '26b8a6dbf15dddbca24924e10bf8748748691c400fcb0c70e1d63038607be2c2';
const HASH = '0x' + '1'.repeat(64), OWNER = '0x' + 'ab'.repeat(20), ACCOUNT = 'acct_' + 'a'.repeat(32);
const APPEND_ONLY = 'WORKFLOW_RUN_RECORD_APPEND_ONLY';
const opened: TestDatabase[] = [];
/** Cluster-wide test roles, dropped after the databases that hold their privileges. */
const roles: string[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map(t => t.drop()));
  if (!roles.length) return;
  const admin = createDatabase({ connectionString: testDatabaseUrl().toString(), maxConnections: 1 });
  try { for (const role of roles.splice(0)) await admin.query(`DROP ROLE IF EXISTS ${role}`); } finally { await admin.close(); }
});

async function fixture(version: number): Promise<Migration> {
  const identity = CERTIFICATE.migrations.find(m => m.version === version)!;
  const sql = await readFile(new URL(`./fixtures/${String(version).padStart(4, '0')}_${identity.name}.sql`, import.meta.url), 'utf8');
  expect(sha(sql)).toBe(identity.sha256);
  return { ...identity, sql };
}
/** A database exactly at schema 32: the v28 build's history plus the certified 0029–0032, as their own operator commands apply them. */
async function schema32(): Promise<{ t: TestDatabase; v32: Migration[]; m33: Migration }> {
  const t = await createTestDatabase({ migrated: false }); opened.push(t);
  const v32 = [...(await loadMigrations()).slice(0, 28), await fixture(29), await fixture(30), await fixture(31), await fixture(32)];
  expect(await migrate(t.db, v32)).toHaveLength(32);
  return { t, v32, m33: await fixture(33) };
}
/** The catalog the v28 build depends on. NOT NULL constraints (PostgreSQL 18 records them) are compared through the columns instead. */
async function catalog(db: Database) {
  const q = async (sql: string) => (await db.query<{ item: string }>(sql)).rows.map(r => r.item).sort();
  return {
    tables: await q(`SELECT tablename AS item FROM pg_tables WHERE schemaname = 'public'`),
    columns: await q(`SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS item
      FROM information_schema.columns WHERE table_schema = 'public'`),
    constraints: await q(`SELECT conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) || ':' || convalidated AS item FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND contype <> 'n'`),
    indexes: await q(`SELECT tablename || ':' || indexname || ':' || indexdef AS item FROM pg_indexes WHERE schemaname = 'public'`),
    functions: await q(`SELECT p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(array_to_string(p.proacl, ','), 'default') AS item
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`),
    triggers: await q(`SELECT tgrelid::regclass::text || ':' || tgname || ':' || md5(pg_get_triggerdef(oid)) AS item FROM pg_trigger WHERE NOT tgisinternal`),
    privileges: await q(`SELECT table_name || ':' || grantee || ':' || privilege_type AS item FROM information_schema.role_table_grants WHERE table_schema = 'public'`),
  };
}
const head = async (db: Database) => (await db.query<{ version: number }>('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]!.version;
const failure = (work: Promise<unknown>) => work.then(() => null, (error: Error & { code?: string }) => `${error.code ?? ''}:${error.message}`);
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex').slice(0, 26).replace(/[0189]/g, 'a')}`;
const appendOnlyFunction = async (db: Database) => (await db.query<{ md5: string; secdef: boolean; config: string[] | null }>(`SELECT
  md5(pg_get_functiondef('workflow_run_append_only()'::regprocedure)) AS md5, prosecdef AS secdef, proconfig AS config FROM pg_proc
  WHERE oid = 'workflow_run_append_only()'::regprocedure`)).rows[0]!;

/** An Editor approval handoff the owner claimed (0005/0006/0022 columns), for the seeded `default` tenant. */
async function handoff(db: Database): Promise<string> {
  const handoffId = id('apr');
  await db.query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind, requester_id, account_id, client_id, client_name, secret_digest, strategy,
      workflow_hash, engine_version, network_environment, funds_class, plan, status, claimed_namespace, claimed_address, claimed_at, claim_expires_at, expires_at)
    VALUES ('default', $1, 'EDITOR_SESSION', $2, NULL, 'flofi-editor', 'Editor', $3, '{}', $4, 'flofi-engine-2', 'MAINNET', 'REAL_FUNDS',
      '{"kind":"SEQUENTIAL"}', 'CLAIMED', 'eip155', $5, now(), now() + interval '1 hour', now() + interval '1 hour')`, [handoffId, ACCOUNT, randomBytes(32), HASH, OWNER]);
  return handoffId;
}
/**
 * A workflow run of `steps` steps with its step rows and creation event, exactly as the workflow-run store writes them. `cancelled`: then ended
 * by its owner before choosing a mode, again exactly as the store's cancellation writes it (the deletable NO_WALLET_REQUEST shape).
 */
async function run(db: Database, steps: number, cancelled = false): Promise<string> {
  const runId = id('wfr');
  await db.query(`INSERT INTO workflow_runs (tenant_id, run_id, handoff_id, requester_kind, requester_ref, owner_namespace, owner_account, wallets, strategy, workflow_hash,
      engine_version, step_count, state, expires_at)
    VALUES ('default', $1, $2, 'EDITOR_SESSION', $3, 'eip155', $4, $5::jsonb, '{}', $6, 'flofi-engine-2', $7, 'PENDING', now() + interval '1 day')`,
  [runId, await handoff(db), ACCOUNT, OWNER, JSON.stringify({ eip155: OWNER }), HASH, steps]);
  for (let i = 0; i < steps; i++)
    await db.query(`INSERT INTO workflow_run_steps (tenant_id, run_id, step_index, state) VALUES ('default', $1, $2, 'PENDING')`, [runId, i]);
  await db.query(`INSERT INTO workflow_run_events (tenant_id, run_id, step_index, kind, detail) VALUES ('default', $1, NULL, 'RUN_CREATED', $2::jsonb)`,
    [runId, JSON.stringify({ stepCount: steps, workflowHash: HASH })]);
  if (cancelled) {
    await db.query(`UPDATE workflow_runs SET state = 'CANCELLED', code = 'OWNER_CANCELLED', version = version + 1 WHERE run_id = $1`, [runId]);
    for (let i = 0; i < steps; i++) {
      await db.query(`UPDATE workflow_run_steps SET state = 'SKIPPED', code = 'OWNER_CANCELLED', version = version + 1 WHERE run_id = $1 AND step_index = $2`, [runId, i]);
      await db.query(`INSERT INTO workflow_run_events (tenant_id, run_id, step_index, kind, code, detail) VALUES ('default', $1, $2, 'STEP_STATE', 'OWNER_CANCELLED',
        '{"state":"SKIPPED"}')`, [runId, i]);
    }
    await db.query(`INSERT INTO workflow_run_events (tenant_id, run_id, step_index, kind, code, detail) VALUES ('default', $1, NULL, 'RUN_CANCELLED', 'OWNER_CANCELLED',
      '{"state":"CANCELLED"}')`, [runId]);
  }
  return runId;
}
const purge = async (db: Database, runId: string, owner = OWNER) =>
  (await db.query<{ result: unknown }>('SELECT purge_unsubmitted_workflow_run($1, $2, $3) AS result', ['default', owner, runId])).rows[0]!.result;
const snapshot = async (db: Database) => ({ runs: (await db.query('SELECT * FROM workflow_runs ORDER BY run_id')).rows,
  steps: (await db.query('SELECT * FROM workflow_run_steps ORDER BY run_id, step_index')).rows,
  events: (await db.query('SELECT * FROM workflow_run_events ORDER BY event_id')).rows,
  groups: (await db.query('SELECT * FROM workflow_run_groups ORDER BY run_id, group_index')).rows,
  handoffs: (await db.query('SELECT handoff_id, status FROM mcp_handoffs ORDER BY handoff_id')).rows });
/** Runs a reversal script on its own connection; a refusal leaves that connection's transaction aborted, so it is rolled back. */
async function reverse(t: TestDatabase, sql: string): Promise<string | null> {
  const connection = t.open(1);
  const refused = await connection.query(sql).then(() => null, (error: Error) => error.message);
  if (refused) await connection.query('ROLLBACK');
  await connection.close();
  return refused;
}
const reversal0033 = () => readFile(new URL('../../../docs/deploy/RELEASE-WORKFLOW-RUN-PURGE-0033.reversal.sql', import.meta.url), 'utf8');
/** The 0032 emergency reversal exactly as documented (the fenced SQL block of its release document). */
async function reversal0032(): Promise<string> {
  const doc = await readFile(new URL('../../../docs/deploy/RELEASE-SINGLE-STEP-RUNS-0032.md', import.meta.url), 'utf8');
  const start = doc.indexOf('```sql\n-- Emergency reversal of 0032_single_step_runs');
  expect(start).toBeGreaterThan(0);
  return doc.slice(start + '```sql\n'.length, doc.indexOf('\n```', start + 1));
}
/** The runtime-role provisioning file, with the identifier psql substitutes for `:"runtime_role"` (`-v runtime_role=<role>`). */
async function runtimePrivileges(role: string): Promise<string> {
  const sql = await readFile(new URL('../../../docs/deploy/RELEASE-WORKFLOW-RUN-PURGE-0033.runtime-privileges.sql', import.meta.url), 'utf8');
  expect(sql.match(/:"runtime_role"/g)).toHaveLength(4);
  expect(sql.match(new RegExp(SHA_0033, 'g'))).toHaveLength(1);
  return sql.replaceAll(':"runtime_role"', `"${role}"`);
}
/** The runtime-role verification query exactly as documented (the fenced SQL block of the release document), for `:'runtime_role'`. */
async function runtimeVerification(role: string): Promise<string> {
  const doc = await readFile(new URL('../../../docs/deploy/RELEASE-WORKFLOW-RUN-PURGE-0033.md', import.meta.url), 'utf8');
  const start = doc.indexOf('```sql\n-- Runtime-role verification of 0033');
  expect(start).toBeGreaterThan(0);
  const sql = doc.slice(start + '```sql\n'.length, doc.indexOf('\n```', start + 1));
  expect(sql.match(/:'runtime_role'/g)).toHaveLength(4);
  return sql.replaceAll(":'runtime_role'", `'${role}'`);
}

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: certificate for 0033 workflow_run_purge (v28 build, PostgreSQL)', { timeout: 120_000 }, () => {
  it('certifies the exact fixture bytes after 0029–0032 for the v28 build; 0015/0016/0023 stay immutable and the migration stays a fixture', async () => {
    expect(CERTIFICATE.base).toEqual(V28[27]);
    expect(CERTIFICATE.migrations.map(m => [m.version, m.name])).toEqual([[29, 'finops_ledger'], [30, 'finops_sync'], [31, 'position_history_purge'],
      [32, 'single_step_runs'], [33, 'workflow_run_purge']]);
    expect(CERTIFICATE.assessment).toBe('docs/deploy/SCHEMA-COMPATIBILITY.md#25-certificate-0033_workflow_run_purge');
    const m33 = await fixture(33);
    expect(m33.sha256).toBe(SHA_0033);
    expect(SHIPPED_MIGRATIONS.some(m => m.version === 33 || m.name === 'workflow_run_purge')).toBe(false);
    for (const version of [15, 16, 23]) {
      const shipped = SHIPPED_MIGRATIONS[version - 1]!;
      expect(sha(await readFile(new URL(`../migrations/${String(version).padStart(4, '0')}_${shipped.name}.sql`, import.meta.url), 'utf8'))).toBe(shipped.sha256);
    }
    // Top-level statements only: two tables, one trigger on the tombstone, the privilege revocations, one redefined and one new function.
    expect(m33.sql.match(/^(CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|SET|TRUNCATE|COMMENT)\b[^\n]*/gm)).toEqual([
      "SET LOCAL lock_timeout = '5s';",
      'CREATE TABLE workflow_run_purge_audit (',
      'CREATE TRIGGER workflow_run_purge_audit_immutable BEFORE UPDATE OR DELETE ON workflow_run_purge_audit',
      'CREATE TABLE workflow_run_purge_permits (',
      'REVOKE ALL ON workflow_run_purge_permits, workflow_run_purge_audit FROM PUBLIC;',
      'CREATE OR REPLACE FUNCTION workflow_run_append_only() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$',
      'CREATE FUNCTION purge_unsubmitted_workflow_run(p_tenant text, p_owner text, p_id text) RETURNS jsonb',
      'REVOKE ALL ON FUNCTION purge_unsubmitted_workflow_run(text, text, text) FROM PUBLIC;']);
    // The redefined function keeps 0015's exact refusal (message and SQLSTATE); 0015 defined it, and its four triggers, exactly so.
    const original = await readFile(new URL('../migrations/0015_workflow_runs.sql', import.meta.url), 'utf8');
    const raise = "  RAISE EXCEPTION 'WORKFLOW_RUN_RECORD_APPEND_ONLY' USING ERRCODE = 'integrity_constraint_violation';";
    expect(original).toContain(`CREATE FUNCTION workflow_run_append_only() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n${raise}\nEND;\n$$;`);
    expect(m33.sql).toContain(`  END IF;\n${raise}\nEND;\n$$;`);
    expect(original.match(/EXECUTE FUNCTION workflow_run_append_only\(\)/g)).toHaveLength(3);
    expect((await readFile(new URL('../migrations/0023_user_funded_groups.sql', import.meta.url), 'utf8')).match(/EXECUTE FUNCTION workflow_run_append_only\(\)/g)).toHaveLength(1);
    // The documented reversal names this exact identity.
    expect((await reversal0033()).match(new RegExp(SHA_0033, 'g'))).toHaveLength(2);
  });

  it('serves schema 33 for the v28 build only through this certificate; the catalog diff is exact; rows survive; reruns change nothing', async () => {
    const { t, v32, m33 } = await schema32();
    const two = await run(t.db, 2), single = await run(t.db, 1), cancelled = await run(t.db, 1, true);
    await t.db.query(`UPDATE workflow_runs SET mode = 'USER_FUNDED', state = 'RUNNING', version = version + 1 WHERE run_id = $1`, [two]);
    await t.db.query(`INSERT INTO workflow_run_groups (tenant_id, run_id, group_index, namespace, chain, fee_payer, step_from, step_to, strategy, signing, state)
      VALUES ('default', $1, 0, 'eip155', 'eip155:8453', $2, 0, 1, 'EVM_WALLET_BATCH', 'UPFRONT', 'PLANNED')`, [two, OWNER]);
    expect([single, cancelled]).toHaveLength(2);
    const before = await catalog(t.db), rows = await snapshot(t.db), original = await appendOnlyFunction(t.db);
    expect(original).toMatchObject({ secdef: false, config: null });

    expect(await migrate(t.db, [...v32, m33])).toEqual([33]);
    expect(await migrate(t.db, [...v32, m33])).toEqual([]);
    const after = await catalog(t.db);
    const added = (key: keyof typeof before) => after[key].filter(item => !before[key].includes(item));
    const removed = (key: keyof typeof before) => before[key].filter(item => !after[key].includes(item));
    expect(added('tables')).toEqual(['workflow_run_purge_audit', 'workflow_run_purge_permits']);
    for (const key of ['tables', 'columns', 'constraints', 'indexes', 'triggers', 'privileges'] as const) expect(removed(key), key).toEqual([]);
    expect(added('columns').map(c => c.split(':')[0]).sort()).toEqual(['workflow_run_purge_audit.event_count', 'workflow_run_purge_audit.final_state',
      'workflow_run_purge_audit.handoff_id', 'workflow_run_purge_audit.owner_account', 'workflow_run_purge_audit.owner_namespace', 'workflow_run_purge_audit.purged_at',
      'workflow_run_purge_audit.run_created_at', 'workflow_run_purge_audit.run_id', 'workflow_run_purge_audit.shape', 'workflow_run_purge_audit.tenant_id',
      'workflow_run_purge_permits.run_id', 'workflow_run_purge_permits.tenant_id', 'workflow_run_purge_permits.transaction_id'].sort());
    expect(added('constraints').map(c => c.split(':').slice(0, 2).join(':')).sort()).toEqual(['workflow_run_purge_audit:workflow_run_purge_audit_check',
      'workflow_run_purge_audit:workflow_run_purge_audit_final_state_check', 'workflow_run_purge_audit:workflow_run_purge_audit_handoff_id_check',
      'workflow_run_purge_audit:workflow_run_purge_audit_owner_account_check', 'workflow_run_purge_audit:workflow_run_purge_audit_owner_namespace_check',
      'workflow_run_purge_audit:workflow_run_purge_audit_pkey', 'workflow_run_purge_audit:workflow_run_purge_audit_run_id_check',
      'workflow_run_purge_audit:workflow_run_purge_audit_shape_check', 'workflow_run_purge_audit:workflow_run_purge_audit_tenant_id_fkey',
      'workflow_run_purge_audit:workflow_run_purge_audit_tenant_id_handoff_id_key', 'workflow_run_purge_audit:workflow_run_purge_audit_event_count_check',
      'workflow_run_purge_permits:workflow_run_purge_permits_pkey', 'workflow_run_purge_permits:workflow_run_purge_permits_tenant_id_run_id_fkey'].sort());
    expect(added('indexes').map(i => i.split(':').slice(0, 2).join(':')).sort()).toEqual(['workflow_run_purge_audit:workflow_run_purge_audit_pkey',
      'workflow_run_purge_audit:workflow_run_purge_audit_tenant_id_handoff_id_key', 'workflow_run_purge_permits:workflow_run_purge_permits_pkey']);
    expect(added('triggers').map(i => i.split(':').slice(0, 2).join(':'))).toEqual(['workflow_run_purge_audit:workflow_run_purge_audit_immutable']);
    expect(added('privileges').every(p => p.startsWith('workflow_run_purge_audit:') || p.startsWith('workflow_run_purge_permits:'))).toBe(true);
    // Functions: one new procedure (EXECUTE revoked from PUBLIC: owner only) and the redefined body of 0015's; nothing else.
    expect(removed('functions').map(f => f.split(':')[0])).toEqual(['workflow_run_append_only']);
    expect(added('functions').map(f => f.split(':')[0]).sort()).toEqual(['purge_unsubmitted_workflow_run', 'workflow_run_append_only']);
    expect(added('functions').find(f => f.startsWith('purge_unsubmitted_workflow_run:'))!.split(':').at(-1)).not.toMatch(/(^|,)=X\//);
    expect(added('functions').find(f => f.startsWith('workflow_run_append_only:'))).toMatch(/:default$/);
    expect(await appendOnlyFunction(t.db)).toMatchObject({ secdef: true, config: ['search_path=pg_catalog, public, pg_temp'] });
    expect(await snapshot(t.db)).toEqual(rows);

    // The v28 build serves 33 through this certificate; the previous certificate (0029–0032), no certificate and a strict check refuse it.
    expect(await assertSchemaCompatible(t.db, V28)).toMatchObject({ version: 33, application: 28, forward: CERTIFICATE.migrations.map(m => ({ version: m.version })) });
    await expect(assertSchemaCompatible(t.db, V28, [PREVIOUS])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    await expect(assertSchemaCompatible(t.db, V28, [])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    await expect(assertSchemaCurrent(t.db, V28)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    expect(await migrate(t.db, (await loadMigrations()).slice(0, 28))).toEqual([]);
    await expect(migrate(t.db, [...v32, { ...m33, sql: m33.sql + '\n', sha256: sha(m33.sql + '\n') }])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    expect(await head(t.db)).toBe(33);
  });

  it('keeps 0015’s refusal for every plain DELETE and every UPDATE; a permit of another transaction or another run unlocks nothing', async () => {
    const { t, v32, m33 } = await schema32();
    const target = await run(t.db, 1, true), other = await run(t.db, 1, true);
    expect(await migrate(t.db, [...v32, m33])).toEqual([33]);
    const refused = `23000:${APPEND_ONLY}`;
    for (const table of ['workflow_run_events', 'workflow_run_steps', 'workflow_runs'])
      expect(await failure(t.db.query(`DELETE FROM ${table} WHERE run_id = $1`, [target])), table).toBe(refused);
    expect(await failure(t.db.query(`UPDATE workflow_run_events SET code = 'EDITED' WHERE run_id = $1`, [target]))).toBe(refused);
    // A user-funded run's group row too (0023's trigger, same function).
    const grouped = await run(t.db, 1);
    await t.db.query(`UPDATE workflow_runs SET mode = 'USER_FUNDED', state = 'RUNNING', version = version + 1 WHERE run_id = $1`, [grouped]);
    await t.db.query(`INSERT INTO workflow_run_groups (tenant_id, run_id, group_index, namespace, chain, fee_payer, step_from, step_to, strategy, signing, state)
      VALUES ('default', $1, 0, 'eip155', 'eip155:8453', $2, 0, 0, 'EVM_WALLET_BATCH', 'UPFRONT', 'PLANNED')`, [grouped, OWNER]);
    expect(await failure(t.db.query('DELETE FROM workflow_run_groups WHERE run_id = $1', [grouped]))).toBe(refused);

    // A committed permit (its transaction ended) unlocks nothing in any later transaction; neither does one for another run.
    await t.db.query(`INSERT INTO workflow_run_purge_audit (tenant_id, run_id, handoff_id, owner_namespace, owner_account, shape, final_state, run_created_at, event_count)
      VALUES ('default', $1, $2, 'eip155', $3, 'NO_WALLET_REQUEST', 'CANCELLED', now(), 1)`, [other, id('apr'), OWNER]);
    await t.db.query(`INSERT INTO workflow_run_purge_permits (tenant_id, run_id, transaction_id) VALUES ('default', $1, txid_current())`, [other]);
    expect(await failure(t.db.query('DELETE FROM workflow_run_events WHERE run_id = $1', [other]))).toBe(refused);
    expect(await failure(t.db.transaction(async tx => {
      await tx.query(`UPDATE workflow_run_purge_permits SET transaction_id = txid_current() WHERE run_id = $1`, [other]);
      await tx.query('DELETE FROM workflow_run_events WHERE run_id = $1', [target]);
    }))).toBe(refused);
    // UPDATE stays refused even inside the permitted transaction (only DELETE is ever let through).
    expect(await failure(t.db.transaction(async tx => {
      await tx.query(`UPDATE workflow_run_purge_permits SET transaction_id = txid_current() WHERE run_id = $1`, [other]);
      await tx.query(`UPDATE workflow_run_events SET code = 'EDITED' WHERE run_id = $1`, [other]);
    }))).toBe(refused);
    await t.db.query('DELETE FROM workflow_run_purge_permits WHERE run_id = $1', [other]);
    // The tombstone itself is immutable.
    expect(await failure(t.db.query('DELETE FROM workflow_run_purge_audit WHERE run_id = $1', [other]))).toBe('23000:APPEND_ONLY_VIOLATION: DELETE on workflow_run_purge_audit');
    expect(await failure(t.db.query(`UPDATE workflow_run_purge_audit SET event_count = 2 WHERE run_id = $1`, [other]))).toBe('23000:APPEND_ONLY_VIOLATION: UPDATE on workflow_run_purge_audit');

    // The checked procedure deletes the deletable run, leaves no permit and a tombstone; the other rows stay.
    expect(await purge(t.db, target)).toEqual({ ok: true, disposition: 'DELETED' });
    expect((await t.db.query('SELECT count(*)::int AS n FROM workflow_run_purge_permits')).rows).toEqual([{ n: 0 }]);
    expect((await t.db.query('SELECT shape, final_state, event_count FROM workflow_run_purge_audit WHERE run_id = $1', [target])).rows)
      .toEqual([{ shape: 'NO_WALLET_REQUEST', final_state: 'CANCELLED', event_count: 3 }]);
    for (const table of ['workflow_runs', 'workflow_run_steps', 'workflow_run_events'])
      expect((await t.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE run_id = $1`, [target])).rows, table).toEqual([{ n: 0 }]);
    expect((await t.db.query('SELECT count(*)::int AS n FROM workflow_runs WHERE run_id = ANY($1)', [[other, grouped]])).rows).toEqual([{ n: 2 }]);
    // EXECUTE is the owner's only.
    expect((await t.db.query(`SELECT has_function_privilege('public', 'purge_unsubmitted_workflow_run(text,text,text)', 'EXECUTE') AS public`)).rows).toEqual([{ public: false }]);
  });

  it('a failing 0033 and a lock timeout roll back completely, leaving the exact schema-32 catalog', async () => {
    const { t, v32, m33 } = await schema32();
    await run(t.db, 1, true);
    const before = await catalog(t.db), rows = await snapshot(t.db);
    const broken = m33.sql + '\nSELECT 1/0;';
    await expect(migrate(t.db, [...v32, { ...m33, sql: broken, sha256: sha(broken) }])).rejects.toThrow();
    expect(await head(t.db)).toBe(32);
    expect(await catalog(t.db)).toEqual(before);
    // A writer holding `tenants` (the tombstone's foreign key needs SHARE ROW EXCLUSIVE on it): 0033 waits at most 5 s, then rolls back completely.
    const blocker = t.open(1);
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE tenants IN ROW EXCLUSIVE MODE');
    const started = Date.now();
    await expect(migrate(t.db, [...v32, m33])).rejects.toThrow(/lock timeout|canceling statement/);
    expect(Date.now() - started).toBeLessThan(25_000);
    await blocker.query('ROLLBACK');
    expect(await head(t.db)).toBe(32);
    expect(await catalog(t.db)).toEqual(before);
    expect(await snapshot(t.db)).toEqual(rows);
    expect(await migrate(t.db, [...v32, m33])).toEqual([33]);
  });

  it('the documented reversal restores the exact schema-32 catalog only while no attempt was deleted, and only on 0033 as head', async () => {
    const { t, v32, m33 } = await schema32();
    const deletable = await run(t.db, 1, true);
    const before = await catalog(t.db), original = await appendOnlyFunction(t.db);
    expect(await migrate(t.db, [...v32, m33])).toEqual([33]);
    // While 0033 is head, the 0032 reversal refuses: 0033 must be reversed first.
    expect(await reverse(t, await reversal0032())).toBe('NOT_CERTIFIED_0032_HEAD');
    expect(await reverse(t, await reversal0033())).toBeNull();
    expect(await catalog(t.db)).toEqual(before);
    expect(await appendOnlyFunction(t.db)).toEqual(original);
    expect(await head(t.db)).toBe(32);
    expect(await assertSchemaCompatible(t.db, V28, [PREVIOUS])).toMatchObject({ version: 32, application: 28 });
    expect(await failure(t.db.query('DELETE FROM workflow_runs WHERE run_id = $1', [deletable]))).toBe(`23000:${APPEND_ONLY}`);
    // It refuses anywhere 0033 is not the newest migration.
    expect(await reverse(t, await reversal0033())).toBe('NOT_CERTIFIED_0033_HEAD');
    expect(await catalog(t.db)).toEqual(before);

    // Re-activated, then one attempt deleted: the reversal refuses and changes nothing (a deletion cannot be undone), so 0032 stays too.
    expect(await migrate(t.db, [...v32, m33])).toEqual([33]);
    expect(await purge(t.db, deletable)).toEqual({ ok: true, disposition: 'DELETED' });
    const deleted = await catalog(t.db);
    expect(await reverse(t, await reversal0033())).toBe('WORKFLOW_RUN_PURGES_PRESENT');
    expect(await reverse(t, await reversal0032())).toBe('NOT_CERTIFIED_0032_HEAD');
    expect(await catalog(t.db)).toEqual(deleted);
    expect(await head(t.db)).toBe(33);
    expect(await assertSchemaCompatible(t.db, V28)).toMatchObject({ version: 33, application: 28 });
  });

  it('with a separate runtime role (production’s default privileges) the provisioning file closes permit forgery and leaves deletion to the procedure', async () => {
    const { t, v32, m33 } = await schema32();
    const role = `flofi_test_runtime_${randomBytes(6).toString('hex')}`;
    roles.push(role);
    // Production's model: a migration role owns every object; the runtime role holds table rights by grant and, for every table created later, by
    // default privileges; 0016's procedure was granted to it explicitly. 0033 itself names no role.
    await t.db.query(`CREATE ROLE ${role} NOLOGIN`);
    await t.db.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await t.db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await t.db.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await t.db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await t.db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`);
    await t.db.query(`GRANT EXECUTE ON FUNCTION purge_unstarted_execution(text, text, text) TO ${role}`);
    const deletable = await run(t.db, 1, true), kept = await run(t.db, 2);
    const asRuntime = <T>(work: (tx: Pick<Database, 'query'>) => Promise<T>) =>
      t.db.transaction(async tx => { await tx.query(`SET LOCAL ROLE ${role}`); return work(tx); });
    /** As the runtime role, without the checked procedure: a forged tombstone and permit, then a DELETE of the run's events; always rolled back. */
    const forge = (runId: string) => failure(asRuntime(async tx => {
      await tx.query(`INSERT INTO workflow_run_purge_audit (tenant_id, run_id, handoff_id, owner_namespace, owner_account, shape, final_state, run_created_at,
        event_count) VALUES ('default', $1, $2, 'eip155', $3, 'NO_WALLET_REQUEST', 'CANCELLED', now(), 1)`, [runId, id('apr'), OWNER]);
      await tx.query(`INSERT INTO workflow_run_purge_permits (tenant_id, run_id, transaction_id) VALUES ('default', $1, txid_current())`, [runId]);
      const { rowCount } = await tx.query('DELETE FROM workflow_run_events WHERE run_id = $1', [runId]);
      throw new Error(`FORGED_DELETE_ROLLED_BACK:${rowCount}`);
    }));
    const purgeAsRuntime = (runId: string) => asRuntime(async tx =>
      (await tx.query<{ result: unknown }>('SELECT purge_unsubmitted_workflow_run($1, $2, $3) AS result', ['default', OWNER, runId])).rows[0]!.result);
    const verification = async () => (await t.db.query(await runtimeVerification(role))).rows;
    const provision = async () => reverse(t, await runtimePrivileges(role));
    const events = async (runId: string) => (await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM workflow_run_events WHERE run_id = $1', [runId])).rows[0]!.n;

    // Below 0033 the file refuses and changes nothing.
    const at32 = await catalog(t.db);
    expect(await provision()).toBe('WORKFLOW_RUN_PURGE_NOT_ACTIVE');
    expect(await catalog(t.db)).toEqual(at32);
    expect(await migrate(t.db, [...v32, m33])).toEqual([33]);
    // The hazard the file exists for: the default privileges let the runtime role forge a permit and delete a run the procedure refuses; and the
    // runtime role cannot call the procedure (History's Delete fails closed).
    expect(await forge(kept)).toBe(':FORGED_DELETE_ROLLED_BACK:1');
    expect(await failure(purgeAsRuntime(deletable))).toBe('42501:permission denied for function purge_unsubmitted_workflow_run');
    expect(await verification()).toEqual([{ runtime_execute: false, runtime_reads_tombstones: true, runtime_writes_tombstones: true,
      runtime_touches_permits: true, public_execute: false }]);

    // Provisioned: only privileges of 0033's own objects change, and a rerun changes nothing.
    const before = await catalog(t.db);
    expect(await provision()).toBeNull();
    const after = await catalog(t.db);
    for (const key of ['tables', 'columns', 'constraints', 'indexes', 'triggers'] as const) expect(after[key], key).toEqual(before[key]);
    const changed = (key: 'functions' | 'privileges') => [...after[key].filter(i => !before[key].includes(i)), ...before[key].filter(i => !after[key].includes(i))];
    expect(changed('functions').map(f => f.split(':')[0])).toEqual(['purge_unsubmitted_workflow_run', 'purge_unsubmitted_workflow_run']);
    expect(changed('privileges').every(p => /^workflow_run_purge_(audit|permits):/.test(p) && p.includes(`:${role}:`))).toBe(true);
    expect(await provision()).toBeNull();
    expect(await catalog(t.db)).toEqual(after);
    expect(await verification()).toEqual([{ runtime_execute: true, runtime_reads_tombstones: true, runtime_writes_tombstones: false,
      runtime_touches_permits: false, public_execute: false }]);

    // The documented reversal still restores the exact schema-32 catalog (the grants go with the objects); re-applying 0033 brings the default
    // privileges back, so the file is needed again after every application of 0033.
    expect(await reverse(t, await reversal0033())).toBeNull();
    expect(await head(t.db)).toBe(32);
    expect(await catalog(t.db)).toEqual(at32);
    expect(await migrate(t.db, [...v32, m33])).toEqual([33]);
    expect(await forge(kept)).toBe(':FORGED_DELETE_ROLLED_BACK:1');
    expect(await provision()).toBeNull();

    // As the runtime role now: no forgery, no permit access, no tombstone write; plain DELETE keeps 0015's refusal; the procedure alone deletes.
    expect(await forge(kept)).toBe('42501:permission denied for table workflow_run_purge_audit');
    expect(await failure(asRuntime(tx => tx.query(`INSERT INTO workflow_run_purge_permits (tenant_id, run_id, transaction_id) VALUES ('default', $1, txid_current())`,
      [kept])))).toBe('42501:permission denied for table workflow_run_purge_permits');
    expect(await failure(asRuntime(tx => tx.query('SELECT count(*) FROM workflow_run_purge_permits')))).toBe('42501:permission denied for table workflow_run_purge_permits');
    expect(await failure(asRuntime(tx => tx.query('DELETE FROM workflow_run_purge_audit')))).toBe('42501:permission denied for table workflow_run_purge_audit');
    expect(await failure(asRuntime(tx => tx.query('DELETE FROM workflow_runs WHERE run_id = $1', [kept])))).toBe(`23000:${APPEND_ONLY}`);
    expect(await purgeAsRuntime(kept)).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
    expect(await purgeAsRuntime(id('wfr'))).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    expect(await purgeAsRuntime(deletable)).toEqual({ ok: true, disposition: 'DELETED' });
    expect(await purgeAsRuntime(deletable)).toEqual({ ok: true, disposition: 'DELETED' });
    expect(await asRuntime(async tx => (await tx.query('SELECT shape, final_state FROM workflow_run_purge_audit WHERE run_id = $1', [deletable])).rows))
      .toEqual([{ shape: 'NO_WALLET_REQUEST', final_state: 'CANCELLED' }]);
    expect(await events(deletable)).toBe(0);
    expect(await events(kept)).toBe(1);
    expect((await t.db.query('SELECT count(*)::int AS n FROM workflow_run_purge_permits')).rows).toEqual([{ n: 0 }]);
  });
});
