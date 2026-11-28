// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the certified 0031 `position_history_purge`, from its SHA-256-pinned fixture, on disposable PostgreSQL.
 * 0031 follows the optional FinOps 0029/0030 (certified by PR #218 for the v28 build) and redefines only 0016's snapshot predicate, so that an
 * owner can delete a provably unstarted Uniswap position-management simulation. Proven here: the exact bytes and certificate; the v28 build serving
 * schema 31 only through this certificate (the previous certificate, which stops at 0030, refuses it); a catalog diff of exactly one redefined
 * function; every pre-existing row and log byte surviving; which snapshots become deletable (an unstarted position simulation, nothing else) and
 * which stay protected (authorized, attempted, observed, evidenced, reconciled, tampered, other owner or tenant, leased, observed by a worker);
 * a deletion racing an authorization; a failing 0031 rolling back completely; and the documented emergency reversal restoring the exact
 * schema-30 catalog. Synthetic records only; the real service's records are proven by `apps/reference-dapp/backend/uniswap-position-purge.pg.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSchemaCompatible, assertSchemaCurrent, CERTIFIED_FORWARD_MIGRATIONS, createPostgresLogStore, ensureTenant, loadMigrations, migrate,
  SHIPPED_MIGRATIONS, type ForwardCompatibilityCertificate, type Migration, type Projector } from '../src/index.js';
import { bytes, createTestDatabase, type TestDatabase } from './pg-harness.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const CERTIFICATE = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
const V28 = SHIPPED_MIGRATIONS.slice(0, 28);
/** The certificate main carried before this build (PR #218): 0029 and 0030 only. A build with it must refuse schema 31. */
const PREVIOUS: ForwardCompatibilityCertificate = { ...CERTIFICATE, migrations: CERTIFICATE.migrations.slice(0, 2) };
const OWNER = '0x' + '11'.repeat(20), OTHER = '0x' + '22'.repeat(20);
const opened: TestDatabase[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(t => t.drop())); });

async function fixture(version: number): Promise<Migration> {
  const identity = CERTIFICATE.migrations.find(m => m.version === version)!;
  const sql = await readFile(new URL(`./fixtures/${String(version).padStart(4, '0')}_${identity.name}.sql`, import.meta.url), 'utf8');
  expect(sha(sql)).toBe(identity.sha256);
  return { ...identity, sql };
}
/** A database exactly at schema 30: the v28 build's history plus the certified FinOps 0029/0030, as their own commands apply them. */
async function schema30(): Promise<{ t: TestDatabase; v30: Migration[]; m31: Migration }> {
  const t = await createTestDatabase({ migrated: false }); opened.push(t);
  const v30 = [...(await loadMigrations()).slice(0, 28), await fixture(29), await fixture(30)];
  expect(await migrate(t.db, v30)).toHaveLength(30);
  await ensureTenant(t.db, 'default'); await ensureTenant(t.db, 'tenant-b');
  return { t, v30, m31: await fixture(31) };
}
async function catalog(db: { query: <T>(sql: string) => Promise<{ rows: T[] }> }) {
  const q = async (sql: string) => (await db.query<{ item: string }>(sql)).rows.map(r => r.item).sort();
  return {
    columns: await q(`SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS item
      FROM information_schema.columns WHERE table_schema = 'public'`),
    constraints: await q(`SELECT conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) AS item FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace`),
    indexes: await q(`SELECT tablename || ':' || indexname || ':' || indexdef AS item FROM pg_indexes WHERE schemaname = 'public'`),
    functions: await q(`SELECT p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(array_to_string(p.proacl, ','), 'default') AS item
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`),
    triggers: await q(`SELECT tgrelid::regclass::text || ':' || tgname || ':' || md5(pg_get_triggerdef(oid)) AS item FROM pg_trigger WHERE NOT tgisinternal`),
    privileges: await q(`SELECT table_name || ':' || grantee || ':' || privilege_type AS item FROM information_schema.role_table_grants WHERE table_schema = 'public'`),
  };
}

type Line = Record<string, unknown>;
/** A position-management run snapshot exactly as `flofi.uniswap-position-run.v1` stores it, unstarted. */
const position = (id: string, patch: Line = {}): Line => ({ format: 'flofi.uniswap-position-run.v1', id, provenance: 'MOCKED',
  workflow: { workflowId: 'wf-' + id, revision: 1, nodes: [{ id: 'n1', actionType: 'asset.liquidity.concentrated' }] }, owner: OWNER,
  request: { operation: 'EXIT', tokenId: '9001', partBps: null, close: true },
  review: { format: 'flofi.uniswap-position-review.v1', commitment: '0x' + 'ab'.repeat(32), operation: 'EXIT', partBps: null, close: true, owner: OWNER,
    recipient: OWNER, block: { number: 10, hash: '0x' + 'cd'.repeat(32), timestamp: 1 }, position: { tokenId: '9001', liquidity: '10', tokensOwed0: '0', tokensOwed1: '0' },
    calls: ['DECREASE', 'COLLECT', 'BURN'], expiresAt: '2026-11-19T00:00:00.000Z' },
  authorization: null, attempts: [], result: null, evidence: null, verdict: 'PENDING', error: null, ...patch });
type Projection = { status?: string; owner?: string; needsObservation?: boolean; hasEvidence?: boolean };
function store(t: TestDatabase, tenantId: string, projections: Map<string, Projection>) {
  const projector: Projector = name => {
    if (!name.endsWith('.jsonl')) return null;
    const runId = name.slice(0, -'.jsonl'.length), p = projections.get(runId) ?? {};
    return { run: { runId, workflowId: 'wf-' + runId, flow: 'base-liquidity', status: p.status ?? 'SIMULATED', provenance: 'MOCKED', ownerAccount: p.owner ?? OWNER,
      recoveryOf: null, errorCode: null, needsObservation: p.needsObservation ?? false, hasEvidence: p.hasEvidence ?? false, attempts: [], journal: [] }, work: [] };
  };
  return createPostgresLogStore({ db: t.db, tenantId, namespace: 'base-liquidity', projector });
}
const jsonl = (...lines: Line[]) => bytes(lines.map(line => JSON.stringify(line)).join('\n') + '\n');
async function purge(t: TestDatabase, id: string, owner = OWNER, tenant = 'default') {
  return (await t.db.query<{ result: { ok: boolean; code?: string; disposition?: string } }>('SELECT purge_unstarted_execution($1,$2,$3) AS result',
    [tenant, owner, id])).rows[0]!.result;
}

describe('BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: certificate for 0031 position_history_purge (v28 build, PostgreSQL)', { timeout: 120_000 }, () => {
  it('certifies the exact fixture bytes after the FinOps 0029/0030 for the v28 build; 0016 stays immutable and unshipped migrations stay in fixtures', async () => {
    expect(CERTIFICATE.base).toEqual(V28[27]);
    // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 extended this same base-28 certificate with 0032 and 0033 (proven by certificate-0032.pg.test.ts
    // and certificate-0033.pg.test.ts); 0029–0031 keep their exact identities and order.
    expect(CERTIFICATE.migrations.map(m => [m.version, m.name])).toEqual([[29, 'finops_ledger'], [30, 'finops_sync'], [31, 'position_history_purge'],
      [32, 'single_step_runs'], [33, 'workflow_run_purge'], [34, 'developer_project_ownership'], [35, 'studio_integrations'], [36, 'studio_certification'], [37, 'execution_origins_platform_fees'],
      [38, 'platform_fee_authorizations']]);
    expect((await fixture(31)).sha256).toBe('c7d4a08223df2a3d5f32d70902d1d5b2efd5ec961b67f146ea20c2a4afeb898d');
    expect(SHIPPED_MIGRATIONS.find(m => m.version === 16)!.sha256).toBe('a3c258cadd9d7865ad9d36d63ec0921fc47455bb3651c201074f3b0486b4be6f');
    expect(sha(await readFile(new URL('../migrations/0016_owner_history_purge.sql', import.meta.url), 'utf8'))).toBe(SHIPPED_MIGRATIONS[15]!.sha256);
    // This build ships through 0028; a later build that ships 0029–0031 must ship exactly these identities.
    for (const certified of CERTIFICATE.migrations) {
      const shipped = SHIPPED_MIGRATIONS.find(m => m.version === certified.version);
      if (shipped) expect(shipped).toEqual(certified);
    }
    const sql = (await fixture(31)).sql;
    // The only statements: the lock timeout, the predicate's redefinition and its privilege (unchanged: no grant to anyone).
    expect(sql.match(/^(CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|SET|TRUNCATE)\b[^\n]*/gm)).toEqual([
      "SET LOCAL lock_timeout = '5s';",
      'CREATE OR REPLACE FUNCTION disposable_execution_snapshot(s jsonb, p_id text, p_owner text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$',
      'REVOKE ALL ON FUNCTION disposable_execution_snapshot(jsonb,text,text) FROM PUBLIC;']);
    // The predicate is 0016's, byte for byte, plus exactly the position branch and `result` in the must-be-null list (data-privacy review).
    const original = await readFile(new URL('../migrations/0016_owner_history_purge.sql', import.meta.url), 'utf8');
    const body = (text: string) => { const from = text.indexOf('FUNCTION disposable_execution_snapshot'); return text.slice(from, text.indexOf('END; $$;', from)); };
    const branch = sql.slice(sql.indexOf("  ELSIF s->>'format'='flofi.uniswap-position-run.v1' THEN"), sql.indexOf('  ELSE RETURN false; END IF;'));
    expect(branch.split('\n').filter(Boolean)).toHaveLength(6);
    expect(body(sql).replace(branch, '').replace(",s->'result']", ']')).toBe(body(original));
  });

  it('serves schema 31 for the v28 build only through this certificate; the catalog diff is the one predicate; rows and logs survive; reruns change nothing', async () => {
    const { t, v30, m31 } = await schema30();
    const projections = new Map<string, Projection>(), s = store(t, 'default', projections);
    const legacy = jsonl({ quote: { executionId: 'legacy-run', ownerReview: { account: OWNER } }, workflow: { workflowId: 'wf' }, reviewedManifestHash: null, attempts: [], outcome: null });
    await s.create('legacy-run.jsonl', legacy);
    await s.create('kept-run.jsonl', jsonl(position('kept-run')));
    const before = await catalog(t.db);
    const rows = async () => (await t.db.query(`SELECT run_id, namespace, log_name, status, owner_account FROM execution_runs ORDER BY run_id`)).rows;
    const data = await rows();

    expect(await migrate(t.db, [...v30, m31])).toEqual([31]);
    expect(await migrate(t.db, [...v30, m31])).toEqual([]);
    const after = await catalog(t.db);
    expect({ ...after, functions: undefined }).toEqual({ ...before, functions: undefined });
    const changed = after.functions.filter(f => !before.functions.includes(f)), removed = before.functions.filter(f => !after.functions.includes(f));
    expect(changed.map(f => f.split(':')[0])).toEqual(['disposable_execution_snapshot']);
    expect(removed.map(f => f.split(':')[0])).toEqual(['disposable_execution_snapshot']);
    // Privileges unchanged: still no PUBLIC execute (the ACL part of the entry is identical).
    expect(changed[0]!.split(':').slice(2)).toEqual(removed[0]!.split(':').slice(2));
    expect(await rows()).toEqual(data);
    expect(await s.read('legacy-run.jsonl')).toEqual(legacy);

    // The v28 build serves 31 through this certificate; the previous certificate (0029–0030 only) and a strict check refuse it.
    expect(await assertSchemaCompatible(t.db, V28)).toMatchObject({ version: 31, application: 28,
      forward: CERTIFICATE.migrations.slice(0, 3).map(m => ({ version: m.version })) });
    await expect(assertSchemaCompatible(t.db, V28, [PREVIOUS])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    await expect(assertSchemaCompatible(t.db, V28, [])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    await expect(assertSchemaCurrent(t.db, V28)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    // The v28 runner (its deploy step) never changes a database ahead of it.
    expect(await migrate(t.db, (await loadMigrations()).slice(0, 28))).toEqual([]);
    // An edited 0031 is refused, never re-applied.
    await expect(migrate(t.db, [...v30, { ...m31, sql: m31.sql + '\n', sha256: sha(m31.sql + '\n') }])).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
  });

  it('deletes only a provably unstarted position simulation; every authorized, attempted, observed, evidenced, reconciled or foreign record stays', async () => {
    const { t, v30, m31 } = await schema30();
    const projections = new Map<string, Projection>(), s = store(t, 'default', projections), other = store(t, 'tenant-b', projections);
    const cases: Array<[string, Uint8Array, Projection?]> = [
      ['unstarted', jsonl(position('unstarted'))],
      ['refreshed', jsonl(position('refreshed'), position('refreshed', { review: { ...position('refreshed').review as Line, commitment: '0x' + 'ef'.repeat(32) } }))],
      ['authorized', jsonl(position('authorized'), position('authorized', { authorization: '0x' + 'ab'.repeat(32) })), { status: 'AUTHORIZED' }],
      // Invalidated after an authorization: an earlier snapshot was authorized, so the run is retained.
      ['invalidated', jsonl(position('invalidated'), position('invalidated', { authorization: '0x' + 'ab'.repeat(32) }), position('invalidated'))],
      ['prepared', jsonl(position('prepared', { authorization: '0x' + 'ab'.repeat(32), attempts: [{ id: 'a1', step: 'EXIT', state: 'PREPARED', nonce: '7' }] })), { status: 'PREPARED' }],
      ['attempt-only', jsonl(position('attempt-only', { attempts: [{ id: 'a1', step: 'EXIT', state: 'SUBMITTING' }] }))],
      ['unknown', jsonl(position('unknown', { attempts: [{ id: 'a1', state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: '0x' + '01'.repeat(32) }] })), { status: 'SUBMITTING', needsObservation: true }],
      ['reconciled', jsonl(position('reconciled', { result: { liquidityRemoved: '10' }, evidence: { outcome: 'RECONCILED' }, verdict: 'RECONCILED' })), { status: 'RECONCILED', hasEvidence: true }],
      ['result-only', jsonl(position('result-only', { result: { liquidityRemoved: '10' } }))],
      ['evidence-only', jsonl(position('evidence-only', { evidence: { outcome: 'RECONCILED' } }))],
      ['divergent', jsonl(position('divergent', { verdict: 'DIVERGENT' }))],
      ['signed', jsonl(position('signed', { review: { ...position('signed').review as Line, signature: '0x' + '02'.repeat(65) } }))],
      ['receipt', jsonl(position('receipt', { review: { ...position('receipt').review as Line, receipt: { status: 1 } } }))],
      ['extra-key', jsonl(position('extra-key', { claim: 'x' }))],
      // A snapshot lacking one of the record's own keys (e.g. a future shape without `result`) is retained, never assumed unstarted.
      ['missing-key', jsonl(Object.fromEntries(Object.entries(position('missing-key')).filter(([key]) => key !== 'result')))],
      ['wrong-id', jsonl(position('wrong-id', { id: 'another-run' }))],
      ['wrong-owner', jsonl(position('wrong-owner', { owner: OTHER }))],
      ['observed-status', jsonl(position('observed-status')), { needsObservation: true }],
      ['evidenced-status', jsonl(position('evidenced-status')), { hasEvidence: true }],
      ['not-json', bytes('{"format":"flofi.uniswap-position-run.v1"\n')],
    ];
    for (const [id, content, projection] of cases) { if (projection) projections.set(id, projection); await s.create(id + '.jsonl', content); }
    await other.create('foreign.jsonl', jsonl(position('foreign')));

    // Before 0031 (schema 30, exactly 0016's predicate) no position run is deletable: the explicit, fail-safe refusal of today.
    for (const [id] of cases) expect(await purge(t, id), id).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
    expect(await migrate(t.db, [...v30, m31])).toEqual([31]);

    const deletable = new Set(['unstarted', 'refreshed']);
    for (const [id] of cases) {
      const result = await purge(t, id);
      if (deletable.has(id)) expect(result, id).toMatchObject({ ok: true, disposition: 'DELETED' });
      else expect(result, id).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
    }
    // Tenant isolation and owner verification: a caller-supplied id never reaches another tenant's or owner's run.
    expect(await purge(t, 'foreign', OWNER, 'default')).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    expect(await purge(t, 'foreign', OTHER, 'tenant-b')).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    expect(await purge(t, 'kept', OTHER)).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    // Idempotent: the tombstone answers DELETED again; the identity can never be recreated, even by a stale writer.
    expect(await purge(t, 'unstarted')).toEqual({ ok: true, disposition: 'DELETED' });
    await expect(s.create('unstarted.jsonl', jsonl(position('unstarted')))).rejects.toThrow('EXECUTION_DELETED');
    expect((await t.db.query(`SELECT run_id FROM execution_purge_audit ORDER BY run_id`)).rows).toEqual([{ run_id: 'refreshed' }, { run_id: 'unstarted' }]);
    // The immutable audit and append-only protections are untouched.
    await expect(t.db.query(`DELETE FROM execution_purge_audit`)).rejects.toThrow('APPEND_ONLY_VIOLATION');
    await expect(t.db.query(`DELETE FROM execution_log_segments WHERE name = 'authorized.jsonl'`)).rejects.toThrow('APPEND_ONLY_VIOLATION');
    expect((await t.db.query(`SELECT count(*)::int AS n FROM execution_runs`)).rows).toEqual([{ n: cases.length - 2 + 1 }]);
  });

  it('keeps recovery obligations: a live lease, an INTENT naming the run or a queued work item refuses deletion', async () => {
    const { t, v30, m31 } = await schema30();
    expect(await migrate(t.db, [...v30, m31])).toEqual([31]);
    const s = store(t, 'default', new Map());
    for (const id of ['leased', 'intent', 'queued']) await s.create(id + '.jsonl', jsonl(position(id)));
    await t.db.query(`INSERT INTO execution_leases (tenant_id, namespace, lease_key, owner_id, fence, acquired_at, expires_at) VALUES ('default', 'base-liquidity', 'leased', 'h', 1, now(), now() + interval '1 hour')`);
    // The position claim log of BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 is an INTENT log naming the run.
    await s.create('8453-0x' + 'aa'.repeat(20) + '-9001.unipm-position', bytes(JSON.stringify({ runId: 'intent' }) + '\n'));
    await t.db.query(`INSERT INTO work_items (tenant_id, kind, run_id, payload, dedupe_key, state, available_at) VALUES ('default', 'reconcile', 'queued', '{}'::jsonb, 'reconcile:queued', 'READY', now())`);
    for (const id of ['leased', 'intent', 'queued']) expect(await purge(t, id), id).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
  });

  it('a deletion racing an authorization never loses it: both orders are forced, and the predicate (not the run status) refuses a later deletion', async () => {
    const { t, v30, m31 } = await schema30();
    expect(await migrate(t.db, [...v30, m31])).toEqual([31]);
    // The writer's projection stays SIMULATED, so only the snapshot predicate can refuse the deletion.
    const writerOf = (id: string) => createPostgresLogStore({ db: t.open(2), tenantId: 'default', namespace: 'base-liquidity',
      projector: name => name.endsWith('.jsonl') ? { run: { runId: id, workflowId: 'wf-' + id, flow: 'base-liquidity', status: 'SIMULATED', provenance: 'MOCKED',
        ownerAccount: OWNER, recoveryOf: null, errorCode: null, needsObservation: false, hasEvidence: false, attempts: [], journal: [] }, work: [] } : null });
    const s = store(t, 'default', new Map()), authorize = (id: string) => jsonl(position(id), position(id, { authorization: '0x' + 'ab'.repeat(32) }));
    // A. The deletion holds the log's advisory lock first: the authorization write waits for it, then is refused (the identity is tombstoned).
    await s.create('first.jsonl', jsonl(position('first')));
    const holder = t.open(1);
    await holder.query('BEGIN');
    const held = (await holder.query<{ result: { ok: boolean; disposition?: string } }>('SELECT purge_unstarted_execution($1,$2,$3) AS result', ['default', OWNER, 'first'])).rows[0]!.result;
    expect(held).toMatchObject({ ok: true, disposition: 'DELETED' });
    let settled = false;
    const write = writerOf('first').extend('first.jsonl', authorize('first'), () => undefined).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(settled).toBe(false); // blocked on the same advisory lock
    await holder.query('COMMIT');
    await expect(write).rejects.toThrow(/EXECUTION_DELETED|NOT_FOUND|JOURNAL_CORRUPT/);
    expect((await t.db.query(`SELECT run_id FROM execution_runs WHERE run_id = 'first'`)).rows).toEqual([]);
    // B. The authorization lands first: the run is kept, refused by the predicate alone (its projection is still SIMULATED).
    await s.create('second.jsonl', jsonl(position('second')));
    await writerOf('second').extend('second.jsonl', authorize('second'), () => undefined);
    expect((await t.db.query<{ status: string }>(`SELECT status FROM execution_runs WHERE run_id = 'second'`)).rows).toEqual([{ status: 'SIMULATED' }]);
    expect(await purge(t, 'second')).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
    expect(await s.read('second.jsonl')).toEqual(authorize('second'));
  });

  it('a failing 0031 rolls back completely; the documented emergency reversal restores the exact schema-30 catalog and the previous certificate', async () => {
    const { t, v30, m31 } = await schema30();
    const before = await catalog(t.db);
    const broken = m31.sql + '\nSELECT 1/0;';
    await expect(migrate(t.db, [...v30, { ...m31, sql: broken, sha256: sha(broken) }])).rejects.toThrow();
    expect((await t.db.query('SELECT max(version) AS version FROM schema_migrations')).rows).toEqual([{ version: 30 }]);
    expect(await catalog(t.db)).toEqual(before);
    // A lock 0031 cannot take within its timeout rolls back too (the predicate is held by an open DDL transaction elsewhere).
    const blocker = t.open(1);
    await blocker.query('BEGIN');
    await blocker.query(`ALTER FUNCTION disposable_execution_snapshot(jsonb,text,text) IMMUTABLE`);
    await expect(migrate(t.db, [...v30, m31])).rejects.toThrow(/lock timeout|canceling statement/);
    await blocker.query('ROLLBACK');
    expect((await t.db.query('SELECT max(version) AS version FROM schema_migrations')).rows).toEqual([{ version: 30 }]);

    expect(await migrate(t.db, [...v30, m31])).toEqual([31]);
    const s = store(t, 'default', new Map());
    await s.create('deleted.jsonl', jsonl(position('deleted')));
    await s.create('kept.jsonl', jsonl(position('kept')));
    expect(await purge(t, 'deleted')).toMatchObject({ ok: true, disposition: 'DELETED' });
    const reversal = await readFile(new URL('../../../docs/deploy/RELEASE-POSITION-PURGE-0031.reversal.sql', import.meta.url), 'utf8');
    // The reversal restores 0016's predicate byte for byte (the immutable 0016 file is its source).
    const original = await readFile(new URL('../migrations/0016_owner_history_purge.sql', import.meta.url), 'utf8');
    const fn = (sql: string) => sql.slice(sql.indexOf('FUNCTION disposable_execution_snapshot'), sql.indexOf('END; $$;', sql.indexOf('FUNCTION disposable_execution_snapshot')));
    expect(fn(reversal)).toBe(fn(original));
    await t.db.query(reversal);
    expect(await catalog(t.db)).toEqual(before);
    expect((await t.db.query('SELECT max(version) AS version FROM schema_migrations')).rows).toEqual([{ version: 30 }]);
    // The build before this one (certificate through 0030) serves the database again; the deleted run stays deleted; the kept run is refused again.
    expect(await assertSchemaCompatible(t.db, V28, [PREVIOUS])).toMatchObject({ version: 30, application: 28 });
    await expect(s.create('deleted.jsonl', jsonl(position('deleted')))).rejects.toThrow('EXECUTION_DELETED');
    expect(await purge(t, 'kept')).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
    // The reversal refuses to run anywhere 0031 is not the newest migration.
    await expect(t.db.query(reversal)).rejects.toThrow('NOT_CERTIFIED_0031_HEAD');
  });
});
