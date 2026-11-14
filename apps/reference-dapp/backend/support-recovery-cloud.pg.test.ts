// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001 end to end on PostgreSQL, with the UNCHANGED Robinhood transfer service and the real worker
 * `reconcile` handler against a MOCKED in-process chain (no public network, no real broadcast; the test is the only wallet, as in
 * `cloud-execution.pg.test.ts`). An owner-submitted transfer's result is unknown, its transaction check exhausts its budget and stops,
 * Support discovers it, an operator resumes the check, the existing worker reconciles it, and the recovery verifies as resolved — with
 * exactly one transaction on chain and no second submission.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFilesystemEvidenceStore, createLogger, createPostgresWorkQueue, createWorker, sweep } from '@defi-workflow-engine/cloud-runtime';
import { createNativeTransferNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createRobinhoodTransferChain, TRANSFER_OWNER as owner } from '../e2e/robinhood-transfer-harness.mjs';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import type { TransferRecord } from '../src/server/robinhood-transfer-service.ts';
import { discoverIncidents } from '../src/admin/support/incidents.ts';
import { executeRecovery, previewRecovery, recoveryHistory, verifyRecovery } from '../src/admin/support/recovery.ts';
import { createBackend, type FlowResult } from './app.ts';

const quiet = createLogger({ service: 'test', sink: () => undefined });
const env = { GRYLOO_ROBINHOOD_HARNESS: 'MOCKED_LOOPBACK_ONLY' } as const;
const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'rh-support', revision: 1, resourceEdges: [],
  nodes: [createNativeTransferNode('node-002', { chain: 'eip155:46630', amount: '1000000000000', recipient: 'CONNECTED_OWNER' })] };
function ok<T>(result: FlowResult): T { if (!result.ok) throw new Error(result.code); return result.value as T; }

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

describe('Support & Recovery: resume a stopped transaction check end to end', () => {
  it('discovers the stopped check, re-queues it once, the worker reconciles it, and nothing is submitted again', async () => {
    const chain = createRobinhoodTransferChain({ nonce: 700 }), db = t.open(6);
    const backend = createBackend({ db, env, logger: quiet, tenantId: 'default', holderId: 'worker-support', rpc: { 'robinhood-transfer': chain.rpc }, busyRetries: 3,
      evidenceStore: createFilesystemEvidenceStore(await mkdtemp(join(tmpdir(), 'flofi-support-evidence-'))) });
    const queue = createPostgresWorkQueue({ db, ownerId: 'worker-support' });
    const worker = createWorker({ queue, handlers: backend.handlers, logger: quiet, workerId: 'worker-support', concurrency: 4 });
    const rh = (method: string, ...args: unknown[]) => backend.callFlow('robinhood-transfer', method, args);

    // The owner signs and broadcasts; the browser then loses the result.
    const simulated = ok<TransferRecord>(await rh('simulate', workflow, owner));
    const record = ok<TransferRecord>(await rh('review', simulated.id, simulated.review.commitment, workflow));
    const begin = ok<{ transaction: Record<string, string> }>(await rh('begin', record.id, owner, workflow));
    ok(await rh('handoff', record.id));
    await chain.rpc('MOCK_submit', [begin.transaction]);
    ok(await rh('report', record.id, { kind: 'UNKNOWN', code: 'TRANSFER_SUBMISSION_UNKNOWN' }));
    expect(chain.transactions).toHaveLength(1);

    // Its check exhausts its budget (as after a long RPC outage): the queue dead-letters it and flags the run.
    await db.query(`UPDATE work_items SET available_at = now() WHERE state = 'READY'`);
    const [claimed] = await queue.claim(1, ['reconcile']);
    expect(claimed?.runId).toBe(record.id);
    expect(await queue.dead(claimed!, 'OBSERVATION_BUDGET_EXHAUSTED')).toBe(true);
    await sweep(db, { tenantId: 'default' }); // the sweeper deliberately does not re-arm a flagged run
    expect((await db.query(`SELECT count(*)::int AS n FROM work_items WHERE run_id = $1 AND state IN ('READY', 'LEASED')`, [record.id])).rows[0]).toEqual({ n: 0 });

    const now = new Date();
    const { incidents } = await discoverIncidents(db, 'default', now);
    const incident = incidents.find(i => i.id === `run:${record.id}`);
    expect(incident).toMatchObject({ kind: 'OBSERVATION_STOPPED', eligibility: 'RECOVERABLE_NOW', submitted: 'UNKNOWN', funds: 'TEST_ONLY', environment: 'MOCKED', outcomeKnown: false });

    const host = { db, tenantId: 'default' };
    const preview = (await previewRecovery(host, record.id, 'execution.resume-observation', now))!;
    expect(preview.eligibility).toEqual({ eligible: true });
    const result = await executeRecovery(host, 'adm_aaaaaaaaaaaaaaaaaaaaaaaaaa', { runId: record.id, action: 'execution.resume-observation',
      stateToken: preview.stateToken, idempotencyKey: 'support-e2e-key-0001', reason: 'RPC outage over' }, now);
    expect(result).toMatchObject({ replayed: false, attentionCleared: true, verification: { status: 'PENDING_VERIFICATION', taskState: 'READY' } });

    // The existing worker handler reconciles it — read-only discovery of the owner's transaction by nonce.
    expect(await worker.drainOnce()).toBeGreaterThanOrEqual(1);
    expect(ok<TransferRecord>(await rh('status', record.id))).toMatchObject({ verdict: 'RECONCILED', attempt: { state: 'CONFIRMED', reconciled: true } });
    expect(await verifyRecovery(host, { runId: record.id, action: 'execution.resume-observation', workItemId: result.workItemId }))
      .toMatchObject({ status: 'RESOLVED', taskState: 'DONE', runStatus: 'RECONCILED' });
    expect((await recoveryHistory(host, new Date(), { runId: record.id }))[0]).toMatchObject({ outcome: 'OK', operationId: result.operationId, verification: { status: 'RESOLVED' } });

    // Nothing was submitted twice, and there is nothing left to recover.
    expect(chain.transactions).toHaveLength(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM execution_attempts WHERE run_id = $1`, [record.id])).rows[0]).toEqual({ n: 1 });
    expect((await previewRecovery(host, record.id, 'execution.resume-observation', new Date()))!.eligibility).toMatchObject({ eligible: false, code: 'SUPPORT_NOTHING_TO_RECOVER' });
    expect((await discoverIncidents(db, 'default', new Date())).incidents.find(i => i.id === `run:${record.id}`)).toBeUndefined();
    await db.close();
  });
});
