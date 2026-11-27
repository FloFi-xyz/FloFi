// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001: durable execution origins (KAN-25) and the platform fee ledger, against PostgreSQL at the certified
 * schema 37 (and at schema 28, where both stay dormant). Synthetic rows only; nothing is signed, submitted or collected.
 *   Attribution: an origin recorded at creation survives the deletion of the approval binding; a web-recorded run keeps FloFi Web when an MCP
 *   approval later binds it; a run signed through an approval page takes the approval's channel; the backfill recovers Legacy Web only where no
 *   approval could have created the run, leaves ambiguous runs Unknown, is idempotent, audited and never changes execution totals; an approved
 *   correction is an audit trail; Admin counts match the canonical rows.
 *   Revenue: F02/F03/F05 amounts, F07/F08 exactly once under repeated and concurrent accrual, F09–F11 waived failures, F10 partial runs owe
 *   nothing yet, F13 history before activation excluded, F14 a repeated saved workflow is a new execution, F16 settled ≤ authorized, F17/F18
 *   collection never active, revenue by origin.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CERTIFIED_FORWARD_MIGRATIONS, forwardMigrationSqlUrl, loadMigrations, migrate, type Database } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { channelPeriod, loadChannelCounts } from '../admin/analytics/channels.ts';
import { correctOrigin, originBackfill } from '../admin/analytics/origin-backfill.ts';
import { createPgHandoffStore } from '../platform/handoff-store.ts';
import { effectiveOrigins, recordExecutionOrigin, revenueOriginsActive } from '../workflow-runs/execution-origins.ts';
import { createPgWorkflowRunStore } from '../workflow-runs/pg-store.ts';
import { platformFeeActivation } from './activation.ts';
import { accruePlatformFees, loadFeeTotals } from './ledger.ts';
import { composeWorkflow } from '../engine/strategy-engine';

const NOW = new Date('2026-12-10T12:00:00.000Z'), DAY = 86_400_000, ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const HASH = '0x' + 'a'.repeat(64), OWNER = '0x' + 'ab'.repeat(20), OTHER = '0x' + 'cd'.repeat(20);
const CHATGPT = 'https://chatgpt.com/oauth/fixture/client.json';
const accountId = 'mcpacct_' + 'b'.repeat(26), GRANT = 'grt_' + 'f'.repeat(26);
let t: TestDatabase, db: Database, dormant: TestDatabase, seq = 0;
const tag = () => { let n = ++seq, s = ''; do { s = String.fromCharCode(97 + n % 26) + s; n = Math.floor(n / 26); } while (n); return s.padStart(26, 'a'); };

beforeAll(async () => {
  t = await createTestDatabase({ migrated: false }); db = t.db;
  const certificate = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
  const forward = await Promise.all(certificate.migrations.map(async m => ({ ...m, sql: await readFile(forwardMigrationSqlUrl(m), 'utf8') })));
  expect(await migrate(db, [...await loadMigrations(), ...forward])).toHaveLength(37);
  await db.query(`INSERT INTO mcp_accounts (tenant_id, account_id) VALUES ('default', $1)`, [accountId]);
  await db.query(`INSERT INTO mcp_oauth_grants (tenant_id, grant_id, account_id, client_id, client_name, scopes, resource)
    VALUES ('default', $3, $1, $2, 'Totally Claude', ARRAY['flofi.approval'], 'https://flofi.example/mcp')`, [accountId, CHATGPT, GRANT]);
  dormant = await createTestDatabase();
});
afterAll(async () => { await t?.drop(); await dormant?.drop(); });

type Kind = 'MCP_ACCOUNT' | 'EDITOR_SESSION' | 'CHANNEL_CONVERSATION';
async function handoff(seed: { kind: Kind; plan?: Record<string, unknown>; owner?: string; claimedAt?: Date; runIds?: string[] }): Promise<string> {
  const id = 'apr_' + tag(), at = seed.claimedAt ?? ago(5);
  const mcp = seed.kind === 'MCP_ACCOUNT';
  await db.query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind, requester_id, requester_context, account_id, grant_id, client_id, client_name,
      secret_digest, strategy, workflow_hash, engine_version, network_environment, funds_class, plan, status, claimed_namespace, claimed_address, claimed_at,
      claim_expires_at, applied_at, run_ids, expires_at, created_at)
    VALUES ('default', $1, $2, $3, '{}', $4, $5, $6, 'x', $7, '{}', $8, 'fixture', 'MAINNET', 'REAL_FUNDS', $9, 'APPLIED', 'eip155', $10, $11, $11, $11, $12, $13, $11)`,
  [id, seed.kind, mcp ? null : `${seed.kind.toLowerCase()}-${tag()}`, mcp ? accountId : null, mcp ? GRANT : null,
    mcp ? CHATGPT : seed.kind === 'CHANNEL_CONVERSATION' ? 'telegram:123456789' : 'flofi-editor', randomBytes(32), HASH,
    seed.plan ?? { kind: 'SINGLE_FLOW', flow: 'ethereum-swap' }, seed.owner ?? OWNER, at, seed.runIds ?? [], new Date(at.getTime() + DAY)]);
  return id;
}
async function run(runId: string, seed: { flow?: string; createdAt?: Date; owner?: string; status?: string } = {}): Promise<string> {
  const flow = seed.flow ?? 'ethereum-swap', name = `${runId}.jsonl`, createdAt = seed.createdAt ?? ago(2), status = seed.status ?? 'RECONCILED';
  await db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ('default', $1) ON CONFLICT DO NOTHING`, [`wf-${runId}`]);
  await db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256) VALUES ('default', $1, $2, 'RUN', 1, 1, 2, $3)`,
    [flow, name, 'c'.repeat(64)]);
  await db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, owner_account, needs_observation, has_evidence,
      log_version, created_at, updated_at) VALUES ('default', $1, $2, $3, $4, $2, $5, 'PUBLIC_MAINNET', $6, false, $7, 1, $8, $8)`,
  [runId, flow, name, `wf-${runId}`, status, seed.owner ?? OWNER, status === 'RECONCILED', createdAt]);
  if (status === 'RECONCILED') await db.query(`INSERT INTO execution_attempts (tenant_id, attempt_id, run_id, step, state, transaction_hash, reconciled)
    VALUES ('default', $1, $2, 'MAIN', 'CONFIRMED', $3, true)`, [`${runId}.0`, runId, '0x' + (seq % 16).toString(16).repeat(64)]);
  return runId;
}
const SWAP = { action: 'swap', network: 'ethereum', inputAsset: 'USDC', outputAsset: 'ETH', amount: '100', slippageBps: 100 };
const BRIDGE = { action: 'bridge', sourceNetwork: 'ethereum', destinationNetwork: 'robinhood', asset: 'ETH', amount: '0.04' };
const SWAP_ONLY = { ...SWAP, amount: '5' };
const BATCH = { action: 'batch_payment', network: 'base', asset: 'USDC', recipients: [{ recipient: '0x' + 'a1'.repeat(20), amount: '20' },
  { recipient: '0x' + 'b2'.repeat(20), amount: '30' }, { recipient: '0x' + 'c3'.repeat(20), amount: '50' }] };
type StepSeed = { state: string; received?: { asset: string; amount: string }[] };
/** The run's own canonical workflow hash, as the approval stored it (accrual composes bound to it). */
const hashOf = (strategy: unknown) => { const w = composeWorkflow(strategy); if (!w.ok) throw new Error(w.code); return w.workflowHash; };
async function workflowRun(seed: { strategy: unknown; steps: StepSeed[]; state?: string; createdAt?: Date; kind?: Kind; hash?: string }): Promise<string> {
  const createdAt = seed.createdAt ?? ago(1), state = seed.state ?? 'COMPLETED', kind = seed.kind ?? 'EDITOR_SESSION';
  const h = await handoff({ kind, plan: { kind: 'SEQUENTIAL', flow: null }, claimedAt: createdAt });
  const ref = (await db.query<{ ref: string }>('SELECT requester_ref AS ref FROM mcp_handoffs WHERE handoff_id = $1', [h])).rows[0]!.ref;
  const id = 'wfr_' + tag();
  await db.query(`INSERT INTO workflow_runs (tenant_id, run_id, handoff_id, requester_kind, requester_ref, owner_namespace, owner_account, wallets, strategy,
      workflow_hash, engine_version, step_count, mode, state, completed_at, expires_at, created_at, updated_at)
    VALUES ('default', $1, $2, $3, $4, 'eip155', $5, jsonb_build_object('eip155', $5::text), $6, $7, 'fixture', $8, 'USER_FUNDED', $9, $10, $11, $12, $12)`,
  [id, h, kind, ref, OWNER, JSON.stringify(seed.strategy), seed.hash ?? hashOf(seed.strategy), seed.steps.length, state, state === 'COMPLETED' ? createdAt : null, new Date(createdAt.getTime() + DAY), createdAt]);
  for (const [index, step] of seed.steps.entries()) {
    const outcome = step.state === 'RECONCILED' ? { kind: 'USER_FUNDED_GROUP', executionId: `${id}:g0`, flow: null, status: 'RECONCILED', transactions: [],
      evidence: { environment: 'PUBLIC_MAINNET', outcome: 'RECONCILED', bundleHash: null }, spent: [], received: step.received ?? [], observedAt: createdAt.toISOString() } : null;
    const resolved = step.state !== 'PENDING' && step.state !== 'SKIPPED';
    await db.query(`INSERT INTO workflow_run_steps (tenant_id, run_id, step_index, state, flow, strategy, workflow_hash, outcome) VALUES ('default', $1, $2, $3, $4, $5, $6, $7)`,
      [id, index, step.state, resolved ? 'ethereum-swap' : null, resolved ? '{}' : null, resolved ? HASH : null, outcome]);
  }
  return id;
}
const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: number }>(sql, params)).rows[0]!.n);
const channels = async () => { const r = await loadChannelCounts({ db, tenantId: 'default' }, { period: channelPeriod('all', NOW) }); if (!r.ok) throw new Error(r.code);
  return r.value.byEnvironment.MAINNET; };

describe('execution origins (schema 37)', () => {
  it('is dormant at schema 28 and active at the exact certified 0037', async () => {
    expect(await revenueOriginsActive(dormant.db)).toBe(false);
    expect(await recordExecutionOrigin(dormant.db, 'default', { runId: 'nope' }, 'web', 'CREATION', 'WEB_APP_SERVER_ACTION')).toBe('INACTIVE');
    expect(await revenueOriginsActive(db)).toBe(true);
  });

  it('records a workflow run origin from its approval in the creating transaction; a repeated claim records nothing twice', async () => {
    const store = createPgWorkflowRunStore(db, 'default');
    const h = await handoff({ kind: 'MCP_ACCOUNT', plan: { kind: 'SEQUENTIAL', flow: null } });
    const input = { runId: 'wfr_' + tag(), handoffId: h, requester: { kind: 'MCP_ACCOUNT' as const, ref: accountId }, owner: { namespace: 'eip155' as const, address: OWNER },
      wallets: { eip155: OWNER }, strategy: { version: 2, steps: [SWAP, BRIDGE] } as never, workflowHash: HASH, engineVersion: 'fixture', stepCount: 2,
      expiresAt: new Date(Date.now() + DAY), origin: 'mcp_chatgpt' as const };
    const created = await store.create(input, new Date());
    await store.create({ ...input, runId: 'wfr_' + tag() }, new Date());
    const origins = await effectiveOrigins(db, 'default', { runIds: [], workflowRunIds: [created.runId] });
    expect(origins.workflowRuns.get(created.runId)).toEqual({ origin: 'mcp_chatgpt', basis: 'CREATION' });
    expect(await count(`SELECT count(*)::int AS n FROM execution_origins WHERE workflow_run_id = $1`, [created.runId])).toBe(1);
  });

  it('an approval binding supersedes a web record durably (correction row); an approval-page run takes the approval channel; purge erases nothing', async () => {
    const web = await run('web-run-' + tag()), signed = await run('signed-run-' + tag());
    expect(await recordExecutionOrigin(db, 'default', { runId: web }, 'web', 'CREATION', 'WEB_APP_SERVER_ACTION')).toBe('RECORDED');
    expect(await recordExecutionOrigin(db, 'default', { runId: web }, 'web', 'CREATION', 'WEB_APP_SERVER_ACTION')).toBe('EXISTS');
    const h = await handoff({ kind: 'MCP_ACCOUNT' });
    await createPgHandoffStore(db, 'default').bindRuns(h, [web, signed]);
    const origins = await effectiveOrigins(db, 'default', { runIds: [web, signed], workflowRunIds: [] });
    // The web record stays as written; an append-only correction names the approval's channel (and only once).
    expect(origins.runs.get(web)).toEqual({ origin: 'mcp_chatgpt', basis: 'CORRECTION' });
    await createPgHandoffStore(db, 'default').bindRuns(h, [web]);
    expect(await count(`SELECT count(*)::int AS n FROM execution_origin_corrections WHERE run_id = $1 AND reason_code = 'APPROVAL_BINDING_SUPERSEDES_WEB'`, [web])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM execution_origins WHERE run_id = $1 AND origin = 'web'`, [web])).toBe(1);
    expect(origins.runs.get(signed)).toEqual({ origin: 'mcp_chatgpt', basis: 'APPROVAL_BINDING' });
    // Approval deletion (retention) no longer erases the attribution: the origin is the run's own durable record.
    await db.query(`DELETE FROM mcp_handoffs WHERE handoff_id = $1`, [h]);
    const after = await effectiveOrigins(db, 'default', { runIds: [signed, web], workflowRunIds: [] });
    expect(after.runs.get(signed)?.origin).toBe('mcp_chatgpt');
    expect(after.runs.get(web)?.origin).toBe('mcp_chatgpt');
  });

  it('backfills Legacy Web only where no approval could have created the run, idempotently, audited, never changing execution totals', async () => {
    const quiet = await run('legacy-' + tag(), { flow: 'base-swap', owner: OTHER });
    // An MCP approval claimed by OWNER for ethereum-swap before this run: it could have been signed on that approval page, so it stays Unknown.
    await handoff({ kind: 'MCP_ACCOUNT', claimedAt: ago(10) });
    const ambiguous = await run('ambiguous-' + tag(), { createdAt: ago(3) });
    const boundTelegram = await run('telegram-' + tag(), { owner: OTHER, flow: 'robinhood-swap' });
    await handoff({ kind: 'CHANNEL_CONVERSATION', owner: OTHER, runIds: [boundTelegram], plan: { kind: 'SINGLE_FLOW', flow: 'robinhood-swap' } });
    const totalsBefore = await count('SELECT count(*)::int AS n FROM execution_runs');
    const oldest = (await db.query<{ at: Date }>('SELECT min(created_at) AS at FROM mcp_handoffs')).rows[0]!.at;
    await expect(originBackfill({ db, tenantId: 'default' }, { now: NOW, approvalsCompleteSince: new Date(oldest.getTime() - 1) })).rejects.toThrow('ORIGIN_BACKFILL_HISTORY_INCOMPLETE');
    // Without the operator's statement that no approval was ever removed, a run younger than 31 days after the oldest approval is not provable.
    const cautious = await originBackfill({ db, tenantId: 'default' }, { now: NOW, approvalsCompleteSince: oldest });
    expect(cautious.byClass.NO_APPROVAL).toBe(0);
    expect(cautious.byClass.BEFORE_COMPLETE_HISTORY).toBeGreaterThanOrEqual(1);
    const dry = await originBackfill({ db, tenantId: 'default' }, { now: NOW, approvalsCompleteSince: oldest, approvalsNeverPurged: true });
    expect(dry.mode).toBe('DRY_RUN');
    expect(await count(`SELECT count(*)::int AS n FROM execution_origins WHERE basis = 'BACKFILL'`)).toBe(0);
    expect(dry.byClass).toMatchObject({ AMBIGUOUS: 1 });
    const applied = await originBackfill({ db, tenantId: 'default' }, { now: NOW, approvalsCompleteSince: oldest, approvalsNeverPurged: true, apply: { approvalRef: 'KAN-25', actor: 'cli' } });
    expect(applied.recorded).toBe(dry.byClass.BOUND + dry.byClass.NO_APPROVAL);
    const origins = await effectiveOrigins(db, 'default', { runIds: [quiet, ambiguous, boundTelegram], workflowRunIds: [] });
    expect(origins.runs.get(quiet)).toEqual({ origin: 'legacy_web', basis: 'BACKFILL' });
    expect(origins.runs.get(boundTelegram)).toEqual({ origin: 'telegram', basis: 'BACKFILL' });
    expect(origins.runs.has(ambiguous)).toBe(false);
    const again = await originBackfill({ db, tenantId: 'default' }, { now: NOW, approvalsCompleteSince: oldest, approvalsNeverPurged: true, apply: { approvalRef: 'KAN-25', actor: 'cli' } });
    expect(again.recorded).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM execution_runs')).toBe(totalsBefore);
    expect(await count(`SELECT count(*)::int AS n FROM admin_audit_events WHERE kind = 'EXECUTION_ORIGINS_BACKFILLED'`)).toBe(2);
    // Admin counts follow the canonical rows: Legacy Web and Telegram appear, the ambiguous run stays Unknown origin.
    const mainnet = await channels();
    expect(mainnet.counts.LEGACY_WEB).toBeGreaterThanOrEqual(1);
    expect(mainnet.counts.TELEGRAM).toBeGreaterThanOrEqual(1);
    expect(mainnet.counts.UNKNOWN).toBeGreaterThanOrEqual(1);
    // An explicitly approved correction leaves an audit trail and never rewrites the recorded origin.
    expect(await correctOrigin({ db, tenantId: 'default' }, { runId: ambiguous, origin: 'mcp_chatgpt', approvalRef: 'KAN-25', reasonCode: 'OWNER_CONFIRMED', actor: 'cli' }))
      .toEqual({ previous: null, origin: 'mcp_chatgpt' });
    expect((await effectiveOrigins(db, 'default', { runIds: [ambiguous], workflowRunIds: [] })).runs.get(ambiguous)).toEqual({ origin: 'mcp_chatgpt', basis: 'CORRECTION' });
    await expect(correctOrigin({ db, tenantId: 'default' }, { runId: ambiguous, origin: 'whatsapp', approvalRef: 'KAN-25', reasonCode: 'X_Y_Z', actor: 'cli' }))
      .rejects.toThrow('ORIGIN_CORRECTION_REQUEST_INVALID');
  });
});

describe('platform fee ledger (schema 37)', () => {
  const activation = platformFeeActivation({ FLOFI_PLATFORM_FEE_ACCOUNTING_FROM: ago(3).toISOString() });
  const ETH = 'eip155:1/native:ETH';

  it('F17/F18: accounting needs an explicit start, collection is never active, and an unmigrated database accrues nothing', async () => {
    expect(platformFeeActivation({}).accounting).toEqual({ active: false, from: null, code: 'PLATFORM_FEE_ACCOUNTING_NOT_ACTIVATED' });
    expect(platformFeeActivation({ FLOFI_PLATFORM_FEE_ACCOUNTING_FROM: 'tomorrow' }).accounting.code).toBe('PLATFORM_FEE_ACCOUNTING_FROM_INVALID');
    expect(platformFeeActivation({}).collection).toEqual({ active: false, code: 'PLATFORM_FEE_COLLECTION_DISABLED' });
    expect(platformFeeActivation({ FLOFI_PLATFORM_FEE_COLLECTION: 'on' }).collection.code).toBe('PLATFORM_FEE_TREASURY_NOT_CONFIGURED');
    expect(platformFeeActivation({ FLOFI_PLATFORM_FEE_COLLECTION: 'on', FLOFI_PLATFORM_FEE_TREASURY_EVM: '0x' + 'ab'.repeat(20).toUpperCase(),
      FLOFI_PLATFORM_FEE_TREASURY_SOLANA: '11111111111111111111111111111111' }).collection.code).toBe('PLATFORM_FEE_TREASURY_INVALID');
    expect(platformFeeActivation({ FLOFI_PLATFORM_FEE_COLLECTION: 'on', FLOFI_PLATFORM_FEE_TREASURY_EVM: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
      FLOFI_PLATFORM_FEE_TREASURY_SOLANA: '11111111111111111111111111111111' }).collection.code).toBe('PLATFORM_FEE_POLICY_NOT_APPROVED');
    expect(platformFeeActivation({ FLOFI_PLATFORM_FEE_COLLECTION: 'on', FLOFI_PLATFORM_FEE_TREASURY_EVM: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
      FLOFI_PLATFORM_FEE_TREASURY_SOLANA: '11111111111111111111111111111111', FLOFI_PLATFORM_FEE_POLICY_APPROVAL: 'FIN-1' }).collection)
      .toEqual({ active: false, code: 'PLATFORM_FEE_AUTHORIZED_BASIS_NOT_RECORDED' });
    expect(await accruePlatformFees(dormant.db, 'default', activation, { apply: true, limit: 50 })).toMatchObject({ recorded: 0, code: 'PLATFORM_FEE_LEDGER_NOT_MIGRATED' });
    expect(await accruePlatformFees(db, 'default', platformFeeActivation({}), { apply: true, limit: 50 })).toMatchObject({ recorded: 0, code: 'PLATFORM_FEE_ACCOUNTING_NOT_ACTIVATED' });
  });

  it('accrues each terminal execution once, with the right amounts, and nothing for history, open runs or never-started ones', async () => {
    const swapBridge = await workflowRun({ strategy: { version: 2, steps: [SWAP, BRIDGE] }, steps: [{ state: 'RECONCILED', received: [{ asset: ETH, amount: '40000000000000000' }] },
      { state: 'RECONCILED' }] });
    const again = await workflowRun({ strategy: { version: 2, steps: [SWAP, BRIDGE] }, steps: [{ state: 'RECONCILED', received: [{ asset: ETH, amount: '40000000000000000' }] },
      { state: 'RECONCILED' }], kind: 'MCP_ACCOUNT' });
    const batch = await workflowRun({ strategy: BATCH, steps: [{ state: 'RECONCILED' }, { state: 'RECONCILED' }, { state: 'RECONCILED' }] });
    const failedAfterStart = await workflowRun({ strategy: { version: 2, steps: [SWAP, BRIDGE] }, state: 'FAILED', steps: [{ state: 'RECONCILED' }, { state: 'FAILED' }] });
    // As `store.cancel` leaves a run that never reached a chain: every step SKIPPED, no outcome.
    const cancelledUnstarted = await workflowRun({ strategy: { version: 2, steps: [SWAP, BRIDGE] }, state: 'CANCELLED', steps: [{ state: 'SKIPPED' }, { state: 'SKIPPED' }] });
    // A run composed to another hash (an engine or catalog change since its Review) is never charged under today's composition.
    const drifted = await workflowRun({ strategy: { version: 2, steps: [SWAP, BRIDGE] }, hash: '0x' + 'e'.repeat(64),
      steps: [{ state: 'RECONCILED', received: [{ asset: ETH, amount: '1' }] }, { state: 'RECONCILED' }] });
    const halted = await workflowRun({ strategy: { version: 2, steps: [SWAP, BRIDGE] }, state: 'HALTED', steps: [{ state: 'RECONCILED' }, { state: 'BLOCKED' }] });
    const historical = await workflowRun({ strategy: { version: 2, steps: [SWAP, BRIDGE] }, createdAt: ago(10), steps: [{ state: 'RECONCILED' }, { state: 'RECONCILED' }] });
    await recordExecutionOrigin(db, 'default', { workflowRunId: again }, 'mcp_chatgpt', 'CREATION', 'APPROVAL_REQUESTER');
    // Concurrent accruals (two workers, a restart mid-pass): one row per execution.
    const reports = await Promise.all([1, 2, 3].map(() => accruePlatformFees(db, 'default', activation, { apply: true, limit: 200 })));
    expect(reports.reduce((n, r) => n + r.recorded, 0)).toBe(5);
    const rows = new Map((await db.query<{ workflow_run_id: string; state: string; lines: { fee: string; principal: string; chainId: string }[]; reason: string | null; origin: string | null }>(
      'SELECT workflow_run_id, state, lines, reason, origin FROM platform_fee_ledger')).rows.map(r => [r.workflow_run_id, r]));
    expect(rows.get(swapBridge)).toMatchObject({ state: 'DUE', lines: [{ chainId: 'eip155:1', principal: '100000000', fee: '800000' }] });
    expect(rows.get(again)).toMatchObject({ state: 'DUE', origin: 'mcp_chatgpt' }); // F14: a second execution of the same saved workflow
    expect(rows.get(batch)).toMatchObject({ state: 'DUE', lines: [{ chainId: 'eip155:8453', principal: '100000000', fee: '800000' }] });
    expect(rows.get(failedAfterStart)).toMatchObject({ state: 'WAIVED', reason: 'WORKFLOW_FAILED', lines: [] });
    expect(rows.get(drifted)).toMatchObject({ state: 'UNSUPPORTED', reason: 'PLATFORM_FEE_WORKFLOW_HASH_MISMATCH', lines: [] });
    for (const id of [cancelledUnstarted, halted, historical]) expect(rows.has(id)).toBe(false);
    expect(await accruePlatformFees(db, 'default', activation, { apply: true, limit: 200 })).toMatchObject({ recorded: 0 });
    // The ledger itself refuses a second row or a forged collection.
    await expect(db.query(`UPDATE platform_fee_ledger SET state = 'COLLECTED', version = version + 1 WHERE workflow_run_id = $1`, [swapBridge])).rejects.toThrow();
    const totals = await loadFeeTotals(db, 'default', { from: ago(30), to: new Date(Math.max(Date.now(), NOW.getTime()) + DAY) }, 'MAINNET');
    expect(totals.byState).toMatchObject({ DUE: 3, WAIVED: 1, UNSUPPORTED: 1 });
    expect(totals.collectedByAsset).toEqual([]);
    expect(totals.dueByAsset).toEqual([
      { chainId: 'eip155:1', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, fee: '1600000', executions: 2 },
      { chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, fee: '800000', executions: 1 }]);
    expect(totals.byOrigin).toMatchObject({ mcp_chatgpt: 1 });
  });

  it('never stalls: runs that record nothing (expired before starting) cannot hold a completed run back, whatever the page size', async () => {
    const created = ago(2);
    for (let i = 0; i < 3; i++) await workflowRun({ strategy: { version: 2, steps: [SWAP, BRIDGE] }, state: 'EXPIRED', createdAt: new Date(created.getTime() + i),
      steps: [{ state: 'PENDING' }, { state: 'PENDING' }] });
    const completed = await workflowRun({ strategy: SWAP_ONLY, createdAt: new Date(created.getTime() + 10), steps: [{ state: 'RECONCILED' }] });
    const first = await accruePlatformFees(db, 'default', activation, { apply: true, limit: 1 });
    expect(first.recorded).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM platform_fee_ledger WHERE workflow_run_id = $1', [completed])).toBe(1);
  });
});

