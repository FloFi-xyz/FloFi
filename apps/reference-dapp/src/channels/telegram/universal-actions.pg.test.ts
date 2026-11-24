// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNELS-001: the one-tap actions under a Telegram approval message, end to end at the HTTP boundary on a disposable
 * loopback PostgreSQL (MOCKED owner flows, Bot API double): the approval message keeps its one URL button and adds callback actions (status, add
 * another action, cancel) that run exactly their typed commands; and a proposal the owner already APPLIED in FloFi's signing flow (it may have run)
 * is never carried into a new workflow, never edited here and never reported as cancelled. The owner's claim and apply use the real platform path.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { applyApproval, claimApproval, type WalletRef } from '../../platform/index.ts';
import { approvalSurface } from '../../server/approval-surface.ts';
import { ownerFlowRuntime } from '../../workflow-runs/workflow-run.test-harness.ts';
import { botApi, callbackUpdate, telegramEnv, telegramRequest, textUpdate } from './fixtures.test-harness.ts';
import { handleTelegramWebhook } from './handler.ts';

const OWNER = '0x1111111111111111111111111111111111111111';
const SWAP = 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps', BRIDGE = (amount: string) => `bridge ${amount} USDC from Base Sepolia to Arbitrum Sepolia via auto slippage 50 bps`;
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
const evm = (address: string): WalletRef => ({ namespace: 'eip155', address });
const secretOf = (url: string) => decodeURIComponent(new URL(url).hash.slice(1));

async function deployment() {
  const tenantId = `ua-${randomBytes(6).toString('hex')}`;
  await t.db.query('INSERT INTO tenants (tenant_id) VALUES ($1)', [tenantId]);
  const token = randomBytes(24).toString('base64url'), tg = telegramEnv();
  const env = { ...tg.env, TENANT_ID: tenantId, FLOFI_WORKFLOW_RUNS: 'enabled', FLOFI_CHANNEL_DISPATCH_TOKEN_SHA256: createHash('sha256').update(token).digest('hex') };
  const api = botApi(), host = { db: t.db, tenantId }, now = () => new Date();
  const flows = ownerFlowRuntime(['base-sepolia-swap', 'crosschain-router-testnet'], { enabled: true, delegation: null }, now);
  const common = { env, host, runtime: flows.runtime, interpreter: null, now, sleep: async () => undefined, random: () => 0.5 };
  const post = async (update: unknown) => { const r = await handleTelegramWebhook(telegramRequest(update, tg.webhookSecret), { ...common, fetch: api.fetch }); expect(r.status).toBe(200); };
  const surface = () => approvalSurface(env, () => undefined, { host, runtime: flows.runtime });
  /** The owner proves their wallet on /approve and loads the proposal into FloFi's signing flow (APPLIED): it may run from here on. */
  const ownerApplies = async (link: string) => {
    const claimed = await claimApproval(await surface(), secretOf(link), [evm(OWNER)], true);
    await applyApproval(await surface(), secretOf(link), [evm(OWNER)], claimed.workflow);
    return claimed.view.approvalId;
  };
  /** The owner proves their wallet and claims the proposal only (a multi-step run starts here; the handoff still reads CLAIMED). */
  const ownerClaims = async (link: string) => (await claimApproval(await surface(), secretOf(link), [evm(OWNER)], true)).view.approvalId;
  const handoffs = async () => (await t.db.query(`SELECT handoff_id, status, strategy FROM mcp_handoffs WHERE tenant_id = $1 ORDER BY created_at`, [tenantId]))
    .rows as { handoff_id: string; status: string; strategy: unknown }[];
  return { api, say: (text: string) => post(textUpdate(text)), tap: (data: string) => post(callbackUpdate(data)), ownerApplies, ownerClaims, handoffs };
}
type Keyboard = { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] };
const keyboardOf = (call: { params: Record<string, unknown> }) => {
  const markup = call.params.reply_markup;
  return (typeof markup === 'string' ? JSON.parse(markup) : markup) as Keyboard | undefined;
};
const actions = (strategy: unknown) => JSON.stringify(strategy).match(/"action":"[a-z_]+"/g) ?? [];

describe('BUILD-FLOFI-UNIVERSAL-CHANNELS-001 Telegram approval actions (PostgreSQL, Bot API double, MOCKED owner flows)', () => {
  it('the approval message has the URL button first, then status / add another action / cancel; taps run the typed commands', async () => {
    const d = await deployment();
    await d.say(SWAP);
    const approval = [...d.api.delivered()].reverse().find(call => keyboardOf(call)?.inline_keyboard[0]?.[0]?.url)!;
    const keyboard = keyboardOf(approval)!;
    expect(keyboard.inline_keyboard[0]).toEqual([{ text: 'Authorize', url: expect.stringMatching(/\/approve#flofi_chs_/) }]);
    expect(keyboard.inline_keyboard.slice(1).flat().map(b => [b.text, b.callback_data])).toEqual([['Check status', 'act:status'], ['Add another action', 'act:add'],
      ['Cancel request', 'act:cancel']]);
    const replies = d.api.texts().length;
    await d.tap('act:status');
    expect(d.api.texts().length).toBeGreaterThan(replies);
    await d.tap('act:cancel');
    expect(d.api.texts().at(-1)).toMatch(/^Cancelled\. The previous approval link no longer works\./);
    expect((await d.handoffs()).map(h => h.status)).toEqual(['REVOKED']);
  });

  it('add another action after the owner APPLIED the proposal starts a new, separate workflow: the applied step is never proposed again', async () => {
    const d = await deployment();
    await d.say(SWAP);
    await d.ownerApplies(d.api.lastLink()!);
    await d.tap('act:add');
    expect(d.api.texts().at(-1)).toMatch(/already in your FloFi signing flow, so it may have run\. Its steps will not be added again/);
    await d.say(BRIDGE('5'));
    const [first, second] = await d.handoffs();
    expect([first!.status, second!.status]).toEqual(['APPLIED', 'PENDING']);
    expect(actions(second!.strategy)).toEqual(['"action":"bridge"']);
  });

  it('a kept step of an APPLIED workflow is dropped from the next proposal; editing or cancelling an APPLIED request is refused, never reported done', async () => {
    const d = await deployment();
    await d.say(SWAP);
    await d.say('add step');
    await d.say(BRIDGE('5'));
    expect(actions((await d.handoffs()).at(-1)!.strategy)).toEqual(['"action":"swap"', '"action":"bridge"']);
    await d.ownerApplies(d.api.lastLink()!);
    // A new last step is proposed alone: the applied workflow's kept swap is never part of it.
    await d.say('swap 2 USDC to WETH on Base Sepolia slippage 50 bps');
    expect(d.api.texts().at(-1)).toContain('Your earlier workflow is already in your signing flow; its steps are not included again.');
    const latest = (await d.handoffs()).at(-1)!;
    expect(actions(latest.strategy)).toEqual(['"action":"swap"']);
    expect(JSON.stringify(latest.strategy)).toContain('"amount":"2"');
    await d.ownerApplies(d.api.lastLink()!);
    await d.tap('act:cancel');
    expect(d.api.texts().at(-1)).toMatch(/already in your FloFi signing flow, so it cannot be cancelled here/);
    expect((await d.handoffs()).map(h => h.status)).toEqual(['REVOKED', 'APPLIED', 'APPLIED']);
  });

  it('editing the step list of an APPLIED proposal is refused here and proposes nothing', async () => {
    const d = await deployment();
    await d.say(SWAP);
    await d.ownerApplies(d.api.lastLink()!);
    await d.say('remove step 1');
    expect(d.api.texts().at(-1)).toMatch(/already in your FloFi signing flow, so it cannot be edited here/);
    expect((await d.handoffs()).map(h => h.status)).toEqual(['APPLIED']);
  });

  it('a claimed multi-step workflow whose run started is in the signing flow even while its handoff reads CLAIMED: never withdrawn or carried forward', async () => {
    const d = await deployment();
    await d.say(SWAP);
    await d.say('add step');
    await d.say(BRIDGE('5'));
    await d.ownerClaims(d.api.lastLink()!);
    expect((await d.handoffs()).map(h => h.status)).toEqual(['REVOKED', 'CLAIMED']);
    await d.tap('act:add');
    expect(d.api.texts().at(-1)).toMatch(/already in your FloFi signing flow, so it may have run/);
    await d.say('swap 2 USDC to WETH on Base Sepolia slippage 50 bps');
    const all = await d.handoffs();
    // The claimed workflow keeps its state (its run continues for the owner); the new request is only the new swap.
    expect(all.map(h => h.status)).toEqual(['REVOKED', 'CLAIMED', 'PENDING']);
    expect(actions(all.at(-1)!.strategy)).toEqual(['"action":"swap"']);
  });

  it('LINK never re-proposes a proposal already APPLIED in the signing flow', async () => {
    const d = await deployment();
    await d.say(SWAP);
    await d.ownerApplies(d.api.lastLink()!);
    await d.say('link');
    expect(d.api.texts().at(-1)).toMatch(/A new link would propose it again, so none was sent/);
    expect((await d.handoffs()).map(h => h.status)).toEqual(['APPLIED']);
  });
});
