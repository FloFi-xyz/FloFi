// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001 release certification: the certified 0015 (the SHA-256-pinned fixture) on v14 databases holding N synthetic delegated
 * lineages of the v14 build (delegated rule → occurrence → authorization → revision → execution → budget entry). Synthetic rows only.
 *
 * For each size it runs the runner's own transaction (its advisory lock, ledger read, the exact SQL in two consecutive parts so the new tables
 * and the delegated alterations are timed apart, its ledger row) and measures it while sampling the migrator's lock waits; checks which reads
 * and writes wait while it is open and the locks it holds; and then checks that every row keeps its values, every constraint is validated, the
 * v14 build's delegated writes and schema check still work, and that the documented reversal (§9.3) and a re-application succeed.
 *
 *   FLOFI_0015_SCALE_ROWS=0,10000,100000   lineages per database (default 1000, the CI size)
 *   FLOFI_0015_SCALE_CONTENDED=1           also measure 0015 failing behind a long delegated read (its 5 s lock_timeout) at each size
 *   FLOFI_0015_SCALE_REPORT=<file.json>    write the measurements
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSchemaCompatible, loadMigrations, migrate, SHIPPED_MIGRATIONS, type Database, type Migration, type Queryable } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from './pg-harness.js';

const SIZES = (process.env.FLOFI_0015_SCALE_ROWS ?? '1000').split(',').map(Number);
const CONTENDED = process.env.FLOFI_0015_SCALE_CONTENDED === '1';
const LOCK_ID = 7_340_032_001, V14_BUILD = SHIPPED_MIGRATIONS.slice(0, 14);
const SPLIT = 'ALTER TABLE delegated_authorizations ALTER COLUMN rule_id DROP NOT NULL;';
const TABLES = ['automation_rules', 'automation_occurrences', 'delegated_authorizations', 'delegated_authorization_revisions', 'delegated_executions', 'delegated_budget_entries'];
let V14M: readonly Migration[], M15: Migration, PARTS: readonly [string, string], REVERSAL: string;
const report: Record<string, unknown>[] = [];
const dropped: TestDatabase[] = [];
beforeAll(async () => {
  const sql = await readFile(new URL('./fixtures/0015_workflow_runs.sql', import.meta.url), 'utf8');
  M15 = { version: 15, name: 'workflow_runs', sql, sha256: createHash('sha256').update(sql).digest('hex') };
  V14M = (await loadMigrations()).slice(0, 14);
  const at = sql.indexOf(SPLIT);
  PARTS = [sql.slice(0, at), sql.slice(at)];
  const doc = await readFile(new URL('../../../docs/deploy/SCHEMA-COMPATIBILITY.md', import.meta.url), 'utf8');
  const section = doc.slice(doc.indexOf('### 9.3')), start = section.indexOf('```sql\n') + '```sql\n'.length;
  REVERSAL = section.slice(start, section.indexOf('\n```', start));
});
afterAll(async () => {
  await Promise.allSettled(dropped.map(t => t.drop()));
  if (process.env.FLOFI_0015_SCALE_REPORT) await writeFile(process.env.FLOFI_0015_SCALE_REPORT, JSON.stringify(report, null, 2) + '\n');
}, 120_000);

const ms = (from: number, to: number) => Math.round((to - from) * 10) / 10, sum = (...parts: number[]) => Math.round(parts.reduce((a, b) => a + b, 0) * 10) / 10;
/** A 26-character base-32 id suffix ([a-z2-7]) unique for every integer `g` below 2^60. */
const id = (prefix: string) => `'${prefix}' || (SELECT string_agg(substr('abcdefghijklmnopqrstuvwxyz234567', CASE WHEN i < 12 THEN ((g >> (5 * i)) & 31)::int ELSE 0 END + 1, 1), '' ORDER BY i)
  FROM generate_series(0, 25) i)`;
const owner = `'0x' || lpad(to_hex(g), 40, '0')`, hash = `'0x' || md5(g::text) || md5(g::text)`;
/** v14 delegated lineages `from`..`to` exactly as the v14 stores shape them (every 10th execution still open). */
async function lineages(db: Queryable, from: number, to: number) {
  const range = `FROM generate_series(${from}::bigint, ${to}::bigint) g`;
  await db.query(`INSERT INTO automation_rules (tenant_id, rule_id, owner_namespace, owner_account, display_name, kind, state, execution_mode, authorization_id, definition,
    action_strategy, action_workflow_hash, engine_version, timezone, next_evaluation_at)
    SELECT 'default', ${id('aut_')}, 'eip155', ${owner}, 'DCA', 'SCHEDULED_DCA', 'ACTIVE', 'DELEGATED_WITH_LIMITS', ${id('dau_')}, '{}', '{}', ${hash}, 'flofi-engine-2', 'UTC', now() ${range}`);
  await db.query(`INSERT INTO delegated_authorizations (tenant_id, authorization_id, owner_namespace, owner_account, rule_id, state)
    SELECT 'default', ${id('dau_')}, 'eip155', ${owner}, ${id('aut_')}, 'EXPIRED' ${range}`);
  await db.query(`INSERT INTO delegated_authorization_revisions (tenant_id, authorization_id, revision, owner_namespace, owner_account, state, strategy, workflow_hash, manifest,
    manifest_hash) SELECT 'default', ${id('dau_')}, 1, 'eip155', ${owner}, 'EXPIRED', '{}', ${hash}, '{}', ${hash} ${range}`);
  await db.query(`INSERT INTO automation_occurrences (tenant_id, occurrence_id, rule_id, owner_namespace, owner_account, trigger_key, kind, state, strategy, workflow_hash, due_at,
    expires_at, decided_at) SELECT 'default', ${id('occ_')}, ${id('aut_')}, 'eip155', ${owner}, 'slot:' || g, 'SCHEDULE', 'DELEGATED', '{}', ${hash}, now(), now() + interval '1 hour', now() ${range}`);
  await db.query(`INSERT INTO delegated_executions (tenant_id, execution_id, authorization_id, revision, owner_namespace, owner_account, rule_id, occurrence_id, state, workflow_hash,
    manifest_hash, step_count, settled_at) SELECT 'default', ${id('dex_')}, ${id('dau_')}, 1, 'eip155', ${owner}, ${id('aut_')}, ${id('occ_')},
    CASE WHEN g % 10 = 0 THEN 'QUEUED' ELSE 'SETTLED' END, ${hash}, ${hash}, 1, CASE WHEN g % 10 = 0 THEN NULL ELSE now() END ${range}`);
  await db.query(`INSERT INTO delegated_budget_entries (tenant_id, authorization_id, execution_id, step_index, asset, reserved_amount, spent_amount, state, day_start, week_start,
    month_start) SELECT 'default', ${id('dau_')}, ${id('dex_')}, 0, 'eip155:84532/erc20:0x' || lpad(to_hex(g), 40, '0'), 1000, 990, 'SPENT', date_trunc('day', now()),
    date_trunc('week', now()), date_trunc('month', now()) ${range}`);
}
/** Row count and digest of every table, over the columns each had before 0015. */
async function digest(db: Queryable, columns: Record<string, readonly string[]>) {
  const out: Record<string, { rows: number; md5: string }> = {};
  for (const [table, names] of Object.entries(columns)) {
    const row = `(${names.map(n => `x."${n}"`).join(', ')})::text`;
    out[table] = (await db.query<{ rows: number; md5: string }>(`SELECT count(*)::int AS rows, md5(coalesce(string_agg(${row}, E'\\n' ORDER BY ${row}), '')) AS md5
      FROM "${table}" x`)).rows[0]!;
  }
  return out;
}
/** The definition of the delegated tables (columns, constraints, indexes, triggers): what 0015 changes and §9.3 restores. */
async function delegatedShape(db: Queryable) {
  return (await db.query<{ k: string }>(`
    SELECT 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull AS k
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL SELECT 'con ' || conrelid::regclass || '.' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid::regclass::text = ANY($1)
    UNION ALL SELECT 'idx ' || indexrelid::regclass || ' ' || pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid::regclass::text = ANY($1)
    UNION ALL SELECT 'trg ' || tgrelid::regclass || '.' || tgname FROM pg_trigger WHERE tgrelid::regclass::text = ANY($1) AND NOT tgisinternal
    ORDER BY 1`, [['delegated_authorizations', 'delegated_executions']])).rows.map(r => r.k);
}
/** 'OK', or the SQLSTATE `sql` failed with when it would wait longer than 300 ms for a lock (55P03). */
const probe = (db: Database, sql: string) => db.transaction(async tx => { await tx.query(`SET LOCAL lock_timeout = '300ms'`); await tx.query(sql); })
  .then(() => 'OK', (error: { code?: string }) => error.code ?? 'ERROR');
/** How long `sql` took (it may wait for a lock), and its outcome. */
async function timed(db: Database, sql: string) {
  const t0 = performance.now();
  const result = await db.query(sql).then(() => 'OK', (error: { code?: string }) => error.code ?? 'ERROR');
  return { ms: ms(t0, performance.now()), result };
}
/** Samples one backend's wait events until `done`: the longest continuous wait on a lock it was seen in. */
function lockWaits(db: Database, pid: () => number | null, done: () => boolean) {
  return (async () => {
    let longest = 0, since: number | null = null, samples = 0;
    while (!done()) {
      const target = pid();
      if (target !== null) {
        const { rows } = await db.query<{ w: string | null }>('SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1', [target]);
        samples++;
        const now = performance.now();
        if (rows[0]?.w === 'Lock') { since ??= now; longest = Math.max(longest, now - since); } else since = null;
      }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    return { samples, longestLockWaitMs: ms(0, longest) };
  })();
}

const EXPECTED_LOCKS = [
  { relname: 'delegated_authorizations', mode: 'AccessExclusiveLock' }, { relname: 'delegated_authorizations', mode: 'AccessShareLock' },
  { relname: 'delegated_authorizations', mode: 'ShareLock' }, { relname: 'delegated_authorizations', mode: 'ShareRowExclusiveLock' },
  { relname: 'delegated_executions', mode: 'AccessExclusiveLock' }, { relname: 'delegated_executions', mode: 'AccessShareLock' },
  { relname: 'delegated_executions', mode: 'ShareLock' }, { relname: 'delegated_executions', mode: 'ShareRowExclusiveLock' },
  { relname: 'mcp_handoffs', mode: 'AccessShareLock' }, { relname: 'mcp_handoffs', mode: 'ShareRowExclusiveLock' },
  { relname: 'schema_migrations', mode: 'AccessShareLock' }, { relname: 'schema_migrations', mode: 'RowExclusiveLock' },
  { relname: 'tenants', mode: 'AccessShareLock' }, { relname: 'tenants', mode: 'ShareRowExclusiveLock' }];
// What waits while 0015 is open (55P03 = it would have waited), read with each statement taking its lock but touching no row.
const PROBES: Record<string, [string, 'OK' | '55P03']> = {
  'delegated_authorizations read': ['SELECT count(*) FROM delegated_authorizations', '55P03'],
  'delegated_executions read': ['SELECT count(*) FROM delegated_executions', '55P03'],
  'delegated_executions write': [`UPDATE delegated_executions SET version = version WHERE false`, '55P03'],
  'delegated_budget_entries read': ['SELECT count(*) FROM delegated_budget_entries', 'OK'],
  'automation_rules write': [`UPDATE automation_rules SET version = version WHERE false`, 'OK'],
  'mcp_handoffs read': ['SELECT count(*) FROM mcp_handoffs', 'OK'],
  'mcp_handoffs write': [`UPDATE mcp_handoffs SET status = status WHERE false`, '55P03'],
  'tenants read': ['SELECT count(*) FROM tenants', 'OK'],
  'tenants write': [`UPDATE tenants SET tenant_id = tenant_id WHERE false`, '55P03'],
  'execution_runs write': [`UPDATE execution_runs SET status = status WHERE false`, 'OK'],
  'work queue write': [`UPDATE work_items SET state = state WHERE false`, 'OK'],
};

describe('BUILD-CHAT-E2E-001 0015 on v14 databases with synthetic delegated lineages (PostgreSQL)', () => {
  for (const size of SIZES) it(`${size} lineages: duration, lock waits and locks, what waits, rows, constraints, v14 writes, reversal and re-application`, async () => {
    const t = await createTestDatabase({ migrated: false });
    dropped.push(t);
    await migrate(t.db, V14M);
    const seeded0 = performance.now();
    if (size > 0) await lineages(t.db, 1, size);
    await t.db.query('ANALYZE');
    const entry: Record<string, unknown> = { lineages: size, seedMs: ms(seeded0, performance.now()),
      bytes: (await t.db.query<{ b: string }>(`SELECT pg_total_relation_size('delegated_authorizations') + pg_total_relation_size('delegated_executions') AS b`)).rows[0]!.b };
    const columns: Record<string, string[]> = {};
    for (const r of (await t.db.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = ANY($1) ORDER BY table_name, ordinal_position`, [TABLES])).rows) (columns[r.table_name] ??= []).push(r.column_name);
    const before = await digest(t.db, columns), shape14 = await delegatedShape(t.db);
    expect(before.delegated_executions!.rows).toBe(size);

    if (CONTENDED) {
      // A long delegated read holds its lock past 0015's 5 s lock_timeout: 0015 fails and rolls back; what queued behind it waited until then.
      const reader = t.open(1), app = t.open(3);
      let holding!: () => void, release!: () => void;
      const held = new Promise<void>(resolve => { holding = resolve; }), freed = new Promise<void>(resolve => { release = resolve; });
      const blocker = reader.transaction(async tx => { await tx.query('SELECT count(*) FROM delegated_executions'); holding(); await freed; });
      await held;
      const t0 = performance.now(), failed = migrate(t.open(1), [...V14M, M15]).then(() => 'APPLIED', (error: { code?: string }) => error.code ?? 'ERROR');
      await new Promise(resolve => setTimeout(resolve, 500));
      const [handoffWrite, delegatedRead, runWrite] = await Promise.all([timed(app, `UPDATE mcp_handoffs SET status = status WHERE false`),
        timed(app, 'SELECT count(*) FROM delegated_authorizations'), timed(app, `UPDATE execution_runs SET status = status WHERE false`)]);
      const outcome = await failed, failedAfterMs = ms(t0, performance.now());
      release(); await blocker;
      expect(outcome).toBe('55P03');
      expect({ ledger: (await t.db.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0], rows: await digest(t.db, columns), shape: await delegatedShape(t.db) })
        .toEqual({ ledger: { v: 14 }, rows: before, shape: shape14 });
      entry.contended = { outcome, failedAfterMs, waitedBehindIt: { handoffWrite, delegatedRead }, notWaiting: { runWrite } };
    }

    // The runner's transaction, measured.
    const migrator = t.open(1), sampler = t.open(1), app = t.open(4);
    let pid: number | null = null, finished = false;
    const waits = lockWaits(sampler, () => pid, () => finished);
    const marks: Record<string, number> = {};
    let locks: { relname: string; mode: string }[] = [];
    const probes: Record<string, string> = {};
    marks.start = performance.now();
    await migrator.transaction(async tx => {
      pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      await tx.query('SELECT version, name, sha256 FROM schema_migrations ORDER BY version');
      marks.locked = performance.now();
      await tx.query(PARTS[0]);
      marks.tables = performance.now();
      await tx.query(PARTS[1]);
      marks.delegated = performance.now();
      await tx.query('INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)', [M15.version, M15.name, M15.sha256]);
      marks.ledger = performance.now();
      // Open, before its commit (not counted in the timings): the locks it holds and what waits for them.
      locks = (await app.query<{ relname: string; relkind: string; mode: string }>(`SELECT c.relname, c.relkind::text, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = $1 AND l.granted AND c.relnamespace = 'public'::regnamespace ORDER BY 1, 3`, [pid])).rows
        .filter(l => l.relkind === 'r' && !/^workflow_run/.test(l.relname)).map(({ relname, mode }) => ({ relname, mode }));
      for (const [name, [sql]] of Object.entries(PROBES)) probes[name] = await probe(app, sql);
      marks.commit = performance.now();
    });
    marks.committed = performance.now();
    finished = true;
    const sampled = await waits;
    const commit = marks.committed! - marks.commit!;
    entry.migration = { totalMs: sum(ms(marks.start!, marks.ledger!), ms(0, commit)), lockAndLedgerReadMs: ms(marks.start!, marks.locked!),
      newTablesMs: ms(marks.locked!, marks.tables!), delegatedAlterationsMs: ms(marks.tables!, marks.delegated!), ledgerRowMs: ms(marks.delegated!, marks.ledger!), commitMs: ms(0, commit),
      // How long each lock blocks others (from its acquisition to the commit): handoff/tenant writes from the new tables on, delegated reads/writes from the alterations on.
      handoffAndTenantWritesBlockedMs: sum(ms(marks.locked!, marks.ledger!), ms(0, commit)), delegatedReadsAndWritesBlockedMs: sum(ms(marks.tables!, marks.ledger!), ms(0, commit)), ...sampled };
    entry.locks = locks;
    entry.probes = probes;
    expect(locks).toEqual(EXPECTED_LOCKS);
    expect(probes).toEqual(Object.fromEntries(Object.entries(PROBES).map(([name, [, expected]]) => [name, expected])));

    // Afterwards: every row as before, every constraint validated, no workflow-run source, the v14 build serving and writing.
    expect(await digest(t.db, columns)).toEqual(before);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND NOT convalidated`)).rows[0]).toEqual({ n: 0 });
    expect((await t.db.query(`SELECT count(*)::int AS n FROM delegated_executions WHERE workflow_run_id IS NOT NULL`)).rows[0]).toEqual({ n: 0 });
    expect(await assertSchemaCompatible(t.db, V14_BUILD)).toMatchObject({ version: 15, application: 14 });
    expect(await migrate(t.db, V14M)).toEqual([]);
    await lineages(t.db, size + 1, size + 1);
    await t.db.query(`UPDATE delegated_executions SET state = 'AUTHORITY_VERIFIED', version = version + 1 WHERE execution_id = (SELECT execution_id FROM delegated_executions
      WHERE state = 'QUEUED' ORDER BY execution_id LIMIT 1)`);

    // The documented reversal (§9.3) on this size, and the re-application by the real runner.
    const r0 = performance.now();
    await t.db.query(REVERSAL);
    entry.reversalMs = ms(r0, performance.now());
    expect(await delegatedShape(t.db)).toEqual(shape14);
    expect(await assertSchemaCompatible(t.db, V14_BUILD)).toEqual({ version: 14, application: 14, forward: [] });
    const a0 = performance.now();
    expect(await migrate(t.db, [...V14M, M15])).toEqual([15]);
    entry.reapplyMs = ms(a0, performance.now());
    report.push(entry);
    console.info(`0015 at ${size} lineages: ${JSON.stringify(entry.migration)} reversal ${entry.reversalMs} ms, re-application ${entry.reapplyMs} ms`
      + (entry.contended ? ` contended ${JSON.stringify(entry.contended)}` : ''));
  }, 600_000);
});
