// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHANNELS-001: the Telegram channel meets FloFi's /approve in a real browser, on the embedded PostgreSQL runtime with the MOCKED
 * loopback testnet router and the loopback Bot API double (127.0.0.1:8559; nothing reaches Telegram, never a public network or a real
 * transaction):
 *
 *   the real webhook route under `next start` (a delivery without the secret token refused; /start greets with the first-contact notice)
 *   → an exact bridge command becomes a CHANNEL_CONVERSATION approval after the response, its link sent once in a URL button (read from
 *   the double the way the user's phone shows it) → /approve: "FROM TELEGRAM", nothing authorized, sharing off by default; the owner
 *   proves a wallet, opts in, loads and adds the proposal → the product's own simulation and Strategy Manifest Review, where current
 *   main blocks MOCKED financial authority (no approval, no execution, no wallet transaction) → the scheduled dispatch (bearer only)
 *   reports "loaded in FloFi" to the chat once; STATUS reads the same.
 *
 * The owner's full execution lifecycle (wallet-signed steps, reconciliation, "Execution reconciled ✅ · evidence: MOCKED") is proven
 * by `src/channels/whatsapp/journey.pg.test.ts` on the same Channel Core, as for MCP and the Developer API.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet.ts';
import { E2E_APP_ORIGIN as APP_ORIGIN } from './app-origin';
import { CHANNEL_E2E, CHANNEL_E2E_USER_POOL, channelE2eUsers, TELEGRAM_DOUBLE } from './channel-constants';
import { handoffOfLink, query } from './channel-fixtures';
import { chooseWallet, openSimulationDetails } from './fixtures';
import { guardedContext, installJourneyWallet, journeySends, walletRequests } from './journey-fixtures';
import { assertMcpHarness } from './mcp-fixtures';
import { assertExecutionBlocked } from './release-safety-fixtures';
import { routerControl } from './router-fixtures';

const ROUTE = `${APP_ORIGIN}/api/channels/telegram`, BRIDGE = 'bridge 1 USDC from Base Sepolia to Arbitrum Sepolia via auto slippage 50 bps';
type BotCall = { method: string; params: { chat_id?: string; text?: string; caption?: string; photo?: { mimeType: string; size: number; png: boolean };
  reply_markup?: { inline_keyboard: { text: string; url?: string }[][] } } };
/** This test's own Telegram user (fresh per run and repetition), so /start is always the first exchange of a new conversation. */
const user = () => channelE2eUsers(test.info().repeatEachIndex).telegram;
/** The double's calls to this test's chat only (the dispatch may also deliver what another test's conversation left pending). */
const calls = async (): Promise<BotCall[]> => ((await (await fetch(`${TELEGRAM_DOUBLE}/__flofi/calls`)).json()) as BotCall[])
  .filter(c => String(c.params.chat_id) === String(user()));
/** What the user reads: text messages, and photo captions (BUILD-WORKFLOW-VISUAL-PRESENTATION-001: a proposal is a photo with its text). */
const texts = async () => (await calls()).filter(c => c.method === 'sendMessage' || c.method === 'sendPhoto').map(c => c.params.text ?? c.params.caption ?? '');
let updateId = Math.floor(Date.now() / 1000);
const update = (text: string, from = user()) => ({ update_id: ++updateId, message: { message_id: updateId, date: Math.floor(Date.now() / 1000), text,
  from: { id: from, is_bot: false, first_name: 'Owner' }, chat: { id: from, type: 'private', first_name: 'Owner' } } });
const approval = (page: Page) => page.getByRole('region', { name: 'Proposal from Telegram' });
const bridge = (page: Page) => page.getByRole('region', { name: 'Cross-chain bridge' });
const dispatch = () => fetch(`${APP_ORIGIN}/api/channels/dispatch`, { headers: { authorization: `Bearer ${process.env.FLOFI_E2E_CHANNEL_DISPATCH_TOKEN}` } });

test.describe('BUILD-CHANNELS-001 Telegram → /approve (loopback Bot API double, MOCKED router; MOCKED execution blocked)', () => {
  test.beforeAll(() => { assertMcpHarness(); if (process.env.GRYLOO_CHANNEL_E2E !== CHANNEL_E2E) throw new Error('MOCK_RESET_DENIED'); });

  test('webhook → channel approval → /approve → owner Review (MOCKED blocked) → "loaded" back in the chat by the scheduled dispatch', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const owner = createTestWallet();
    await routerControl('MOCK_reset', [{ network: 'testnet', owner: owner.address, wallets: [] }]);
    await fetch(`${TELEGRAM_DOUBLE}/__flofi/reset`, { method: 'POST' });
    const deliver = (text: string, secret = process.env.FLOFI_E2E_TELEGRAM_WEBHOOK_SECRET!) =>
      request.post(ROUTE, { headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, data: update(text) });

    // 1. The real route under Next: the secret token is required; /start greets with the first-contact notice.
    expect((await request.post(ROUTE, { headers: { 'content-type': 'application/json' }, data: update('/start') })).status()).toBe(401);
    expect((await request.get(ROUTE)).status()).toBe(405);
    const started = await deliver('/start');
    expect([started.status(), await started.json()]).toEqual([200, { ok: true, code: 'ACCEPTED' }]);
    await expect.poll(texts, { timeout: 30_000 }).toEqual([expect.stringMatching(/^FloFi \(automated assistant\)/), expect.stringMatching(/^What I can do/)]);

    // 2. An exact command: a channel approval after the response, its link once in a URL button; "yes" authorizes nothing.
    expect((await deliver(BRIDGE)).status()).toBe(200);
    await expect.poll(async () => (await calls()).some(c => c.params.reply_markup?.inline_keyboard[0]?.[0]?.url), { timeout: 30_000 }).toBe(true);
    const linkCall = (await calls()).find(c => c.params.reply_markup?.inline_keyboard[0]?.[0]?.url)!;
    const url = linkCall.params.reply_markup!.inline_keyboard[0]![0]!.url!;
    expect(url).toMatch(new RegExp(`^${APP_ORIGIN.replace(/[.]/g, '\\.')}/approve#flofi_chs_[A-Za-z0-9_-]{43}$`));
    // BUILD-WORKFLOW-VISUAL-PRESENTATION-001: the proposal is one photo — the workflow PNG, its text as caption, the same Open FloFi button.
    expect(linkCall.method).toBe('sendPhoto');
    expect(linkCall.params.photo).toMatchObject({ mimeType: 'image/png', png: true });
    expect(linkCall.params.caption).toMatch(/^Strategy ready:[\s\S]*Nothing is authorized yet/);
    // The handoff is the one this link belongs to (never "the latest Telegram one": other specs and runs share the database).
    const handoff = await handoffOfLink(url);
    expect(handoff).toMatchObject({ requester_kind: 'CHANNEL_CONVERSATION', account_id: null, grant_id: null, client_name: 'Telegram', status: 'PENDING' });
    await deliver('yes, execute it');
    await expect.poll(async () => (await texts()).at(-1), { timeout: 30_000 }).toMatch(/^Nothing can be authorized here/);

    // 3. /approve in the owner's browser.
    const { context, unexpected } = await guardedContext(browser);
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await installJourneyWallet(page, [owner]);
    await page.goto(url);
    const region = approval(page);
    await expect(region).toContainText('From Telegram');
    await expect(region).toContainText('Nothing is authorized yet.');
    expect(page.url()).not.toContain('flofi_chs_');
    // BUILD-FLOFI-UX-UI-002: "Open FloFi" lands on the normal Canvas with the bridge card already there; no panel, no Load step.
    await expect(page.locator('.approval-page, .approval-handoff')).toHaveCount(0);
    await expect(page.locator('.build-flow-surface .composer-card').first()).toBeVisible();
    await expect(page.locator('.canvas-primary-action button')).toBeDisabled();
    const evidence = process.env.FLOFI_UX_EVIDENCE ? 'e2e/visual-evidence/flofi-ux-ui-002' : null;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      for (const [width, height] of [[1440, 900], [390, 844]] as const) {
        await page.setViewportSize({ width, height }); await page.mouse.move(0, 0);
        await page.screenshot({ path: `${evidence}/approve-before-proof-${width}.png` });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    // Sharing with the chat stays the owner's opt-in.
    await expect(region.getByRole('checkbox')).not.toBeChecked();
    await region.getByRole('checkbox').check();
    await region.getByRole('button', { name: 'Connect wallet and prove ownership' }).click();
    await chooseWallet(page, 'Browser wallet');
    await expect(region.getByRole('status')).toContainText('Ready for your review.');
    await expect(region.getByRole('button', { name: 'Load proposal' })).toHaveCount(0);
    if (evidence) for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height }); await page.mouse.move(0, 0);
      await page.screenshot({ path: `${evidence}/approve-loaded-${width}.png` });
      if (width === 390) await page.setViewportSize({ width: 1440, height: 900 });
    }
    expect((await query<{ status: string; share_status: boolean }>(`SELECT status, share_status FROM mcp_handoffs WHERE handoff_id = $1`, [handoff.handoff_id]))[0])
      .toEqual({ status: 'APPLIED', share_status: true });

    // 4. The product's own simulation and Strategy Manifest Review; MOCKED financial authority cannot be approved or executed.
    await page.getByRole('button', { name: 'Simulate workflow', exact: true }).click();
    await openSimulationDetails(page);
    await expect(bridge(page)).toContainText('Strategy Manifest');
    await expect(page.getByRole('button', { name: 'Approve & Continue', exact: true })).toBeDisabled();
    await expect(page.locator('.review-authorization-details')).toContainText('A simulation that can authorize this workflow is required before approval.');
    await assertExecutionBlocked(page, journeySends);
    expect(await walletRequests(page)).not.toContain('eth_sendTransaction');
    expect(await journeySends()).toBe(0);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();

    // 5. The scheduled dispatch reports progress to the chat, once (no page needs to stay open); a wrong bearer gets nothing.
    expect((await fetch(`${APP_ORIGIN}/api/channels/dispatch`, { headers: { authorization: 'Bearer not-the-scheduler-token-xx' } })).status).toBe(401);
    const loaded = () => query<{ status: string; body: boolean }>(`SELECT status, body_ciphertext IS NOT NULL AS body FROM channel_outbox WHERE kind = 'NOTIFICATION'
      AND dedupe_key = $1`, [`notify:${handoff.handoff_id}:loaded`]);
    // The /approve ping may already have sent it; the dispatch sends it if not, and never twice.
    expect((await dispatch()).status).toBe(200);
    await expect.poll(loaded, { timeout: 30_000 }).toEqual([{ status: 'SENT', body: false }]);
    expect((await dispatch()).status).toBe(200);
    expect((await texts()).filter(t => /^Your proposal is loaded in FloFi/.test(t))).toHaveLength(1);
    await deliver('status');
    await expect.poll(async () => (await texts()).at(-1), { timeout: 30_000 }).toMatch(/^Proposal in a FloFi workflow/);
    // Nothing a chat received carries calldata, a full address, a key or the link's secret again.
    const all = (await texts()).join('\n');
    expect(all).not.toMatch(/0x[0-9a-fA-F]{20,}|calldata|flofi_chs_/);
  });

  // BUILD-FLOFI-UX-UI-002: "Open FloFi" for an owner who is already signed in to FloFi; an expired link; a refresh after loading.
  test('a signed-in owner lands on the populated Canvas and loads the proposal with no further signature; replaced links and refreshes stay safe', async ({ browser, request }) => {
    test.setTimeout(120_000);
    // Its own allowlisted synthetic user (counted down from the pool's end), so this conversation never meets the first test's.
    const me = channelE2eUsers(CHANNEL_E2E_USER_POOL - 1 - test.info().repeatEachIndex).telegram;
    const owner = createTestWallet();
    await routerControl('MOCK_reset', [{ network: 'testnet', owner: owner.address, wallets: [] }]);
    const mine = async (): Promise<BotCall[]> => ((await (await fetch(`${TELEGRAM_DOUBLE}/__flofi/calls`)).json()) as BotCall[]).filter(c => String(c.params.chat_id) === String(me));
    const linkFor = async (text: string) => {
      const before = (await mine()).filter(c => c.params.reply_markup?.inline_keyboard[0]?.[0]?.url).length;
      expect((await request.post(ROUTE, { headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.FLOFI_E2E_TELEGRAM_WEBHOOK_SECRET! },
        data: update(text, me) })).status()).toBe(200);
      await expect.poll(async () => (await mine()).filter(c => c.params.reply_markup?.inline_keyboard[0]?.[0]?.url).length, { timeout: 30_000 }).toBe(before + 1);
      return (await mine()).filter(c => c.params.reply_markup?.inline_keyboard[0]?.[0]?.url).at(-1)!.params.reply_markup!.inline_keyboard[0]![0]!.url!;
    };
    const { context, unexpected } = await guardedContext(browser);
    const signs = async (page: Page) => (await walletRequests(page)).filter(m => m === 'personal_sign').length;

    // 1. First link: the owner proves the wallet once (FloFi's own sign-in session) and the proposal loads.
    const first = await linkFor(BRIDGE);
    const page = await context.newPage();
    await installJourneyWallet(page, [owner]);
    const response = await page.goto(first);
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    await approval(page).getByRole('button', { name: 'Connect wallet and prove ownership' }).click();
    await chooseWallet(page, 'Browser wallet');
    await expect(approval(page).getByRole('status')).toContainText('Ready for your review.');
    expect(await signs(page)).toBe(1);

    // 2. A replaced link (the chat's newer proposal withdraws it) shows the unavailable state, never a Canvas. Expiry takes the same path
    // (lazy, server-side; issued handoffs are immutable, so approve.pg.test.ts covers it with the store's clock).
    const replaced = await linkFor('bridge 2 USDC from Base Sepolia to Arbitrum Sepolia via auto slippage 50 bps');
    const next = await linkFor('bridge 3 USDC from Base Sepolia to Arbitrum Sepolia via auto slippage 50 bps');
    expect((await handoffOfLink(replaced)).status).toBe('REVOKED');
    const withdrawn = await context.newPage();
    await withdrawn.goto(replaced);
    await expect(withdrawn.getByRole('heading', { name: 'This approval is no longer available' })).toBeVisible();
    await expect(withdrawn.getByRole('region', { name: 'Workflow canvas', exact: true })).toHaveCount(0);
    await withdrawn.close();

    // 3. The newest link, in a new tab of the signed-in browser: the Canvas shows the proposal and it loads with no wallet prompt at all.
    const second = await context.newPage();
    await installJourneyWallet(second, [owner]);
    await second.goto(next);
    await expect(approval(second).getByRole('status')).toContainText('Ready for your review.');
    await expect(second.locator('.build-flow-surface .composer-card').first()).toBeVisible();
    await expect(second.locator('.canvas-primary-action button')).toBeEnabled();
    expect(await signs(second)).toBe(0);
    const loaded = await handoffOfLink(next);
    expect(loaded).toMatchObject({ status: 'APPLIED', share_status: false });
    const claimedAt = (await query<{ claimed_at: string }>('SELECT claimed_at::text FROM mcp_handoffs WHERE handoff_id = $1', [loaded.handoff_id]))[0]!.claimed_at;
    // 4. A refresh never restores silently or claims again: one explicit Restore, the same single claim, still nothing signed.
    await second.reload();
    await expect(approval(second)).toContainText('This proposal is already in a FloFi workflow for your wallet.');
    await expect(second.locator('.build-flow-surface .composer-card')).toHaveCount(0);
    await approval(second).getByRole('button', { name: 'Restore proposal' }).click();
    await expect(approval(second).getByRole('status')).toContainText('Ready for your review.');
    await expect(second.locator('.canvas-primary-action button')).toBeEnabled();
    expect(await query<{ claimed_at: string; status: string }>('SELECT claimed_at::text, status FROM mcp_handoffs WHERE handoff_id = $1', [loaded.handoff_id]))
      .toEqual([{ claimed_at: claimedAt, status: 'APPLIED' }]);
    expect(await signs(second)).toBe(0);
    expect(await walletRequests(second)).not.toContain('eth_sendTransaction');
    expect(await journeySends()).toBe(0);
    // Sharing stayed off, so the chat received no progress for these proposals.
    expect((await mine()).map(c => c.params.text ?? c.params.caption ?? '').filter(t => /^Your proposal is loaded in FloFi/.test(t))).toEqual([]);
    expect(unexpected).toEqual([]);
    await context.close();
  });
});
