// SPDX-License-Identifier: AGPL-3.0-only
/** REAL disposable PostgreSQL; financial records below are synthetic fixtures, never production or chain executions. */
import { afterEach, describe, expect, it } from 'vitest';
import { createOwnerHistory, createPostgresLogStore, createPostgresLeaseStore, createRunQueries, ensureTenant, type Database, type Projector } from '../src/index.js';
import { createTestDatabase, bytes, type TestDatabase } from './pg-harness.js';
const owner = '0x' + '11'.repeat(20), stranger = '0x' + '22'.repeat(20);
const opened: TestDatabase[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(t => t.drop())); });
const database = async () => { const t = await createTestDatabase(); opened.push(t); return t; };
const snapshot = (id: string, extra: Record<string, unknown> = {}) => ({ quote: { executionId: id, ownerReview: { account: owner } },
  workflow: { workflowId: `workflow-${id}` }, reviewedManifestHash: null, attempts: [], outcome: null, ...extra });
async function seed(t: TestDatabase, id: string, options: { status?: string; tenant?: string; journal?: boolean; extra?: Record<string, unknown>; evidence?: boolean; observe?: boolean } = {}) {
  const tenantId = options.tenant ?? 'default'; await ensureTenant(t.db, tenantId);
  const projector: Projector = () => ({ run: { runId: id, workflowId: `workflow-${id}`, flow: 'base-swap', status: options.status ?? 'SIMULATED', provenance: 'MOCKED', ownerAccount: owner,
    recoveryOf: null, errorCode: null, needsObservation: options.observe ?? false, hasEvidence: options.evidence ?? false, attempts: [], journal: options.journal ? [{ sequence: 0,
      entryHash: '0x' + 'aa'.repeat(32), level: 'workflow', entityId: `workflow-${id}`, attemptId: null, fromState: null, toState: 'SIMULATED', recordedAt: '2026-10-27T00:00:00Z' }] : [] }, work: [] });
  const store = createPostgresLogStore({ db: t.db, tenantId, namespace: 'base-swap', projector });
  const first = JSON.stringify(snapshot(id, options.extra)) + '\n';
  await store.create(`${id}.jsonl`, bytes(first));
  await store.extend(`${id}.jsonl`, bytes(first + JSON.stringify(snapshot(id, options.extra)) + '\n'), () => undefined);
  return { store, first };
}
describe('owner purge and archive, real PostgreSQL', () => {
  it('rehearses 56 runs / 39 independently checked disposable candidates / 9 journals; deletes bytes and keeps all 17 unsafe runs', async () => {
    const t = await database(), history = createOwnerHistory(t.db, 'default');
    for (let i = 0; i < 39; i++) await seed(t, `candidate-${i}`, { status: i < 31 ? 'SIMULATED' : 'PREPARED', journal: i < 9 });
    for (let i = 0; i < 17; i++) await seed(t, `retained-${i}`, { status: ['PENDING','SUBMITTING','SUBMISSION_RESULT_UNKNOWN','AUTHORIZED','RECONCILED'][i % 5] });
    const counts = async () => (await t.db.query(`SELECT (SELECT count(*)::integer FROM execution_runs) AS runs,
      (SELECT count(*)::integer FROM execution_log_segments) AS segments,(SELECT count(*)::integer FROM journal_entries) AS journals`)).rows[0];
    expect(await counts()).toEqual({ runs: 56, segments: 112, journals: 9 });
    for (let i = 0; i < 39; i++) expect(await history.change(owner, 'EXECUTION_RUN', `candidate-${i}`, 'DELETE')).toMatchObject({ ok: true, disposition: 'DELETED', counts: { execution_runs: 1, execution_log_segments: 2 } });
    expect(await counts()).toEqual({ runs: 17, segments: 34, journals: 0 });
    expect((await t.db.query('SELECT count(*)::integer AS n FROM execution_purge_audit')).rows).toEqual([{ n: 39 }]);
    expect((await t.db.query('SELECT count(*)::integer AS n FROM execution_purge_permits')).rows).toEqual([{ n: 0 }]);
    for (let i = 0; i < 17; i++) expect(await history.change(owner, 'EXECUTION_RUN', `retained-${i}`, 'DELETE')).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
  });
  it('refuses another wallet/tenant and permits an idempotent retry only for the actual owner', async () => {
    const t = await database(); await seed(t, 'owned'); await ensureTenant(t.db, 'other');
    expect(await createOwnerHistory(t.db, 'default').change(stranger, 'EXECUTION_RUN', 'owned', 'DELETE')).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    expect(await createOwnerHistory(t.db, 'other').change(owner, 'EXECUTION_RUN', 'owned', 'DELETE')).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    const history = createOwnerHistory(t.db, 'default');
    const results = await Promise.all([history.change(owner, 'EXECUTION_RUN', 'owned', 'DELETE'), history.change(owner, 'EXECUTION_RUN', 'owned', 'DELETE')]);
    expect(results.every(r => r.ok && r.disposition === 'DELETED')).toBe(true);
    expect((await t.db.query('SELECT count(*)::integer AS n FROM execution_purge_audit')).rows).toEqual([{ n: 1 }]);
    expect(await history.change(stranger, 'EXECUTION_RUN', 'owned', 'DELETE')).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
  });
  it('keeps append-only triggers active and prevents stale logs, projections, queue work and successful idempotency replies from resurrecting a purged run', async () => {
    const t = await database(), { store, first } = await seed(t, 'stale', { journal: true });
    await expect(t.db.query('DELETE FROM execution_log_segments')).rejects.toThrow('APPEND_ONLY_VIOLATION');
    await expect(t.db.query('UPDATE journal_entries SET to_state=to_state')).rejects.toThrow('APPEND_ONLY_VIOLATION');
    await t.db.query(`INSERT INTO api_idempotency(tenant_id,scope,idempotency_key,request_sha256,state,response,claimed_until,expires_at)
      VALUES('default','flows/base-swap/prepare','test-key-123',$1,'COMPLETED',$2,now(),now()+interval '1 day')`, ['aa'.repeat(32), JSON.stringify({ ok: true, value: { quote: { executionId: 'stale' } } })]);
    expect(await createOwnerHistory(t.db, 'default').change(owner, 'EXECUTION_RUN', 'stale', 'DELETE')).toMatchObject({ ok: true });
    expect(await store.read('stale.jsonl')).toBeNull();
    await expect(store.create('stale.jsonl', bytes(first))).rejects.toThrow('EXECUTION_DELETED');
    await expect(store.extend('stale.jsonl', bytes(first + first), () => undefined)).rejects.toThrow('EXECUTION_DELETED');
    await expect(t.db.query(`INSERT INTO work_items(tenant_id,kind,dedupe_key,run_id,payload,state) VALUES('default','flow.observe','stale','stale','{}','READY')`)).rejects.toThrow('EXECUTION_DELETED');
    expect((await t.db.query('SELECT response FROM api_idempotency')).rows).toEqual([{ response: { ok: false, code: 'EXECUTION_DELETED' } }]);
    await expect(t.db.query('DELETE FROM execution_purge_audit')).rejects.toThrow('APPEND_ONLY_VIOLATION');
    await seed(t, 'another', { journal: true });
    await expect(t.db.query("DELETE FROM execution_log_segments WHERE name='another.jsonl'")).rejects.toThrow('APPEND_ONLY_VIOLATION');
  });
  it.each([
    { reviewedManifestHash: '0x' + '11'.repeat(32) }, { attempts: [{ state: 'CANCELLED' }] }, { signature: 'private-signature' },
    { outcome: { received: '1' } }, { unknownFutureFinancialField: true }, { quote: { executionId: 'unsafe', ownerReview: { account: stranger } } },
  ])('retains raw snapshots with authority, attempts, signatures, outcomes, unknown fields or wrong owner: %j', async extra => {
    const t = await database(); await seed(t, 'unsafe', { extra });
    expect(await createOwnerHistory(t.db, 'default').change(owner, 'EXECUTION_RUN', 'unsafe', 'DELETE')).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
    expect(await createRunQueries(t.db, 'default').getRun('unsafe')).not.toBeNull();
  });
  it('checks every historic snapshot; clearing authorization in the latest snapshot never erases its history', async () => {
    const t = await database(), { store, first } = await seed(t, 'history', { extra: { reviewedManifestHash: '0x' + 'ab'.repeat(32) } });
    const prior = new TextDecoder().decode((await store.read('history.jsonl'))!);
    await store.extend('history.jsonl', bytes(prior + JSON.stringify(snapshot('history')) + '\n'), () => undefined);
    expect(first).toContain('reviewedManifestHash');
    expect(await createOwnerHistory(t.db, 'default').change(owner, 'EXECUTION_RUN', 'history', 'DELETE')).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
  });
  it('archives a financially uncertain run without removing evidence/history and excludes it from all main run lists after reconnect', async () => {
    const t = await database(); await seed(t, 'uncertain', { status: 'SUBMISSION_RESULT_UNKNOWN', observe: true });
    const history = createOwnerHistory(t.db, 'default');
    expect(await history.change(owner, 'EXECUTION_RUN', 'uncertain', 'ARCHIVE')).toEqual({ ok: true, disposition: 'ARCHIVED' });
    expect((await createRunQueries(t.db, 'default').listRuns(null, 100, { owner })).items).toEqual([]);
    expect((await createRunQueries(t.db, 'default').listRuns(null, 100, { owner, flow: 'base-swap', includeArchived: true })).items).toHaveLength(1);
    expect(await createRunQueries(t.db, 'default').getRun('uncertain')).toMatchObject({ needsObservation: true });
    expect(await createOwnerHistory(t.open(), 'default').disposition(owner, 'EXECUTION_RUN', 'uncertain')).toEqual({ ok: true, disposition: 'ARCHIVED' });
    expect((await t.db.query('SELECT count(*)::integer AS n FROM execution_log_segments')).rows).toEqual([{ n: 2 }]);
  });
  it('refuses READY work, active leases and in-progress methods on the same flow', async () => {
    const t = await database(); await seed(t, 'queued');
    await t.db.query(`INSERT INTO work_items(tenant_id,kind,dedupe_key,payload,state) VALUES('default','flow.observe','indirect', '{"runId":"queued"}','READY')`);
    expect(await createOwnerHistory(t.db, 'default').change(owner, 'EXECUTION_RUN', 'queued', 'DELETE')).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
  });

  it('retains economic intent bytes even when no attempt made it into the projection', async () => {
    const t = await database(); await seed(t, 'reserved');
    const intents = createPostgresLogStore({ db: t.db, tenantId: 'default', namespace: 'base-swap' });
    await intents.create('economic-reservation.intent', bytes(JSON.stringify({ id: 'reserved', transaction: { nonce: 1 } }) + '\n'));
    expect(await createOwnerHistory(t.db, 'default').change(owner, 'EXECUTION_RUN', 'reserved', 'DELETE')).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
  });

  it('preserves terminal work owned by another run that happens to reference the requested run', async () => {
    const t = await database(); await seed(t, 'candidate'); await seed(t, 'other-run');
    await t.db.query(`INSERT INTO work_items(tenant_id,kind,dedupe_key,run_id,payload,state,completed_at)
      VALUES('default','flow.observe','shared-terminal','other-run','{"source":"candidate"}','DONE',now())`);
    expect(await createOwnerHistory(t.db, 'default').change(owner, 'EXECUTION_RUN', 'candidate', 'DELETE')).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
    expect((await t.db.query('SELECT run_id FROM work_items')).rows).toEqual([{ run_id: 'other-run' }]);
    expect((await t.db.query('SELECT count(*)::int AS n FROM execution_runs')).rows).toEqual([{ n: 2 }]);
  });

  it('refuses a live execution lease and an in-flight API operation, preserving their history', async () => {
    const t = await database(); await seed(t, 'leased'); await seed(t, 'inflight');
    const history = createOwnerHistory(t.db, 'default');
    const leases = createPostgresLeaseStore({ db: t.db, tenantId: 'default', namespace: 'base-swap', holderId: 'test', busyCode: 'EXECUTION_BUSY' });
    await leases.hold('leased', async () => expect(await history.change(owner, 'EXECUTION_RUN', 'leased', 'DELETE')).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' }));
    await t.db.query(`INSERT INTO api_idempotency(tenant_id,scope,idempotency_key,request_sha256,state,claimed_until,expires_at)
      VALUES('default','flows/base-swap/begin','inflight-operation',$1,'IN_PROGRESS',now()+interval '1 minute',now()+interval '1 day')`, ['aa'.repeat(32)]);
    expect(await history.change(owner, 'EXECUTION_RUN', 'inflight', 'DELETE')).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
  });

  it('serializes indirect queue insertion with purge; a late writer sees the committed tombstone', async () => {
    const t = await database(); await seed(t, 'racing');
    let release!: () => void, inspected!: () => void;
    const ready = new Promise<void>(resolve => { inspected = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const gated: Database = { ...t.db, transaction: work => t.db.transaction(async tx => { const result = await work(tx); inspected(); await gate; return result; }) };
    const deletion = createOwnerHistory(gated, 'default').change(owner, 'EXECUTION_RUN', 'racing', 'DELETE');
    await ready;
    const insertion = t.db.query(`INSERT INTO work_items(tenant_id,kind,dedupe_key,payload,state) VALUES('default','flow.observe','late-ref','{"runId":"racing"}','READY')`);
    // Install the rejection handler before the other transaction commits.
    const refused = expect(insertion).rejects.toThrow('EXECUTION_DELETED');
    try {
      await expect.poll(async () => (await t.db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")).rows[0]!.n).toBe(1);
    } finally { release(); }
    expect(await deletion).toMatchObject({ ok: true, disposition: 'DELETED' }); await refused;
    expect((await t.db.query('SELECT count(*)::int AS n FROM work_items')).rows).toEqual([{ n: 0 }]);
  });

  it('keeps a run when the concurrent queue writer commits before purge inspects it', async () => {
    const t = await database(); await seed(t, 'writer-first');
    let release!: () => void, inserted!: () => void;
    const ready = new Promise<void>(resolve => { inserted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writer = t.db.transaction(async tx => {
      await tx.query(`INSERT INTO work_items(tenant_id,kind,dedupe_key,payload,state) VALUES('default','flow.observe','first-ref','{"runId":"writer-first"}','READY')`);
      inserted(); await gate;
    });
    await ready;
    const deletion = createOwnerHistory(t.db, 'default').change(owner, 'EXECUTION_RUN', 'writer-first', 'DELETE');
    try {
      await expect.poll(async () => (await t.db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")).rows[0]!.n).toBe(1);
    } finally { release(); }
    await writer;
    expect(await deletion).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
    expect((await t.db.query('SELECT count(*)::int AS n FROM execution_runs')).rows).toEqual([{ n: 1 }]);
  });

  it('archives an executed workflow library entry even without a saved draft, retaining its runs', async () => {
    const t = await database(); await seed(t, 'executed', { status: 'RECONCILED', evidence: true });
    const history = createOwnerHistory(t.db, 'default');
    expect(await history.change(owner, 'SAVED_WORKFLOW', 'workflow-executed', 'DELETE')).toEqual({ ok: false, code: 'RUN_DELETE_REFUSED' });
    expect(await history.change(owner, 'SAVED_WORKFLOW', 'workflow-executed', 'ARCHIVE')).toEqual({ ok: true, disposition: 'ARCHIVED' });
    expect(await createOwnerHistory(t.open(), 'default').disposition(owner, 'SAVED_WORKFLOW', 'workflow-executed')).toEqual({ ok: true, disposition: 'ARCHIVED' });
    expect(await createRunQueries(t.db, 'default').getRun('executed')).toMatchObject({ hasEvidence: true });
  });
});
