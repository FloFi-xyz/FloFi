// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: a multi-step workflow from a Telegram conversation, end to end on a disposable loopback PostgreSQL through the real webhook
 * handler, Channel Core, approval surface, workflow run store and scheduled dispatch. The chat authors the steps (ADD STEP), receives ONE approval
 * link with the authorization count, the owner claims and signs each step in FloFi (the owner's flow runs are recorded by the isolated
 * flow-runtime test double), and the chat hears each reconciled step, "step 2 is ready" with the continuation link, and the completion. LINK
 * never restarts a running workflow. Evidence MOCKED; nothing leaves the process.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { applyApproval, claimApproval, workflowRunContinue, type WalletRef } from '../../platform/index.ts';
import { approvalSurface } from '../../server/approval-surface.ts';
import { createPgWorkflowRunStore } from '../../workflow-runs/pg-store.ts';
import { advanceRun } from '../../workflow-runs/runner.ts';
import { ownerFlowRuntime } from '../../workflow-runs/workflow-run.test-harness.ts';
import { handleChannelDispatch } from '../dispatch-http.ts';
import { botApi, telegramEnv, telegramRequest, textUpdate } from './fixtures.test-harness.ts';
import { handleTelegramWebhook } from './handler.ts';

const OWNER = '0x1111111111111111111111111111111111111111';
const SWAP = 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps', BRIDGE = 'bridge 5 USDC from Base Sepolia to Arbitrum Sepolia via auto slippage 50 bps';
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
const evm = (address: string): WalletRef => ({ namespace: 'eip155', address });

async function deployment() {
  const tenantId = `wf-${randomBytes(6).toString('hex')}`;
  await t.db.query('INSERT INTO tenants (tenant_id) VALUES ($1)', [tenantId]);
  const token = randomBytes(24).toString('base64url'), tg = telegramEnv();
  const env = { ...tg.env, TENANT_ID: tenantId, FLOFI_WORKFLOW_RUNS: 'enabled', FLOFI_CHANNEL_DISPATCH_TOKEN_SHA256: createHash('sha256').update(token).digest('hex') };
  const api = botApi(), host = { db: t.db, tenantId };
  const now = () => new Date();
  const flows = ownerFlowRuntime(['base-sepolia-swap', 'crosschain-router-testnet'], { enabled: true, delegation: null }, now);
  const common = { env, host, runtime: flows.runtime, interpreter: null, now, sleep: async () => undefined, random: () => 0.5 };
  const say = async (text: string) => { const r = await handleTelegramWebhook(telegramRequest(textUpdate(text), tg.webhookSecret), { ...common, fetch: api.fetch }); expect(r.status).toBe(200); };
  const sweep = async () => { const r = await handleChannelDispatch(new Request('http://127.0.0.1:3100/api/channels/dispatch', { headers: { authorization: `Bearer ${token}` } }),
    { ...common, seams: { telegramFetch: api.fetch } }); expect(r.status).toBe(200); };
  const surface = () => approvalSurface(env, () => undefined, { host, runtime: flows.runtime });
  const store = createPgWorkflowRunStore(t.db, tenantId);
  /** What the deployment's worker does between dispatches: it observes the owner's step runs (read-only) and advances the run. */
  const worker = (runId: string) => advanceRun({ store, runtime: flows.runtime, delegation: null, policyFor: () => null, now, log: () => undefined }, runId);
  return { env, api, flows, say, sweep, surface, store, worker, tenantId };
}

describe('BUILD-CHAT-E2E-001 Telegram multi-step workflow (PostgreSQL, Bot API double, MOCKED flows)', () => {
  it('authors steps in chat, hands ONE approval to the owner, follows each step to completion and never restarts a running workflow', async () => {
    const d = await deployment();
    await d.say(SWAP);
    const singleLink = d.api.lastLink()!;
    await d.say('add step');
    expect(d.api.texts().at(-1)).toMatch(/^Step 1 kept\. Describe step 2/);
    await d.say(BRIDGE);
    const ready = d.api.texts().at(-1)!, link = d.api.lastLink()!;
    expect(link).not.toBe(singleLink);
    expect(ready).toMatch(/1\. [\s\S]*2\. /);
    expect(ready).toContain('Authorizations: at least 2 wallet confirmations in FloFi — one per step');
    expect(ready).toContain('One authorization is not one transaction');
    // The one-step link sent before ADD STEP no longer works: the first step can never run alone and then again in the workflow.
    const secretOf = (url: string) => decodeURIComponent(new URL(url).hash.slice(1));
    expect(await claimApproval(await d.surface(), secretOf(singleLink), [evm(OWNER)], true).then(() => 'CLAIMED', e => (e as Error).message)).toBe('HANDOFF_REVOKED');

    // The owner claims the workflow in FloFi (wallet proof) and signs step 1 in the signing surface.
    const secret = secretOf(link);
    const claimed = await claimApproval(await d.surface(), secret, [evm(OWNER)], true);
    expect(claimed.view.workflowRun).toMatchObject({ run: { state: 'RUNNING', mode: 'CONFIRM_EACH_STEP' }, step: { index: 0, count: 2 } });
    await applyApproval(await d.surface(), secret, [evm(OWNER)], claimed.workflow);
    d.flows.ownerExecutes('base-sepolia-swap', OWNER, claimed.workflow, 'RECONCILED');
    const run = (await d.store.byHandoff(claimed.view.approvalId))!;
    await d.worker(run.runId);
    await d.sweep();
    const notices = d.api.texts().slice(-3);
    expect(notices.some(text => /1\. Swap — reconciled ✅ · tx 0x[0-9a-f]{4}…[0-9a-f]{4}/.test(text))).toBe(true);
    expect(notices.some(text => text.startsWith(`Step 2 is ready for your signature in FloFi: http://127.0.0.1:3100/approve#${claimed.view.approvalId}`))).toBe(true);
    // LINK while the workflow runs never creates a second approval (it would restart from step 1).
    const handoffs = async () => (await t.db.query(`SELECT count(*)::int AS n FROM mcp_handoffs WHERE tenant_id = $1`, [d.tenantId])).rows[0]!.n as number;
    const before = await handoffs();
    await d.say('link');
    expect(d.api.texts().at(-1)).toMatch(/^This workflow is already running\. Continue it in FloFi/);
    expect(await handoffs()).toBe(before);
    await d.say('status');
    expect(d.api.texts().at(-1)).toMatch(/Workflow: running\n1\. Swap — reconciled ✅[\s\S]*\n2\. Bridge — waiting/);

    // Step 2, then the completion reaches the chat once.
    const second = await workflowRunContinue(await d.surface(), claimed.view.approvalId, [evm(OWNER)]);
    expect(second.command).toMatchObject({ type: 'ADD_ROUTER_BRIDGE' });
    d.flows.ownerExecutes('crosschain-router-testnet', OWNER, second.workflow, 'RECONCILED');
    await d.worker(run.runId);
    await d.sweep();
    await d.sweep();
    expect(d.api.texts().filter(text => text === 'Workflow completed: every step reconciled ✅')).toHaveLength(1);
    expect((await d.store.byId(run.runId))!.state).toBe('COMPLETED');
  });
});
