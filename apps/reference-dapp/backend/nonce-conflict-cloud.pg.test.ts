// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001 (P0): the worker's nonce-conflict handling on durable cloud state — PostgreSQL, fenced leases,
 * the outbox and real worker processes, with the MOCKED loopback Base/Arbitrum router harness. The reserved approval nonce is consumed by
 * a different transaction (a wallet cancel); the worker investigates read-only, paces stable checks, escalates to an operator after
 * unchanged complete evidence, and never resolves, fails or resubmits anything. The only "wallet" is the test.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFilesystemEvidenceStore, createLogger, createPostgresWorkQueue, createWorker, MAX_DELIVERIES, type Database } from '@defi-workflow-engine/cloud-runtime';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import { editorReducer, initialEditor } from '../src/domain/editor.ts';
import type { RouterBegin, RouterRecord } from '../src/server/router-service.ts';
import { createRouterHarness, ROUTER_OWNER, type RouterHarness } from '../e2e/router-harness.ts';
import { listNonceConflicts } from '../src/server/nonce-conflict-store.ts';
import { STABLE_ESCALATION_CODE } from '../src/server/nonce-conflict.ts';
import { previewRecovery } from '../src/admin/support/recovery.ts';
import { incidentDetail } from '../src/admin/support/view.ts';
import { nonceConflictView } from '../src/admin/support/nonce-conflict-view.ts';
import { createBackend, type FlowResult } from './app.ts';

const quiet = createLogger({ service: 'test', sink: () => undefined });
const env = { GRYLOO_ROUTER_HARNESS: 'MOCKED_LOOPBACK_ONLY' } as const;
const SEND = ['eth_sendTransaction', 'eth_sendRawTransaction', 'sendTransaction'];
function ok<T>(result: FlowResult): T { if (!result.ok) throw new Error(result.code); return result.value as T; }
function workflow(): SemanticWorkflow {
  const result = editorReducer(initialEditor(), { type: 'ADD_ROUTER_BRIDGE', input: { source: 'Base', destination: 'Arbitrum', token: 'USDC', amount: '10', recipient: '',
    slippage: '50', routing: 'AUTO' }, source: 'CANVAS', baseRevision: 0 }, createBaseSepoliaReviewContext());
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
}

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); await t.db.query(`INSERT INTO tenants (tenant_id) VALUES ('tenant-b')`); });
afterAll(async () => { await t?.drop(); });
async function deployment(h: RouterHarness, tenantId = 'default') {
  const methods: string[] = [];
  const source = (method: string, params: readonly unknown[]) => { methods.push(method); return h.baseRpc(method, params); };
  const destination = (method: string, params: readonly unknown[]) => { methods.push(method); return h.arbitrumRpc(method, params); };
  const db: Database = t.open(6), workerId = `worker-${Math.random().toString(16).slice(2, 8)}`;
  const backend = createBackend({ db, env, logger: quiet, tenantId, holderId: workerId, evidenceStore: createFilesystemEvidenceStore(await mkdtemp(join(tmpdir(), 'flofi-nc-'))),
    rpc: { 'crosschain-router': source }, router: { destinationRpc: destination, providers: h.providers }, busyRetries: 3 });
  const worker = createWorker({ queue: createPostgresWorkQueue({ db, ownerId: workerId, tenantId }), handlers: backend.handlers, logger: quiet, workerId, concurrency: 4 });
  return { db, worker, methods, call: (method: string, ...args: unknown[]) => backend.callFlow('crosschain-router', method, args, tenantId, ROUTER_OWNER) };
}
const due = (db: Database) => db.query(`UPDATE work_items SET available_at = now() WHERE state = 'READY'`);
const task = async (runId: string) => (await t.db.query<{ state: string; last_error: string | null; deliveries: number; delay_s: number }>(`SELECT state, last_error, deliveries,
  extract(epoch FROM available_at - now())::int AS delay_s FROM work_items WHERE run_id = $1 AND kind = 'reconcile' ORDER BY id DESC LIMIT 1`, [runId])).rows[0]!;

/** A reviewed run whose approval was handed to the wallet, then the wallet consumed the reserved nonce with a different transaction. */
async function conflicted(h: RouterHarness, d: Awaited<ReturnType<typeof deployment>>) {
  const w = workflow(), run = ok<RouterRecord>(await d.call('simulate', w, ROUTER_OWNER));
  ok(await d.call('review', run.id, run.review.commitment, w));
  const begun = ok<RouterBegin>(await d.call('begin', run.id, ROUTER_OWNER, w));
  ok(await d.call('handoff', run.id));
  const cancel = h.wallet.cancel();
  h.advance(600); // the cancel becomes final on the MOCKED chain
  return { runId: run.id, begun, cancel };
}

describe('nonce-conflict reconciliation on durable cloud state (MOCKED Base / Arbitrum)', () => {
  it('investigates read-only, keeps the outcome unknown, backs off, escalates once evidence is stable and complete, and allows a read-only re-inspection', async () => {
    const h = createRouterHarness({ nonce: 60n, autoFillSeconds: null }), d = await deployment(h);
    const { runId, begun, cancel } = await conflicted(h, d);
    const sendsBefore = h.counters.sends;

    await due(d.db); await d.worker.drainOnce();
    let record = ok<RouterRecord>(await d.call('status', runId));
    expect(record).toMatchObject({ verdict: 'PENDING', error: 'ROUTER_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION' });
    expect(record.attempts.at(-1)).toMatchObject({ attemptId: begun.attempt.attemptId, state: 'SUBMISSION_RESULT_UNKNOWN', conflictingTransactionHash: cancel });
    let [row] = await listNonceConflicts(t.db, 'default', runId);
    expect(row).toMatchObject({ attemptId: begun.attempt.attemptId, classification: 'CONFLICTING_TRANSACTION_IDENTIFIED', conflictingTransactionHash: cancel,
      stableObservations: 0, investigations: 1, escalatedAt: null,
      report: { financialOutcome: 'UNKNOWN', executionStructure: 'DIRECT', reviewedEffectInConflict: 'ABSENT', proofComplete: true,
        alternateNonce: { status: 'NONE_IN_SCANNED_RANGE', complete: true } } });
    expect(row!.lastVerifiedAt).toBeInstanceOf(Date);
    // A stable conflict is paced from 15 minutes (the worker's own backoff would retry within seconds) and keeps the observation's own reason.
    expect(await task(runId)).toMatchObject({ state: 'READY', last_error: 'ROUTER_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION' });
    expect((await task(runId)).delay_s).toBeGreaterThan(14 * 60);

    // Worker restart: a fresh process continues the same investigation row (idempotent), with the recorded consumer re-verified by hash —
    // the ~25-read nonce binary search does not run again.
    const restarted = await deployment(h);
    await due(restarted.db); await restarted.worker.drainOnce();
    [row] = await listNonceConflicts(t.db, 'default', runId);
    expect(row).toMatchObject({ investigations: 2, stableObservations: 1 });
    expect(restarted.methods.filter(m => m === 'eth_getTransactionCount')).toEqual([]);
    expect(await t.db.query(`SELECT count(*)::int AS n FROM execution_nonce_conflicts WHERE run_id = $1`, [runId])).toMatchObject({ rows: [{ n: 1 }] });

    // Unchanged evidence for 24 h and four checks: the check stops for an operator; the outcome is still unknown (never resolved/failed).
    await t.db.query(`UPDATE execution_nonce_conflicts SET first_observed_at = now() - interval '2 days' WHERE run_id = $1`, [runId]);
    for (let i = 0; i < 4 && (await task(runId)).state === 'READY'; i++) { await due(restarted.db); await restarted.worker.drainOnce(); }
    expect(await task(runId)).toMatchObject({ state: 'DEAD', last_error: STABLE_ESCALATION_CODE });
    expect((await task(runId)).deliveries).toBeLessThan(10); // not 500
    expect(MAX_DELIVERIES).toBe(500);
    [row] = await listNonceConflicts(t.db, 'default', runId);
    expect(row!.escalatedAt).toBeInstanceOf(Date);
    const projected = (await t.db.query<{ status: string }>(`SELECT status, attention_required, needs_observation, error_code FROM execution_runs WHERE run_id = $1`, [runId])).rows[0]!;
    expect(projected).toMatchObject({ attention_required: true, needs_observation: true, error_code: 'ROUTER_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION' });
    expect(['RECONCILED', 'FAILED', 'CANCELLED', 'COMPLETED']).not.toContain(projected.status);
    record = ok<RouterRecord>(await d.call('status', runId));
    expect(record.verdict).toBe('PENDING');

    // Support shows the investigation without calling it resolved, and a read-only re-inspection stays available (bounded by the registry).
    const detail = await incidentDetail({}, { db: t.db, tenantId: 'default' }, new Date(), `run:${runId}`);
    expect(detail.type).toBe('run');
    const views = detail.type === 'run' ? detail.nonceConflicts!.map(row => nonceConflictView(row)) : [];
    expect(views[0]).toMatchObject({ classification: 'A different transaction used the reserved nonce', step: 'APPROVAL', nonce: '60',
      outcome: expect.stringMatching(/^Unknown/), status: expect.stringMatching(/escalated for operator review \(outcome still unknown\)/),
      conflictingTransaction: { hash: cancel, proven: true } });
    expect(JSON.stringify(views)).not.toMatch(/resolved/i);
    // With the run's own state: the stopped check is the escalation, and a queued re-inspection is said so (never "resolved").
    const row0 = detail.type === 'run' ? detail.nonceConflicts![0]! : null;
    expect(nonceConflictView(row0!, { needsObservation: true, reconcile: { state: 'DEAD', createdAt: new Date(0) } }).status).toMatch(/escalated for operator review/);
    expect(nonceConflictView(row0!, { needsObservation: true, reconcile: { state: 'READY', createdAt: new Date(Date.now() + 1000) } }).status)
      .toBe('Re-inspection queued — outcome still unknown');
    expect(nonceConflictView(row0!, { needsObservation: false, reconcile: null }).outcome).toMatch(/no longer observes this run/);
    expect(JSON.stringify(views)).not.toContain(ROUTER_OWNER.slice(2));
    const preview = await previewRecovery({ db: t.db, tenantId: 'default' }, runId, 'execution.resume-observation', new Date());
    expect(preview?.eligibility).toEqual({ eligible: true });

    // No observer ever sent anything.
    expect(h.counters.sends).toBe(sendsBefore);
    expect([...d.methods, ...restarted.methods].filter(m => SEND.includes(m))).toEqual([]);
  });

  it('new evidence resets the stability count and re-opens automatic observation', async () => {
    const h = createRouterHarness({ nonce: 70n, autoFillSeconds: null }), d = await deployment(h);
    const { runId } = await conflicted(h, d);
    await due(d.db); await d.worker.drainOnce();
    await due(d.db); await d.worker.drainOnce();
    let [row] = await listNonceConflicts(t.db, 'default', runId);
    expect(row!.stableObservations).toBe(1);
    // Simulate an earlier, different report (e.g. a scan that had not finished): the next complete one is new evidence.
    await t.db.query(`UPDATE execution_nonce_conflicts SET evidence_fingerprint = repeat('0', 64), escalated_at = now() WHERE run_id = $1`, [runId]);
    await due(d.db); await d.worker.drainOnce();
    [row] = await listNonceConflicts(t.db, 'default', runId);
    expect(row).toMatchObject({ stableObservations: 0, escalatedAt: null });
  });

  it('an RPC outage never erases stored evidence nor resets stability, and paces like any transient failure', async () => {
    const h = createRouterHarness({ nonce: 80n, autoFillSeconds: null }), d = await deployment(h);
    const { runId } = await conflicted(h, d);
    await due(d.db); await d.worker.drainOnce();
    await due(d.db); await d.worker.drainOnce();
    const outage = await (async () => {
      const methods: string[] = [];
      const db: Database = t.open(4), workerId = 'outage-worker';
      const backend = createBackend({ db, env, logger: quiet, tenantId: 'default', holderId: workerId, evidenceStore: null,
        rpc: { 'crosschain-router': async (method, params) => { methods.push(method); if (method === 'eth_getTransactionByHash') throw Error('PUBLIC_RPC_UNAVAILABLE'); return h.baseRpc(method, params); } },
        router: { destinationRpc: h.arbitrumRpc, providers: h.providers }, busyRetries: 3 });
      return { db, worker: createWorker({ queue: createPostgresWorkQueue({ db, ownerId: workerId }), handlers: backend.handlers, logger: quiet, workerId, concurrency: 2 }) };
    })();
    await due(outage.db); await outage.worker.drainOnce();
    const [row] = await listNonceConflicts(t.db, 'default', runId);
    expect(row).toMatchObject({ classification: 'CONFLICTING_TRANSACTION_IDENTIFIED', stableObservations: 1, lastCheckCode: 'RPC_UNAVAILABLE', investigations: 3 });
    expect((await task(runId)).delay_s).toBeLessThan(10 * 60 + 5);
  });

  it('keeps tenants isolated: another tenant never sees or affects the investigation', async () => {
    const h = createRouterHarness({ nonce: 90n, autoFillSeconds: null }), d = await deployment(h);
    const { runId } = await conflicted(h, d);
    await due(d.db); await d.worker.drainOnce();
    expect(await listNonceConflicts(t.db, 'tenant-b', runId)).toEqual([]);
    const other = await deployment(h, 'tenant-b');
    await due(other.db); await other.worker.drainOnce(); // a tenant-scoped worker claims only its own tenant's items
    const [row] = await listNonceConflicts(t.db, 'default', runId);
    expect(row!.investigations).toBe(1);
  });
});
