// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FINOPS-AUTOMATED-SYNC-002 P0: the historical reconciliation procedure on disposable PostgreSQL. It selects only public
 * mainnet executions that still need observation with an incident-class settlement code, writes nothing in a dry run, and on apply only
 * re-queues each run's own `reconcile` task through the audited recovery. Run status, attempts and transaction hashes never change; only the
 * stopped-check `attention_required` flag is cleared, as the interactive recovery does.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTenant } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { runAdminCommand } from '../cli-commands.ts';
import { historicalReconciliation } from './historical-reconciliation.ts';

let t: TestDatabase;
const tenant = 'default', NOW = new Date('2026-11-18T23:00:00Z');
type Seed = { runId: string; flow?: string; status?: string; provenance?: string; needsObservation?: boolean; attention?: boolean; errorCode?: string | null;
  work?: { state: 'DEAD' | 'READY'; lastError?: string } | null };
async function seed(run: Seed) {
  const flow = run.flow ?? 'crosschain-universal', log = run.runId + '.log';
  await t.db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ($1, 'workflow-1') ON CONFLICT DO NOTHING`, [tenant]);
  await t.db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256)
    VALUES ($1, $2, $3, 'RUN', 1, 1, 3, $4)`, [tenant, flow, log, createHash('sha256').update('{}\n').digest('hex')]);
  await t.db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, owner_account, needs_observation,
      attention_required, has_evidence, log_version, created_at, updated_at, error_code) VALUES ($1, $2, $3, $2 || '.log', 'workflow-1', $3, $4, $5, NULL, $6, $7, false, 1,
      $8, $8, $9)`, [tenant, run.runId, flow, run.status ?? 'SOURCE_CONFIRMED', run.provenance ?? 'PUBLIC_MAINNET', run.needsObservation ?? true, run.attention ?? true,
    new Date('2026-11-18T19:40:00Z'), run.errorCode === undefined ? 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE' : run.errorCode]);
  await t.db.query(`INSERT INTO execution_attempts (tenant_id, attempt_id, run_id, step, state, transaction_hash, reconciled)
    VALUES ($1, $2 || '.0', $2, 'DEPOSIT', 'CONFIRMED', $3, true)`, [tenant, run.runId, '0x' + run.runId.replace(/[^0-9a-f]/g, '').padEnd(64, '0').slice(0, 64)]);
  const work = run.work === undefined ? { state: 'DEAD' as const, lastError: 'OBSERVATION_BUDGET_EXHAUSTED' } : run.work;
  if (work) await t.db.query(`INSERT INTO work_items (tenant_id, kind, dedupe_key, run_id, payload, state, deliveries, last_error, completed_at)
    VALUES ($1, 'reconcile', $2 || ':' || $3, $3, jsonb_build_object('namespace', $2::text, 'runId', $3::text), $4, 500, $5, $6)`,
  [tenant, flow, run.runId, work.state, work.lastError ?? null, work.state === 'DEAD' ? new Date() : null]);
}
const snapshot = async () => (await t.db.query(`SELECT r.run_id, r.status, r.error_code, r.needs_observation, a.state, a.transaction_hash
  FROM execution_runs r JOIN execution_attempts a USING (tenant_id, run_id) WHERE r.tenant_id = $1 ORDER BY r.run_id`, [tenant])).rows;

beforeAll(async () => {
  t = await createTestDatabase();
  await ensureTenant(t.db, tenant);
  await seed({ runId: 'xuni-a1' });
  await seed({ runId: 'xuni-a2', errorCode: 'UNIVERSAL_DELIVERY_ORDER_NOT_BOUND', status: 'RECOVERY_REQUIRED' });
  await seed({ runId: 'xuni-a3', attention: false, work: { state: 'READY' } });
  await seed({ runId: 'xuni-a4', work: { state: 'DEAD', lastError: 'UNIVERSAL_STORE_CORRUPT' } });
  // Never candidates: a terminal run, a testnet run, another error class and another flow.
  await seed({ runId: 'xuni-b1', status: 'RECONCILED', needsObservation: false, errorCode: null, work: null });
  await seed({ runId: 'xuni-b2', provenance: 'PUBLIC_TESTNET' });
  await seed({ runId: 'xuni-b3', errorCode: 'UNIVERSAL_DELIVERY_RECIPIENT_MISMATCH' });
  await seed({ runId: 'pub-b4', flow: 'base-swap' });
});
afterAll(async () => { await t?.drop(); });

describe('historical settlement reconciliation', () => {
  it('a dry run lists only incident-class mainnet executions and writes nothing', async () => {
    const before = await snapshot(), items = (await t.db.query('SELECT count(*)::int AS n FROM work_items')).rows[0]!.n;
    const result = await historicalReconciliation({ db: t.db, tenantId: tenant }, { flow: 'crosschain-universal', limit: 50, now: NOW });
    expect(result).toMatchObject({ mode: 'DRY_RUN', queued: 0, remaining: 2 });
    expect(result.candidates.map(c => [c.runId, c.disposition])).toEqual([['xuni-a1', 'ELIGIBLE'], ['xuni-a2', 'ELIGIBLE'],
      ['xuni-a3', 'ALREADY_OBSERVING'], ['xuni-a4', 'REFUSED']]);
    expect(result.candidates.find(c => c.runId === 'xuni-a4')?.code).toBe('SUPPORT_STOP_REASON_NOT_RETRYABLE');
    expect(await snapshot()).toEqual(before);
    expect((await t.db.query('SELECT count(*)::int AS n FROM work_items')).rows[0]!.n).toBe(items);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM admin_audit_events WHERE tenant_id = $1`, [tenant])).rows[0]!.n).toBe(0);
  });

  it('apply requires an approval, re-queues only the reconcile task, and is idempotent', async () => {
    await expect(runAdminCommand('reconcile-history', { apply: true }, t.db, tenant)).rejects.toThrow('ARGUMENT_REQUIRED: --approval-ref');
    const before = await snapshot();
    const io = { env: {}, adminKey: () => Buffer.alloc(32), wallet: async () => '', now: () => NOW };
    const applied = await runAdminCommand('reconcile-history', { apply: true, 'approval-ref': 'INC-2026-11-18', reason: 'Re-observe with the trace verifier' },
      t.db, tenant, io) as { reconciliation: Awaited<ReturnType<typeof historicalReconciliation>> };
    expect(applied.reconciliation).toMatchObject({ mode: 'APPLY', queued: 2, remaining: 0 });
    expect(applied.reconciliation.candidates.map(c => [c.runId, c.disposition])).toEqual([['xuni-a1', 'QUEUED'], ['xuni-a2', 'QUEUED'],
      ['xuni-a3', 'ALREADY_OBSERVING'], ['xuni-a4', 'REFUSED']]);
    // The execution records, attempts and hashes are untouched; only a reconcile task is queued and the stopped-check flag cleared.
    expect(await snapshot()).toEqual(before);
    const queued = (await t.db.query(`SELECT run_id, kind, state FROM work_items WHERE tenant_id = $1 AND state = 'READY' ORDER BY run_id`, [tenant])).rows;
    expect(queued).toEqual([{ run_id: 'xuni-a1', kind: 'reconcile', state: 'READY' }, { run_id: 'xuni-a2', kind: 'reconcile', state: 'READY' },
      { run_id: 'xuni-a3', kind: 'reconcile', state: 'READY' }]);
    expect((await t.db.query(`SELECT run_id FROM execution_runs WHERE tenant_id = $1 AND attention_required ORDER BY run_id`, [tenant])).rows.map(r => r.run_id))
      .not.toContain('xuni-a1');
    expect((await t.db.query(`SELECT count(*)::int AS n FROM admin_audit_events WHERE tenant_id = $1 AND kind = 'SUPPORT_RECOVERY' AND outcome = 'OK'`, [tenant])).rows[0]!.n).toBe(2);
    const again = await historicalReconciliation({ db: t.db, tenantId: tenant }, { flow: 'crosschain-universal', limit: 50, now: NOW,
      apply: { approvalRef: 'INC-2026-11-18', reason: 'Re-observe with the trace verifier', actor: 'cli' } });
    expect(again).toMatchObject({ queued: 0 });
    expect(again.candidates.slice(0, 3).every(c => c.disposition === 'ALREADY_OBSERVING')).toBe(true);
  });
});
