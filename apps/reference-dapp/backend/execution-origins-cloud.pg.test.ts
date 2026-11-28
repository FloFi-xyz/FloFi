// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (KAN-25 §8.1/§8.2): where an execution started, recorded when the API creates it, at the certified
 * schema 37. The unchanged Robinhood transfer flow runs behind the API on a MOCKED in-process chain (no public network, no real broadcast; the only
 * "wallet" is the test calling MOCK_submit).
 *   §8.1  an /app creating call is Web Chat only with the server-verified Chat context, Web Editor otherwise; the previous build's BFF value is the
 *         legacy combined `web`; any other header value records nothing — through the HTTP API (BFF path) and the embedded runtime alike.
 *   §8.2  a run created on an approval page takes that approval's channel at creation, with status sharing off or on, only for an exact reviewed
 *         workflow hash, the approval's claimant as the request's proven wallet and the run's owner, and one unambiguous channel.
 *   The origin never changes through review, signing, submission, reconciliation or a later approval binding, and recording changes no execution.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CERTIFIED_FORWARD_MIGRATIONS, createFilesystemEvidenceStore, createHttpServer, createLogger, createPostgresWorkQueue, createWorker, forwardMigrationSqlUrl,
  loadMigrations, migrate, type Database } from '@defi-workflow-engine/cloud-runtime';
import { createNativeTransferNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createRobinhoodTransferChain, TRANSFER_OWNER as owner } from '../e2e/robinhood-transfer-harness.mjs';
import { createTestDatabase, type TestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';
import { callCloudFlow } from '../src/server/cloud-api-client.ts';
import type { TransferRecord } from '../src/server/robinhood-transfer-service.ts';
import type { Workflow } from '../src/domain/initial-workflow.ts';
import { semanticWorkflowHash } from '../src/engine/strategy-engine.ts';
import { createPgHandoffStore } from '../src/platform/handoff-store.ts';
import { reviewedWorkflows } from '../src/workflow-runs/approval-page-origin.ts';
import { effectiveOrigins, recordExecutionOrigin, type OriginContext } from '../src/workflow-runs/execution-origins.ts';
import { createPgWorkflowRunStore } from '../src/workflow-runs/pg-store.ts';
import { channelPeriod, loadChannelCounts } from '../src/admin/analytics/channels.ts';
import { createBackend, type FlowResult } from './app.ts';

const quiet = createLogger({ service: 'test', sink: () => undefined });
const env = { GRYLOO_ROBINHOOD_HARNESS: 'MOCKED_LOOPBACK_ONLY' } as const;
const OTHER = '0x' + 'cd'.repeat(20), CHATGPT = 'https://chatgpt.com/oauth/fixture/client.json';
const accountId = 'mcpacct_' + 'c'.repeat(26), GRANT = 'grt_' + 'e'.repeat(26);
let t: TestDatabase, db: Database, seq = 0, amount = 1_000_000_000_000n;
const tag = () => { let n = ++seq, s = ''; do { s = String.fromCharCode(97 + n % 26) + s; n = Math.floor(n / 26); } while (n); return s.padStart(26, 'a'); };
/** A distinct transfer workflow (its own canonical hash) per case. */
const workflow = (): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: `rh-origin-${++seq}`, revision: 1, resourceEdges: [],
  nodes: [createNativeTransferNode('node-002', { chain: 'eip155:46630', amount: String(amount += 1_000n), recipient: 'CONNECTED_OWNER' })] });
function ok<T>(result: FlowResult): T { if (!result.ok) throw new Error(result.code); return result.value as T; }

beforeAll(async () => {
  t = await createTestDatabase({ migrated: false }); db = t.db;
  const certificate = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
  const forward = await Promise.all(certificate.migrations.map(async m => ({ ...m, sql: await readFile(forwardMigrationSqlUrl(m), 'utf8') })));
  expect(await migrate(db, [...await loadMigrations(), ...forward])).toHaveLength(38);
  await db.query(`INSERT INTO mcp_accounts (tenant_id, account_id) VALUES ('default', $1)`, [accountId]);
  await db.query(`INSERT INTO mcp_oauth_grants (tenant_id, grant_id, account_id, client_id, client_name, scopes, resource)
    VALUES ('default', $3, $1, $2, 'Totally Claude', ARRAY['flofi.approval'], 'https://flofi.example/mcp')`, [accountId, CHATGPT, GRANT]);
});
afterAll(async () => { await t?.drop(); });

let nonce = 400;
async function deployment() {
  const chain = createRobinhoodTransferChain({ nonce: nonce++ }), workerId = `worker-${randomBytes(3).toString('hex')}`;
  const backend = createBackend({ db, env, logger: quiet, tenantId: 'default', holderId: workerId,
    evidenceStore: createFilesystemEvidenceStore(await mkdtemp(join(tmpdir(), 'flofi-origin-evidence-'))), rpc: { 'robinhood-transfer': chain.rpc }, busyRetries: 3 });
  const worker = createWorker({ queue: createPostgresWorkQueue({ db, ownerId: workerId }), handlers: backend.handlers, logger: quiet, workerId, concurrency: 4 });
  /** A creating call as the embedded runtime makes it (the context is what FloFi's server derived for the request). */
  const simulate = async (w: SemanticWorkflow, context: OriginContext | null) =>
    ok<TransferRecord>(await backend.callFlow('robinhood-transfer', 'simulate', [w, owner], 'default', null, null, false, context));
  return { chain, backend, worker, simulate };
}
type Recorded = { origin: string; basis: string; evidence: string } | undefined;
const originOf = async (runId: string): Promise<Recorded> => (await db.query<{ origin: string; basis: string; evidence: string }>(
  'SELECT origin, basis, evidence FROM execution_origins WHERE tenant_id = $1 AND run_id = $2', ['default', runId])).rows[0];
const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: number }>(sql, params)).rows[0]!.n);
const channels = async (environment: 'MAINNET' | 'TESTNET' | 'MOCKED') => {
  const result = await loadChannelCounts({ db, tenantId: 'default' }, { period: channelPeriod('all', new Date(Date.now() + 60_000)) });
  if (!result.ok) throw new Error(result.code);
  return result.value.byEnvironment[environment];
};
const hashOf = (record: unknown) => { const [w] = reviewedWorkflows(record); if (!w) throw new Error('NO_REVIEWED_WORKFLOW'); return semanticWorkflowHash(w as Workflow); };

type Kind = 'MCP_ACCOUNT' | 'CHANNEL_CONVERSATION' | 'EDITOR_SESSION';
/** An approval of `owner` (or `claimant`) as the stores write it, APPLIED (or CLAIMED) a minute ago. */
async function approval(seed: { kind: Kind; hash: string; share?: boolean; claimant?: string; plan?: Record<string, unknown>; status?: 'APPLIED' | 'CLAIMED';
  claimExpired?: boolean }): Promise<string> {
  const id = 'apr_' + tag(), at = new Date(Date.now() - 60_000), mcp = seed.kind === 'MCP_ACCOUNT';
  await db.query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind, requester_id, requester_context, account_id, grant_id, client_id, client_name,
      secret_digest, strategy, workflow_hash, engine_version, network_environment, funds_class, plan, status, claimed_namespace, claimed_address, claimed_at,
      claim_expires_at, applied_at, share_status, expires_at, created_at)
    VALUES ('default', $1, $2, $3, '{}', $4, $5, $6, 'ChatGPT', $7, '{}', $8, 'fixture', 'PUBLIC_TESTNET', 'TEST_FUNDS', $9, $10, 'eip155', $11, $12, $13, $14, $15, $16, $12)`,
  [id, seed.kind, mcp ? null : `${seed.kind.toLowerCase().replace('_', '-')}-${tag()}`, mcp ? accountId : null, mcp ? GRANT : null,
    mcp ? CHATGPT : seed.kind === 'CHANNEL_CONVERSATION' ? 'telegram:123456789' : 'flofi-editor', randomBytes(32), seed.hash,
    seed.plan ?? { kind: 'SINGLE_FLOW', flow: 'robinhood-transfer' }, seed.status ?? 'APPLIED', seed.claimant ?? owner, at,
    new Date(Date.now() + (seed.claimExpired ? -1_000 : 600_000)), seed.status === 'CLAIMED' ? null : at, seed.share ?? false, new Date(Date.now() + 86_400_000)]);
  return id;
}
const proven = (address = owner): OriginContext => ({ surface: 'APPROVAL_PAGE', wallets: [{ namespace: 'eip155', address: address.toLowerCase() }] });

describe('§8.1 Web Chat and Web Editor at creation', () => {
  it('records Web Chat only with the verified Chat context, Web Editor otherwise, through the HTTP API and the embedded runtime', async () => {
    const d = await deployment(), token = 't'.repeat(40);
    const server = createHttpServer({ routes: d.backend.routes, logger: quiet, authToken: token });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, remote = { API_BASE_URL: base, API_AUTH_TOKEN: token };
      const viaApi = async (surface: OriginContext | null) => ok<TransferRecord>(await callCloudFlow('robinhood-transfer', 'simulate', [workflow(), owner], { env: remote, surface }));
      const raw = async (value: string) => (await (await fetch(`${base}/v1/flows/robinhood-transfer/simulate`, { method: 'POST', headers: { 'content-type': 'application/json',
        authorization: `Bearer ${token}`, 'idempotency-key': randomBytes(16).toString('hex'), 'x-flofi-execution-surface': value },
        body: JSON.stringify({ args: [workflow(), owner] }) })).json() as { value: TransferRecord }).value;
      expect(await originOf((await viaApi({ surface: 'WEB_CHAT' })).id)).toEqual({ origin: 'web_chat', basis: 'CREATION', evidence: 'WEB_CHAT_INITIATION' });
      expect(await originOf((await viaApi({ surface: 'WEB_EDITOR' })).id)).toEqual({ origin: 'web_editor', basis: 'CREATION', evidence: 'WEB_EDITOR_SERVER_ACTION' });
      // A BFF of the previous build (not yet redeployed) sends the combined value: the legacy `web`, honestly not separated.
      expect(await originOf((await raw('web-app')).id)).toEqual({ origin: 'web', basis: 'CREATION', evidence: 'WEB_APP_SERVER_ACTION' });
      // No context, or any value that is not one of the closed ones (an origin name, a label): nothing is recorded, the call is unchanged.
      expect(await originOf((await viaApi(null)).id)).toBeUndefined();
      for (const value of ['web_chat', 'chat', 'WEB_CHAT']) expect(await originOf((await raw(value)).id), value).toBeUndefined();
    } finally { await new Promise(resolve => server.close(resolve)); }
    // The embedded runtime passes the same context in process.
    expect(await originOf((await d.simulate(workflow(), { surface: 'WEB_CHAT' })).id)).toMatchObject({ origin: 'web_chat' });
    expect(await originOf((await d.simulate(workflow(), { surface: 'WEB_EDITOR' })).id)).toMatchObject({ origin: 'web_editor' });
  });

  it('a non-creating method records nothing, whatever context it carries', async () => {
    const d = await deployment(), created = await d.simulate(workflow(), null);
    ok(await d.backend.callFlow('robinhood-transfer', 'status', [created.id], 'default', null, null, false, { surface: 'WEB_CHAT' }));
    expect(await originOf(created.id)).toBeUndefined();
  });
});

describe('§8.2 an approval page attributes its run at creation', () => {
  it('takes the approval\'s channel with status sharing off, and keeps it when sharing is on and the approval binds the run', async () => {
    const d = await deployment(), w = workflow(), hash = hashOf(await d.simulate(w, null));
    await approval({ kind: 'MCP_ACCOUNT', hash, share: false });
    const unshared = await d.simulate(w, proven());
    expect(await originOf(unshared.id)).toEqual({ origin: 'mcp_chatgpt', basis: 'CREATION', evidence: 'APPROVAL_PAGE_CREATION' });
    // Sharing on: the same at creation; the binding sharing drives (bindRuns) neither duplicates nor corrects it.
    const w2 = workflow(), hash2 = hashOf(await d.simulate(w2, null));
    const shared = await approval({ kind: 'CHANNEL_CONVERSATION', hash: hash2, share: true });
    const run = await d.simulate(w2, proven());
    expect(await originOf(run.id)).toEqual({ origin: 'telegram', basis: 'CREATION', evidence: 'APPROVAL_PAGE_CREATION' });
    await createPgHandoffStore(db, 'default').bindRuns(shared, [run.id]);
    expect(await originOf(run.id)).toEqual({ origin: 'telegram', basis: 'CREATION', evidence: 'APPROVAL_PAGE_CREATION' });
    expect(await count('SELECT count(*)::int AS n FROM execution_origin_corrections WHERE run_id = $1', [run.id])).toBe(0);
    // Sharing still decides only what the requester sees: the unshared approval binds nothing and shows no run.
    expect((await db.query('SELECT run_ids FROM mcp_handoffs WHERE workflow_hash = $1', [hash])).rows[0]).toEqual({ run_ids: [] });
  });

  it('records nothing without an exact hash, the claimant\'s proven wallet, the run\'s own owner or one unambiguous live approval', async () => {
    const d = await deployment();
    const fresh = async () => { const w = workflow(); return { w, hash: hashOf(await d.simulate(w, null)) }; };
    // Another workflow (an edited proposal): no approval proposed exactly this one.
    const edited = await fresh();
    await approval({ kind: 'MCP_ACCOUNT', hash: '0x' + 'f'.repeat(64) });
    expect(await originOf((await d.simulate(edited.w, proven())).id)).toBeUndefined();
    // The request proved no wallet, or only another one: nothing (the owner argument alone is never the claimant).
    const unproven = await fresh();
    await approval({ kind: 'MCP_ACCOUNT', hash: unproven.hash });
    expect(await originOf((await d.simulate(unproven.w, { surface: 'APPROVAL_PAGE', wallets: [] })).id)).toBeUndefined();
    expect(await originOf((await d.simulate(unproven.w, proven(OTHER))).id)).toBeUndefined();
    // Another wallet claimed it (even when this request proved that wallet too: the run's owner is not the claimant).
    const foreign = await fresh();
    await approval({ kind: 'MCP_ACCOUNT', hash: foreign.hash, claimant: OTHER });
    expect(await originOf((await d.simulate(foreign.w, { surface: 'APPROVAL_PAGE', wallets: [{ namespace: 'eip155', address: OTHER }, { namespace: 'solana',
      address: 'So11111111111111111111111111111111111111112' }] })).id)).toBeUndefined();
    // Two live approvals of different channels for the same workflow: ambiguous, nothing; of the same channel: that channel.
    const ambiguous = await fresh();
    await approval({ kind: 'MCP_ACCOUNT', hash: ambiguous.hash });
    await approval({ kind: 'CHANNEL_CONVERSATION', hash: ambiguous.hash });
    expect(await originOf((await d.simulate(ambiguous.w, proven())).id)).toBeUndefined();
    const twice = await fresh();
    await approval({ kind: 'MCP_ACCOUNT', hash: twice.hash });
    await approval({ kind: 'MCP_ACCOUNT', hash: twice.hash, share: true });
    expect(await originOf((await d.simulate(twice.w, proven())).id)).toMatchObject({ origin: 'mcp_chatgpt' });
    // A lapsed claim, another flow, or a multi-step approval (its steps are a workflow run's, never an execution of their own): nothing.
    const lapsed = await fresh();
    await approval({ kind: 'MCP_ACCOUNT', hash: lapsed.hash, status: 'CLAIMED', claimExpired: true });
    await approval({ kind: 'MCP_ACCOUNT', hash: lapsed.hash, plan: { kind: 'SINGLE_FLOW', flow: 'base-swap' } });
    await approval({ kind: 'EDITOR_SESSION', hash: lapsed.hash, plan: { kind: 'SEQUENTIAL', flow: null } });
    expect(await originOf((await d.simulate(lapsed.w, proven())).id)).toBeUndefined();
    // A live claim (not yet applied) is the approval's page too.
    const claimed = await fresh();
    await approval({ kind: 'CHANNEL_CONVERSATION', hash: claimed.hash, status: 'CLAIMED' });
    expect(await originOf((await d.simulate(claimed.w, proven())).id)).toMatchObject({ origin: 'telegram' });
  });
});

describe('the origin is immutable and recording changes no execution', () => {
  it('survives review, signing, submission, reconciliation and a later approval binding unchanged', async () => {
    const d = await deployment(), w = workflow();
    const record = await d.simulate(w, { surface: 'WEB_CHAT' });
    const reviewed = ok<TransferRecord>(await d.backend.callFlow('robinhood-transfer', 'review', [record.id, record.review.commitment, w], 'default', null, null, false,
      { surface: 'WEB_EDITOR' }));
    const begin = ok<{ record: TransferRecord; transaction: Record<string, string> }>(await d.backend.callFlow('robinhood-transfer', 'begin', [reviewed.id, owner, w]));
    ok(await d.backend.callFlow('robinhood-transfer', 'handoff', [reviewed.id]));
    const hash = await d.chain.rpc('MOCK_submit', [begin.transaction]) as string; // the owner's wallet, the only submitter
    ok(await d.backend.callFlow('robinhood-transfer', 'report', [reviewed.id, { kind: 'HASH', hash }]));
    await db.query(`UPDATE work_items SET available_at = now() WHERE state = 'READY'`);
    await d.worker.drainOnce(); await d.worker.drainOnce();
    expect(ok<TransferRecord>(await d.backend.callFlow('robinhood-transfer', 'status', [record.id]))).toMatchObject({ verdict: 'RECONCILED' });
    expect(await originOf(record.id)).toEqual({ origin: 'web_chat', basis: 'CREATION', evidence: 'WEB_CHAT_INITIATION' });
    // A second record (another surface, an approval page) never replaces it, and the row itself cannot be rewritten.
    expect(await recordExecutionOrigin(db, 'default', { runId: record.id }, 'mcp_claude', 'CREATION', 'APPROVAL_PAGE_CREATION')).toBe('EXISTS');
    await expect(db.query(`UPDATE execution_origins SET origin = 'web_editor' WHERE run_id = $1`, [record.id])).rejects.toThrow(/EXECUTION_ORIGIN_IMMUTABLE/);
    expect(await originOf(record.id)).toEqual({ origin: 'web_chat', basis: 'CREATION', evidence: 'WEB_CHAT_INITIATION' });
    // The Admin counts the reconciled run (a MOCKED harness run) as Web Chat, its own row, inside the FloFi Web total.
    const mocked = await channels('MOCKED');
    expect(mocked.counts.WEB_CHAT).toBeGreaterThanOrEqual(1);
  });

  it('a web record at creation that an approval binding contradicts is corrected once, append-only, naming the recorded value', async () => {
    const d = await deployment(), w = workflow(), run = await d.simulate(w, { surface: 'WEB_EDITOR' });
    const bound = await approval({ kind: 'MCP_ACCOUNT', hash: hashOf(run), share: true });
    await createPgHandoffStore(db, 'default').bindRuns(bound, [run.id]);
    await createPgHandoffStore(db, 'default').bindRuns(bound, [run.id]);
    expect(await originOf(run.id)).toEqual({ origin: 'web_editor', basis: 'CREATION', evidence: 'WEB_EDITOR_SERVER_ACTION' });
    expect((await db.query('SELECT origin, previous_origin, reason_code FROM execution_origin_corrections WHERE run_id = $1', [run.id])).rows)
      .toEqual([{ origin: 'mcp_chatgpt', previous_origin: 'web_editor', reason_code: 'APPROVAL_BINDING_SUPERSEDES_WEB' }]);
    expect((await effectiveOrigins(db, 'default', { runIds: [run.id], workflowRunIds: [] })).runs.get(run.id)).toEqual({ origin: 'mcp_chatgpt', basis: 'CORRECTION' });
  });

  it('an Editor workflow run records Web Chat or Web Editor in its creating transaction, and the Admin separates them', async () => {
    const store = createPgWorkflowRunStore(db, 'default');
    const editorRun = async (origin: 'web_chat' | 'web_editor', evidence?: string) => {
      const handoffId = await approval({ kind: 'EDITOR_SESSION', hash: '0x' + 'a'.repeat(64), plan: { kind: 'SEQUENTIAL', flow: null } });
      const ref = (await db.query<{ ref: string }>('SELECT requester_ref AS ref FROM mcp_handoffs WHERE handoff_id = $1', [handoffId])).rows[0]!.ref;
      return store.create({ runId: 'wfr_' + tag(), handoffId, requester: { kind: 'EDITOR_SESSION', ref }, owner: { namespace: 'eip155', address: owner },
        wallets: { eip155: owner }, strategy: { version: 2, steps: [] } as never, workflowHash: '0x' + 'a'.repeat(64), engineVersion: 'fixture', stepCount: 2,
        expiresAt: new Date(Date.now() + 86_400_000), origin, ...evidence ? { originEvidence: evidence } : {} }, new Date());
    };
    const chat = await editorRun('web_chat', 'WEB_CHAT_INITIATION'), editor = await editorRun('web_editor');
    const rows = (await db.query<{ workflow_run_id: string; origin: string; evidence: string }>(`SELECT workflow_run_id, origin, evidence FROM execution_origins
      WHERE workflow_run_id = ANY($1::text[]) ORDER BY origin`, [[chat.runId, editor.runId]])).rows;
    expect(rows).toEqual([{ workflow_run_id: chat.runId, origin: 'web_chat', evidence: 'WEB_CHAT_INITIATION' },
      { workflow_run_id: editor.runId, origin: 'web_editor', evidence: 'APPROVAL_REQUESTER' }]);
    // Completed (as the runner leaves them) they are counted under their own rows; an Editor run without a record stays FloFi Web (Chat or Editor).
    const before = await channels('TESTNET');
    const unrecorded = await editorRun('web_editor');
    await db.query(`DELETE FROM execution_origins WHERE workflow_run_id = $1`, [unrecorded.runId]);
    for (const id of [chat.runId, editor.runId, unrecorded.runId]) {
      // A fixture shortcut (the transition triggers guard the runner's own path, tested elsewhere): the final state the runner leaves.
      await db.query(`ALTER TABLE workflow_runs DISABLE TRIGGER USER; ALTER TABLE workflow_run_steps DISABLE TRIGGER USER`);
      try {
        await db.query(`UPDATE workflow_runs SET state = 'COMPLETED', mode = 'USER_FUNDED', completed_at = now() WHERE run_id = $1`, [id]);
        await db.query(`UPDATE workflow_run_steps SET state = 'RECONCILED', flow = 'robinhood-transfer', strategy = '{}', workflow_hash = $2,
          outcome = jsonb_build_object('kind', 'USER_FUNDED_GROUP', 'executionId', run_id || ':g0', 'evidence', jsonb_build_object('outcome', 'RECONCILED'))
          WHERE run_id = $1`, [id, '0x' + 'a'.repeat(64)]);
      } finally { await db.query(`ALTER TABLE workflow_runs ENABLE TRIGGER USER; ALTER TABLE workflow_run_steps ENABLE TRIGGER USER`); }
    }
    const after = await channels('TESTNET');
    expect(after.counts.WEB_CHAT - before.counts.WEB_CHAT).toBe(1);
    expect(after.counts.WEB_EDITOR - before.counts.WEB_EDITOR).toBe(1);
    expect(after.counts.FLOFI_WEB - before.counts.FLOFI_WEB).toBe(1);
    expect(after.total - before.total).toBe(3);
  });

  it('every creating call makes exactly one run, with or without a context; its result is the flow\'s own', async () => {
    const d = await deployment(), before = await count('SELECT count(*)::int AS n FROM execution_runs');
    const contexts: (OriginContext | null)[] = [null, { surface: 'WEB_CHAT' }, { surface: 'WEB_EDITOR' }, { surface: 'WEB_APP' }, proven(), proven(OTHER)];
    const records = [];
    for (const context of contexts) records.push(await d.simulate(workflow(), context));
    expect(await count('SELECT count(*)::int AS n FROM execution_runs')).toBe(before + contexts.length);
    expect(new Set(records.map(r => r.id)).size).toBe(contexts.length);
    // The same flow record shape whatever the context (attribution adds nothing to it).
    for (const r of records) expect(Object.keys(r).sort()).toEqual(Object.keys(records[0]!).sort());
    expect(await count(`SELECT count(*)::int AS n FROM execution_attempts a WHERE a.run_id = ANY($1::text[])`, [records.map(r => r.id)])).toBe(0);
  });
});
