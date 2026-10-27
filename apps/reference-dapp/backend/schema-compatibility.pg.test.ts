// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-DB-COMPAT-001: this build across the newer migrations its forward-compatibility certificate names (for the compatibility release:
 * BUILD-ADMIN-001's 0012, from its SHA-256-pinned fixture), on PostgreSQL. The API and worker are composed exactly as `main.ts` composes
 * them (startup schema check, `createBackend`, `createHttpServer`, `createWorker`) on MOCKED in-process chains and reached through the
 * HTTP client the web uses; cold starts are real `node backend/main.ts …` and `developer-admin.ts` processes; the Vercel paths run the
 * real embedded runtime, platform state, Developer API, approval surface and MCP OAuth. No public network, no real transaction: the only
 * "wallet" is the test calling MOCK_submit, as the existing cloud suites do.
 *
 * A build without a certificate for its own newest migration has nothing to prove here and skips this suite.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, createDatabase, createFilesystemEvidenceStore, createHttpServer, createLogger,
  createPostgresWorkQueue, createWorker, loadMigrations, migrate, SHIPPED_MIGRATIONS, sweep, type Database, type Migration, type Queryable } from '@defi-workflow-engine/cloud-runtime';
import { createNativeTransferNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createRobinhoodTransferChain, TRANSFER_OWNER as owner } from '../e2e/robinhood-transfer-harness.mjs';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import * as unpatched from '../../../packages/cloud-runtime/test/baseline/migrations-fa7816b.ts';
import { developerEnv, developerProject, ORIGIN, SECRET } from '../src/developer/developer.test-harness.ts';
import { handleDeveloperRequest } from '../src/developer/http.ts';
import { session } from '../src/mcp/gateway.test-harness.ts';
import { oauthClient, oauthEnv, signIn } from '../src/mcp/oauth/oauth-test-harness.ts';
import { deploymentOAuthStore } from '../src/mcp/oauth/runtime.ts';
import { claimApproval, viewApproval } from '../src/platform/index.ts';
import { approvalSurface } from '../src/server/approval-surface.ts';
import { callCloudFlow, listCloudRuns, readCloudRun, type FlowResult } from '../src/server/cloud-api-client.ts';
import { cloudFlow, embeddedRuntime, type CloudJournalPage } from '../src/server/flow-runtime.ts';
import { platformStateHost } from '../src/server/platform-state-host.ts';
import { readiness } from '../src/server/readiness.ts';
import { FLOFI_PRODUCTION_ORIGIN } from '../src/platform/navigation.ts';
import type { TransferRecord } from '../src/server/robinhood-transfer-service.ts';
import { createBackend } from './app.ts';

const HEAD = SHIPPED_MIGRATIONS.at(-1)!;
const CERTIFICATE = CERTIFIED_FORWARD_MIGRATIONS.find(c => JSON.stringify(c.base) === JSON.stringify(HEAD));
const APP = fileURLToPath(new URL('..', import.meta.url));
const quiet = createLogger({ service: 'test', sink: () => undefined });
const TOKEN = 'schema compatibility test token '.padEnd(48, '.'), HARNESS = { GRYLOO_ROBINHOOD_HARNESS: 'MOCKED_LOOPBACK_ONLY' };
const STRANGER = '0x' + '5'.repeat(40), CLAIMANT = '0x' + '1'.repeat(40);
const BRIDGE = { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '5' };
const transferWorkflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'rh-compat', revision: 1, resourceEdges: [],
  nodes: [createNativeTransferNode('node-002', { chain: 'eip155:46630', amount: '1000000000000', recipient: 'CONNECTED_OWNER' })] };
const MISMATCH = { error: 'MIGRATION_HISTORY_MISMATCH' };
const outcome = (work: Promise<unknown>) => work.then(value => ({ value }), (error: Error) => ({ error: error.message }));
function ok<T>(result: FlowResult<unknown>): T { if (!result.ok) throw new Error(result.code); return result.value as T; }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const ledger = async (db: Queryable) => (await db.query(`SELECT version, name, sha256, applied_at::text FROM schema_migrations ORDER BY version`)).rows;

/** This build's migrations, and the same followed by the certified newer ones (their exact pinned SQL): what the next build's runner applies. */
let THIS: readonly Migration[], NEXT: readonly Migration[];
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
  if (!CERTIFICATE) return;
  THIS = await loadMigrations();
  const certified = await Promise.all(CERTIFICATE.migrations.map(async m => {
    const sql = await readFile(new URL(`../../../packages/cloud-runtime/test/fixtures/${String(m.version).padStart(4, '0')}_${m.name}.sql`, import.meta.url), 'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== m.sha256) throw new Error('CERTIFIED_FIXTURE_MISMATCH');
    return { ...m, sql };
  }));
  NEXT = [...THIS, ...certified];
});
// Each test's servers, pools, databases and directories are released after it, newest first (bounded: a DROP DATABASE waits for a checkpoint).
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined); }, 60_000);

async function database(migrations: readonly Migration[]): Promise<TestDatabase> {
  const t = await createTestDatabase({ migrated: false });
  cleanup.push(() => t.drop());
  await migrate(t.db, migrations);
  return t;
}
async function scratch(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `flofi-compat-${label}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const pool = (url: string, name: string): Database => {
  const db = createDatabase({ connectionString: url, maxConnections: 6, applicationName: name });
  cleanup.push(() => db.close());
  return db;
};
type Chain = ReturnType<typeof createRobinhoodTransferChain>;
const backendFor = (db: Database, chain: Chain, evidence: string, holderId: string) => createBackend({ db, env: HARNESS, logger: quiet, tenantId: 'default', holderId,
  evidenceStore: createFilesystemEvidenceStore(evidence), rpc: { 'robinhood-transfer': chain.rpc }, busyRetries: 3 });
/** An API instance as `main.ts api` starts one: the startup schema check (this build's shipped history), then the backend behind HTTP. */
async function apiInstance(url: string, chain: Chain, evidence: string) {
  const db = pool(url, 'flofi-api'), schema = await assertSchemaCompatible(db, SHIPPED_MIGRATIONS);
  const server = createHttpServer({ routes: backendFor(db, chain, evidence, `api-${randomBytes(3).toString('hex')}`).routes, logger: quiet, authToken: TOKEN,
    ready: async () => { await db.query('SELECT 1'); return true; } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { schema, env: { API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, API_AUTH_TOKEN: TOKEN } };
}
/** A worker instance as `main.ts worker` starts one: the same check, its tenant's queue, reconciliation and evidence handlers, the sweep. */
async function workerInstance(url: string, chain: Chain, evidence: string) {
  const db = pool(url, 'flofi-worker'), schema = await assertSchemaCompatible(db, SHIPPED_MIGRATIONS), workerId = `worker-${randomBytes(3).toString('hex')}`;
  const worker = createWorker({ queue: createPostgresWorkQueue({ db, ownerId: workerId, tenantId: 'default' }), handlers: backendFor(db, chain, evidence, workerId).handlers,
    logger: quiet, workerId, concurrency: 8 });
  /** Drains what is due now (time travel for the queue's back-off), as many rounds as reconciliation and evidence archiving take. */
  const settle = async () => { for (let round = 0; round < 3; round++) { await db.query(`UPDATE work_items SET available_at = now() WHERE state = 'READY'`); await worker.drainOnce(); } };
  return { schema, worker, settle, sweep: () => sweep(db, { tenantId: 'default' }) };
}
const transfer = <T>(env: Record<string, string>, method: string, ...args: unknown[]) => callCloudFlow<T>('robinhood-transfer', method, args, { env });
/** An owner journey through the API up to the owner's wallet submission and the browser's report of it (`HASH`, or `UNKNOWN`: browser lost). */
async function submitted(env: Record<string, string>, chain: Chain, report: 'HASH' | 'UNKNOWN') {
  const simulated = ok<TransferRecord>(await transfer(env, 'simulate', transferWorkflow, owner));
  const reviewed = ok<TransferRecord>(await transfer(env, 'review', simulated.id, simulated.review.commitment, transferWorkflow));
  const begin = ok<{ transaction: Record<string, string> }>(await transfer(env, 'begin', reviewed.id, owner, transferWorkflow));
  ok(await transfer(env, 'handoff', reviewed.id));
  const hash = await chain.rpc('MOCK_submit', [begin.transaction]) as string;   // the owner's wallet, the only submitter
  ok(await transfer(env, 'report', reviewed.id, report === 'HASH' ? { kind: 'HASH', hash } : { kind: 'UNKNOWN', code: 'TRANSFER_SUBMISSION_UNKNOWN' }));
  return reviewed.id;
}

const child = (extra: Record<string, string>) => ({ PATH: process.env.PATH ?? '', NODE_ENV: 'test' as const, ...process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}, ...extra });
const records = (stdout: string) => stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>);
/** A one-shot `node backend/<script> …` process: its exit code and JSON log records. */
const node = (script: string, args: readonly string[], env: Record<string, string>) =>
  promisify(execFile)(process.execPath, [`backend/${script}`, ...args], { cwd: APP, timeout: 90_000, env: child(env) })
    .then(({ stdout }) => ({ code: 0, stdout }), (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }));
/** A long-running `node backend/main.ts <command>` process, resolved once it logs `ready`; `stop` sends SIGTERM and returns its exit code. */
async function serve(command: 'api' | 'worker', ready: string, env: Record<string, string>) {
  const proc = spawn(process.execPath, ['backend/main.ts', command], { cwd: APP, env: child(env), stdio: ['ignore', 'pipe', 'ignore'] });
  const lines: Record<string, unknown>[] = [], exited = new Promise<number | null>(resolve => proc.once('exit', code => resolve(code)));
  let buffer = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${command.toUpperCase()}_START_TIMEOUT`)), 60_000);
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (line.startsWith('{')) { const record = JSON.parse(line) as Record<string, unknown>; lines.push(record); if (record.event === ready) { clearTimeout(timer); resolve(); } }
      }
    });
    void exited.then(code => { clearTimeout(timer); reject(new Error(`${command.toUpperCase()}_EXITED_${code}: ${JSON.stringify(lines.at(-1))}`)); });
  });
  return { records: lines, stop: async () => { proc.kill('SIGTERM'); return exited; } };
}
const freePort = () => new Promise<number>(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); }); });
/** Log fields `main.ts` reports for a database at `version`. */
const schemaFields = (version: number) => version === THIS.length ? { schema_version: version }
  : { schema_version: version, application_schema_version: THIS.length, forward_migrations: CERTIFICATE!.migrations.map(m => `${m.version}_${m.name}`).join(',') };
/** Serverless pools are per function instance: closing them makes the next call a cold start. */
async function coldWebInstance() {
  const caches = globalThis as unknown as Record<symbol, Map<string, Promise<{ db: Database; close?: () => Promise<void> }>> | undefined>;
  for (const symbol of [Symbol.for('flofi.embedded-runtime'), Symbol.for('flofi.platform-state')]) {
    for (const host of caches[symbol]?.values() ?? []) await host.then(h => h.close ? h.close() : h.db.close(), () => undefined).catch(() => undefined);
    caches[symbol]?.clear();
  }
}

describe.runIf(CERTIFICATE)(`BUILD-DB-COMPAT-001 this build across its certified newer migrations (${CERTIFICATE?.migrations.map(m => m.name).join(', ')}) on PostgreSQL`, () => {
  it('11: the API and worker keep serving through the migration: owner journeys, journals, reconciliation, recovery and owner reads never fail', async () => {
    const t = await database(THIS), chain = createRobinhoodTransferChain({ nonce: 300 }), evidence = await scratch('evidence');
    const api = await apiInstance(t.url, chain, evidence), worker = await workerInstance(t.url, chain, evidence);
    expect([api.schema, worker.schema]).toEqual(Array(2).fill({ version: THIS.length, application: THIS.length, forward: [] }));
    // In flight when the migration lands: two owner-submitted transfers, one reported, one whose outcome the browser never learned.
    const reported = await submitted(api.env, chain, 'HASH'), unknown = await submitted(api.env, chain, 'UNKNOWN');

    // Steady web traffic (simulate, then list and read as the owner) and the worker's loop, while the next build's runner migrates.
    let stop = false, requests = 0;
    const failures: string[] = [];
    const traffic = async () => {
      while (!stop) {
        try {
          const simulated = ok<TransferRecord>(await transfer(api.env, 'simulate', transferWorkflow, owner));
          if (!ok<{ runId: string }[]>(await listCloudRuns('robinhood-transfer', owner, { env: api.env })).some(r => r.runId === simulated.id)) throw new Error('LIST_MISSING_RUN');
          if (!ok(await readCloudRun(simulated.id, owner, { env: api.env }))) throw new Error('READ_MISSING_RUN');
          requests++;
        } catch (error) { failures.push((error as Error).message); }
      }
    };
    const loop = async () => {
      while (!stop) { try { await worker.worker.drainOnce(); await worker.sweep(); } catch (error) { failures.push(`WORKER_${(error as Error).message}`); } await sleep(20); }
    };
    const running = [traffic(), traffic(), loop()];
    await sleep(400);
    const before = requests;
    expect(await migrate(pool(t.url, 'flofi-migrate'), NEXT)).toEqual(CERTIFICATE!.migrations.map(m => m.version));
    await sleep(400);
    stop = true;
    await Promise.all(running);
    expect(failures).toEqual([]);
    expect([before, requests - before].every(n => n > 0)).toBe(true);

    // The warm worker reconciles both in-flight transfers on the newer schema (the unknown one by observation alone) and archives evidence.
    await worker.settle();
    for (const id of [reported, unknown])
      expect(ok<TransferRecord>(await transfer(api.env, 'status', id))).toMatchObject({ verdict: 'RECONCILED', attempt: { state: 'CONFIRMED', reconciled: true } });
    // Cold starts of this build on the newer schema (a restart, a scale-out): accepted under the certificate, and fully serving.
    const api2 = await apiInstance(t.url, chain, evidence), worker2 = await workerInstance(t.url, chain, evidence);
    expect(api2.schema).toEqual({ version: NEXT.length, application: THIS.length, forward: CERTIFICATE!.migrations });
    const after = await submitted(api2.env, chain, 'UNKNOWN');
    await worker2.sweep();
    await worker2.settle();
    expect(ok<TransferRecord>(await transfer(api2.env, 'status', after))).toMatchObject({ verdict: 'RECONCILED', attempt: { state: 'CONFIRMED', reconciled: true } });
    // Owner access: the owner sees its runs (with evidence) and journals; any other wallet sees nothing.
    for (const id of [reported, unknown, after]) expect(ok(await readCloudRun(id, owner, { env: api2.env }))).toMatchObject({ runId: id, hasEvidence: true });
    expect(ok<{ runId: string }[]>(await listCloudRuns('robinhood-transfer', owner, { env: api2.env }))[0]).toMatchObject({ runId: after });
    expect(ok<CloudJournalPage>(await readCloudRun(after, owner, { env: api2.env, journal: { after: null, limit: 50 } })).items.length).toBeGreaterThan(0);
    expect(ok(await listCloudRuns('robinhood-transfer', STRANGER, { env: api2.env }))).toEqual([]);
    expect(ok(await readCloudRun(after, STRANGER, { env: api2.env }))).toBeNull();
    expect(chain.transactions).toHaveLength(3); // one economic submission per journey, each by the owner's wallet

    // For comparison: the released build refuses this database on any cold start; the next build accepts it exactly.
    expect(await outcome(unpatched.assertSchemaCurrent(t.db, SHIPPED_MIGRATIONS))).toEqual(MISMATCH);
    expect(await assertSchemaCompatible(t.db, NEXT)).toEqual({ version: NEXT.length, application: NEXT.length, forward: [] });
  });

  it('12: real cold starts — `main.ts migrate/api/worker` and the Developer CLI start on this build’s schema and on the certified newer one, never on an older or uncertified one', async () => {
    const [behind, exact, ahead, uncertified] = await Promise.all([database(THIS.slice(0, -1)), database(THIS), database(NEXT), database(THIS)]);
    await uncertified.db.query(`INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, 'uncertified_change', $2)`, [THIS.length + 1, 'e'.repeat(64)]);
    const evidence = await scratch('worker');

    // Railway's pre-deploy of this build (a deploy or a rollback to it) on the newer schema: nothing applied, nothing changed, success.
    const history = await ledger(ahead.db), migrated = await node('main.ts', ['migrate'], { DATABASE_URL: ahead.url });
    expect([migrated.code, records(migrated.stdout).find(r => r.event === 'migrate.applied')])
      .toEqual([0, expect.objectContaining({ versions: 'none', ...schemaFields(NEXT.length) })]);
    expect(await ledger(ahead.db)).toEqual(history);
    for (const [t, version] of [[exact, THIS.length], [ahead, NEXT.length]] as const) {
      const port = await freePort(), api = await serve('api', 'api.listening', { DATABASE_URL: t.url, PORT: String(port), HOST: '127.0.0.1' });
      try {
        expect(api.records.find(r => r.event === 'api.starting')).toMatchObject(schemaFields(version));
        expect(await (await fetch(`http://127.0.0.1:${port}/readyz`)).json()).toEqual({ ok: true });
      } finally { expect(await api.stop()).toBe(0); }
      const worker = await serve('worker', 'worker.starting', { DATABASE_URL: t.url, EVIDENCE_DIRECTORY: evidence });
      try { expect(worker.records.find(r => r.event === 'worker.starting')).toMatchObject(schemaFields(version)); }
      finally { expect(await worker.stop()).toBe(0); }
    }
    // Refused, exit 1, before serving anything: an older schema, or a newer migration no certificate of this build names.
    for (const [t, code] of [[behind, 'SCHEMA_NOT_MIGRATED'], [uncertified, 'MIGRATION_HISTORY_MISMATCH']] as const)
      for (const command of ['api', 'worker']) {
        const refused = await node('main.ts', [command], { DATABASE_URL: t.url, PORT: String(await freePort()), HOST: '127.0.0.1', EVIDENCE_DIRECTORY: evidence });
        expect([refused.code, records(refused.stdout).find(r => r.event === 'backend.failed')]).toEqual([1, expect.objectContaining({ stage: 'schema', error_code: code })]);
      }
    const before = await ledger(uncertified.db), refused = await node('main.ts', ['migrate'], { DATABASE_URL: uncertified.url });
    expect([refused.code, records(refused.stdout).find(r => r.event === 'backend.failed')]).toEqual([1, expect.objectContaining({ stage: 'migrate', error_code: 'MIGRATION_HISTORY_MISMATCH' })]);
    expect(await ledger(uncertified.db)).toEqual(before);

    // The Developer operator CLI on the newer schema.
    const cli = await node('developer-admin.ts', ['create-project', '--tenant', 'default', '--name', 'Compatibility'], { DATABASE_URL: ahead.url, FLOFI_DEVELOPER_SECRET: SECRET });
    expect(cli.code).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ tenantId: 'default', projectId: expect.stringMatching(/^prj_/) });
    // The next build (its migrations shipped) starts only once they are applied.
    expect(await outcome(assertSchemaCompatible(exact.db, NEXT))).toEqual({ error: 'SCHEMA_NOT_MIGRATED' });
    expect((await assertSchemaCompatible(ahead.db, NEXT)).forward).toEqual([]);
  });

  it('12: Vercel cold starts on the newer schema — embedded flows, readiness, platform state, the Developer API, approvals and MCP OAuth all serve', async () => {
    const t = await database(NEXT);
    const embedded = { FLOFI_RUNTIME: 'embedded', DATABASE_URL: t.url, TENANT_ID: 'compat-embedded', GRYLOO_ROUTER_TESTNET_HARNESS: 'MOCKED_LOOPBACK_ONLY', ...HARNESS };
    // Production shape: flows on the Railway API, platform state (MCP, Developer, Channels, approvals) on the same database.
    const remote = { API_BASE_URL: 'https://api.example', API_AUTH_TOKEN: TOKEN, VERCEL: '1', VERCEL_ENV: 'production', TENANT_ID: 'compat-remote', DATABASE_URL: t.url,
      FLOFI_PUBLIC_ORIGIN: FLOFI_PRODUCTION_ORIGIN };
    try {
      await coldWebInstance();
      expect(await cloudFlow('robinhood-transfer', 'mode', [], { env: embedded })).toEqual({ ok: true, value: 'harness' });
      expect((await readiness({ env: embedded })).runtime).toEqual({ kind: 'embedded', status: 'READY', tenant: 'compat-embedded', schemaVersion: NEXT.length });
      expect((await embeddedRuntime(embedded)).schemaVersion).toBe(NEXT.length);
      const host = await platformStateHost(embedded);
      const project = await developerProject(host.db, { tenantId: host.tenantId });
      const developer = (method: string, path: string, body?: unknown) => handleDeveloperRequest(new Request(ORIGIN + '/api/developer/v1' + path, { method,
        headers: { authorization: `Bearer ${project.key}`, ...body === undefined ? {} : { 'content-type': 'application/json' } }, ...body === undefined ? {} : { body: JSON.stringify(body) } }),
      { env: developerEnv(embedded), schedule: () => undefined });
      const created = await developer('POST', '/strategies', { strategy: BRIDGE });
      expect(created.status).toBe(201);
      const strategy = await created.json() as { id: string; workflowHash: string };
      const approval = await developer('POST', '/approvals', { strategyId: strategy.id, workflowHash: strategy.workflowHash });
      expect(approval.status).toBe(201);
      const secret = decodeURIComponent(new URL((await approval.json() as { approvalUrl: string }).approvalUrl).hash.slice(1));
      const surface = await approvalSurface(developerEnv(embedded), () => undefined);
      expect(await viewApproval(surface, secret, [])).toMatchObject({ requesterKind: 'DEVELOPER_PROJECT', authorized: false, authority: 'NONE' });
      await claimApproval(surface, secret, [{ namespace: 'eip155', address: CLAIMANT }], false);
      const tokens = await signIn(oauthClient({ env: oauthEnv(embedded) }), { scope: 'flofi.strategy flofi.approval flofi.runs' });
      const mcp = session({ env: { ...oauthEnv(embedded), FLOFI_MCP: 'enabled' }, token: tokens.access_token });
      const composed = (await mcp.callTool('compose_strategy', { strategy: BRIDGE })).output as { workflowHash: string };
      const handoff = await mcp.callTool('request_user_approval', { strategy: BRIDGE, workflowHash: composed.workflowHash });
      expect({ ...handoff.output, ...handoff.meta['flofi/approval'] as Record<string, unknown> }).toMatchObject({ ok: true, authority: 'NONE' });

      await coldWebInstance();
      const remoteHost = await platformStateHost(remote);
      expect(remoteHost.tenantId).toBe('compat-remote');
      const remoteTokens = await signIn(oauthClient({ env: oauthEnv(remote) }), { scope: 'flofi.approval' });
      expect(remoteTokens.access_token).toEqual(expect.any(String));
      const account = (await t.db.query<{ account_id: string }>('SELECT account_id FROM mcp_accounts WHERE tenant_id = $1', ['compat-remote'])).rows[0]!.account_id;
      expect(await (await deploymentOAuthStore(remote)).accountActive(account)).toBe(true);
      // For comparison: the released build's platform state refuses this database on every cold start.
      expect(await outcome(unpatched.assertSchemaCurrent(remoteHost.db, SHIPPED_MIGRATIONS))).toEqual(MISMATCH);
    } finally { await coldWebInstance(); }
  });
});
