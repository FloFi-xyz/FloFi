// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: admin analytics against PostgreSQL and genuine run records.
 *
 *  - A real MOCKED Router testnet run (Base Sepolia → Arbitrum Sepolia, loopback chains, the API routes, the worker, the outbox) is
 *    reconciled end to end; the facts indexer reads its canonical record and the overview counts it once, as one bridge on its source
 *    network with its destination as an arrival — in the Mocked environment only. A second, simulated-only run never counts.
 *  - Seeded projections exercise what one journey cannot: a Solana composition and its step runs (counted once, re-indexed when the
 *    composition record grows), an unreadable record (reported, never guessed), and the indexer's batch limits.
 *  - Automation metrics, health and the CLI `index` command read the same database.
 *  - Range edges (pre-PR hardening): a composition that started before the range still claims its step runs, a recovery belongs to the
 *    execution it recovers (never counted twice across ranges), a truncated range reports what it covers, and owner-confirmed proposals are
 *    linked to the executions FloFi verified through their approval handoff.
 */
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFilesystemEvidenceStore, createLogger, createPostgresWorkQueue, createWorker, HttpError, SHIPPED_MIGRATIONS, type Database } from '@defi-workflow-engine/cloud-runtime';
import { CROSSCHAIN_ROUTER_BASE_SEPOLIA_ARBITRUM_SEPOLIA as TESTNET } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet.ts';
import { editorReducer, initialEditor } from '../src/domain/editor.ts';
import type { RouterBridgeInput } from '../src/domain/router-authoring.ts';
import type { RouterBegin, RouterRecord } from '../src/server/router-service.ts';
import { WALLET_PRINCIPAL_HEADER } from '../src/server/run-ownership.ts';
import { createRouterHarness, type RouterHarness } from '../e2e/router-harness.ts';
import { automationAnalytics } from '../src/admin/analytics/automations.ts';
import { indexRunFacts } from '../src/admin/analytics/indexer.ts';
import { workflowView } from '../src/admin/analytics/view.ts';
import { loadRuns } from '../src/admin/analytics/workflows.ts';
import { runAdminCommand } from '../src/admin/cli-commands.ts';
import { apiReadiness, healthReport } from '../src/admin/health.ts';
import { createBackend, type FlowResult } from './app.ts';

const FLOW = 'crosschain-router-testnet';
const quiet = createLogger({ service: 'test', sink: () => undefined });
const env = { GRYLOO_ROUTER_TESTNET_HARNESS: 'MOCKED_LOOPBACK_ONLY', GRYLOO_ROUTER_HARNESS: 'MOCKED_LOOPBACK_ONLY' } as const;
function ok<T>(result: FlowResult): T { if (!result.ok) throw new Error(result.code); return result.value as T; }
function workflow(): SemanticWorkflow {
  const input: RouterBridgeInput = { source: 'Base Sepolia', destination: 'Arbitrum Sepolia', token: 'USDC', amount: '1', recipient: '', slippage: '50', routing: 'AUTO' };
  const result = editorReducer(initialEditor(), { type: 'ADD_ROUTER_BRIDGE', input, source: 'CANVAS', baseRevision: 0 }, createBaseSepoliaReviewContext());
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
}
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

async function deployment(h: RouterHarness) {
  const db: Database = t.open(6), workerId = `worker-${Math.random().toString(16).slice(2, 8)}`, dir = await mkdtemp(join(tmpdir(), 'flofi-admin-evidence-'));
  const backend = createBackend({ db, env, logger: quiet, tenantId: 'default', holderId: workerId, evidenceStore: createFilesystemEvidenceStore(dir),
    rpc: { [FLOW]: h.baseRpc }, routers: { [FLOW]: { destinationRpc: h.arbitrumRpc, providers: h.providers } }, busyRetries: 3 });
  const worker = createWorker({ queue: createPostgresWorkQueue({ db, ownerId: workerId }), handlers: backend.handlers, logger: quiet, workerId, concurrency: 8 });
  const post = async (method: string, args: unknown[], principal: string) => {
    const route = backend.routes.find(r => r.name === 'flow')!, path = `/v1/flows/${FLOW}/${method}`;
    try {
      return (await route.handler({ method: 'POST', path, query: new URLSearchParams(), body: { args }, requestId: 'r',
        headers: { 'idempotency-key': crypto.randomUUID(), [WALLET_PRINCIPAL_HEADER]: principal } }, route.pattern.exec(path)!)).body as FlowResult;
    } catch (error) { if (error instanceof HttpError) return { ok: false, code: `HTTP_${error.status}_${error.message}` } as FlowResult; throw error; }
  };
  return { db, worker, post };
}

type Seed = { runId: string; flow: string; status: string; provenance?: string; record: unknown; attempts?: { step: string; state: string; hash?: string | null; reconciled?: boolean }[];
  createdAt?: Date; workflowId?: string; hasEvidence?: boolean; logBytes?: Buffer };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function seed(db: Database, run: Seed) {
  const bytes = run.logBytes ?? Buffer.from(JSON.stringify(run.record) + '\n'), name = `${run.runId}.jsonl`, workflowId = run.workflowId ?? `wf-${run.runId}`;
  await db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ('default', $1) ON CONFLICT DO NOTHING`, [workflowId]);
  await db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256) VALUES ('default', $1, $2, 'RUN', 1, 1, $3, $4)`,
    [run.flow, name, bytes.length, sha(bytes)]);
  await db.query(`INSERT INTO execution_log_segments (tenant_id, namespace, name, seq, bytes, segment_sha256, content_sha256) VALUES ('default', $1, $2, 0, $3, $4, $4)`,
    [run.flow, name, bytes, sha(bytes)]);
  await db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, needs_observation, has_evidence, log_version, created_at, updated_at)
    VALUES ('default', $1, $2, $3, $4, $2, $5, $6, false, $7, 1, $8, $8)`, [run.runId, run.flow, name, workflowId, run.status, run.provenance ?? 'PUBLIC_DEVNET', run.hasEvidence ?? false,
    run.createdAt ?? new Date(Date.now() - 3_600_000)]);
  for (const [i, attempt] of (run.attempts ?? []).entries())
    await db.query(`INSERT INTO execution_attempts (tenant_id, attempt_id, run_id, step, state, transaction_hash, reconciled) VALUES ('default', $1, $2, $3, $4, $5, $6)`,
      [`${run.runId}.${attempt.step}.${i}`, run.runId, attempt.step, attempt.state, attempt.hash ?? null, attempt.reconciled ?? false]);
}
async function extend(db: Database, flow: string, runId: string, record: unknown) {
  const name = `${runId}.jsonl`, segment = Buffer.from(JSON.stringify(record) + '\n');
  const prior = (await db.query<{ bytes: Buffer }>(`SELECT bytes FROM execution_log_segments WHERE tenant_id = 'default' AND namespace = $1 AND name = $2 ORDER BY seq`, [flow, name])).rows;
  const whole = Buffer.concat([...prior.map(r => r.bytes), segment]);
  await db.query(`UPDATE execution_logs SET version = 2, segment_count = 2, byte_length = $3, content_sha256 = $4 WHERE tenant_id = 'default' AND namespace = $1 AND name = $2`,
    [flow, name, whole.length, sha(whole)]);
  await db.query(`INSERT INTO execution_log_segments (tenant_id, namespace, name, seq, bytes, segment_sha256, content_sha256) VALUES ('default', $1, $2, 1, $3, $4, $5)`,
    [flow, name, segment, sha(segment), sha(whole)]);
  // As the real projection does: a new log version moves updated_at forward (created_at never moves).
  await db.query(`UPDATE execution_runs SET log_version = 2, updated_at = now() WHERE tenant_id = 'default' AND run_id = $1`, [runId]);
}
const SOL_DEV = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', SIG = (c: string) => c.repeat(88).slice(0, 88);
const swapNode = { nodeId: 'swap', actionType: 'asset.swap.exact-input', chainId: SOL_DEV }, lpNode = { nodeId: 'lp', actionType: 'asset.liquidity.concentrated', chainId: SOL_DEV };

describe('BUILD-ADMIN-001 admin analytics (PostgreSQL, genuine records)', () => {
  it('a real reconciled router run counts once, as a bridge on its source network, in the Mocked environment only', async () => {
    const A = createTestWallet().address, h = createRouterHarness({ profile: TESTNET, owner: A, nonce: 3n }), w = workflow(), d = await deployment(h);
    const run = ok<RouterRecord>(await d.post('simulate', [w, A], A)), id = run.id;
    ok<RouterRecord>(await d.post('simulate', [workflow(), A], A)); // a second simulation that never starts
    ok(await d.post('review', [id, run.review.commitment, w], A));
    const approval = ok<RouterBegin>(await d.post('begin', [id, A, w], A));
    ok(await d.post('handoff', [id], A));
    ok(await d.post('report', [id, { kind: 'HASH', hash: h.wallet.send(approval.transaction) }], A));
    const due = () => d.db.query(`UPDATE work_items SET available_at = now() WHERE state = 'READY'`);
    await due(); await d.worker.drainOnce();
    const deposit = ok<RouterBegin>(await d.post('begin', [id, A, w], A));
    ok(await d.post('handoff', [id], A));
    ok(await d.post('report', [id, { kind: 'HASH', hash: h.wallet.send(deposit.transaction) }], A));
    let final = ok<RouterRecord>(await d.post('status', [id], A));
    for (let i = 0; i < 15 && final.phase !== 'RECONCILED'; i++) { await due(); await d.worker.drainOnce(); h.advance(5); final = ok<RouterRecord>(await d.post('status', [id], A)); }
    expect(final).toMatchObject({ phase: 'RECONCILED', verdict: 'RECONCILED', provenance: 'MOCKED' });

    const index = await indexRunFacts(t.db, 'default', { limit: 50, budgetMs: 60_000 });
    expect(index).toMatchObject({ indexed: 1, unindexable: 0, pending: 0, budgetExhausted: false });
    expect((await t.db.query(`SELECT state, actions FROM admin_run_facts WHERE run_id = $1`, [id])).rows)
      .toEqual([{ state: 'INDEXED', actions: [{ i: 0, kind: 'BRIDGE', type: 'asset.bridge', chain: TESTNET.source.chain, to: TESTNET.destination.chain }] }]);
    const view = await workflowView({ db: t.db, tenantId: 'default' }, { env: 'MOCKED' }, new Date());
    if (!view.ok) throw new Error(view.code);
    const a = view.analytics;
    expect(a.executedByEnvironment).toEqual({ MAINNET: 0, TESTNET: 0, MOCKED: 1 });
    expect(a.funnel).toMatchObject({ simulated: 2, authorized: 1, started: 1, executed: 1, completed: 1 });
    expect(a.networks.rows.map(r => [r.name, r.actions, r.share, r.asDestination, r.COMPLETED])).toEqual([['Base Sepolia', 1, 1, 0, 1], ['Arbitrum Sepolia', 0, 0, 1, 0]]);
    expect(a.bridgeRoutes).toEqual([expect.objectContaining({ actions: 1, COMPLETED: 1, from: expect.objectContaining({ name: 'Base Sepolia' }), to: expect.objectContaining({ name: 'Arbitrum Sepolia' }) })]);
    expect(a.utilization.find(u => u.kind === 'BRIDGE')).toMatchObject({ executions: 1, executedActions: 1, completedActions: 1 });
    expect(a.fees.eligibleCompleted).toBe(1);
    const testnet = await workflowView({ db: t.db, tenantId: 'default' }, { env: 'TESTNET' }, new Date());
    expect(testnet.ok && testnet.analytics.funnel.executed).toBe(0); // MOCKED activity is never counted as testnet activity
    expect(JSON.stringify(view.analytics)).not.toContain(A.slice(2)); // no wallet address in the aggregates
  });

  it('folds composition step runs into their composition, re-indexes it as it grows, and reports unreadable records', async () => {
    await seed(t.db, { runId: 'sdx-step-1', flow: 'solana-devnet-swap', status: 'RECONCILED', hasEvidence: true, workflowId: 'wf-comp',
      record: { review: { workflow: { nodes: [swapNode] } } }, attempts: [{ step: 'SWAP', state: 'CONFIRMED', hash: SIG('a'), reconciled: true }] });
    await seed(t.db, { runId: 'solcomp-1', flow: 'solana-devnet-composition', status: 'CONSUMING', workflowId: 'wf-comp',
      record: { review: { workflow: { nodes: [swapNode, lpNode] } }, producerRunId: 'sdx-step-1', consumerRunIds: [] } });
    await seed(t.db, { runId: 'unreadable-1', flow: 'robinhood-transfer', status: 'RECONCILED', hasEvidence: true, provenance: 'PUBLIC_TESTNET',
      record: null, logBytes: Buffer.from('{"review":{"workflow":\n'), attempts: [{ step: 'TRANSFER', state: 'CONFIRMED', hash: '0x' + 'c'.repeat(64), reconciled: true }] });
    expect(await indexRunFacts(t.db, 'default', { limit: 50, budgetMs: 60_000 })).toMatchObject({ indexed: 2, unindexable: 1, pending: 0 });
    expect((await t.db.query(`SELECT run_id, state, code, composition_of FROM admin_run_facts WHERE run_id IN ('sdx-step-1', 'unreadable-1') ORDER BY run_id`)).rows).toEqual([
      { run_id: 'sdx-step-1', state: 'INDEXED', code: null, composition_of: 'solcomp-1' }, { run_id: 'unreadable-1', state: 'UNINDEXABLE', code: 'RUN_RECORD_UNREADABLE', composition_of: null }]);

    // The liquidity step starts: its run appears and the composition record names it in a new log version → re-indexed.
    await seed(t.db, { runId: 'olp-step-1', flow: 'orca-liquidity', status: 'PENDING', workflowId: 'wf-comp', record: { review: { workflow: { nodes: [lpNode] } } },
      attempts: [{ step: 'OPEN', state: 'PENDING', hash: SIG('b') }] });
    await extend(t.db, 'solana-devnet-composition', 'solcomp-1', { review: { workflow: { nodes: [swapNode, lpNode] } }, producerRunId: 'sdx-step-1', consumerRunIds: ['olp-step-1'] });
    expect(await indexRunFacts(t.db, 'default', { limit: 50, budgetMs: 60_000 })).toMatchObject({ indexed: 2, pending: 0 });
    expect((await t.db.query(`SELECT composition_of, indexed_log_version::int AS v FROM admin_run_facts WHERE run_id IN ('olp-step-1', 'solcomp-1') ORDER BY run_id`)).rows)
      .toEqual([{ composition_of: 'solcomp-1', v: 1 }, { composition_of: null, v: 2 }]);

    const view = await workflowView({ db: t.db, tenantId: 'default' }, { env: 'TESTNET' }, new Date());
    if (!view.ok) throw new Error(view.code);
    const composition = view.executions.find(e => e.rootId === 'solcomp-1')!;
    expect(view.executions.filter(e => e.workflowId === 'wf-comp').map(e => e.rootId)).toEqual(['solcomp-1']);
    expect(composition.actions!.map(x => [x.kind, x.outcome, x.executed])).toEqual([['SWAP', 'COMPLETED', true], ['LIQUIDITY', 'IN_PROGRESS', true]]);
    expect(view.analytics.networks.rows).toEqual([expect.objectContaining({ name: 'Solana Devnet', actions: 2, COMPLETED: 1, IN_PROGRESS: 1 })]);
    expect(view.analytics.networks.withoutRecordCodes).toEqual([{ code: 'RUN_RECORD_UNREADABLE', count: 1 }]);
    expect(view.analytics.funnel.executed).toBe(2);
  });

  it('indexes in bounded batches and reports what remains; the CLI completes it; the cache rebuilds after deletion', async () => {
    for (let i = 0; i < 5; i++) await seed(t.db, { runId: `batch-${i}`, flow: 'robinhood-transfer', status: 'HASH', provenance: 'PUBLIC_TESTNET',
      record: { review: { workflow: { nodes: [{ actionType: 'asset.transfer', chainId: 'eip155:46630' }] } } }, attempts: [{ step: 'TRANSFER', state: 'HASH', hash: '0x' + String(i).repeat(64) }] });
    expect(await indexRunFacts(t.db, 'default', { limit: 2, budgetMs: 60_000 })).toMatchObject({ indexed: 2, pending: 3 });
    expect(await indexRunFacts(t.db, 'default', { limit: 10, budgetMs: -1 })).toMatchObject({ indexed: 0, pending: 3, budgetExhausted: true });
    expect(await runAdminCommand('index', {}, t.db, 'default')).toEqual({ index: { indexed: 3, unindexable: 0, pending: 0, budgetExhausted: false } });
    // Rows are a derived cache: deleting them only costs a re-index.
    await t.db.query(`DELETE FROM admin_run_facts WHERE run_id LIKE 'batch-%'`);
    expect(await indexRunFacts(t.db, 'default', { limit: 10, budgetMs: 60_000 })).toMatchObject({ indexed: 5, pending: 0 });
  });

  it('classifies automation and delegated execution metrics by their own states', async () => {
    const owner = '0x' + 'ab'.repeat(20), rule = 'aut_' + 'a'.repeat(26), now = new Date();
    await t.db.query(`INSERT INTO automation_rules (tenant_id, rule_id, owner_namespace, owner_account, display_name, kind, state, definition, action_strategy, action_workflow_hash,
      engine_version, timezone, next_evaluation_at) VALUES ('default', $1, 'eip155', $2, 'DCA', 'SCHEDULED_DCA', 'ACTIVE', '{}', '{"a":1}', $3, 'flofi-engine-2', 'UTC',
      now() - interval '1 hour')`, [rule, owner, '0x' + 'd'.repeat(64)]);
    await t.db.query(`INSERT INTO automation_rules (tenant_id, rule_id, owner_namespace, owner_account, display_name, kind, state, definition, timezone, next_evaluation_at)
      VALUES ('default', $1, 'eip155', $2, 'Watch', 'DAILY_WATCH', 'PAUSED', '{}', 'UTC', now())`, ['aut_' + 'b'.repeat(26), owner]);
    for (const [occ, state] of [['c', 'PENDING_OWNER'], ['d', 'DISMISSED']] as const)
      await t.db.query(`INSERT INTO automation_occurrences (tenant_id, occurrence_id, rule_id, owner_namespace, owner_account, trigger_key, kind, state, due_at, expires_at, decided_at)
        VALUES ('default', $1, $2, 'eip155', $3, $4, 'SCHEDULE', $5, now(), now() + interval '1 day', $6)`,
      ['occ_' + occ.repeat(26), rule, owner, `slot:2026-10-14T0${occ === 'c' ? 1 : 2}:00`, state, state === 'DISMISSED' ? now : null]);
    for (const outcome of ['TRIGGERED', 'CONDITION_NOT_MET', 'CONDITION_NOT_MET', 'PRICE_FEED_MISMATCH'])
      await t.db.query(`INSERT INTO automation_evaluations (tenant_id, rule_id, at, outcome) VALUES ('default', $1, now(), $2)`, [rule, outcome]);
    const data = await automationAnalytics(t.db, 'default', { from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 60_000) }, now);
    expect(data.rules.byState).toEqual(expect.arrayContaining([{ key: 'ACTIVE', count: 1 }, { key: 'PAUSED', count: 1 }]));
    expect(data.rules.byMode).toEqual([{ key: 'CONFIRM_EACH_TIME', count: 2 }]);
    expect(data.evaluations).toEqual({ total: 4, byOutcome: [{ key: 'CONDITION_NOT_MET', count: 2 }, expect.objectContaining({ count: 1 }), expect.objectContaining({ count: 1 })] });
    expect(data.occurrences).toMatchObject({ created: 2, pendingOwnerNow: 1 });
    expect(data.issues).toEqual([expect.objectContaining({ source: 'EVALUATION', code: 'PRICE_FEED_MISMATCH', count: 1 })]);
    expect(data.delegated).toMatchObject({ installed: true, created: 0, openNow: 0, attentionNow: 0 });
    expect(JSON.stringify(data)).not.toContain(owner.slice(2));
    const health = await healthReport({}, { db: t.db, tenantId: 'default' }, now);
    const applied = (await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations')).rows[0]!.n;
    expect(health.database).toMatchObject({ ok: true, value: { appliedMigrations: applied, shippedMigrations: SHIPPED_MIGRATIONS.length, tenantId: 'default' } });
    expect(health.scheduler).toMatchObject({ ok: true, value: { installed: true, overdueRules: 1 } });
    expect(health.api).toEqual({ topology: 'embedded-or-local', readiness: null });
    expect(health.queue.ok).toBe(true);
  });

  it('a composition that started before the range still claims its step runs; a recovery belongs to the execution it recovers', async () => {
    const DAY = 86_400_000, ago = (days: number) => new Date(Date.now() - days * DAY);
    // The composition started 10 days ago; its liquidity step ran yesterday, when the composition record grew to name it.
    await seed(t.db, { runId: 'solcomp-old', flow: 'solana-devnet-composition', status: 'CONSUMING', workflowId: 'wf-old-comp', createdAt: ago(10),
      record: { review: { workflow: { nodes: [swapNode, lpNode] } }, producerRunId: 'sdx-old', consumerRunIds: [] } });
    await seed(t.db, { runId: 'sdx-old', flow: 'solana-devnet-swap', status: 'RECONCILED', hasEvidence: true, workflowId: 'wf-old-comp', createdAt: ago(10),
      record: { review: { workflow: { nodes: [swapNode] } } }, attempts: [{ step: 'SWAP', state: 'CONFIRMED', hash: SIG('c'), reconciled: true }] });
    await seed(t.db, { runId: 'olp-new', flow: 'orca-liquidity', status: 'PENDING', workflowId: 'wf-old-comp', createdAt: ago(1), record: { review: { workflow: { nodes: [lpNode] } } },
      attempts: [{ step: 'OPEN', state: 'PENDING', hash: SIG('d') }] });
    await extend(t.db, 'solana-devnet-composition', 'solcomp-old', { review: { workflow: { nodes: [swapNode, lpNode] } }, producerRunId: 'sdx-old', consumerRunIds: ['olp-new'] });
    // A run that started 10 days ago and was recovered yesterday; and one that started inside the range and was recovered inside it.
    const swap = (runId: string, createdAt: Date, status: string, recoveryOf?: string) => seed(t.db, { runId, flow: 'robinhood-transfer', status, provenance: 'PUBLIC_TESTNET',
      createdAt, workflowId: `wf-${recoveryOf ?? runId}`, hasEvidence: status === 'RECONCILED', record: { review: { workflow: { nodes: [{ actionType: 'asset.transfer', chainId: 'eip155:46630' }] } } },
      attempts: [{ step: 'TRANSFER', state: status === 'RECONCILED' ? 'CONFIRMED' : 'HASH', hash: '0x' + runId.length.toString(16).repeat(64).slice(0, 64), reconciled: status === 'RECONCILED' }] })
      .then(() => recoveryOf ? t.db.query(`UPDATE execution_runs SET recovery_of = $2 WHERE tenant_id = 'default' AND run_id = $1`, [runId, recoveryOf]) : undefined);
    await swap('rh-old', ago(10), 'INCONCLUSIVE'); await swap('rh-old-rec', ago(1), 'RECONCILED', 'rh-old');
    await swap('rh-new', ago(3), 'INCONCLUSIVE'); await swap('rh-new-rec', ago(2), 'RECONCILED', 'rh-new');

    const week = await workflowView({ db: t.db, tenantId: 'default' }, { range: '7d', env: 'TESTNET' }, new Date());
    if (!week.ok) throw new Error(week.code);
    expect(week.indexing).toMatchObject({ pending: 0 });
    expect((await t.db.query(`SELECT composition_of FROM admin_run_facts WHERE run_id = 'olp-new'`)).rows).toEqual([{ composition_of: 'solcomp-old' }]);
    const ids = week.executions.map(e => e.rootId);
    expect(ids).not.toContain('olp-new'); // a step of a composition counted in its own (earlier) range
    expect(ids).not.toContain('rh-old-rec'); // part of an execution that started before the range
    expect(week.executions.find(e => e.rootId === 'rh-new')).toMatchObject({ runIds: ['rh-new', 'rh-new-rec'], classification: { outcome: 'COMPLETED' } });
    const month = await workflowView({ db: t.db, tenantId: 'default' }, { range: '30d', env: 'TESTNET' }, new Date());
    if (!month.ok) throw new Error(month.code);
    expect(month.executions.find(e => e.rootId === 'rh-old')).toMatchObject({ runIds: ['rh-old', 'rh-old-rec'], classification: { outcome: 'COMPLETED' } });
    expect(month.executions.find(e => e.rootId === 'solcomp-old')!.actions!.map(a => [a.kind, a.outcome])).toEqual([['SWAP', 'COMPLETED'], ['LIQUIDITY', 'IN_PROGRESS']]);
    expect(month.delegatedInRange).toBe(0);
  });

  it('a truncated range covers only its newest runs and says how many it holds', async () => {
    const range = { from: new Date(Date.now() - 30 * 86_400_000), to: new Date(Date.now() + 60_000) };
    const all = await loadRuns(t.db, 'default', range);
    const cut = await loadRuns(t.db, 'default', range, 3);
    expect(all.coverage).toMatchObject({ truncated: false, coveredFrom: null });
    expect(cut.coverage).toMatchObject({ truncated: true, runsInRange: all.coverage.runsInRange });
    expect(cut.coverage.coveredFrom).toEqual(cut.runs[2]!.createdAt); // the oldest of the three newest runs that may have started
    expect(all.coverage.runsInRange).toBeGreaterThan(3);
    // A simulation that never started is never loaded: it is counted by the facts the classifier reads.
    expect(all.runs.some(r => r.flow === FLOW && r.attempts.length === 0)).toBe(false);
    expect(all.idle).toContainEqual({ flow: FLOW, provenance: 'MOCKED', status: 'PREPARED', journalAuthorized: false, hasAttempts: false, count: 1 });
    // 0012 adds no (tenant_id, created_at) index to execution_runs: ranged reads are bounded by the existing (tenant_id, updated_at) one.
    expect((await t.db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'execution_runs' AND indexdef LIKE '%(tenant_id, created_at)%'`)).rows).toEqual([]);
  });

  it('links owner-confirmed proposals to the executions FloFi verified through their approval handoff', async () => {
    const owner = '0x' + 'ef'.repeat(20), rule = 'aut_' + 'c'.repeat(26), now = new Date();
    await t.db.query(`INSERT INTO automation_rules (tenant_id, rule_id, owner_namespace, owner_account, display_name, kind, state, definition, action_strategy, action_workflow_hash,
      engine_version, timezone, next_evaluation_at) VALUES ('default', $1, 'eip155', $2, 'DCA', 'SCHEDULED_DCA', 'ACTIVE', '{}', '{"a":1}', $3, 'flofi-engine-2', 'UTC', now())`,
    [rule, owner, '0x' + 'd'.repeat(64)]);
    const handoff = async (id: string, status: 'PENDING' | 'APPLIED', runIds: string[]) => t.db.query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind,
        requester_id, client_id, client_name, secret_digest, strategy, workflow_hash, engine_version, network_environment, funds_class, plan, status, claimed_namespace,
        claimed_address, claimed_at, claim_expires_at, applied_at, run_ids, expires_at)
      VALUES ('default', $1, 'AUTOMATION_RULE', $2, 'flofi-automations', 'FloFi Automations', $3, '{"a":1}', $4, 'flofi-engine-2', 'PUBLIC_TESTNET', 'TEST_FUNDS', '{"kind":"x"}',
        $5, $6, $7, $8, $8, $9, $10, now() + interval '1 day')`,
    [id, `automation:${rule}`, Buffer.alloc(32, id.charCodeAt(4)), '0x' + 'd'.repeat(64), status, status === 'APPLIED' ? 'eip155' : null, status === 'APPLIED' ? owner : null,
      status === 'APPLIED' ? now : null, status === 'APPLIED' ? now : null, runIds]);
    const occurrence = (id: string, slot: string, state: string, handoffId: string) => t.db.query(`INSERT INTO automation_occurrences (tenant_id, occurrence_id, rule_id,
        owner_namespace, owner_account, trigger_key, kind, state, strategy, workflow_hash, due_at, expires_at, handoff_id, decided_at)
      VALUES ('default', $1, $2, 'eip155', $3, $4, 'SCHEDULE', $5, '{"a":1}', $6, now(), now() + interval '1 day', $7, $8)`,
    [id, rule, owner, `slot:${slot}`, state, '0x' + 'd'.repeat(64), handoffId, state === 'COMPLETED' ? now : null]);
    await seed(t.db, { runId: 'auto-run-1', flow: 'robinhood-transfer', status: 'RECONCILED', provenance: 'PUBLIC_TESTNET', hasEvidence: true,
      record: { review: { workflow: { nodes: [{ actionType: 'asset.transfer', chainId: 'eip155:46630' }] } } },
      attempts: [{ step: 'TRANSFER', state: 'CONFIRMED', hash: '0x' + '7'.repeat(64), reconciled: true }] });
    await handoff('apr_' + 'a'.repeat(26), 'APPLIED', ['auto-run-1']);
    await handoff('apr_' + 'b'.repeat(26), 'APPLIED', []); // applied, its execution not linked (yet)
    await handoff('apr_' + 'c'.repeat(26), 'PENDING', []);
    await occurrence('occ_' + 'e'.repeat(26), '2026-10-14T03:00', 'COMPLETED', 'apr_' + 'a'.repeat(26));
    await occurrence('occ_' + 'f'.repeat(26), '2026-10-14T04:00', 'APPROVAL_CREATED', 'apr_' + 'b'.repeat(26));
    await occurrence('occ_' + 'g'.repeat(26), '2026-10-14T05:00', 'APPROVAL_CREATED', 'apr_' + 'c'.repeat(26));
    await occurrence('occ_' + 'h'.repeat(26), '2026-10-14T06:00', 'COMPLETED', 'apr_' + 'd'.repeat(26)); // its handoff was purged (30-day retention)
    const data = await automationAnalytics(t.db, 'default', { from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 60_000) }, now);
    expect(data.proposals).toEqual({ withApproval: 4, applied: 3, approvalDeleted: 1, linkedExecutions: 1, linkedCompleted: 1,
      linkedByEnvironment: { MAINNET: 0, TESTNET: 1, MOCKED: 0 } });
    expect(data.evaluationsRetainedFrom).toBeNull();
    const longAgo = await automationAnalytics(t.db, 'default', { from: new Date(now.getTime() - 200 * 86_400_000), to: now }, now);
    expect(longAgo.evaluationsRetainedFrom).toBe(new Date(now.getTime() - 90 * 86_400_000).toISOString());
    expect(JSON.stringify(data)).not.toContain(owner.slice(2));
  });

  it('checks the Railway API readiness endpoint with a bounded request and closed codes', async () => {
    const seen: string[] = [];
    expect(await apiReadiness({ API_BASE_URL: 'https://api.flofi.example' }, async url => { seen.push(String(url)); return new Response('{"ok":true}', { status: 200 }); }))
      .toMatchObject({ topology: 'remote', readiness: { ok: true, value: { status: 200 } } });
    expect(seen).toEqual(['https://api.flofi.example/readyz']);
    expect(await apiReadiness({ API_BASE_URL: 'https://api.flofi.example' }, async () => new Response('', { status: 503 })))
      .toEqual({ topology: 'remote', readiness: { ok: false, code: 'API_NOT_READY_503' } });
    expect(await apiReadiness({ API_BASE_URL: 'https://api.flofi.example' }, async () => { throw new TypeError('fetch failed'); }))
      .toEqual({ topology: 'remote', readiness: { ok: false, code: 'API_UNREACHABLE' } });
  });
});
