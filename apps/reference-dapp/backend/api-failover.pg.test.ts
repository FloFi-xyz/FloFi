// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-INFRA-API-FAILOVER-CERT-001: two replicas of the production API entry point (`node backend/main.ts api`, plain Node, NODE_ENV=production
 * with the bearer token) on ONE disposable loopback PostgreSQL, as Railway would run `flofi-api` with two replicas. The robinhood-transfer flow runs
 * against the repository's MOCKED loopback chain (127.0.0.1:8553, served by this test; the "wallet" is the test calling MOCK_submit): nothing reaches
 * a public network, nothing is signed with a real key, no funds exist.
 *
 *  1. Either replica serves any step of one owner run; the same idempotent request sent to both replicas at once executes once.
 *  2. SIGTERM on a replica with requests in flight: they complete, the draining replica takes no new work (its kept-alive connections are closed
 *     after their response, as a reverse proxy pools them; this client then retries on the other replica, as the BFF does), the other replica
 *     serves throughout, and the stopped one exits 0 long before the 25 s cap (Railway sends SIGKILL after drainingSeconds=30).
 *  2b. A mutation whose caller already disconnected (its own deadline passed) still finishes before the stopping replica closes its database.
 *  3. A replica killed (SIGKILL) during `begin`'s chain read — before its first write — loses nothing: its idempotency claim (120 s) and run lease
 *     (30 s) block only that run until they expire; then the other replica completes the same request exactly once (fenced takeover).
 *  4. After every API replica restarted, the worker reconciles the owner-signed attempt and a fresh replica reports it RECONCILED: one transaction.
 *
 * The pool bound (replicas × DATABASE_POOL_MAX) is sampled from pg_stat_activity throughout. Not exercised here: Railway's edge proxy (routing, retries),
 * Flight/beta mode with wallet principals, and hosted-only guards (these processes are not "hosted").
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { Agent, createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNativeTransferNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createRobinhoodTransferChain, TRANSFER_OWNER as owner } from '../e2e/robinhood-transfer-harness.mjs';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import type { TransferRecord } from '../src/server/robinhood-transfer-service.ts';

const APP = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'failover-api-token-'.padEnd(48, 'x'), POOL_MAX = 4;
const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'failover', revision: 1, resourceEdges: [],
  nodes: [createNativeTransferNode('node-002', { chain: 'eip155:46630', amount: '1000000000000', recipient: 'CONNECTED_OWNER' })] };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const dir = mkdtempSync(join(tmpdir(), 'flofi-api-failover-'));

/** The MOCKED loopback chain the harness transport reads (fixed port 8553), with per-method latency to hold requests in flight. */
const chain = createRobinhoodTransferChain({ nonce: 40 });
const delays = new Map<string, number>(), calls = new Map<string, number>();
let chainServer: Server;
function serveChain(): Promise<void> {
  chainServer = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    const { id, method, params } = JSON.parse(body) as { id: unknown; method: string; params: unknown[] };
    calls.set(method, (calls.get(method) ?? 0) + 1);
    if (delays.get(method)) await sleep(delays.get(method)!);
    res.setHeader('content-type', 'application/json');
    try { res.end(JSON.stringify({ jsonrpc: '2.0', id, result: await chain.rpc(method, params) }, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v)); }
    catch { res.statusCode = 400; res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'MOCK_RPC_DENIED' } })); }
  });
  return new Promise((resolve, reject) => {
    // The harness transport's address is fixed (robinhood-rpc.ts): a leftover `robinhood-transfer-harness.mjs --serve` must be stopped first.
    chainServer.once('error', error => reject((error as { code?: string }).code === 'EADDRINUSE' ? new Error('MOCKED_CHAIN_PORT_8553_IN_USE') : error));
    chainServer.listen(8553, '127.0.0.1', () => resolve());
  });
}

type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly at: number };
type Proc = { readonly name: string; readonly child: ChildProcess; readonly records: Record<string, unknown>[]; readonly exited: Promise<Exit> };
type Api = Proc & { readonly port: number; readonly agent: Agent };
const procs: Proc[] = [];
let t: TestDatabase;

const freePort = () => new Promise<number>(resolve => { const s = createNetServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
function launch(name: string, role: 'api' | 'worker', env: Record<string, string>): Proc {
  const child = spawn(process.execPath, ['backend/main.ts', role], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', TMPDIR: tmpdir(),
    NODE_ENV: 'production', DATABASE_URL: t.url, DATABASE_POOL_MAX: String(POOL_MAX), TENANT_ID: 'default', FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS',
    GRYLOO_ROBINHOOD_HARNESS: 'MOCKED_LOOPBACK_ONLY', ...env } });
  const records: Record<string, unknown>[] = [];
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (line.startsWith('{')) try { records.push(JSON.parse(line) as Record<string, unknown>); } catch { /* not a log record */ }
    }
  });
  child.stderr!.resume();
  // 'close' follows 'exit' once stdout is drained, so the last log line (e.g. api.stop_timeout) is already in `records`; `at` is the exit time.
  let exitAt = 0;
  child.once('exit', () => { exitAt = Date.now(); });
  const exited = new Promise<Exit>(resolve => child.once('close', (code, signal) => resolve({ code, signal, at: exitAt || Date.now() })));
  const proc = { name, child, records, exited };
  procs.push(proc);
  return proc;
}
async function startApi(name: string): Promise<Api> {
  const port = await freePort();
  const proc = launch(name, 'api', { API_AUTH_TOKEN: TOKEN, PORT: String(port), HOST: '127.0.0.1' });
  // A reverse proxy keeps its upstream connections alive and reuses them: so does this replica's client.
  const api: Api = { ...proc, port, agent: new Agent({ keepAlive: true, maxSockets: 16 }) };
  for (const deadline = Date.now() + 60_000; ;) {
    const ready = await send(api, 'GET', '/readyz', null, { fresh: true }).then(r => r.status === 200, () => false);
    if (ready) return api;
    if (proc.child.exitCode !== null || Date.now() > deadline) throw new Error(`API_${name}_NOT_READY`);
    await sleep(200);
  }
}
const events = (proc: Proc) => proc.records.map(r => r.event);

type Reply = { readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: { ok: boolean; value?: unknown; code?: string } };
/** One HTTP exchange on the replica's kept-alive connections (or a fresh connection). Rejects with the socket error code when nothing answered. */
function send(api: Api, method: 'GET' | 'POST', path: string, body: unknown, options: { key?: string; fresh?: boolean } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = body === null ? '' : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port: api.port, method, path, agent: options.fresh ? false : api.agent, headers: { authorization: `Bearer ${TOKEN}`,
      ...body === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }, ...options.key ? { 'idempotency-key': options.key } : {} } },
    res => { let data = ''; res.on('data', chunk => { data += String(chunk); }); res.on('end', () => {
      try { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(data) as Reply['body'] }); } catch (error) { reject(error as Error); } }); });
    req.on('error', error => reject(new Error((error as { code?: string }).code ?? 'REQUEST_FAILED')));
    req.end(text);
  });
}
const flow = (api: Api, method: string, args: unknown[], key?: string) => send(api, 'POST', `/v1/flows/robinhood-transfer/${method}`, { args }, key ? { key } : {});
async function ok<T>(reply: Promise<Reply>): Promise<T> {
  const { status, body } = await reply;
  if (status !== 200 || !body.ok) throw new Error(`UNEXPECTED_${status}_${body.code ?? 'NO_CODE'}`);
  return body.value as T;
}
let keys = 0;
const key = (label: string) => `failover-${label}-${++keys}-`.padEnd(24, '0');
const count = async (sql: string, values: unknown[] = []) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, values)).rows[0]!.n;
const claim = (k: string) => t.db.query<{ state: string; claim_s: number }>(`SELECT state, extract(epoch FROM claimed_until - now())::float8 AS claim_s
  FROM api_idempotency WHERE idempotency_key = $1`, [k]).then(r => r.rows[0]);
const liveLeases = () => t.db.query<{ lease_key: string; fence: string; ttl_s: number }>(`SELECT lease_key, fence::text AS fence,
  extract(epoch FROM expires_at - now())::float8 AS ttl_s FROM execution_leases WHERE expires_at > now()`).then(r => r.rows);
const attemptStates = (runId: string) => t.db.query<{ to_state: string }>(`SELECT to_state FROM journal_entries WHERE run_id = $1 AND level = 'attempt'
  ORDER BY sequence`, [runId]).then(r => r.rows.map(row => row.to_state));
/** The highest number of PostgreSQL connections both API replicas held at once (application_name `flofi-api`). */
let peakApiConnections = 0;
const sampleConnections = async () => {
  const n = await count(`pg_stat_activity WHERE datname = current_database() AND application_name = 'flofi-api'`);
  peakApiConnections = Math.max(peakApiConnections, n);
};
async function reviewed(api: Api): Promise<TransferRecord> {
  const simulated = await ok<TransferRecord>(flow(api, 'simulate', [workflow, owner], key('simulate')));
  return ok<TransferRecord>(flow(api, 'review', [simulated.id, simulated.review.commitment, workflow], key('review')));
}

let a: Api, b: Api, runOne: TransferRecord, hashOne: string;
beforeAll(async () => {
  t = await createTestDatabase();
  await serveChain();
  [a, b] = await Promise.all([startApi('a'), startApi('b')]);
}, 120_000);
// A failed scenario never leaves chain latency behind for the next one.
afterEach(() => { delays.clear(); });
afterAll(async () => {
  try {
    for (const proc of procs) if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGKILL');
    await Promise.all(procs.map(proc => proc.exited));
    await new Promise<void>(resolve => chainServer ? chainServer.close(() => resolve()) : resolve());
    await t?.drop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000);

describe('BUILD-INFRA-API-FAILOVER-CERT-001: two API replicas (main.ts api, plain Node) on one PostgreSQL', () => {
  it('1: either replica serves every step of one owner run; the same idempotent request on both replicas at once executes once', async () => {
    const runsBefore = await count('execution_runs');
    // Both replicas receive the same simulate (same key) while the chain read holds the first one in flight: exactly one execution.
    delays.set('eth_getTransactionCount', 400);
    const same = key('duplicate');
    const [ra, rb] = await Promise.all([flow(a, 'simulate', [workflow, owner], same), flow(b, 'simulate', [workflow, owner], same)]);
    delays.clear();
    const winner = [ra, rb].find(r => r.status === 200 && r.body.ok)!, other = winner === ra ? rb : ra;
    expect(winner).toBeDefined();
    // The other replica answers a replay (completed already) or IN_PROGRESS (409), which the BFF retries with the same key.
    if (other.status === 409) expect(other.body).toEqual({ ok: false, code: 'IDEMPOTENCY_IN_PROGRESS' });
    else expect(other.body).toEqual(winner.body);
    const replay = await flow(other === ra ? a : b, 'simulate', [workflow, owner], same);
    expect(replay.body).toEqual(winner.body);
    expect(await count('execution_runs')).toBe(runsBefore + 1);
    expect(await claim(same)).toMatchObject({ state: 'COMPLETED' });

    // Each step on the other replica than the one before: nothing is kept between requests except in PostgreSQL.
    const simulated = winner.body.value as TransferRecord;
    const review = await ok<TransferRecord>(flow(b, 'review', [simulated.id, simulated.review.commitment, workflow], key('review')));
    // Two replicas racing begin for one run (different keys, as two browser tabs): one PREPARED attempt.
    const raced = await Promise.all([flow(a, 'begin', [review.id, owner, workflow], key('begin')), flow(b, 'begin', [review.id, owner, workflow], key('begin'))]);
    expect(raced.filter(r => r.body.ok)).toHaveLength(1);
    expect(raced.find(r => !r.body.ok)!.body.code).toMatch(/^TRANSFER_(BUSY|EXISTING_ATTEMPT_OBSERVE_ONLY)$/);
    const begun = raced.find(r => r.body.ok)!.body.value as { record: TransferRecord; transaction: Record<string, string> };
    await ok(flow(b, 'handoff', [review.id], key('handoff')));
    hashOne = await chain.rpc('MOCK_submit', [begun.transaction]) as string;          // the owner's wallet, the only submitter
    await ok(flow(a, 'report', [review.id, { kind: 'HASH', hash: hashOne }], key('report')));
    runOne = await ok<TransferRecord>(flow(b, 'status', [review.id]));
    expect(runOne.attempt).toMatchObject({ state: 'PENDING', transactionHash: hashOne });
    expect(await attemptStates(review.id)).toEqual(['PREPARED', 'SUBMITTING', 'PENDING']);
    expect(chain.transactions).toHaveLength(1);
    await sampleConnections();
  }, 90_000);

  it('2: SIGTERM with requests in flight: they complete, the draining replica takes no new work, the other serves throughout, exit 0 well before 25 s', async () => {
    const runsBefore = await count('execution_runs');
    // The other replica answers status reads all along (a fresh connection each, as new proxy connections would).
    let served = 0, failed = 0, polling = true;
    try {
      const poll = (async () => {
        while (polling) {
          await send(b, 'POST', '/v1/flows/robinhood-transfer/status', { args: [runOne.id] }, { fresh: true })
            .then(r => { if (r.status === 200 && r.body.ok) served++; else failed++; }, () => { failed++; });
          await sampleConnections();
          await sleep(100);
        }
      })();
      // Three owner requests are in flight on replica A (held by the chain read) when it receives SIGTERM.
      delays.set('eth_getTransactionCount', 800);
      const before = calls.get('eth_getTransactionCount') ?? 0;
      const inflightKeys = [key('inflight'), key('inflight'), key('inflight')];
      const inflight = inflightKeys.map(k => flow(a, 'simulate', [workflow, owner], k));
      // All three are inside their handlers (each holds its idempotency claim) and the chain read holds them.
      const claimed = () => t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM api_idempotency WHERE idempotency_key = ANY($1) AND state = 'IN_PROGRESS'`,
        [inflightKeys]).then(r => r.rows[0]!.n);
      for (const deadline = Date.now() + 10_000; await claimed() < 3 || (calls.get('eth_getTransactionCount') ?? 0) === before;) {
        if (Date.now() > deadline) throw new Error('SIMULATE_NOT_IN_FLIGHT');
        await sleep(25);
      }
      const stoppedAt = Date.now();
      a.child.kill('SIGTERM');
      const answered = await Promise.all(inflight);
      delays.clear();
      // Every request that was in flight completes normally.
      for (const reply of answered) expect([reply.status, reply.body.ok]).toEqual([200, true]);
      // Draining: each kept-alive connection is closed after its answer, so the proxy's next request on its pooled connections cannot reach
      // the draining replica (its listener is closed); this client then retries on the other replica, as the BFF does.
      expect.soft(answered.map(r => r.headers.connection)).toEqual(['close', 'close', 'close']);
      const next = key('failover');
      expect.soft(await flow(a, 'simulate', [workflow, owner], next).then(() => 'SERVED_BY_DRAINING_REPLICA', (error: Error) => error.message))
        .toMatch(/^(ECONNREFUSED|ECONNRESET)$/);
      const failedOver = await ok<TransferRecord>(flow(b, 'simulate', [workflow, owner], next));
      const exit = await a.exited;
      polling = false; await poll;
      expect({ code: exit.code, signal: exit.signal }).toEqual({ code: 0, signal: null });
      // A clean stop as soon as the in-flight work ended — not the forced exit at 25 s.
      expect.soft(exit.at - stoppedAt).toBeLessThan(15_000);
      expect(events(a)).toContain('api.stopping');
      expect.soft(events(a)).not.toContain('api.stop_timeout');
      expect({ served: served > 0, failed }).toEqual({ served: true, failed: 0 });

      // Nothing was lost or left half-done: four new runs, each readable on the surviving replica, every claim completed, no lease held.
      expect(await count('execution_runs')).toBe(runsBefore + 4);
      for (const reply of [...answered.map(r => r.body.value as TransferRecord), failedOver])
        expect(await ok<TransferRecord>(flow(b, 'status', [reply.id]))).toMatchObject({ id: reply.id, verdict: reply.verdict });
      for (const k of [...inflightKeys, next]) expect(await claim(k)).toMatchObject({ state: 'COMPLETED' });
      expect(await liveLeases()).toEqual([]);
      // Two replicas never held more PostgreSQL connections than replicas × DATABASE_POOL_MAX.
      expect(peakApiConnections).toBeGreaterThan(0);
      expect(peakApiConnections).toBeLessThanOrEqual(2 * POOL_MAX);
    } finally { polling = false; delays.clear(); }
  }, 90_000);

  it('2b: a mutation whose caller already left finishes before the stopping replica closes its database', async () => {
    const a2 = await startApi('a2'), runsBefore = await count('execution_runs'), k = key('orphan');
    // The BFF's own deadline passed: it disconnects while its simulate is held by the chain read. The handler keeps running.
    delays.set('eth_getTransactionCount', 1_500);
    const text = JSON.stringify({ args: [workflow, owner] });
    const orphan = request({ host: '127.0.0.1', port: a2.port, method: 'POST', path: '/v1/flows/robinhood-transfer/simulate', agent: false,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'idempotency-key': k } });
    orphan.on('error', () => undefined);
    orphan.end(text);
    for (const deadline = Date.now() + 10_000; (await claim(k))?.state !== 'IN_PROGRESS';) {
      if (Date.now() > deadline) throw new Error('ORPHAN_NOT_STARTED');
      await sleep(25);
    }
    orphan.destroy();
    await sleep(100);
    // No connection is left, so the server closes at once; the database must stay open until the orphaned handler ended.
    const stoppedAt = Date.now();
    a2.child.kill('SIGTERM');
    const exit = await a2.exited;
    delays.clear();
    expect({ code: exit.code, signal: exit.signal }).toEqual({ code: 0, signal: null });
    expect(exit.at - stoppedAt).toBeLessThan(15_000);
    expect(events(a2)).not.toContain('api.stop_timeout');
    // The mutation completed and stored its answer: the BFF's later retry (same key) on the other replica is a replay, not IN_PROGRESS.
    expect(await claim(k)).toMatchObject({ state: 'COMPLETED' });
    expect(await count('execution_runs')).toBe(runsBefore + 1);
    const replay = await ok<TransferRecord>(flow(b, 'simulate', [workflow, owner], k));
    expect(await ok<TransferRecord>(flow(b, 'status', [replay.id]))).toMatchObject({ id: replay.id });
    expect(await count('execution_runs')).toBe(runsBefore + 1);
    expect(await liveLeases()).toEqual([]);
  }, 90_000);

  it('3: a replica killed during begin\'s chain read loses nothing: its claim and lease block only that run until they expire; the other replica then completes it once', async () => {
    const a3 = await startApi('a3');                                     // the replaced replica (a restart on the same database)
    const record = await reviewed(a3);
    const k = key('crash-begin');
    delays.set('eth_getTransactionCount', 30_000);
    try {
      const before = calls.get('eth_getTransactionCount') ?? 0;
      const pending = flow(a3, 'begin', [record.id, owner, workflow], k).then(() => 'ANSWERED', (error: Error) => error.message);
      for (const deadline = Date.now() + 10_000; (calls.get('eth_getTransactionCount') ?? 0) === before;) {
        if (Date.now() > deadline) throw new Error('BEGIN_NOT_IN_FLIGHT');
        await sleep(25);
      }
      a3.child.kill('SIGKILL');                                          // a crash (or Railway's SIGKILL after drainingSeconds)
      expect(await a3.exited).toMatchObject({ code: null, signal: 'SIGKILL' });
      expect(await pending).toMatch(/^(ECONNRESET|REQUEST_FAILED)$/);
    } finally { delays.clear(); }

    // What the crash left: an IN_PROGRESS claim (expires within 120 s) and the run's lease (expires within 30 s); no attempt, no transaction.
    const left = await claim(k);
    expect(left!.state).toBe('IN_PROGRESS');
    expect(left!.claim_s).toBeGreaterThan(90);
    expect(left!.claim_s).toBeLessThanOrEqual(120);
    const leases = await liveLeases();
    expect(leases.map(l => l.lease_key)).toEqual([record.id]);
    expect(leases[0]!.ttl_s).toBeLessThanOrEqual(30);
    expect(await attemptStates(record.id)).toEqual([]);
    // The BFF's retry (same key) on the surviving replica is told to retry; every other run is served normally meanwhile.
    expect((await flow(b, 'begin', [record.id, owner, workflow], k)).body).toEqual({ ok: false, code: 'IDEMPOTENCY_IN_PROGRESS' });
    expect(await ok<TransferRecord>(flow(b, 'status', [runOne.id]))).toMatchObject({ id: runOne.id });

    // Time travel past both windows (the claim's 120 s and the lease's 30 s, measured above): the same request is taken over and runs once.
    await t.db.query(`UPDATE api_idempotency SET claimed_until = now() - interval '1 second' WHERE idempotency_key = $1`, [k]);
    await t.db.query(`UPDATE execution_leases SET expires_at = now() - interval '1 second' WHERE lease_key = $1 AND expires_at > now()`, [record.id]);
    const taken = await ok<{ record: TransferRecord }>(flow(b, 'begin', [record.id, owner, workflow], k));
    expect(taken.record.attempt?.state).toBe('PREPARED');
    expect((await flow(b, 'begin', [record.id, owner, workflow], k)).body).toEqual({ ok: true, value: taken });      // replay, not a second begin
    expect(await attemptStates(record.id)).toEqual(['PREPARED']);
    expect(await claim(k)).toMatchObject({ state: 'COMPLETED' });
    // The takeover is fenced: the run's lease fence advanced past the crashed holder's.
    const fence = await t.db.query<{ fence: string }>(`SELECT fence::text AS fence FROM execution_leases WHERE lease_key = $1`, [record.id]);
    expect(BigInt(fence.rows[0]!.fence)).toBeGreaterThan(BigInt(leases[0]!.fence));
    expect(chain.transactions).toHaveLength(1);
  }, 90_000);

  it('4: after every API replica restarted, the worker reconciles the owner-signed attempt and a fresh replica reports it RECONCILED (one transaction)', async () => {
    const stoppedAt = Date.now();
    b.child.kill('SIGTERM');
    const exit = await b.exited;
    expect({ code: exit.code, signal: exit.signal }).toEqual({ code: 0, signal: null });
    expect(exit.at - stoppedAt).toBeLessThan(15_000);
    // No API replica is running now. Durable work makes the reconciliation due; the worker process observes the chain read-only.
    await t.db.query(`UPDATE work_items SET available_at = now() WHERE state = 'READY'`);
    const worker = launch('worker', 'worker', { EVIDENCE_DIRECTORY: join(dir, 'evidence') });
    for (const deadline = Date.now() + 45_000; ;) {
      const run = await t.db.query<{ status: string }>(`SELECT status FROM execution_runs WHERE run_id = $1`, [runOne.id]);
      if (run.rows[0]?.status === 'RECONCILED') break;
      if (Date.now() > deadline || worker.child.exitCode !== null) throw new Error('RECONCILIATION_TIMEOUT');
      await sleep(250);
    }
    worker.child.kill('SIGTERM');
    expect(await worker.exited).toMatchObject({ code: 0, signal: null });
    const c = await startApi('c');
    expect(await ok<TransferRecord>(flow(c, 'status', [runOne.id]))).toMatchObject({ verdict: 'RECONCILED',
      attempt: { state: 'CONFIRMED', reconciled: true, transactionHash: hashOne } });
    expect(await attemptStates(runOne.id)).toEqual(['PREPARED', 'SUBMITTING', 'PENDING', 'CONFIRMED']);
    expect(chain.transactions).toHaveLength(1);
  }, 120_000);
});
