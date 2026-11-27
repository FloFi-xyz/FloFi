// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-25): completed executions by channel against PostgreSQL, on controlled fixtures with exact
 * expected counts — workflow runs of every requester kind (a Batch Payment-shaped 8-step run counted once), owner-signed step runs and live
 * developer step runs counted only through their workflow run, recoveries and retries folded into one execution, bound single flows attributed
 * to their approval's channel, unbound ones Unknown origin whatever their time, conflicting bindings, automations, environments and period
 * boundaries. Then FloFi Web only from positive records, an 8-recipient Batch Payment counted once, and a binding that keeps its channel only
 * while its approval exists. Then workflow runs whose steps carry MOCKED evidence (a harness deployment) counted under Mocked, as their one-step
 * runs are, never under their approval's Mainnet.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { channelPeriod, loadChannelCounts, type ChannelCounts } from './channels.ts';

const NOW = new Date('2026-11-20T10:00:00.000Z'), MIDNIGHT = new Date('2026-11-20T00:00:00.000Z'), DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const HASH = '0x' + 'a'.repeat(64), OWNER = '0x' + 'ab'.repeat(20);
const CHATGPT = 'https://chatgpt.com/oauth/fixture/client.json', CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata', DCR = 'flofi_dcr_fixtureclient';
let t: TestDatabase, db: Database, seq = 0;
/** A distinct 26-letter id body ([a-z] only, valid for every `[a-z2-7]{26}` identifier). */
const tag = () => { let n = ++seq, s = ''; do { s = String.fromCharCode(97 + n % 26) + s; n = Math.floor(n / 26); } while (n); return s.padStart(26, 'a'); };
const accountId = 'mcpacct_' + 'a'.repeat(26);

beforeAll(async () => {
  t = await createTestDatabase(); db = t.db;
  // A one-step Editor run needs 0032's widened step-count rule (a certified-ahead migration): applied here from its SHA-pinned fixture.
  await db.query(await readFile(new URL('../../../../../packages/cloud-runtime/test/fixtures/0032_single_step_runs.sql', import.meta.url), 'utf8'));
  await db.query(`INSERT INTO tenants (tenant_id) VALUES ('empty-tenant')`);
  await db.query(`INSERT INTO mcp_accounts (tenant_id, account_id) VALUES ('default', $1)`, [accountId]);
});
afterAll(async () => { await t?.drop(); });

const grants = new Map<string, string>();
async function grantFor(clientId: string) {
  let grant = grants.get(clientId);
  if (!grant) {
    grant = 'grt_' + tag(); grants.set(clientId, grant);
    await db.query(`INSERT INTO mcp_oauth_grants (tenant_id, grant_id, account_id, client_id, client_name, scopes, resource)
      VALUES ('default', $1, $2, $3, 'ChatGPT', ARRAY['flofi.approval'], 'https://flofi.example/mcp')`, [grant, accountId, clientId]);
  }
  return grant;
}
type Kind = 'MCP_ACCOUNT' | 'DEVELOPER_PROJECT' | 'CHANNEL_CONVERSATION' | 'AUTOMATION_RULE' | 'EDITOR_SESSION';
type HandoffSeed = { kind: Kind; clientId: string; environment?: string | undefined; plan?: Record<string, unknown>; runIds?: string[]; createdAt?: Date };
/** An approval handoff, inserted as the stores write it (the client name is deliberately misleading: it must never matter). */
async function handoff(seed: HandoffSeed): Promise<string> {
  const id = 'apr_' + tag(), createdAt = seed.createdAt ?? ago(2);
  let requesterId: string | null = null, context: Record<string, unknown> = {}, grant: string | null = null;
  if (seed.kind === 'MCP_ACCOUNT') grant = await grantFor(seed.clientId);
  else if (seed.kind === 'DEVELOPER_PROJECT') {
    const project = 'prj_' + tag(), strategy = 'str_' + tag();
    await db.query(`INSERT INTO developer_projects (tenant_id, project_id, display_name) VALUES ('default', $1, 'Fixture')`, [project]);
    await db.query(`INSERT INTO developer_strategies (tenant_id, strategy_id, project_id, environment, strategy, workflow_hash, engine_version, funds_class,
      network_environment, plan) VALUES ('default', $1, $2, 'production', '{}', $3, 'fixture', 'REAL_FUNDS', 'MAINNET', '{}')`, [strategy, project, HASH]);
    requesterId = `${project}.production`; context = { strategyId: strategy };
  } else requesterId = `${seed.kind.toLowerCase().replace('_', '-')}-${tag()}`;
  const environment = seed.environment ?? 'MAINNET';
  await db.query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind, requester_id, requester_context, account_id, grant_id, client_id, client_name,
      secret_digest, strategy, workflow_hash, engine_version, network_environment, funds_class, plan, status, claimed_namespace, claimed_address, claimed_at,
      claim_expires_at, applied_at, run_ids, expires_at, created_at)
    VALUES ('default', $1, $2, $3, $4, $5, $6, $7, 'ChatGPT', $8, '{}', $9, 'fixture', $10, $11, $12, 'APPLIED', 'eip155', $13, $14, $14, $14, $15, $16, $14)`,
  [id, seed.kind, requesterId, context, seed.kind === 'MCP_ACCOUNT' ? accountId : null, grant, seed.clientId, randomBytes(32), HASH, environment,
    environment === 'MAINNET' ? 'REAL_FUNDS' : 'TEST_FUNDS', seed.plan ?? { kind: 'SINGLE_FLOW', flow: 'base-swap' }, OWNER, createdAt, seed.runIds ?? [],
    new Date(createdAt.getTime() + DAY)]);
  return id;
}
type StepSeed = { state: string; kind?: 'OWNER_RUN' | 'USER_FUNDED_GROUP' | 'DELEGATED_STEP'; executionId?: string; environment?: string };
/** A workflow run as the runner leaves it (inserted directly in its final state: the transition triggers only guard updates). */
async function workflowRun(seed: { kind: Kind; clientId: string; environment?: string; state?: string; steps?: StepSeed[]; createdAt?: Date;
  mode?: string }): Promise<string> {
  const createdAt = seed.createdAt ?? ago(2), steps = seed.steps ?? [{ state: 'RECONCILED' }, { state: 'RECONCILED' }];
  const h = await handoff({ kind: seed.kind, clientId: seed.clientId, environment: seed.environment, plan: { kind: 'SEQUENTIAL', flow: null }, createdAt });
  const ref = (await db.query<{ ref: string }>(`SELECT requester_ref AS ref FROM mcp_handoffs WHERE handoff_id = $1`, [h])).rows[0]!.ref;
  const id = 'wfr_' + tag(), state = seed.state ?? 'COMPLETED';
  await db.query(`INSERT INTO workflow_runs (tenant_id, run_id, handoff_id, requester_kind, requester_ref, owner_namespace, owner_account, wallets, strategy,
      workflow_hash, engine_version, step_count, mode, state, completed_at, expires_at, created_at, updated_at)
    VALUES ('default', $1, $2, $3, $4, 'eip155', $5, jsonb_build_object('eip155', $5::text), '{}', $6, 'fixture', $7, $8, $9, $10, $11, $12, $12)`,
  [id, h, seed.kind, ref, OWNER, HASH, steps.length, seed.mode ?? 'USER_FUNDED', state, state === 'COMPLETED' ? createdAt : null, new Date(createdAt.getTime() + DAY), createdAt]);
  for (const [index, step] of steps.entries()) {
    const outcome = step.state === 'RECONCILED' || step.executionId ? { kind: step.kind ?? 'USER_FUNDED_GROUP', executionId: step.executionId ?? `${id}:g0`,
      evidence: { outcome: 'RECONCILED', ...step.environment ? { environment: step.environment } : {} } } : null;
    await db.query(`INSERT INTO workflow_run_steps (tenant_id, run_id, step_index, state, flow, strategy, workflow_hash, outcome)
      VALUES ('default', $1, $2, $3, 'base-swap', '{}', $4, $5)`, [id, index, step.state, HASH, outcome]);
  }
  return id;
}
type RunSeed = { flow?: string; status?: string; provenance?: string; createdAt?: Date; recoveryOf?: string; workflowId?: string; needsObservation?: boolean;
  attempts?: { state: string; hash?: boolean; reconciled?: boolean }[]; tenant?: string };
/** One execution_runs projection row (with its log and workflow rows), as the flow projectors write it. */
async function run(runId: string, seed: RunSeed = {}): Promise<string> {
  const tenant = seed.tenant ?? 'default', flow = seed.flow ?? 'base-swap', status = seed.status ?? 'RECONCILED', name = `${runId}.jsonl`;
  const workflowId = seed.workflowId ?? `wf-${runId}`, createdAt = seed.createdAt ?? ago(2);
  const attempts = seed.attempts ?? (status === 'RECONCILED' ? [{ state: 'CONFIRMED', hash: true, reconciled: true }] : []);
  await db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [tenant, workflowId]);
  await db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256) VALUES ($1, $2, $3, 'RUN', 1, 1, 2, $4)`,
    [tenant, flow, name, 'b'.repeat(64)]);
  await db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, recovery_of, needs_observation, has_evidence,
      log_version, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $3, $6, $7, $8, $9, $10, 1, $11, $11)`,
  [tenant, runId, flow, name, workflowId, status, seed.provenance ?? 'PUBLIC_MAINNET', seed.recoveryOf ?? null, seed.needsObservation ?? false,
    status === 'RECONCILED', createdAt]);
  for (const [i, attempt] of attempts.entries())
    await db.query(`INSERT INTO execution_attempts (tenant_id, attempt_id, run_id, step, state, transaction_hash, reconciled) VALUES ($1, $2, $3, 'MAIN', $4, $5, $6)`,
      [tenant, `${runId}.${i}`, runId, attempt.state, attempt.hash ? '0x' + (seq++ % 16).toString(16).repeat(64) : null, attempt.reconciled ?? false]);
  return runId;
}

const counts = async (period: 'today' | '7d' | '30d' | 'all', tenantId = 'default'): Promise<ChannelCounts> => {
  const result = await loadChannelCounts({ db, tenantId }, { period: channelPeriod(period, NOW) });
  if (!result.ok) throw new Error(result.code);
  return result.value;
};
const zero = { FLOFI_WEB: 0, CHATGPT_MCP: 0, CLAUDE_MCP: 0, TELEGRAM: 0, DEVELOPER_API: 0, MCP_UNIDENTIFIED: 0, UNKNOWN: 0 };

describe('BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 completed executions by channel (PostgreSQL)', () => {
  it('counts each completed and reconciled run once, by the channel its trusted records name', async () => {
    expect((await counts('all', 'empty-tenant')).byEnvironment.MAINNET).toEqual({ counts: zero, total: 0, automation: 0 });

    // Workflow runs, one per requester kind; a Batch Payment-shaped run of 8 steps (one wallet group each) is ONE run.
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor' });
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', steps: Array.from({ length: 8 }, () => ({ state: 'RECONCILED' })) });
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', steps: [{ state: 'RECONCILED' }] }); // a one-step Editor run (single card)
    // An owner-signed run of an MCP workflow: its two step executions are counted through it, never again as single flows.
    await run('own-1'); await run('own-2');
    await workflowRun({ kind: 'MCP_ACCOUNT', clientId: CHATGPT, mode: 'CONFIRM_EACH_STEP', steps: [{ state: 'RECONCILED', kind: 'OWNER_RUN', executionId: 'own-1' },
      { state: 'RECONCILED', kind: 'OWNER_RUN', executionId: 'own-2' }] });
    await workflowRun({ kind: 'MCP_ACCOUNT', clientId: CLAUDE });
    await workflowRun({ kind: 'CHANNEL_CONVERSATION', clientId: 'telegram:123456789' });
    // A live developer workflow run: its step ran under the server-assigned `wfr_…-step-0` workflow id.
    const developer = await workflowRun({ kind: 'DEVELOPER_PROJECT', clientId: 'prj_fixture', mode: 'CONFIRM_EACH_STEP' });
    await run('dev-step', { workflowId: `${developer}-step-0` });
    await workflowRun({ kind: 'MCP_ACCOUNT', clientId: DCR }); // a dynamically registered client, whatever it calls itself
    await workflowRun({ kind: 'AUTOMATION_RULE', clientId: 'flofi-automations' });
    // Not completed, or not credibly so: never counted. A halted run's reconciled step execution is not a completed workflow either.
    await run('own-halted');
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', state: 'HALTED', steps: [{ state: 'RECONCILED', kind: 'OWNER_RUN', executionId: 'own-halted' },
      { state: 'PENDING' }], mode: 'CONFIRM_EACH_STEP' });
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', state: 'RUNNING', steps: [{ state: 'RECONCILED' }, { state: 'DELEGATED' }] });
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', steps: [{ state: 'RECONCILED' }, { state: 'UNCERTAIN' }] });
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', environment: 'PUBLIC_TESTNET' });
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', environment: 'MOCK' });
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', createdAt: ago(40) });
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', createdAt: MIDNIGHT });
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', createdAt: new Date(MIDNIGHT.getTime() - 1) });

    // Single flows bound to their approval (`run_ids`, written server-side).
    await handoff({ kind: 'MCP_ACCOUNT', clientId: CHATGPT, runIds: [await run('sf-chatgpt')] });
    // A recovery belongs to the execution it recovers: the binding of the recovery run attributes the one execution.
    await run('sf-claude', { status: 'INCONCLUSIVE', attempts: [{ state: 'SUBMISSION_RESULT_UNKNOWN', hash: true }] });
    await handoff({ kind: 'MCP_ACCOUNT', clientId: CLAUDE, runIds: [await run('sf-claude-r', { recoveryOf: 'sf-claude', createdAt: ago(1.5) })] });
    // Several attempts of one run (cancelled, reverted, then confirmed) are one execution.
    await handoff({ kind: 'CHANNEL_CONVERSATION', clientId: 'telegram:123456789', runIds: [await run('sf-telegram', { attempts: [{ state: 'CANCELLED' },
      { state: 'REVERTED', hash: true }, { state: 'CONFIRMED', hash: true, reconciled: true }] })] });
    await run('sf-conflict');
    await handoff({ kind: 'MCP_ACCOUNT', clientId: CHATGPT, runIds: ['sf-conflict'] });
    await handoff({ kind: 'CHANNEL_CONVERSATION', clientId: 'telegram:123456789', runIds: ['sf-conflict'] });
    await run('sf-same');
    await handoff({ kind: 'MCP_ACCOUNT', clientId: CHATGPT, runIds: ['sf-same'] });
    await handoff({ kind: 'MCP_ACCOUNT', clientId: 'https://chatgpt.com/oauth/other/client.json', runIds: ['sf-same'] });
    await handoff({ kind: 'AUTOMATION_RULE', clientId: 'flofi-automations', runIds: [await run('sf-auto')] });
    // Unbound single flows (no record names them): Unknown origin, however old or recent.
    await run('sf-unbound-old', { createdAt: ago(10) });
    await run('sf-unbound-recent', { createdAt: ago(3) });
    await run('sf-testnet', { provenance: 'PUBLIC_TESTNET' });
    // Never completed: failed, uncertain, still observed, simulated only.
    await run('sf-failed', { status: 'REVERTED', attempts: [{ state: 'REVERTED', hash: true }] });
    await run('sf-uncertain', { status: 'INCONCLUSIVE', attempts: [{ state: 'SUBMISSION_RESULT_UNKNOWN', hash: true }] });
    await run('sf-observing', { status: 'RECONCILED', needsObservation: true });
    await run('sf-simulated', { status: 'SIMULATED' });

    // FloFi Web: the five Editor workflow runs of the period (two-step, 8-step, one-step, today's and yesterday's), never an unbound single flow.
    // Unknown origin: the conflicting binding and both unbound single flows.
    const month = await counts('30d');
    expect(month.byEnvironment.MAINNET).toEqual({ counts: { FLOFI_WEB: 5, CHATGPT_MCP: 3, CLAUDE_MCP: 2, TELEGRAM: 2, DEVELOPER_API: 1, MCP_UNIDENTIFIED: 1, UNKNOWN: 3 },
      total: 17, automation: 2 });
    expect(month.byEnvironment.TESTNET).toEqual({ counts: { ...zero, FLOFI_WEB: 1, UNKNOWN: 1 }, total: 2, automation: 0 });
    expect(month.byEnvironment.MOCKED).toEqual({ counts: zero, total: 0, automation: 0 });
    expect(month).toMatchObject({ unrecognizedEnvironment: 1, workflowRunsTruncated: false, coverage: { truncated: false } });
    expect(JSON.stringify(month)).not.toMatch(/0x[0-9a-f]{40}|apr_|wfr_|mcpacct_|grt_|chatgpt\.com|claude\.ai|sf-|own-/);

    // Periods: an execution belongs to the period it started in; Today starts at UTC midnight (inclusive).
    expect((await counts('today')).byEnvironment.MAINNET).toEqual({ counts: { ...zero, FLOFI_WEB: 1 }, total: 1, automation: 0 });
    expect((await counts('7d')).byEnvironment.MAINNET.counts).toMatchObject({ FLOFI_WEB: 5, UNKNOWN: 2 });
    expect((await counts('all')).byEnvironment.MAINNET).toMatchObject({ counts: { FLOFI_WEB: 6, UNKNOWN: 3 }, total: 18 });
  });

  it('counts FloFi Web only from positive records, a Batch Payment once, and a bound one-step run only while its approval exists', async () => {
    const before = (await counts('all')).byEnvironment.MAINNET;
    // Unbound one-step executions, very old and a minute old: Unknown origin, whatever their time.
    await run('one-step-unbound-old', { createdAt: ago(400) });
    await run('one-step-unbound-new', { createdAt: new Date(NOW.getTime() - 60_000) });
    // An Editor workflow run is FloFi Web; an 8-recipient Batch Payment (eight legs, one wallet group) is ONE completed run, counted once.
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', steps: [{ state: 'RECONCILED' }], createdAt: ago(1) });
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', steps: Array.from({ length: 8 }, () => ({ state: 'RECONCILED' })), createdAt: ago(1) });
    // The rule for a one-step run an Editor approval recorded: FloFi Web. This fixture is seeded directly; no current code records one (Editor
    // approvals are SEQUENTIAL, and run_ids is written only for single-flow plans). One an MCP approval recorded keeps that approval's channel.
    await handoff({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', createdAt: ago(1), runIds: [await run('one-step-editor', { createdAt: ago(0.9) })] });
    await handoff({ kind: 'MCP_ACCOUNT', clientId: CHATGPT, createdAt: ago(1), runIds: [await run('one-step-mcp', { createdAt: ago(0.9) })] });
    // A one-step run whose approval was removed (retention) has no record left: Unknown origin.
    const removed = await handoff({ kind: 'MCP_ACCOUNT', clientId: CLAUDE, createdAt: ago(1), runIds: [await run('one-step-removed', { createdAt: ago(0.9) })] });
    const recorded = (await counts('all')).byEnvironment.MAINNET;
    expect(recorded).toEqual({ counts: { ...before.counts, FLOFI_WEB: before.counts.FLOFI_WEB + 3, CHATGPT_MCP: before.counts.CHATGPT_MCP + 1,
      CLAUDE_MCP: before.counts.CLAUDE_MCP + 1, UNKNOWN: before.counts.UNKNOWN + 2 }, total: before.total + 7, automation: before.automation });
    await db.query(`DELETE FROM mcp_handoffs WHERE tenant_id = 'default' AND handoff_id = $1`, [removed]);
    expect((await counts('all')).byEnvironment.MAINNET).toEqual({ ...recorded, counts: { ...recorded.counts, CLAUDE_MCP: recorded.counts.CLAUDE_MCP - 1,
      UNKNOWN: recorded.counts.UNKNOWN + 1 } });
  });

  it('counts a workflow run whose steps carry MOCKED evidence under Mocked, as its one-step runs are, never under its approval\'s Mainnet', async () => {
    const before = await counts('all');
    expect(before.byEnvironment.MOCKED).toEqual({ counts: zero, total: 0, automation: 0 });
    // A harness deployment (`*_HARNESS=MOCKED_LOOPBACK_ONLY`): an MCP confirm-each-step run on a Mainnet approval whose owner-signed steps
    // reconciled with MOCKED evidence (their own runs have MOCKED provenance and are counted only through the workflow run).
    await run('mock-own-1', { provenance: 'MOCKED' }); await run('mock-own-2', { provenance: 'MOCKED' });
    await workflowRun({ kind: 'MCP_ACCOUNT', clientId: CHATGPT, mode: 'CONFIRM_EACH_STEP', steps: [
      { state: 'RECONCILED', kind: 'OWNER_RUN', executionId: 'mock-own-1', environment: 'MOCKED' },
      { state: 'RECONCILED', kind: 'OWNER_RUN', executionId: 'mock-own-2', environment: 'MOCKED' }] });
    // An Editor run whose delegated step had MOCKED provenance, next to a step with public evidence: one MOCKED step makes the run Mocked.
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', steps: [{ state: 'RECONCILED', environment: 'PUBLIC_UNVERIFIED' },
      { state: 'RECONCILED', kind: 'DELEGATED_STEP', executionId: 'dex_fixture', environment: 'MOCKED' }] });
    // A one-step harness run an MCP approval bound: Mocked, by its own provenance.
    await handoff({ kind: 'MCP_ACCOUNT', clientId: CHATGPT, runIds: [await run('mock-one-step', { provenance: 'MOCKED' })] });
    // A run whose steps carry only public evidence stays under its approval's Mainnet.
    await workflowRun({ kind: 'EDITOR_SESSION', clientId: 'flofi-editor', steps: [{ state: 'RECONCILED', environment: 'PUBLIC_UNVERIFIED' }] });
    const after = await counts('all'), mainnet = before.byEnvironment.MAINNET;
    expect(after.byEnvironment.MAINNET).toEqual({ ...mainnet, counts: { ...mainnet.counts, FLOFI_WEB: mainnet.counts.FLOFI_WEB + 1 }, total: mainnet.total + 1 });
    expect(after.byEnvironment.MOCKED).toEqual({ counts: { ...zero, FLOFI_WEB: 1, CHATGPT_MCP: 2 }, total: 3, automation: 0 });
    expect(after.byEnvironment.TESTNET).toEqual(before.byEnvironment.TESTNET);
    expect(after.unrecognizedEnvironment).toBe(before.unrecognizedEnvironment);
  });
});
