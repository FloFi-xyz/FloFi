// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-DB-COMPAT-001 on PostgreSQL: real ledgers, the real migration runner and the real 0012 — the exact bytes BUILD-ADMIN-001 will
 * release (a SHA-256-pinned fixture, never shipped from here). Who is who:
 *
 *   v11 build       this package's checks with the history up to 0011 and its certificate for 0012 (the compatibility release)
 *   unpatched v11   the released fa7816b module, vendored byte for byte (`baseline/`): what is deployed before the compatibility release
 *   v12 build       the same history plus 0012 (BUILD-ADMIN-001), checks and runner
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, CERTIFIED_FORWARD_MIGRATIONS, createPostgresLogStore, createPostgresWorkQueue, ensureTenant,
  loadMigrations, migrate, SHIPPED_MIGRATIONS, sweep, type Database, type Migration, type MigrationIdentity, type Queryable } from '../src/index.js';
import * as unpatched from './baseline/migrations-fa7816b.js';
import { bytes, createTestDatabase, text, type TestDatabase } from './pg-harness.js';

const ADMIN = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.migrations.some(m => m.name === 'admin_control_plane'))!;
const PREVIOUS = SHIPPED_MIGRATIONS.slice(0, ADMIN.base.version);
const identity = ({ version, name, sha256 }: MigrationIdentity): MigrationIdentity => ({ version, name, sha256 });
let V11: readonly Migration[], V12: readonly Migration[], M12: Migration;
const dropped: TestDatabase[] = [];
beforeAll(async () => {
  const sql = await readFile(new URL('./fixtures/0012_admin_control_plane.sql', import.meta.url), 'utf8');
  M12 = { version: 12, name: 'admin_control_plane', sql, sha256: createHash('sha256').update(sql).digest('hex') };
  V11 = (await loadMigrations()).slice(0, ADMIN.base.version);
  V12 = [...V11, M12];
});
// Each test's databases are dropped after it (a DROP DATABASE waits for a checkpoint: dozens at once can outlast a default hook timeout).
afterEach(async () => { await Promise.allSettled(dropped.splice(0).map(t => t.drop())); }, 60_000);

async function database(migrations: readonly Migration[]): Promise<TestDatabase> {
  const t = await createTestDatabase({ migrated: false });
  dropped.push(t);
  await migrate(t.db, migrations);
  return t;
}
const outcome = (work: Promise<unknown>) => work.then(value => ({ value }), (error: Error & { code?: unknown }) => ({ error: typeof error.code === 'string' ? error.code : error.message }));
const MISMATCH = { error: 'MIGRATION_HISTORY_MISMATCH' }, BEHIND = { error: 'SCHEMA_NOT_MIGRATED' };
const ledger = async (db: Queryable) => (await db.query(`SELECT version, name, sha256, applied_at::text FROM schema_migrations ORDER BY version`)).rows;
/** Runs `sql` in a transaction that refuses to wait for a lock longer than `ms`: 'OK' or the SQLSTATE it failed with (55P03: it would wait). */
const probe = (db: Database, sql: string, values: readonly unknown[] = [], ms = 300) =>
  db.transaction(async tx => { await tx.query(`SET LOCAL lock_timeout = '${ms}ms'`); await tx.query(sql, values); })
    .then(() => 'OK', (error: { code?: string }) => error.code ?? 'ERROR');
/** `work`'s result, or 'TIMEOUT' when it is still waiting after `ms` (it keeps running). */
const within = <T>(work: Promise<T>, ms: number) => Promise.race([work, new Promise<'TIMEOUT'>(resolve => setTimeout(() => resolve('TIMEOUT'), ms))]);

/**
 * Every object in schema `public` and its definition: relations, columns, constraints, indexes, triggers (internal foreign-key triggers
 * by constraint and function, their names being OIDs), functions, types, policies. Two databases with the same map have the same schema.
 */
async function catalog(db: Queryable): Promise<Map<string, string>> {
  const { rows } = await db.query<{ key: string; def: string }>(`
    SELECT 'relation:' || c.relname AS key, c.relkind::text || ' rls=' || c.relrowsecurity || ' acl=' || coalesce(c.relacl::text, '') || ' opts=' || coalesce(c.reloptions::text, '') AS def
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    UNION ALL SELECT 'column:' || c.relname || '.' || a.attname, format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull
        || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' identity=' || a.attidentity::text || ' generated=' || a.attgenerated::text || ' collation=' || a.attcollation::text
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL SELECT 'constraint:' || c.relname || '.' || k.conname, pg_get_constraintdef(k.oid) || ' deferrable=' || k.condeferrable
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = 'public'::regnamespace
    UNION ALL SELECT 'index:' || i.relname, pg_get_indexdef(i.oid) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE i.relnamespace = 'public'::regnamespace
    UNION ALL SELECT 'trigger:' || c.relname || '.' || CASE WHEN t.tgisinternal THEN 'internal:' || coalesce(k.conname, '?') || ':' || p.proname ELSE t.tgname::text END,
        CASE WHEN t.tgisinternal THEN 'type=' || t.tgtype ELSE pg_get_triggerdef(t.oid) END || ' enabled=' || t.tgenabled::text
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid LEFT JOIN pg_constraint k ON k.oid = t.tgconstraint
      WHERE c.relnamespace = 'public'::regnamespace
    UNION ALL SELECT 'function:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', md5(pg_get_functiondef(p.oid))
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
    UNION ALL SELECT 'type:' || t.typname, t.typtype::text || ' ' || format_type(t.typbasetype, t.typtypmod) || ' ' || coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '')
      FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typtype IN ('e', 'd')
    UNION ALL SELECT 'policy:' || c.relname || '.' || pol.polname, coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
      FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid WHERE c.relnamespace = 'public'::regnamespace`);
  const map = new Map<string, string>();
  for (const { key, def } of rows) map.set(map.has(key) ? `${key}#${[...map.keys()].filter(k => k.startsWith(key)).length}` : key, def);
  return map;
}
/** A digest of every row of each table: the same digests mean the same data. */
async function data(db: Queryable, tables: readonly string[]): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const table of tables)
    digests[table] = (await db.query<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) AS h FROM "${table}" x`)).rows[0]!.h;
  return digests;
}
const RULE = 'aut_' + 'a'.repeat(26), OWNER = '0x' + 'ab'.repeat(20);
/** v11 data of the kinds 0012 sits next to: a run (API), a journal and queued work (worker), an automation rule and its evaluations. */
async function seed(db: Database): Promise<void> {
  await db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ('default', 'wf-1')`);
  await db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256)
    VALUES ('default', 'aave-supply', 'run-1.jsonl', 'RUN', 1, 1, 2, $1)`, ['0'.repeat(64)]);
  await db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, needs_observation, has_evidence, log_version)
    VALUES ('default', 'run-1', 'aave-supply', 'run-1.jsonl', 'wf-1', 'aave-supply', 'PREPARED', 'MOCKED', false, false, 1)`);
  await createPostgresLogStore({ db, tenantId: 'default', namespace: 'compat' }).create('seed.jsonl', bytes('{"seed":1}\n'));
  await createPostgresWorkQueue({ db, ownerId: 'seed', tenantId: 'default' }).enqueue('default', 'reconcile', 'compat:seed', null);
  await db.query(`INSERT INTO automation_rules (tenant_id, rule_id, owner_namespace, owner_account, display_name, kind, state, definition, timezone, next_evaluation_at)
    VALUES ('default', $1, 'eip155', $2, 'Watch', 'DAILY_WATCH', 'ACTIVE', '{}', 'UTC', now())`, [RULE, OWNER]);
  await db.query(`INSERT INTO automation_evaluations (tenant_id, rule_id, at, outcome) SELECT 'default', $1, now() - make_interval(mins => g), 'CONDITION_NOT_MET'
    FROM generate_series(1, 50) g`, [RULE]);
}

describe('BUILD-DB-COMPAT-001 schema checks and runners on real ledgers (PostgreSQL)', () => {
  it('1–4: v11 on v11 passes; the v11 build passes on the certified v12; unpatched v11 refuses it as released; a v10 database is refused', async () => {
    const [at10, at11, at12] = await Promise.all([database(V11.slice(0, 10)), database(V11), database(V12)]);
    // 1. Exactly this build's schema.
    expect(await assertSchemaCompatible(at11.db, PREVIOUS)).toEqual({ version: 11, application: 11, forward: [] });
    expect(await unpatched.assertSchemaCurrent(at11.db, PREVIOUS)).toBe(11);
    // 2. The real 0012, applied by the real runner: the v11 build serves on it, and says so.
    expect(await assertSchemaCompatible(at12.db, PREVIOUS)).toEqual({ version: 12, application: 11, forward: [identity(M12)] });
    expect((await assertSchemaCompatible(at12.db)).version).toBe(12); // the backend's default: this build's migration files
    // 3. The released (unpatched) build refuses it on every cold start, as before; so does the strict check, which is unchanged.
    expect(await outcome(unpatched.assertSchemaCurrent(at12.db, PREVIOUS))).toEqual(MISMATCH);
    expect(await outcome(assertSchemaCurrent(at12.db, PREVIOUS))).toEqual(MISMATCH);
    expect(await outcome(assertSchemaCompatible(at12.db, PREVIOUS, []))).toEqual(MISMATCH);
    // 4. Behind: refused by every build.
    for (const check of [() => assertSchemaCompatible(at10.db, PREVIOUS), () => unpatched.assertSchemaCurrent(at10.db, PREVIOUS), () => assertSchemaCompatible(at11.db, V12)])
      expect(await outcome(check())).toEqual(BEHIND);
    // The v12 build needs exactly its schema.
    expect(await assertSchemaCompatible(at12.db, V12)).toEqual({ version: 12, application: 12, forward: [] });
  });

  it('5–8: an edited historical or certified migration, an unknown 0013 and an inconsistent ledger fail closed and change nothing', async () => {
    const t = await database(V12), original = await ledger(t.db), shape = await catalog(t.db);
    const restore = async () => {
      await t.db.query('DELETE FROM schema_migrations');
      for (const row of original) await t.db.query('INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES ($1, $2, $3, $4)', [row.version, row.name, row.sha256, row.applied_at]);
    };
    const v13 = { version: 13, name: 'later_change', sha256: 'e'.repeat(64) };
    const cases: Array<[string, string, unknown[]]> = [
      ['5. an edited historical checksum', `UPDATE schema_migrations SET sha256 = $1 WHERE version = 7`, ['0'.repeat(64)]],
      ['6. an edited 0012 checksum', `UPDATE schema_migrations SET sha256 = $1 WHERE version = 12`, ['f'.repeat(64)]],
      ['6. a renamed 0012', `UPDATE schema_migrations SET name = 'admin_control_plane_v2' WHERE version = 12`, []],
      ['7. an unknown 0013', `INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)`, [v13.version, v13.name, v13.sha256]],
      ['8. a missing historical migration', `DELETE FROM schema_migrations WHERE version = 6`, []],
      ['8. 0012 without 0011', `DELETE FROM schema_migrations WHERE version = 11`, []],
      ['8. 0012 recorded out of sequence', `UPDATE schema_migrations SET version = 13 WHERE version = 12`, []],
    ];
    for (const [label, sql, values] of cases) {
      await t.db.query(sql, values);
      const tampered = await ledger(t.db);
      const results = { label,
        v11: await outcome(assertSchemaCompatible(t.db, PREVIOUS)), v11Runner: await outcome(migrate(t.db, V11)),
        v12: await outcome(assertSchemaCompatible(t.db, V12)), v12Runner: await outcome(migrate(t.db, V12)) };
      expect(results).toEqual({ label, v11: MISMATCH, v11Runner: MISMATCH, v12: MISMATCH, v12Runner: MISMATCH });
      expect(await ledger(t.db)).toEqual(tampered);
      // 7. Only a certificate admits a newer migration — one naming 0013 for the v11 build would (none does).
      if (label.startsWith('7.')) expect((await assertSchemaCompatible(t.db, PREVIOUS, [{ ...ADMIN, migrations: [...ADMIN.migrations, v13] }])).forward)
        .toEqual([identity(M12), v13]);
      await restore();
    }
    expect(await catalog(t.db)).toEqual(shape);

    // A ledger "downgraded" by hand (0012's row removed, its tables left): v11 needs none of them; the v12 build sees an unmigrated
    // schema, and its runner fails closed re-creating a table that exists — rolled back whole, nothing changed.
    await t.db.query('DELETE FROM schema_migrations WHERE version = 12');
    expect(await assertSchemaCompatible(t.db, PREVIOUS)).toEqual({ version: 11, application: 11, forward: [] });
    expect(await outcome(assertSchemaCompatible(t.db, V12))).toEqual(BEHIND);
    expect(await outcome(migrate(t.db, V12))).toEqual({ error: '42P07' });
    expect((await ledger(t.db)).length).toBe(11);
    expect(await catalog(t.db)).toEqual(shape);
    await restore();

    // 0012 partially present without its ledger row (objects created by hand): the v12 runner fails closed and applies none of it.
    const partial = await database(V11);
    await partial.db.query(`CREATE TABLE admin_run_facts (tenant_id text)`);
    const before = await catalog(partial.db);
    expect(await outcome(migrate(partial.db, V12))).toEqual({ error: '42P07' });
    expect(await catalog(partial.db)).toEqual(before);
    expect((await ledger(partial.db)).length).toBe(11);
  });

  it('10: a runner never changes a database that is ahead of it — certified: nothing to apply; otherwise it fails closed', async () => {
    const t = await database(V12), shape = await catalog(t.db), original = await ledger(t.db);
    const unchanged = async () => { expect(await catalog(t.db)).toEqual(shape); expect(await ledger(t.db)).toEqual(original); };
    expect(await migrate(t.db, V11)).toEqual([]);            // the v11 build's deploy step (Railway pre-deploy) on a v12 database
    expect(await migrate(t.db)).toEqual([]);                 // the same with this build's migration files, as `main.ts migrate` runs it
    expect(await migrate(t.db, V12)).toEqual([]);            // the v12 runner: exact
    await unchanged();
    expect(await outcome(unpatched.migrate(t.db, V11))).toEqual(MISMATCH); // the released runner refuses it (a rollback below 0012 cannot deploy)
    expect(await outcome(migrate(t.db, V11.slice(0, 10)))).toEqual(MISMATCH); // a v10 runner holds no certificate
    expect(await outcome(migrate(t.db, V11, []))).toEqual(MISMATCH);
    await unchanged();
  });

  it('9: concurrent runners while v11 instances cold-start and write: 0012 applies once; patched instances never fail; unpatched ones refuse after it', async () => {
    const t = await database(V11);
    let stop = false;
    const versions: number[] = [], failures: string[] = [], refusals: string[] = [];
    let iterations = 0;
    /** One cold instance per iteration (its own pool): the startup check, then the writes an API/worker instance makes. */
    const instance = async (index: number, kind: 'patched' | 'unpatched') => {
      for (let n = 0; !stop; n++) {
        const db = t.open(2);
        try {
          if (kind === 'unpatched') { await unpatched.assertSchemaCurrent(db, PREVIOUS); continue; }
          const schema = await assertSchemaCompatible(db, PREVIOUS);
          await ensureTenant(db, 'default');
          const log = createPostgresLogStore({ db, tenantId: 'default', namespace: 'compat' }), name = `i${index}-${n}.jsonl`;
          await log.create(name, bytes('{"a":1}\n'));
          await log.extend(name, bytes('{"a":1}\n{"b":2}\n'), () => undefined);
          const queue = createPostgresWorkQueue({ db, ownerId: `i${index}`, tenantId: 'default' });
          await queue.enqueue('default', `compat-${index}`, name, null);
          for (const item of await queue.claim(5, [`compat-${index}`])) await queue.complete(item);
          if (text(await log.read(name)) !== '{"a":1}\n{"b":2}\n') throw new Error('JOURNAL_READ_MISMATCH');
          versions.push(schema.version);
          iterations++;
        } catch (error) { (kind === 'patched' ? failures : refusals).push((error as Error).message); }
        finally { await db.close(); }
      }
    };
    const loops = [0, 1, 2, 3].map(i => instance(i, 'patched')).concat([instance(9, 'unpatched')]);
    await vi.waitFor(() => { if (iterations < 12) throw new Error('warming'); }, { timeout: 60_000, interval: 25 });
    const runners = await Promise.all([migrate(t.open(1), V12), migrate(t.open(1), V12), migrate(t.open(1), V12), migrate(t.open(1), V11)]);
    const after = iterations;
    await vi.waitFor(() => { if (iterations < after + 12) throw new Error('serving'); }, { timeout: 60_000, interval: 25 });
    stop = true;
    await Promise.all(loops);

    expect(runners.slice(0, 3).flat()).toEqual([12]);       // exactly one v12 runner applied 0012
    expect(runners[3]).toEqual([]);                         // the v11 runner applied nothing (before: exact; after: certified)
    expect((await t.db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = 12`)).rows).toEqual([{ n: 1 }]);
    expect(failures).toEqual([]);
    expect(new Set(versions)).toEqual(new Set([11, 12]));
    expect(refusals.length).toBeGreaterThan(0);
    expect(new Set(refusals)).toEqual(new Set(['MIGRATION_HISTORY_MISMATCH']));
  });
});

describe('BUILD-DB-COMPAT-001 what 0012 does to a v11 database (PostgreSQL)', () => {
  it('is purely additive: no pre-existing object or row changes; every addition to a pre-existing relation is listed', async () => {
    const t = await database(V11);
    await seed(t.db);
    const before = await catalog(t.db);
    const tables = [...before.keys()].filter(k => k.startsWith('relation:') && before.get(k)!.startsWith('r ')).map(k => k.slice('relation:'.length))
      .filter(table => table !== 'schema_migrations');
    const rows = await data(t.db, tables), history = await ledger(t.db);
    expect(await migrate(t.db, V12)).toEqual([12]);
    expect((await ledger(t.db)).slice(0, -1)).toEqual(history);                                       // the ledger only gains 0012's row
    const after = await catalog(t.db);

    expect([...before.keys()].filter(key => !after.has(key))).toEqual([]);                          // nothing removed
    expect([...before.keys()].filter(key => after.has(key) && after.get(key) !== before.get(key))).toEqual([]); // nothing redefined
    expect(await data(t.db, tables)).toEqual(rows);                                                   // no existing row touched
    const added = [...after.keys()].filter(key => !before.has(key)).sort();
    const own = (key: string) => /^(relation|index|function):admin_/.test(key) || /^(column|constraint|trigger):admin_[a-z_]+\./.test(key);
    // The only additions to pre-existing relations: one read index on the evaluation history, and the foreign-key triggers PostgreSQL
    // creates on `tenants` for the three admin tables that reference it (they fire only on a tenant UPDATE/DELETE, which nothing does).
    expect(added.filter(key => !own(key))).toEqual([
      'index:automation_evaluations_at',
      ...['admin_audit_events', 'admin_principals', 'admin_settings_versions'].flatMap(table =>
        ['RI_FKey_noaction_del', 'RI_FKey_noaction_upd'].map(fn => `trigger:tenants.internal:${table}_tenant_id_fkey:${fn}`)),
    ]);
    expect(after.get('index:automation_evaluations_at')).toBe('CREATE INDEX automation_evaluations_at ON public.automation_evaluations USING btree (tenant_id, at)');
    expect(added.filter(key => key.startsWith('relation:'))).toEqual(['relation:admin_audit_events', 'relation:admin_audit_events_event_id_seq',
      'relation:admin_principals', 'relation:admin_run_facts', 'relation:admin_sessions', 'relation:admin_settings_versions']);
    expect(added.filter(key => key.startsWith('function:'))).toEqual(['function:admin_principal_transition()', 'function:admin_session_transition()', 'function:admin_settings_gapless()']);
  });

  it('the documented emergency reversal restores the exact v11 catalog and refuses, unchanged, anything but the certified 0012 as newest', async () => {
    const doc = await readFile(new URL('../../../docs/deploy/SCHEMA-COMPATIBILITY.md', import.meta.url), 'utf8');
    const section = doc.slice(doc.indexOf('### 5.1')), start = section.indexOf('```sql\n') + '```sql\n'.length;
    const reversal = section.slice(start, section.indexOf('\n```', start));
    expect(reversal).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
    const v11 = await catalog((await database(V11)).db);
    // Refused (one session each: a refused block leaves its transaction aborted): an edited 0012, or a later migration on top of it.
    for (const tamper of [`UPDATE schema_migrations SET sha256 = repeat('f', 64) WHERE version = 12`,
      `INSERT INTO schema_migrations (version, name, sha256) VALUES (13, 'later_change', repeat('e', 64))`]) {
      const t = await database(V12), session = t.open(1);
      await t.db.query(tamper);
      const before = { shape: await catalog(t.db), history: await ledger(t.db) };
      expect(await outcome(session.query(reversal))).toEqual({ error: 'P0001' });
      await session.close();
      expect({ shape: await catalog(t.db), history: await ledger(t.db) }).toEqual(before);
    }
    // Applied on a v12 database holding admin data: exactly the v11 catalog again; the v11 build serves; 0012 applies again.
    const t = await database(V12);
    await t.db.query(`INSERT INTO admin_settings_versions (tenant_id, setting_key, version, document, created_by) VALUES ('default', 'copilot', 1, NULL, 'cli')`);
    await t.db.query(`INSERT INTO admin_audit_events (tenant_id, actor, kind, outcome) VALUES ('default', 'cli', 'ADMIN_GRANTED', 'OK')`);
    await t.db.query(reversal);
    expect(await catalog(t.db)).toEqual(v11);
    expect(await assertSchemaCompatible(t.db, PREVIOUS)).toEqual({ version: 11, application: 11, forward: [] });
    expect(await migrate(t.db, V12)).toEqual([12]);
  });

  it('while 0012 is open: it locks only `tenants` and the evaluation history; v11 cold starts, runs, journals and the queue never wait for it', async () => {
    const t = await database(V11);
    await seed(t.db);
    const runner = t.open(1), app = t.open(6);
    let decide!: (commit: boolean) => void, ready!: (pid: number) => void;
    const opened = new Promise<number>(resolve => { ready = resolve; }), decision = new Promise<boolean>(resolve => { decide = resolve; });
    // The statements `migrate` runs for one migration, in its order (advisory lock, ledger read, the SQL, the ledger row), held open.
    const migration = runner.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [7_340_032_001]);
      await tx.query('SELECT version, name, sha256 FROM schema_migrations ORDER BY version');
      await tx.query(M12.sql);
      await tx.query('INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)', [M12.version, M12.name, M12.sha256]);
      ready((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
      if (!await decision) throw new Error('ROLLED_BACK');
    });
    const pid = await opened;
    try {
      // Locks on committed relations, as every other session sees them (the new admin_* objects and index are not visible yet).
      const { rows: locks } = await app.query<{ relname: string; relkind: string; mode: string }>(`SELECT c.relname, c.relkind::text, l.mode
        FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.pid = $1 AND l.granted AND c.relnamespace = 'public'::regnamespace ORDER BY 1, 3`, [pid]);
      expect(locks.filter(l => l.relkind === 'r').map(({ relname, mode }) => ({ relname, mode }))).toEqual([
        { relname: 'automation_evaluations', mode: 'ShareLock' },              // the index build: blocks evaluation writes until commit
        { relname: 'schema_migrations', mode: 'AccessShareLock' },
        { relname: 'schema_migrations', mode: 'RowExclusiveLock' },
        { relname: 'tenants', mode: 'AccessShareLock' },
        { relname: 'tenants', mode: 'ShareRowExclusiveLock' },                 // the three foreign keys: blocks tenant writes until commit
      ]);
      // Pre-existing indexes are only read (e.g. tenants_pkey for the foreign keys): nothing there blocks a reader or a writer.
      expect(new Set(locks.filter(l => l.relkind === 'i').map(l => l.mode))).toEqual(new Set(['AccessShareLock']));

      // A v11 instance cold-starting and serving inside the window: none of this waits (each would report TIMEOUT if it did).
      const fresh = t.open(2), log = createPostgresLogStore({ db: fresh, tenantId: 'default', namespace: 'compat' });
      const queue = createPostgresWorkQueue({ db: fresh, ownerId: 'window', tenantId: 'default' });
      expect(await within(assertSchemaCompatible(fresh, PREVIOUS), 2_000)).toEqual({ version: 11, application: 11, forward: [] });
      expect(await within(ensureTenant(fresh, 'default'), 2_000)).toBeUndefined();
      expect(await within(log.create('window.jsonl', bytes('{"a":1}\n')), 2_000)).toBe(true);
      expect(await within(log.extend('window.jsonl', bytes('{"a":1}\n{"b":2}\n'), () => undefined), 2_000)).not.toBe('TIMEOUT');
      expect(await within(queue.enqueue('default', 'compat-window', 'w', null), 2_000)).toBe(true);
      expect(await within(queue.claim(5, ['compat-window']).then(items => Promise.all(items.map(queue.complete))), 2_000)).toEqual([true]);
      expect(await within(sweep(fresh, { tenantId: 'default' }), 2_000)).not.toBe('TIMEOUT');
      expect(await probe(app, `UPDATE execution_runs SET status = 'AUTHORIZED', updated_at = now() WHERE run_id = 'run-1'`)).toBe('OK');
      expect(await probe(app, `INSERT INTO workflows (tenant_id, workflow_id) VALUES ('default', 'wf-window')`)).toBe('OK');
      expect(await probe(app, `UPDATE automation_rules SET display_name = 'Watch 2', updated_at = now() WHERE rule_id = $1`, [RULE])).toBe('OK');
      expect(await probe(app, `SELECT count(*) FROM automation_evaluations WHERE tenant_id = 'default'`)).toBe('OK');

      // What does wait for it, until it commits (bounded by its duration; its own lock waits are bounded by its 5 s lock_timeout):
      // the released ensureTenant statement, a brand-new tenant, and any evaluation write — API owner routes included.
      expect(await probe(app, `INSERT INTO tenants (tenant_id) VALUES ('default') ON CONFLICT (tenant_id) DO NOTHING`)).toBe('55P03');
      const newTenant = ensureTenant(fresh, 'preview-new');
      expect(await within(newTenant, 500)).toBe('TIMEOUT');
      expect(await probe(app, `INSERT INTO automation_evaluations (tenant_id, rule_id, at, outcome) VALUES ('default', $1, now(), 'AUTOMATION_CREATED')`, [RULE])).toBe('55P03');
      expect(await probe(app, `DELETE FROM automation_evaluations WHERE tenant_id = 'default' AND at < now() - interval '90 days'`)).toBe('55P03');

      decide(true);
      await migration;
      await newTenant;
      // Committed: the v11 build serves on the certified schema; the released build refuses it; waiting writes went through.
      expect(await assertSchemaCompatible(fresh, PREVIOUS)).toEqual({ version: 12, application: 11, forward: [identity(M12)] });
      expect(await outcome(unpatched.assertSchemaCurrent(fresh, PREVIOUS))).toEqual(MISMATCH);
      expect(await probe(app, `INSERT INTO automation_evaluations (tenant_id, rule_id, at, outcome) VALUES ('default', $1, now(), 'AUTOMATION_CREATED')`, [RULE])).toBe('OK');
      expect((await app.query(`SELECT tenant_id FROM tenants ORDER BY 1`)).rows).toEqual([{ tenant_id: 'default' }, { tenant_id: 'preview-new' }]);
    } finally { decide(false); await migration.catch(() => undefined); }
  });
});

/**
 * BUILD-CHAT-LEARNING-001: the second certificate. The v12 build (BUILD-ADMIN-001 as merged) with its certificate for 0013 — the exact bytes
 * BUILD-CHAT-LEARNING-001 releases (a SHA-256-pinned fixture) — on real ledgers, runners and the real lock window.
 */
describe('BUILD-CHAT-LEARNING-001 what 0013 does to a v12 database (PostgreSQL)', () => {
  const LEARNING = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.migrations.some(m => m.name === 'copilot_learning'))!;
  const V12_BUILD = SHIPPED_MIGRATIONS.slice(0, 12);
  let V12M: readonly Migration[], M13: Migration, V13M: readonly Migration[];
  beforeAll(async () => {
    const sql = await readFile(new URL('./fixtures/0013_copilot_learning.sql', import.meta.url), 'utf8');
    M13 = { version: 13, name: 'copilot_learning', sql, sha256: createHash('sha256').update(sql).digest('hex') };
    V12M = (await loadMigrations()).slice(0, 12);
    V13M = [...V12M, M13];
  });
  /** v12 data next to which 0013 lands: v11's kinds, plus admin settings and audit rows. */
  async function seed12(db: Database) {
    await seed(db);
    await db.query(`INSERT INTO admin_settings_versions (tenant_id, setting_key, version, document, created_by) VALUES ('default', 'copilot', 1, NULL, 'cli')`);
    await db.query(`INSERT INTO admin_audit_events (tenant_id, actor, kind, outcome) VALUES ('default', 'cli', 'ADMIN_GRANTED', 'OK')`);
  }

  it('the v12 build serves the certified 0013 schema; the strict check and a build without the certificate refuse; a runner never changes it', async () => {
    expect(identity(M13)).toEqual(LEARNING.migrations[0]);
    const t = await database(V13M), shape = await catalog(t.db), history = await ledger(t.db);
    expect(await assertSchemaCompatible(t.db, V12_BUILD)).toEqual({ version: 13, application: 12, forward: [identity(M13)] });
    expect(await outcome(assertSchemaCurrent(t.db, V12_BUILD))).toEqual(MISMATCH);
    expect(await outcome(assertSchemaCompatible(t.db, V12_BUILD, CERTIFIED_FORWARD_MIGRATIONS.filter(c => c !== LEARNING)))).toEqual(MISMATCH);
    expect(await migrate(t.db, V12M)).toEqual([]);           // the v12 build's deploy step on a v13 database: nothing to apply
    expect(await catalog(t.db)).toEqual(shape);
    expect(await ledger(t.db)).toEqual(history);
    await t.db.query(`UPDATE schema_migrations SET sha256 = repeat('f', 64) WHERE version = 13`);
    expect(await outcome(assertSchemaCompatible(t.db, V12_BUILD))).toEqual(MISMATCH);
    expect(await outcome(migrate(t.db, V12M))).toEqual(MISMATCH);
    // A v12 database is exact for the v12 build and behind for a build that ships 0013.
    const at12 = await database(V12M);
    expect(await assertSchemaCompatible(at12.db, V12_BUILD)).toEqual({ version: 12, application: 12, forward: [] });
    expect(await outcome(assertSchemaCompatible(at12.db, V13M))).toEqual(BEHIND);
  });

  it('is purely additive: nothing pre-existing is removed, redefined or added to; no existing row changes', async () => {
    const t = await database(V12M);
    await seed12(t.db);
    const before = await catalog(t.db);
    const tables = [...before.keys()].filter(k => k.startsWith('relation:') && before.get(k)!.startsWith('r ')).map(k => k.slice('relation:'.length))
      .filter(table => table !== 'schema_migrations');
    const rows = await data(t.db, tables), history = await ledger(t.db);
    expect(await migrate(t.db, V13M)).toEqual([13]);
    expect((await ledger(t.db)).slice(0, -1)).toEqual(history);
    const after = await catalog(t.db);
    expect([...before.keys()].filter(key => !after.has(key))).toEqual([]);
    expect([...before.keys()].filter(key => after.has(key) && after.get(key) !== before.get(key))).toEqual([]);
    expect(await data(t.db, tables)).toEqual(rows);
    const added = [...after.keys()].filter(key => !before.has(key)).sort();
    const own = (key: string) => /^(relation|index|function):learning_/.test(key) || /^(column|constraint|trigger):learning_[a-z_]+\./.test(key);
    // Unlike 0012: not even a foreign-key trigger on `tenants` or an index on an existing table.
    expect(added.filter(key => !own(key))).toEqual([]);
    expect(added.filter(key => key.startsWith('relation:'))).toEqual(['relation:learning_candidate_support', 'relation:learning_candidates', 'relation:learning_evaluations',
      'relation:learning_evaluations_evaluation_id_seq', 'relation:learning_feedback_events', 'relation:learning_feedback_events_event_id_seq',
      'relation:learning_knowledge_versions', 'relation:learning_memories', 'relation:learning_subjects']);
    expect(added.filter(key => key.startsWith('function:'))).toEqual(['function:learning_candidate_transition()', 'function:learning_knowledge_admission()']);
  });

  it('while 0013 is open it locks no pre-existing table: v12 cold starts, a brand-new tenant, runs, journals, the queue, evaluations and admin writes never wait', async () => {
    const t = await database(V12M);
    await seed12(t.db);
    const runner = t.open(1), app = t.open(6);
    let decide!: (commit: boolean) => void, ready!: (pid: number) => void;
    const opened = new Promise<number>(resolve => { ready = resolve; }), decision = new Promise<boolean>(resolve => { decide = resolve; });
    const migration = runner.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [7_340_032_001]);
      await tx.query('SELECT version, name, sha256 FROM schema_migrations ORDER BY version');
      await tx.query(M13.sql);
      await tx.query('INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)', [M13.version, M13.name, M13.sha256]);
      ready((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
      if (!await decision) throw new Error('ROLLED_BACK');
    });
    const pid = await opened;
    try {
      const { rows: locks } = await app.query<{ relname: string; relkind: string; mode: string }>(`SELECT c.relname, c.relkind::text, l.mode
        FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.pid = $1 AND l.granted AND c.relnamespace = 'public'::regnamespace ORDER BY 1, 3`, [pid]);
      expect(locks.filter(l => l.relkind === 'r').map(({ relname, mode }) => ({ relname, mode }))).toEqual([
        { relname: 'schema_migrations', mode: 'AccessShareLock' }, { relname: 'schema_migrations', mode: 'RowExclusiveLock' }]);
      expect(locks.filter(l => l.relkind === 'i').every(l => l.relname.startsWith('schema_migrations'))).toBe(true);

      const fresh = t.open(2), log = createPostgresLogStore({ db: fresh, tenantId: 'default', namespace: 'compat' });
      const queue = createPostgresWorkQueue({ db: fresh, ownerId: 'window', tenantId: 'default' });
      expect(await within(assertSchemaCompatible(fresh, V12_BUILD), 2_000)).toEqual({ version: 12, application: 12, forward: [] });
      expect(await within(ensureTenant(fresh, 'default'), 2_000)).toBeUndefined();
      expect(await within(ensureTenant(fresh, 'preview-new'), 2_000)).toBeUndefined();   // 0012 made this wait; 0013 does not
      expect(await within(log.create('window.jsonl', bytes('{"a":1}\n')), 2_000)).toBe(true);
      expect(await within(queue.enqueue('default', 'compat-window', 'w', null), 2_000)).toBe(true);
      expect(await within(sweep(fresh, { tenantId: 'default' }), 2_000)).not.toBe('TIMEOUT');
      expect(await probe(app, `UPDATE execution_runs SET status = 'AUTHORIZED', updated_at = now() WHERE run_id = 'run-1'`)).toBe('OK');
      expect(await probe(app, `INSERT INTO automation_evaluations (tenant_id, rule_id, at, outcome) VALUES ('default', $1, now(), 'AUTOMATION_CREATED')`, [RULE])).toBe('OK');
      expect(await probe(app, `INSERT INTO admin_settings_versions (tenant_id, setting_key, version, document, created_by) VALUES ('default', 'copilot', 2, NULL, 'cli')`)).toBe('OK');
      expect(await probe(app, `INSERT INTO admin_audit_events (tenant_id, actor, kind, outcome) VALUES ('default', 'cli', 'ADMIN_WINDOW', 'OK')`)).toBe('OK');
      expect(await probe(app, `INSERT INTO tenants (tenant_id) VALUES ('another-new') ON CONFLICT (tenant_id) DO NOTHING`)).toBe('OK');
      decide(true);
      await migration;
      expect(await assertSchemaCompatible(fresh, V12_BUILD)).toEqual({ version: 13, application: 12, forward: [identity(M13)] });
      expect(await outcome(unpatched.assertSchemaCurrent(fresh, V12_BUILD))).toEqual(MISMATCH);
    } finally { decide(false); await migration.catch(() => undefined); }
  });

  it('the documented emergency reversal restores the exact v12 catalog and refuses, unchanged, anything but the certified 0013 as newest', async () => {
    const doc = await readFile(new URL('../../../docs/deploy/SCHEMA-COMPATIBILITY.md', import.meta.url), 'utf8');
    const section = doc.slice(doc.indexOf('### 7.3')), start = section.indexOf('```sql\n') + '```sql\n'.length;
    const reversal = section.slice(start, section.indexOf('\n```', start));
    expect(reversal).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
    const v12 = await catalog((await database(V12M)).db);
    for (const tamper of [`UPDATE schema_migrations SET sha256 = repeat('f', 64) WHERE version = 13`,
      `INSERT INTO schema_migrations (version, name, sha256) VALUES (14, 'later_change', repeat('e', 64))`]) {
      const t = await database(V13M), session = t.open(1);
      await t.db.query(tamper);
      const before = { shape: await catalog(t.db), history: await ledger(t.db) };
      expect(await outcome(session.query(reversal))).toEqual({ error: 'P0001' });
      await session.close();
      expect({ shape: await catalog(t.db), history: await ledger(t.db) }).toEqual(before);
    }
    const t = await database(V13M);
    await t.db.query(`INSERT INTO learning_subjects (tenant_id, subject_id, kind, subject_digest) VALUES ('default', $1, 'WALLET', $2)`, ['lsb_' + 'a'.repeat(26), Buffer.alloc(32, 1)]);
    await t.db.query(`INSERT INTO learning_memories (tenant_id, subject_id, term, target) VALUES ('default', $1, 'arb', 'network:ARBITRUM')`, ['lsb_' + 'a'.repeat(26)]);
    await t.db.query(reversal);
    expect(await catalog(t.db)).toEqual(v12);
    expect(await assertSchemaCompatible(t.db, V12_BUILD)).toEqual({ version: 12, application: 12, forward: [] });
    expect(await migrate(t.db, V13M)).toEqual([13]);
  });
});
