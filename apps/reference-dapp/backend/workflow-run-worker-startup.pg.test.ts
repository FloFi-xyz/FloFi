// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HOTFIX WORKFLOW_RUN_WORKER_LOAD_FAILED: the REAL `backend/main.ts worker` process (plain Node, as Railway runs it) with FLOFI_WORKFLOW_RUNS=enabled.
 *
 *  1. It reports `workflow_run.worker_enabled` (and never `worker_disabled`), its own `workflow-run.advance` handler advances a run that an
 *     owner started, and its sweep expires a run that never started — in the live process, not a module loaded in isolation. Restarted, it
 *     resumes the same run idempotently: still one open advance item, the owner's step still awaiting the owner (no evidence, so nothing is
 *     reconciled, failed or submitted), and no run, step or group is ever written by the worker beyond its own bookkeeping.
 *  2. With the module that disabled production (a parameter property Node's type stripping refuses) injected back by a load hook, the worker
 *     disables only this subsystem and logs the cause as closed fields — `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, `SyntaxError` and the
 *     repository-relative module — never the database URL or any exception text; reconciliation keeps sweeping.
 * Disposable loopback PostgreSQL only; MOCKED owner approvals; the worker holds no key and signs nothing.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import { ENGINE_VERSION } from '../src/mcp/execution.ts';
import { applyApproval, claimApproval } from '../src/platform/index.ts';
import { workflowRunHarness, type RunHarness } from '../src/workflow-runs/workflow-run.test-harness.ts';

const APP = fileURLToPath(new URL('..', import.meta.url));
const MULTICHAIN = { version: 2, steps: [
  { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 },
  { action: 'swap', network: 'solana-devnet', inputAsset: 'devUSDC', outputAsset: 'SOL', amount: '5', slippageBps: 50 }] };
/** Puts the pre-fix `Refusal` class (a constructor parameter property) back into the paymaster proxy as the worker loads it. */
const BROKEN_PAYMASTER = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (!url.endsWith('/src/gas-sponsorship/paymaster-service.ts')) return loaded;
  const source = String(loaded.source).replace(/^class Refusal extends Error \\{.*\\}$/m,
    'class Refusal extends Error { constructor(readonly rpcCode: number, code: string) { super(code); } }');
  if (source === String(loaded.source)) throw new Error('PROBE_PATTERN_NOT_FOUND');
  return { ...loaded, source };
} });`)}`;

type Record_ = Readonly<Record<string, unknown>>;
/** Runs the worker until `done` holds for the records so far, then stops it with SIGTERM; returns every JSON record and the exit. */
async function runWorker(url: string, evidence: string, env: Readonly<Record<string, string>>, done: (records: readonly Record_[]) => boolean,
  preload: readonly string[] = []) {
  const proc = spawn(process.execPath, [...preload, 'backend/main.ts', 'worker'], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', DATABASE_URL: url, EVIDENCE_DIRECTORY: evidence, ...env } });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })));
  const records: Record_[] = [];
  let output = '';
  proc.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  let stopping = false;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error(`WORKER_TIMEOUT ${JSON.stringify(records.map(r => r.event))}`)); }, 60_000);
    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text; buffer += text;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!line.startsWith('{')) continue;
        records.push(JSON.parse(line) as Record_);
        // One SIGTERM only: the worker's handler is `once`, so a second signal would take Node's default action.
        if (!stopping && done(records)) { stopping = true; clearTimeout(timer); proc.kill('SIGTERM'); resolve(); }
      }
    });
    void exited.then(({ code }) => { clearTimeout(timer); reject(new Error(`WORKER_EXITED_${code}`)); });
  });
  return { records, output, exit: await exited };
}

/** A run its owner started (first step loaded: AWAITING_OWNER, its advance item queued), as `/approve` does. */
async function startedRun(h: RunHarness) {
  const approval = await h.request(MULTICHAIN);
  const claimed = await claimApproval(h.surface, approval.secret, [h.evm, h.sol], true, h.d.now());
  await applyApproval(h.surface, approval.secret, [h.evm, h.sol], claimed.workflow, h.d.now());
  return (await h.store.byHandoff(approval.approvalId))!;
}
/** Everything the worker could write about a run: its row and steps (with versions), its events, its groups and its open advance item. */
const snapshot = async (h: RunHarness, runId: string, db: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record_[] }> }) => ({
  run: (({ state, currentStep, code, version }) => ({ state, currentStep, code, version }))((await h.store.byId(runId))!),
  steps: (await h.store.steps(runId)).map(s => ({ step: s.stepIndex, state: s.state, outcome: s.outcome ?? null, version: s.version })),
  events: Number((await db.query('SELECT count(*) AS n FROM workflow_run_events WHERE run_id = $1', [runId])).rows[0]!.n),
  groups: Number((await db.query('SELECT count(*) AS n FROM workflow_run_groups WHERE run_id = $1', [runId])).rows[0]!.n),
  openAdvance: (await db.query(`SELECT id::text AS id FROM work_items WHERE kind = 'workflow-run.advance' AND dedupe_key = $1 AND state IN ('READY', 'LEASED')`,
    [runId])).rows.map(r => r.id),
});
const advanceItem = async (db: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record_[] }> }, runId: string) =>
  (await db.query(`SELECT id::text AS id, deliveries, last_error FROM work_items WHERE kind = 'workflow-run.advance' AND dedupe_key = $1 AND state = 'READY'`,
    [runId])).rows;

describe('HOTFIX the real worker process loads and runs the workflow-run subsystem (PostgreSQL)', () => {
  it('reports worker_enabled, advances an owner-started run, sweeps an unstarted one, and resumes idempotently after a restart', async () => {
    const t = await createTestDatabase(), evidence = await mkdtemp(join(tmpdir(), 'flofi-workflow-run-worker-'));
    try {
      const h = await workflowRunHarness(t.db, { delegation: false });
      const run = await startedRun(h);
      const before = await snapshot(h, run.runId, t.db);
      expect(before).toMatchObject({ run: { state: 'RUNNING', currentStep: 0 }, steps: [{ step: 0, state: 'AWAITING_OWNER' }, { step: 1, state: 'PENDING' }],
        groups: 0, openAdvance: [expect.any(String)] });
      const [item] = before.openAdvance;
      // A second run created for its handoff but never started, now past its window: the live sweep expires it.
      const unstarted = await h.request(MULTICHAIN), now = Date.now();
      const idle = await h.store.create({ runId: h.runs.newId('wfr'), handoffId: unstarted.approvalId, requester: { kind: h.requester.kind, ref: h.requester.ref },
        owner: { namespace: 'eip155', address: h.evm.address }, wallets: { eip155: h.evm.address, solana: h.sol.address }, strategy: unstarted.composed.strategy,
        workflowHash: unstarted.composed.workflowHash, engineVersion: ENGINE_VERSION, stepCount: 2, expiresAt: new Date(now - 60_000) }, new Date(now - 120_000));
      expect(idle.state).toBe('PENDING');

      // The handler's own record (the runner's per-step `workflow_run.advanced` lines carry a `step`, not a `state`).
      const handled = (r: Record_) => r.event === 'workflow_run.advanced' && r.run === run.runId && 'state' in r;
      const advanced = (records: readonly Record_[]) => records.some(handled);
      const first = await runWorker(t.url, evidence, { FLOFI_WORKFLOW_RUNS: 'enabled' },
        records => advanced(records) && records.some(r => r.event === 'work.sweep'));
      expect(first.exit).toEqual({ code: 0, signal: null });
      expect(first.records.find(r => r.event === 'workflow_run.worker_enabled')).toMatchObject({ kinds: 'workflow-run.advance',
        user_funded: 'USER_FUNDED_NOT_ENABLED', delegation: false });
      expect(first.records.filter(r => String(r.event).endsWith('.worker_disabled') || String(r.event).endsWith('.sweep_failed'))).toEqual([]);
      // `code: null`: the worker's embedded runtime READ the owner's runs of the step's flow and found none yet (OPEN). An unavailable observer
      // would report its code (WORKFLOW_RUN_OBSERVATION_UNAVAILABLE, RUN_NOT_FOUND…) on this same record.
      expect(first.records.find(handled)).toMatchObject({ state: 'RUNNING', code: null });
      expect(first.records.find(r => r.event === 'workflow_run.swept')).toMatchObject({ expired: 1 });
      expect((await h.store.byId(idle.runId))!).toMatchObject({ state: 'EXPIRED', code: 'WORKFLOW_RUN_EXPIRED' });
      // Without owner evidence the step stays AWAITING_OWNER: nothing reconciled, failed, submitted or grouped by the worker.
      expect(await snapshot(h, run.runId, t.db)).toEqual(before);

      // Restart: the same run resumes from its durable item, with the same result. The worker rescheduled it for the owner's recheck
      // (`WORKFLOW_RUN_WAITING`); that delay elapsing is simulated so the restarted process picks it up.
      expect(await advanceItem(t.db, run.runId)).toEqual([{ id: item, deliveries: 1, last_error: 'WORKFLOW_RUN_WAITING' }]);
      await t.db.query(`UPDATE work_items SET available_at = now() WHERE kind = 'workflow-run.advance' AND dedupe_key = $1 AND state = 'READY'`, [run.runId]);
      const second = await runWorker(t.url, evidence, { FLOFI_WORKFLOW_RUNS: 'enabled' }, advanced);
      expect(second.exit).toEqual({ code: 0, signal: null });
      expect(second.records.find(r => r.event === 'workflow_run.worker_enabled')).toMatchObject({ kinds: 'workflow-run.advance' });
      expect(second.records.find(handled)).toMatchObject({ state: 'RUNNING', code: null });
      // The same item, delivered a second time; nothing else written.
      expect(await snapshot(h, run.runId, t.db)).toEqual(before);
      expect(await advanceItem(t.db, run.runId)).toEqual([{ id: item, deliveries: 2, last_error: 'WORKFLOW_RUN_WAITING' }]);
      expect((await h.store.byId(idle.runId))!.state).toBe('EXPIRED');
    } finally { await t.drop(); await rm(evidence, { recursive: true, force: true }); }
  }, 150_000);

  it('a module Node refuses disables only this subsystem, logged with its closed cause and module and never a secret', async () => {
    const t = await createTestDatabase(), evidence = await mkdtemp(join(tmpdir(), 'flofi-workflow-run-worker-'));
    try {
      const { records, output, exit } = await runWorker(t.url, evidence, { FLOFI_WORKFLOW_RUNS: 'enabled' },
        records => records.some(r => r.event === 'workflow_run.worker_disabled') && records.some(r => r.event === 'work.sweep'), ['--import', BROKEN_PAYMASTER]);
      expect(exit).toEqual({ code: 0, signal: null });
      const disabled = records.find(r => r.event === 'workflow_run.worker_disabled')!;
      expect(disabled).toEqual({ timestamp: expect.any(String), severity: 'ERROR', event: 'workflow_run.worker_disabled', service: 'flofi-worker',
        error_code: 'WORKFLOW_RUN_WORKER_LOAD_FAILED', cause_code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX', node_error: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
        error_type: 'SyntaxError', module: 'apps/reference-dapp/src/gas-sponsorship/paymaster-service.ts' });
      expect(records.some(r => r.event === 'workflow_run.worker_enabled')).toBe(false);
      // The rest of the worker is unaffected: it started and sweeps.
      expect(records.some(r => r.event === 'worker.starting')).toBe(true);
      // Neither the connection string nor its password, nor the exception text, reaches the log.
      const password = new URL(t.url).password;
      expect(output).not.toContain(t.url);
      if (password) expect(output).not.toContain(password);
      expect(output).not.toContain('parameter property');
    } finally { await t.drop(); await rm(evidence, { recursive: true, force: true }); }
  }, 120_000);

  it('an exception whose message carries the database URL is logged as UNCLASSIFIED_ERROR, never its text', async () => {
    const t = await createTestDatabase(), evidence = await mkdtemp(join(tmpdir(), 'flofi-workflow-run-worker-'));
    // The runner module throws, while loading, an error quoting the connection string (as a driver or config error could).
    const leaky = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/src/workflow-runs/worker.ts')) throw new Error('connect failed for ' + process.env.DATABASE_URL);
  return nextLoad(url, context);
} });`)}`;
    try {
      const { records, output, exit } = await runWorker(t.url, evidence, { FLOFI_WORKFLOW_RUNS: 'enabled' },
        records => records.some(r => r.event === 'workflow_run.worker_disabled') && records.some(r => r.event === 'work.sweep'), ['--import', leaky]);
      expect(exit).toEqual({ code: 0, signal: null });
      expect(records.find(r => r.event === 'workflow_run.worker_disabled')).toMatchObject({ error_code: 'WORKFLOW_RUN_WORKER_LOAD_FAILED',
        cause_code: 'UNCLASSIFIED_ERROR' });
      expect(output).not.toContain(t.url);
      expect(output).not.toContain('connect failed');
      const password = new URL(t.url).password;
      if (password) expect(output).not.toContain(password);
    } finally { await t.drop(); await rm(evidence, { recursive: true, force: true }); }
  }, 120_000);
});
