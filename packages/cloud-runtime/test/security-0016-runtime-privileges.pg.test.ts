// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001 (P0): the runtime-role privilege remediation of 0016_owner_history_purge
 * (`docs/deploy/SECURITY-0016-RUNTIME-PRIVILEGES.sql`) and its read-only verification (`.verify.sql`), each run here as its exact file, on
 * disposable loopback PostgreSQL that reproduces FloFi production's privilege model: a non-superuser MIGRATION role owns every object (it is the
 * database owner and applies the shipped migrations and the certified 0029–0037 itself), and a separate RUNTIME role receives table rights only
 * through that owner's `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES` (sequences: USAGE, SELECT, UPDATE), the
 * explicit EXECUTE on `purge_unstarted_execution` and the 0033 runtime-role provisioning file; the owner also administers the runtime role, as
 * Neon's CREATEROLE grant does in production (read from production's catalog, read-only, on 2026-11-23).
 *
 * Proven:
 *   1. the exposure before the remediation: as the runtime role, a forged tombstone and permit delete a COMPLETED run's journal, log bytes, run
 *      and log; and a permit alone, naming an existing legitimate tombstone, deletes another run's log bytes (both rolled back; also committed
 *      once on a throw-away database to show the integrity section of the verification detecting each shape);
 *   2. the remediation as the migration role: only the two private tables' ACLs change, every row of every execution, history, tombstone and
 *      0033 table is byte-for-byte unchanged, a rerun changes nothing (idempotent), and 0033's provisioned privileges stay exactly as they were;
 *   3. after it, as the runtime role: no tombstone or permit can be created, read (permits), changed or removed; plain DELETE/UPDATE on the
 *      execution history keeps 0016's APPEND_ONLY_VIOLATION; owner History's legitimate Delete still purges an eligible unstarted run through the
 *      procedure (tombstone + History event) and still refuses completed, submitting and evidence-bearing runs;
 *   4. refusals change nothing: 0016 absent, an unknown or owning runtime role, a runtime role that owns schema public, a runtime-role
 *      connection, a write (table- or column-level) or CREATE reachable through any membership, inherited or SET-only, predefined roles
 *      included (the post-check rolls the already-issued REVOKEs back), CREATE in public, functions planted in public to fake the checks, and
 *      a lock timeout behind a concurrent migration.
 * Synthetic records only; nothing here reaches a shared, preview or production database (pg-harness refuses any non-loopback host).
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { CERTIFIED_FORWARD_MIGRATIONS, createDatabase, createOwnerHistory, createPostgresLogStore, forwardMigrationSqlUrl, loadMigrations, migrate,
  type Database, type Migration, type Projector } from '../src/index.js';
import { bytes, testDatabaseUrl } from './pg-harness.js';

const OWNER_WALLET = '0x' + '11'.repeat(20);
const SHA_0016 = 'a3c258cadd9d7865ad9d36d63ec0921fc47455bb3651c201074f3b0486b4be6f';
const ADVISORY_LOCK = 7340032001;
const doc = (name: string) => readFile(new URL(`../../../docs/deploy/${name}`, import.meta.url), 'utf8');
/** psql's substitutions for `-v runtime_role=<role>`: `:'runtime_role'` is a quoted literal, `:"runtime_role"` a quoted identifier. */
const substitute = (sql: string, role: string) => sql.replaceAll(":'runtime_role'", `'${role}'`).replaceAll(':"runtime_role"', `"${role}"`);
async function remediationSql(role: string): Promise<string> {
  const sql = await doc('SECURITY-0016-RUNTIME-PRIVILEGES.sql');
  expect(sql.match(/:'runtime_role'/g)).toHaveLength(5);
  expect(sql.match(/:"runtime_role"/g)).toHaveLength(4);
  expect(sql.match(new RegExp(SHA_0016, 'g'))).toHaveLength(1);
  // No data statement anywhere in the file: privileges only.
  expect(sql.match(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/gim)).toBeNull();
  return substitute(sql, role);
}
const verifySql = async (role: string) => substitute(await doc('SECURITY-0016-RUNTIME-PRIVILEGES.verify.sql'), role);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

type Model = { readonly owner: string; readonly runtime: string; readonly asOwner: Database; readonly asRuntime: Database;
  readonly url: (role: string) => string; readonly drop: () => Promise<void> };
const models: Model[] = [];
const extraRoles: string[] = [];
afterEach(async () => {
  // Infrastructure review: every model and role is dropped even when one drop fails (each is independent).
  await Promise.allSettled(models.splice(0).map(model => model.drop()));
  if (!extraRoles.length) return;
  const admin = createDatabase({ connectionString: testDatabaseUrl().toString(), maxConnections: 1 });
  try { for (const role of extraRoles.splice(0)) await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined); } finally { await admin.close(); }
});

/** The certified chain FloFi production runs (shipped 0001–0028, then 0029–0037 from their SHA-256-pinned files), or the first `upTo` of it. */
async function chain(upTo?: number): Promise<Migration[]> {
  const certificate = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
  const ahead = await Promise.all(certificate.migrations.map(async identity => {
    const sql = await readFile(forwardMigrationSqlUrl(identity), 'utf8');
    expect(sha(sql)).toBe(identity.sha256);
    return { ...identity, sql };
  }));
  const all = [...await loadMigrations(), ...ahead];
  return upTo === undefined ? all : all.slice(0, upTo);
}

/** A database whose objects belong to a non-superuser migration role, with a runtime role provisioned exactly as in production. */
async function productionModel(options: { upTo?: number } = {}): Promise<Model> {
  const suffix = randomBytes(5).toString('hex'), owner = `flofi_t_owner_${suffix}`, runtime = `flofi_t_runtime_${suffix}`, name = `flofi_test_${suffix}`;
  // Infrastructure review: a password of its own, so the suite also runs on a loopback server that authenticates (SCRAM), not only under trust.
  const password = randomBytes(16).toString('hex');
  const base = testDatabaseUrl();
  const pools: Database[] = [];
  const drop = async () => {
    await Promise.allSettled(pools.map(pool => pool.close()));
    const cleanup = createDatabase({ connectionString: base.toString(), maxConnections: 1 });
    try {
      for (const statement of [`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`, `DROP ROLE IF EXISTS ${runtime}`, `DROP ROLE IF EXISTS ${owner}`])
        await cleanup.query(statement).catch(() => undefined);
    } finally { await cleanup.close(); }
  };
  // Registered before anything is created, so a setup that fails part-way leaves no role, database or pool behind.
  const pending: Model = { owner, runtime, asOwner: null as unknown as Database, asRuntime: null as unknown as Database, url: () => '', drop };
  models.push(pending);
  const admin = createDatabase({ connectionString: base.toString(), maxConnections: 1 });
  try {
    await admin.query(`CREATE ROLE ${owner} LOGIN NOSUPERUSER CREATEROLE PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER INHERIT PASSWORD '${password}'`);
    // Production: the migration role administers the runtime role (Neon's CREATEROLE grant) without inheriting it.
    await admin.query(`GRANT ${runtime} TO ${owner} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
    await admin.query(`CREATE DATABASE ${name} OWNER ${owner}`);
  } finally { await admin.close(); }
  const url = (role: string) => { const u = new URL(base.toString()); u.username = role; u.password = role === owner || role === runtime ? password : ''; u.pathname = '/' + name;
    return u.toString(); };
  const asOwner = createDatabase({ connectionString: url(owner), maxConnections: 4, applicationName: 'flofi-test-migration' });
  pools.push(asOwner);
  await asOwner.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
  await asOwner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}`);
  await asOwner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtime}`);
  const migrations = await chain(options.upTo);
  expect(await migrate(asOwner, migrations)).toHaveLength(migrations.length);
  if (migrations.length >= 16) await asOwner.query(`GRANT EXECUTE ON FUNCTION purge_unstarted_execution(text, text, text) TO ${runtime}`);
  if (migrations.length >= 33) {
    const provisioning = await doc('RELEASE-WORKFLOW-RUN-PURGE-0033.runtime-privileges.sql');
    await asOwner.query(provisioning.replaceAll(':"runtime_role"', `"${runtime}"`));
  }
  const asRuntime = createDatabase({ connectionString: url(runtime), maxConnections: 4, applicationName: 'flofi-test-runtime' });
  pools.push(asRuntime);
  const model: Model = { owner, runtime, asOwner, asRuntime, url, drop };
  models[models.indexOf(pending)] = model;
  return model;
}

/** Runs a whole SQL file on one dedicated session (simple query protocol, as psql sends it); answers its result sets, or the error. */
async function runFile(connectionString: string, sql: string): Promise<{ results: pg.QueryResult[] } | { error: string; code: string }> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(sql) as unknown as pg.QueryResult | pg.QueryResult[];
    return { results: Array.isArray(result) ? result : [result] };
  } catch (cause) {
    const error = cause as Error & { code?: string };
    // A refusal leaves the session's transaction aborted: psql with ON_ERROR_STOP exits and the server rolls it back. So does this.
    await client.query('ROLLBACK').catch(() => undefined);
    return { error: error.message, code: error.code ?? '' };
  } finally { await client.end(); }
}
const remediate = async (m: Model, options: { as?: string; role?: string } = {}) =>
  runFile(m.url(options.as ?? m.owner), await remediationSql(options.role ?? m.runtime));
const refusal = (outcome: Awaited<ReturnType<typeof runFile>>) => 'error' in outcome ? outcome.error : null;
/** The verification file's result sets by section (BEGIN and the SETs answer no rows). */
async function verification(m: Model) {
  const outcome = await runFile(m.url(m.owner), await verifySql(m.runtime));
  if ('error' in outcome) throw new Error(outcome.error);
  const sets = outcome.results.filter(r => r.command === 'SELECT');
  expect(sets).toHaveLength(7);
  const [identity, role, objects, effective, summary, defaults, integrity] = sets.map(r => r.rows);
  return { identity: identity!, role: role!, objects: objects!, effective: effective!, summary: summary![0]!, defaults: defaults!, integrity: integrity![0]! };
}

/** Synthetic execution runs written exactly as the runtime log store writes them, through the RUNTIME role (as the API and worker do). */
async function seed(m: Model, id: string, options: { status?: string; evidence?: boolean; observe?: boolean } = {}) {
  const projector: Projector = () => ({ run: { runId: id, workflowId: `workflow-${id}`, flow: 'base-swap', status: options.status ?? 'SIMULATED', provenance: 'MOCKED',
    ownerAccount: OWNER_WALLET, recoveryOf: null, errorCode: null, needsObservation: options.observe ?? false, hasEvidence: options.evidence ?? false, attempts: [],
    journal: [{ sequence: 0, entryHash: '0x' + 'aa'.repeat(32), level: 'workflow', entityId: `workflow-${id}`, attemptId: null, fromState: null, toState: 'SIMULATED',
      recordedAt: '2026-11-23T00:00:00Z' }] }, work: [] });
  const store = createPostgresLogStore({ db: m.asRuntime, tenantId: 'default', namespace: 'base-swap', projector });
  const line = JSON.stringify({ quote: { executionId: id, ownerReview: { account: OWNER_WALLET } }, workflow: { workflowId: `workflow-${id}` },
    reviewedManifestHash: null, attempts: [], outcome: null }) + '\n';
  await store.create(`${id}.jsonl`, bytes(line));
  await store.extend(`${id}.jsonl`, bytes(line + line), () => undefined);
}
/** Every row the remediation must never touch (log bytes by digest). */
async function rows(db: Database) {
  const q = async (sql: string) => (await db.query(sql)).rows;
  return {
    runs: await q('SELECT * FROM execution_runs ORDER BY tenant_id, run_id'),
    logs: await q('SELECT * FROM execution_logs ORDER BY tenant_id, namespace, name'),
    segments: await q(`SELECT tenant_id, namespace, name, seq, segment_sha256, encode(sha256(bytes), 'hex') AS digest FROM execution_log_segments ORDER BY 1, 2, 3, 4`),
    journal: await q('SELECT * FROM journal_entries ORDER BY tenant_id, run_id, sequence'),
    tombstones: await q('SELECT * FROM execution_purge_audit ORDER BY tenant_id, run_id'),
    permits: await q('SELECT * FROM execution_purge_permits ORDER BY tenant_id, run_id'),
    history: await q('SELECT * FROM owner_history_events ORDER BY event_id'),
    workflowTombstones: await q('SELECT * FROM workflow_run_purge_audit ORDER BY tenant_id, run_id'),
    migrations: await q('SELECT version, name, sha256 FROM schema_migrations ORDER BY version'),
  };
}
/** Every ACL, default ACL and membership in the database, and this model's roles' memberships: what a privilege change can touch. */
async function acls(db: Database) {
  const q = async (sql: string) => (await db.query<{ item: string }>(sql)).rows.map(r => r.item).sort();
  return {
    relations: await q(`SELECT c.relname || ':' || coalesce(c.relacl::text, '-') AS item FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace`),
    columns: await q(`SELECT a.attrelid::regclass::text || '.' || a.attname || ':' || a.attacl::text AS item FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL`),
    functions: await q(`SELECT p.oid::regprocedure::text || ':' || coalesce(p.proacl::text, '-') || ':' || md5(pg_get_functiondef(p.oid)) AS item FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace`),
    defaults: await q(`SELECT pg_get_userbyid(defaclrole) || ':' || defaclobjtype::text || ':' || defaclacl::text AS item FROM pg_default_acl`),
    // Infrastructure review: only this database's model roles (the shared catalog also holds other suites' roles).
    // `acls` always runs as the model's owner, whose runtime role carries the same suffix.
    memberships: await q(`SELECT roleid::regrole::text || '>' || member::regrole::text AS item FROM pg_auth_members
      WHERE member::regrole::text IN (current_user, replace(current_user, 'flofi_t_owner_', 'flofi_t_runtime_'))`),
    triggers: await q(`SELECT tgrelid::regclass::text || ':' || tgname || ':' || tgenabled::text AS item FROM pg_trigger WHERE NOT tgisinternal`),
    schema: await q(`SELECT nspowner::regrole::text || ':' || coalesce(nspacl::text, '-') AS item FROM pg_namespace WHERE nspname = 'public'`),
  };
}
const failure = (work: Promise<unknown>) => work.then(() => null, (error: Error & { code?: string }) => `${error.code ?? ''}:${error.message}`);
/** A forged deletion as the runtime role, without the checked procedure; always rolled back (an Error carries what it managed to delete). */
const forged = (m: Model, work: (tx: Pick<Database, 'query'>) => Promise<string>, commit = false) =>
  failure(m.asRuntime.transaction(async tx => { const done = await work(tx); if (commit) return done; throw new Error(`FORGED_ROLLED_BACK:${done}`); }));
/** Shape A: a forged tombstone and permit for a COMPLETED run, then its journal, log bytes, run and log. */
const forgeWholeRun = (runId: string) => async (tx: Pick<Database, 'query'>) => {
  await tx.query(`INSERT INTO execution_purge_audit (tenant_id, run_id, owner_account, namespace, log_name, log_sha256, log_version, segment_count, journal_count)
    VALUES ('default', $1, $2, 'base-swap', $3, $4, 2, 2, 1)`, [runId, OWNER_WALLET, `${runId}.jsonl`, '0'.repeat(64)]);
  await tx.query(`INSERT INTO execution_purge_permits VALUES ('default', $1, 'base-swap', $2, txid_current())`, [runId, `${runId}.jsonl`]);
  const deleted = [
    (await tx.query('DELETE FROM journal_entries WHERE run_id = $1', [runId])).rowCount,
    (await tx.query(`DELETE FROM execution_log_segments WHERE namespace = 'base-swap' AND name = $1`, [`${runId}.jsonl`])).rowCount,
    (await tx.query('DELETE FROM execution_runs WHERE run_id = $1', [runId])).rowCount,
    (await tx.query(`DELETE FROM execution_logs WHERE namespace = 'base-swap' AND name = $1`, [`${runId}.jsonl`])).rowCount];
  await tx.query('DELETE FROM execution_purge_permits WHERE run_id = $1', [runId]);
  return deleted.join(',');
};
/** Shape B: no new tombstone at all; a permit naming an existing legitimate tombstone but another run's log, then that log's bytes. */
const forgeLogBytes = (tombstoned: string, victim: string) => async (tx: Pick<Database, 'query'>) => {
  await tx.query(`INSERT INTO execution_purge_permits VALUES ('default', $1, 'base-swap', $2, txid_current())`, [tombstoned, `${victim}.jsonl`]);
  const { rowCount } = await tx.query(`DELETE FROM execution_log_segments WHERE namespace = 'base-swap' AND name = $1`, [`${victim}.jsonl`]);
  await tx.query('DELETE FROM execution_purge_permits WHERE run_id = $1', [tombstoned]);
  return String(rowCount);
};
const ACCESS_TOMBSTONE = '42501:permission denied for table execution_purge_audit';
const ACCESS_PERMIT = '42501:permission denied for table execution_purge_permits';

describe('BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001: 0016 runtime-role privilege remediation (PostgreSQL)', { timeout: 180_000 }, () => {
  it('reproduces the exposure, closes it with only the two ACL changes, keeps every row, stays idempotent and keeps 0033 closed', async () => {
    const m = await productionModel();
    const history = createOwnerHistory(m.asRuntime, 'default');
    await seed(m, 'eligible-before'); await seed(m, 'eligible-after');
    await seed(m, 'completed', { status: 'RECONCILED', evidence: true }); await seed(m, 'submitting', { status: 'SUBMITTING', observe: true });
    // A legitimate owner deletion before the remediation leaves a real tombstone (and its History event).
    expect(await history.change(OWNER_WALLET, 'EXECUTION_RUN', 'eligible-before', 'DELETE')).toMatchObject({ ok: true, disposition: 'DELETED' });

    // Before: production's privileges, as read from its catalog.
    const before = await verification(m);
    expect(before.identity).toEqual([expect.objectContaining({ version: 16, name: 'owner_history_purge', sha256: SHA_0016, certified: true, ledger_head: 37 })]);
    expect(before.role).toEqual([expect.objectContaining({ rolname: m.runtime, rolsuper: false, member_of: '' })]);
    expect(before.summary).toEqual({ runtime_reads_tombstones: true, runtime_writes_tombstones: true, runtime_touches_permits: true, runtime_column_writes: true,
      runtime_member_writes: false, runtime_creates_in_public: false, runtime_execute: true, public_execute: false, public_touches_tables: false });
    expect(before.integrity).toEqual({ open_permits: '0', tombstones: '1', tombstones_without_history_event: '0', tombstones_with_live_records: '0',
      logs_missing_segments: '0', logs_with_digest_mismatch: '0', segments_with_digest_mismatch: '0', journals_with_gaps: '0' });
    // The exposure: both forgery shapes delete protected history (rolled back here).
    expect(await forged(m, forgeWholeRun('completed'))).toBe(':FORGED_ROLLED_BACK:1,2,1,1');
    expect(await forged(m, forgeLogBytes('eligible-before', 'submitting'))).toBe(':FORGED_ROLLED_BACK:2');
    // A runtime role could also plant a tombstone for an identity that does not exist yet, so that identity can never be created.
    expect(await failure(m.asRuntime.transaction(async tx => {
      await tx.query(`INSERT INTO execution_purge_audit (tenant_id, run_id, owner_account, namespace, log_name, log_sha256, log_version, segment_count, journal_count)
        VALUES ('default', 'future-run', $1, 'base-swap', 'future-run.jsonl', $2, 1, 1, 0)`, [OWNER_WALLET, '0'.repeat(64)]);
      throw new Error('PLANTED_ROLLED_BACK');
    }))).toBe(':PLANTED_ROLLED_BACK');

    // The remediation, as the migration role.
    const rowsBefore = await rows(m.asOwner), aclsBefore = await acls(m.asOwner);
    const applied = await remediate(m);
    expect('error' in applied ? applied.error : null).toBeNull();
    const printed = 'results' in applied ? applied.results.at(-2)!.rows : [];
    expect(printed).toEqual([{ runtime_reads_tombstones: true, runtime_writes_tombstones: false, runtime_touches_permits: false, runtime_execute: true,
      public_execute: false }]);
    const aclsAfter = await acls(m.asOwner);
    for (const key of ['columns', 'functions', 'defaults', 'memberships', 'triggers', 'schema'] as const) expect(aclsAfter[key], key).toEqual(aclsBefore[key]);
    const changed = [...aclsAfter.relations.filter(i => !aclsBefore.relations.includes(i)), ...aclsBefore.relations.filter(i => !aclsAfter.relations.includes(i))];
    expect(changed.map(i => i.split(':')[0]).sort()).toEqual(['execution_purge_audit', 'execution_purge_audit', 'execution_purge_permits', 'execution_purge_permits']);
    expect(aclsAfter.relations.find(i => i.startsWith('execution_purge_audit:'))).toContain(`${m.runtime}=r/${m.owner}`);
    expect(aclsAfter.relations.find(i => i.startsWith('execution_purge_permits:'))).not.toContain(m.runtime);
    expect(await rows(m.asOwner)).toEqual(rowsBefore);
    // Idempotent: a rerun changes nothing.
    expect(refusal(await remediate(m))).toBeNull();
    expect(await acls(m.asOwner)).toEqual(aclsAfter);
    expect(await rows(m.asOwner)).toEqual(rowsBefore);

    const after = await verification(m);
    expect(after.summary).toEqual({ runtime_reads_tombstones: true, runtime_writes_tombstones: false, runtime_touches_permits: false, runtime_column_writes: false,
      runtime_member_writes: false, runtime_creates_in_public: false, runtime_execute: true, public_execute: false, public_touches_tables: false });
    expect(after.effective.filter(r => r.runtime === true)).toEqual([{ object: 'execution_purge_audit', privilege: 'SELECT', runtime: true, public: false }]);
    expect(after.effective.every(r => r.public !== true)).toBe(true);
    // 0033's provisioned privileges are untouched (its documented verification answers exactly as before).
    const doc0033 = await doc('RELEASE-WORKFLOW-RUN-PURGE-0033.md'), start = doc0033.indexOf('```sql\n-- Runtime-role verification of 0033');
    const verify0033 = doc0033.slice(start + '```sql\n'.length, doc0033.indexOf('\n```', start + 1)).replaceAll(":'runtime_role'", `'${m.runtime}'`);
    expect((await m.asOwner.query(verify0033)).rows).toEqual([{ runtime_execute: true, runtime_reads_tombstones: true, runtime_writes_tombstones: false,
      runtime_touches_permits: false, public_execute: false }]);

    // After, as the runtime role: no forgery, no permit access, no tombstone change; the append-only triggers still answer plain deletes.
    expect(await forged(m, forgeWholeRun('completed'))).toBe(ACCESS_TOMBSTONE);
    expect(await forged(m, forgeLogBytes('eligible-before', 'submitting'))).toBe(ACCESS_PERMIT);
    expect(await failure(m.asRuntime.query('SELECT count(*) FROM execution_purge_permits'))).toBe(ACCESS_PERMIT);
    expect(await failure(m.asRuntime.query(`UPDATE execution_purge_audit SET owner_account = $1`, ['0x' + '22'.repeat(20)]))).toBe(ACCESS_TOMBSTONE);
    expect(await failure(m.asRuntime.query('DELETE FROM execution_purge_audit'))).toBe(ACCESS_TOMBSTONE);
    expect(await failure(m.asRuntime.query('TRUNCATE execution_purge_audit'))).toBe(ACCESS_TOMBSTONE);
    expect(await failure(m.asRuntime.query('TRUNCATE execution_purge_permits'))).toBe(ACCESS_PERMIT);
    for (const statement of [`DELETE FROM journal_entries WHERE run_id = 'completed'`, `DELETE FROM execution_log_segments WHERE name = 'completed.jsonl'`,
      `DELETE FROM execution_runs WHERE run_id = 'completed'`, `DELETE FROM execution_logs WHERE name = 'completed.jsonl'`, `UPDATE journal_entries SET to_state = to_state`])
      expect(await failure(m.asRuntime.query(statement)), statement).toMatch(/^23000:APPEND_ONLY_VIOLATION: (DELETE|UPDATE) on /);
    // The runtime role still reads tombstones (History, privacy) and owner History's Delete still works through the procedure, and only for an
    // eligible unstarted run.
    expect(await history.disposition(OWNER_WALLET, 'EXECUTION_RUN', 'eligible-before')).toEqual({ ok: true, disposition: 'DELETED' });
    expect(await history.change(OWNER_WALLET, 'EXECUTION_RUN', 'eligible-after', 'DELETE')).toMatchObject({ ok: true, disposition: 'DELETED',
      counts: { execution_runs: 1, execution_logs: 1, execution_log_segments: 2, journal_entries: 1 } });
    expect(await history.change(OWNER_WALLET, 'EXECUTION_RUN', 'eligible-after', 'DELETE')).toMatchObject({ ok: true, disposition: 'DELETED' });
    expect(await history.change(OWNER_WALLET, 'EXECUTION_RUN', 'completed', 'DELETE')).toMatchObject({ ok: false, code: 'RUN_DELETE_REFUSED' });
    expect(await history.change(OWNER_WALLET, 'EXECUTION_RUN', 'submitting', 'DELETE')).toMatchObject({ ok: false, code: 'RUN_DELETE_REFUSED' });
    expect(await history.change('0x' + '22'.repeat(20), 'EXECUTION_RUN', 'completed', 'DELETE')).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    const final = await verification(m);
    expect(final.integrity).toEqual({ open_permits: '0', tombstones: '2', tombstones_without_history_event: '0', tombstones_with_live_records: '0',
      logs_missing_segments: '0', logs_with_digest_mismatch: '0', segments_with_digest_mismatch: '0', journals_with_gaps: '0' });
    expect((await m.asOwner.query(`SELECT run_id FROM execution_runs ORDER BY run_id`)).rows).toEqual([{ run_id: 'completed' }, { run_id: 'submitting' }]);
  });

  it('the verification’s integrity section detects each forgery shape once committed (throw-away database, before the remediation)', async () => {
    const m = await productionModel();
    await seed(m, 'eligible'); await seed(m, 'completed', { status: 'RECONCILED', evidence: true }); await seed(m, 'other', { status: 'RECONCILED' });
    await seed(m, 'kept', { status: 'RECONCILED' }); await seed(m, 'rewritten', { status: 'RECONCILED' });
    expect(await createOwnerHistory(m.asRuntime, 'default').change(OWNER_WALLET, 'EXECUTION_RUN', 'eligible', 'DELETE')).toMatchObject({ ok: true });
    expect(await forged(m, forgeLogBytes('eligible', 'other'), true)).toBeNull();
    expect(await forged(m, forgeWholeRun('completed'), true)).toBeNull();
    // Data-privacy review: a forged tombstone written WITH a forged History event, over a run whose records were not all deleted.
    expect(await forged(m, async tx => {
      await tx.query(`INSERT INTO execution_purge_audit (tenant_id, run_id, owner_account, namespace, log_name, log_sha256, log_version, segment_count, journal_count)
        VALUES ('default', 'kept', $1, 'base-swap', 'kept.jsonl', $2, 2, 2, 1)`, [OWNER_WALLET, '0'.repeat(64)]);
      await tx.query(`INSERT INTO owner_history_events (tenant_id, owner_account, kind, record_id, action) VALUES ('default', $1, 'EXECUTION_RUN', 'kept', 'DELETED')`, [OWNER_WALLET]);
      await tx.query(`INSERT INTO execution_purge_permits VALUES ('default', 'kept', 'base-swap', 'kept.jsonl', txid_current())`);
      const { rowCount } = await tx.query(`DELETE FROM journal_entries WHERE run_id = 'kept'`);
      await tx.query(`DELETE FROM execution_purge_permits WHERE run_id = 'kept'`);
      return String(rowCount);
    }, true)).toBeNull();
    // Data-privacy review: a log's bytes rewritten under a permit naming an existing tombstone, same segment count, recorded digest left as is.
    expect(await forged(m, async tx => {
      await tx.query(`INSERT INTO execution_purge_permits VALUES ('default', 'eligible', 'base-swap', 'rewritten.jsonl', txid_current())`);
      await tx.query(`DELETE FROM execution_log_segments WHERE namespace = 'base-swap' AND name = 'rewritten.jsonl'`);
      for (const seq of [0, 1]) {
        const forgedBytes = Buffer.from(`{"forged":${seq}}\n`);
        await tx.query(`INSERT INTO execution_log_segments (tenant_id, namespace, name, seq, bytes, segment_sha256, content_sha256)
          VALUES ('default', 'base-swap', 'rewritten.jsonl', $1, $2, $3, $4)`, [seq, forgedBytes, sha(forgedBytes.toString()), '0'.repeat(64)]);
      }
      await tx.query(`DELETE FROM execution_purge_permits WHERE run_id = 'eligible'`);
      return 'rewritten';
    }, true)).toBeNull();
    expect((await verification(m)).integrity).toEqual({ open_permits: '0', tombstones: '3', tombstones_without_history_event: '1', tombstones_with_live_records: '1',
      logs_missing_segments: '1', logs_with_digest_mismatch: '2', segments_with_digest_mismatch: '0', journals_with_gaps: '0' });
  });

  it('refuses, changing nothing: 0016 absent, an unknown or owning runtime role, a runtime-role connection, an inherited write, a lock timeout', async () => {
    // Schema 15: 0016 is not applied.
    const early = await productionModel({ upTo: 15 });
    expect(refusal(await remediate(early))).toBe('OWNER_HISTORY_PURGE_0016_NOT_CERTIFIED');

    const m = await productionModel();
    const unchanged = await acls(m.asOwner);
    expect(refusal(await remediate(m, { role: `flofi_t_missing_${randomBytes(4).toString('hex')}` }))).toBe('RUNTIME_ROLE_NOT_FOUND');
    expect(refusal(await remediate(m, { role: m.owner }))).toBe('RUNTIME_ROLE_IS_OWNER');
    expect(refusal(await remediate(m, { as: m.runtime }))).toBe('MIGRATION_ROLE_REQUIRED');
    expect(await acls(m.asOwner)).toEqual(unchanged);
    // Security review: a runtime role that owns schema public could drop and recreate the private tables whatever their grants say.
    // The harness's own (superuser) credentials on this model's database.
    const superuser = testDatabaseUrl(); superuser.pathname = new URL(m.url(m.owner)).pathname;
    const owners = createDatabase({ connectionString: superuser.toString(), maxConnections: 1 });
    try {
      await owners.query(`ALTER SCHEMA public OWNER TO ${m.runtime}`);
      expect(refusal(await remediate(m))).toBe('RUNTIME_ROLE_OWNS_SCHEMA');
      await owners.query(`ALTER SCHEMA public OWNER TO pg_database_owner`);
      // An owner round trip folds the runtime role's own USAGE grant into the owner's: grant it again, exactly as the model has it.
      await owners.query(`GRANT USAGE ON SCHEMA public TO ${m.runtime}`);
    } finally { await owners.close(); }
    expect(await acls(m.asOwner)).toEqual(unchanged);

    // A failure AFTER the REVOKEs ran: the runtime role inherits INSERT on the permit table through another role, so the post-check refuses and
    // the whole transaction (the REVOKEs included) rolls back; the direct grants are still exactly as before.
    const writer = `flofi_t_writer_${randomBytes(4).toString('hex')}`;
    extraRoles.push(writer);
    const admin = createDatabase({ connectionString: testDatabaseUrl().toString(), maxConnections: 1 });
    try { await admin.query(`CREATE ROLE ${writer} NOLOGIN`); await admin.query(`GRANT ${writer} TO ${m.runtime}`); } finally { await admin.close(); }
    await m.asOwner.query(`GRANT INSERT ON execution_purge_permits TO ${writer}`);
    // Security review: functions planted in `public` that would answer every check "false" cannot fool it (search_path is pg_catalog only).
    await m.asOwner.query(`CREATE FUNCTION public.has_table_privilege(text, text, text) RETURNS boolean LANGUAGE sql AS 'SELECT false'`);
    await m.asOwner.query(`CREATE FUNCTION public.pg_has_role(text, oid, text) RETURNS boolean LANGUAGE sql AS 'SELECT false'`);
    const withWriter = await acls(m.asOwner);
    expect(refusal(await remediate(m))).toBe(`OWNER_HISTORY_PURGE_RUNTIME_PRIVILEGES_OPEN: execution_purge_permits:INSERT, execution_purge_permits:COLUMN, MEMBER:${writer}:execution_purge_permits`);
    expect(await acls(m.asOwner)).toEqual(withWriter);
    expect((await verification(m)).summary).toMatchObject({ runtime_touches_permits: true, runtime_member_writes: true });
    await m.asOwner.query(`DROP FUNCTION public.has_table_privilege(text, text, text)`);
    await m.asOwner.query(`DROP FUNCTION public.pg_has_role(text, oid, text)`);
    await m.asOwner.query(`REVOKE ALL ON execution_purge_permits FROM ${writer}`);
    const admin2 = createDatabase({ connectionString: testDatabaseUrl().toString(), maxConnections: 1 });
    try { await admin2.query(`REVOKE ${writer} FROM ${m.runtime}`); } finally { await admin2.close(); }
    expect(await acls(m.asOwner)).toEqual(unchanged);

    // Security review: a membership the runtime role does NOT inherit (it could still SET ROLE to it) and a predefined write role are refused
    // too; so is a runtime role that could CREATE in schema public (an object there could shadow a function the definer procedure calls).
    const admin3 = createDatabase({ connectionString: testDatabaseUrl().toString(), maxConnections: 1 });
    try {
      await admin3.query(`GRANT ${writer} TO ${m.runtime} WITH INHERIT FALSE, SET TRUE`);
      await m.asOwner.query(`GRANT DELETE ON execution_purge_audit TO ${writer}`);
      expect(refusal(await remediate(m))).toBe(`OWNER_HISTORY_PURGE_RUNTIME_PRIVILEGES_OPEN: MEMBER:${writer}:execution_purge_audit`);
      await m.asOwner.query(`REVOKE ALL ON execution_purge_audit FROM ${writer}`);
      // Data-privacy review: column-level grants and CREATE reached only by SET ROLE are refused as well.
      await m.asOwner.query(`GRANT INSERT (tenant_id, run_id, namespace, log_name, transaction_id) ON execution_purge_permits TO ${writer}`);
      expect(refusal(await remediate(m))).toBe(`OWNER_HISTORY_PURGE_RUNTIME_PRIVILEGES_OPEN: MEMBER:${writer}:execution_purge_permits`);
      await m.asOwner.query(`REVOKE ALL ON execution_purge_permits FROM ${writer}`);
      await m.asOwner.query(`GRANT CREATE ON SCHEMA public TO ${writer}`);
      expect(refusal(await remediate(m))).toBe(`OWNER_HISTORY_PURGE_RUNTIME_PRIVILEGES_OPEN: MEMBER:${writer}:SCHEMA_PUBLIC:CREATE`);
      await m.asOwner.query(`REVOKE CREATE ON SCHEMA public FROM ${writer}`);
      await admin3.query(`REVOKE ${writer} FROM ${m.runtime}`);
      await admin3.query(`GRANT pg_write_all_data TO ${m.runtime} WITH INHERIT FALSE, SET TRUE`);
      expect(refusal(await remediate(m))).toBe('OWNER_HISTORY_PURGE_RUNTIME_PRIVILEGES_OPEN: MEMBER:pg_write_all_data:execution_purge_permits, MEMBER:pg_write_all_data:execution_purge_audit');
      await admin3.query(`REVOKE pg_write_all_data FROM ${m.runtime}`);
      await m.asOwner.query(`GRANT CREATE ON SCHEMA public TO ${m.runtime}`);
      expect(refusal(await remediate(m))).toBe('OWNER_HISTORY_PURGE_RUNTIME_PRIVILEGES_OPEN: SCHEMA_PUBLIC:CREATE');
      await m.asOwner.query(`REVOKE CREATE ON SCHEMA public FROM ${m.runtime}`);
    } finally { await admin3.close(); }
    expect(await acls(m.asOwner)).toEqual(unchanged);

    // A concurrent migration holds the migration lock: the remediation stops at its 5 s lock timeout and changes nothing; it applies once free.
    const holder = new pg.Client({ connectionString: m.url(m.owner) });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK]);
      const started = Date.now(), blocked = await remediate(m);
      expect('error' in blocked ? `${blocked.code}:${blocked.error}` : null).toBe('55P03:canceling statement due to lock timeout');
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      expect(await acls(m.asOwner)).toEqual(unchanged);
    } finally { await holder.query('SELECT pg_advisory_unlock_all()').catch(() => undefined); await holder.end(); }
    expect(refusal(await remediate(m))).toBeNull();
    expect((await verification(m)).summary).toMatchObject({ runtime_writes_tombstones: false, runtime_touches_permits: false, runtime_execute: true });
  });
});
