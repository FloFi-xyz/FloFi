// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-SOLANA-TRANSFER-UX-001: the two `/approve` journeys in the real application, through to the receipt.
 *
 *   consumer OAuth → compose_strategy → request_user_approval (a Claude/ChatGPT-shaped MCP request) → the FloFi panel's "Authorize"
 *   (chat-first: the minimal signing surface) or "View in FloFi" (the optional Canvas) → the already connected wallet is recognized and
 *   signs FloFi's sign-in message → FloFi prepares the fresh simulation itself → ONE "Authorize in wallet" click (Review acceptance + the
 *   first wallet request) → the wallet's own confirmation → submission → the next transaction only on the owner's explicit click →
 *   reconciliation → the receipt, read back in the chat.
 *
 * A Base Sepolia public swap on the synthetic loopback RPC and disposable PostgreSQL, with scripted owner wallet confirmations. No public
 * network, provider or broadcast; it proves FloFi's side of the contract, not any vendor's MCP host or wallet extension.
 */
import type { APIRequestContext, Browser, Locator } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet.ts';
import { E2E_APP_ORIGIN as APP_ORIGIN } from './app-origin';
import { AUTHORIZE_IN_WALLET, proveConnectedEvmWallet, signingSurface } from './fixtures';
import { guardedContext, installJourneyWallet, walletRequests } from './journey-fixtures';
import { assertMcpHarness, CLIENT_NAME, connectViaBrowser, hostLog, mcpClient, openHost, panelHtmlOf } from './mcp-fixtures';

test.skip(process.env.GRYLOO_MCP_E2E !== 'EMBEDDED_LOOPBACK_ONLY' || process.env.FLOFI_SWAP_EXECUTION_E2E !== 'MOCKED_LOOPBACK_ONLY',
  'Requires the MCP harness and the opt-in loopback swap execution harness');
test.setTimeout(120_000);
test.beforeAll(assertMcpHarness);

async function control(request: APIRequestContext, method: string, params: unknown[] = []) {
  const response = await request.post('https://127.0.0.1:8558/control', { ignoreHTTPSErrors: true, data: { jsonrpc: '2.0', id: 1, method, params } });
  expect(response.ok()).toBe(true);
  return (await response.json() as { result: unknown }).result;
}

/** The assistant's side (consent, a validated strategy, a proposal) and the owner's browser with its wallet already connected. */
async function proposal(browser: Browser, request: APIRequestContext, presentation: 'Authorize' | 'View in FloFi') {
  await control(request, 'MOCK_reset');
  const owner = createTestWallet();
  const { context, unexpected } = await guardedContext(browser);
  const consent = await context.newPage();
  const client = mcpClient(context.request, (await connectViaBrowser(consent, context.request)).accessToken);
  const composed = await client.tool('compose_strategy', { strategy: { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1' } });
  expect(composed).toMatchObject({ ok: true, stepCount: 1 });
  const args = { strategy: composed.strategy as Record<string, unknown>, workflowHash: String(composed.workflowHash) };
  const result = await client.toolResult('request_user_approval', args);
  // Nothing is authorized by the chat.
  expect(result.structuredContent).toMatchObject({ ok: true, status: 'PENDING', authority: 'NONE' });
  const host = await context.newPage();
  const panel = await openHost(host, client, await panelHtmlOf(client, 'ui://flofi/approval-panel.html'), args, result);
  await expect(panel.getByText('Nothing is authorized yet.', { exact: false })).toBeVisible();
  await panel.getByRole('button', { name: presentation, exact: true }).click();
  await expect.poll(async () => (await hostLog(host)).openLinks.length).toBe(1);
  const url = (await hostLog(host)).openLinks[0]!;
  expect(url).toMatch(new RegExp(`^${APP_ORIGIN.replace(/[.]/g, '\\.')}/approve${presentation === 'View in FloFi' ? '\\?view=canvas' : ''}#flofi_hs_[A-Za-z0-9_-]{43}$`));
  await consent.close();

  // Every transaction waits for the owner's scripted confirmation in the wallet.
  const confirmations: (() => void)[] = []; let requested = 0;
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installJourneyWallet(page, [owner], { chain: '0x14a34', transactionControl: async (method, params) => {
    if (method !== 'MOCK_send') throw Error('MOCK_METHOD_DENIED');
    requested++;
    await new Promise<void>(resolve => confirmations.push(resolve));
    return control(request, method, params);
  } });
  await page.goto(url);
  const region = page.getByRole('region', { name: `Proposal from ${CLIENT_NAME}` });
  await expect(region).toContainText('Nothing is authorized yet.');
  await expect(region.getByRole('checkbox', { name: `Share status and evidence with ${CLIENT_NAME}` })).toBeChecked();
  // The handoff UI stays a compact, neutral provenance strip: no expanded revision dump above the Canvas or signing surface.
  await expect(region.locator('.approval-summary,.approval-explanation')).toHaveCount(0);
  await expect(region.locator('.approval-details')).not.toHaveAttribute('open', '');
  // No Credentials step and no extra Mainnet checkbox on either presentation.
  await expect(page.getByRole('checkbox', { name: /I understand/ })).toHaveCount(0);
  return { owner, context, unexpected, host, panel, page, region, errors,
    requested: () => requested, sends: () => control(request, 'MOCK_sends'),
    confirm: async () => { await expect.poll(() => confirmations.length).toBe(1); confirmations.shift()!(); } };
}
type Journey = Awaited<ReturnType<typeof proposal>>;

/**
 * One click (two in one browser turn) accepts the Review and opens exactly one wallet request; nothing is sent before the wallet confirms.
 * The swap is the next, separate wallet request, opened only by the owner's explicit "Continue to swap"; then the run reconciles.
 */
async function authorizeAndComplete(journey: Journey, actions: Locator) {
  const { page } = journey;
  const authorize = actions.getByRole('button', { name: AUTHORIZE_IN_WALLET, exact: true });
  await expect(authorize).toBeEnabled({ timeout: 30_000 });
  await expect(authorize).toHaveAttribute('data-lifecycle-action', 'approve');
  expect(journey.requested()).toBe(0); expect(await journey.sends()).toBe(0);
  expect((await walletRequests(page)).filter(method => method === 'personal_sign')).toHaveLength(1);
  await authorize.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(journey.requested).toBe(1);
  await expect(actions.locator('[data-lifecycle-action="processing"]')).toHaveText('Waiting for wallet…');
  await page.waitForTimeout(300); expect(journey.requested()).toBe(1); expect(await journey.sends()).toBe(0);
  await journey.confirm();
  const next = actions.locator('[data-lifecycle-action="continue"]');
  await expect(next).toHaveText('Continue to swap', { timeout: 30_000 });
  await page.waitForTimeout(300); expect(journey.requested()).toBe(1); expect(await journey.sends()).toBe(1);
  await next.click();
  await expect.poll(journey.requested).toBe(2);
  await journey.confirm();
}

/** Back in the chat: the panel follows the recorded result and offers the owner-scoped receipt; the model context carries public facts only. */
async function receiptInChat(journey: Journey) {
  const { host, panel } = journey;
  await expect(panel.getByRole('button', { name: 'View receipt', exact: true })).toBeVisible({ timeout: 45_000 });
  let receipt = '';
  await expect.poll(async () => {
    receipt = /Receipt: (\S+)/.exec(JSON.stringify((await hostLog(host)).modelContext.at(-1) ?? {}))?.[1]?.replace(/["\\].*$/, '') ?? '';
    return receipt;
  }, { timeout: 45_000 }).toMatch(new RegExp(`^${APP_ORIGIN.replace(/[.]/g, '\\.')}/app/dashboard/runs/[^/?#]+$`));
  // Only the host's own link log holds the session link it opened; the model never receives it, tokens, calldata or signatures.
  const log = await hostLog(host);
  expect(JSON.stringify(log)).not.toMatch(/flofi_at_|flofi_rt_|calldata|"signature"/);
  expect(JSON.stringify(log.modelContext)).not.toMatch(/flofi_hs_|approvalUrl|walletLinks/);
  await panel.getByRole('button', { name: 'View receipt', exact: true }).click();
  await expect.poll(async () => (await hostLog(host)).openLinks).toContain(receipt);
  return receipt;
}

async function finish(journey: Journey, receipt: string) {
  // Exactly the two owner-confirmed transactions reached the wallet (this document's request log).
  expect((await walletRequests(journey.page)).filter(method => method === 'eth_sendTransaction')).toHaveLength(2);
  // The receipt opens for the owner (the proof's own wallet session) with the reconciled run; nothing was sent again.
  await journey.page.goto(receipt);
  await expect(journey.page.locator('main')).toContainText(/Reconciled|Completed/);
  expect(await journey.sends()).toBe(2); expect(journey.requested()).toBe(2);
  expect(journey.unexpected).toEqual([]);
  expect(journey.errors).toEqual([]);
  await journey.context.close();
}

test('chat-first: Authorize → signing surface → one Authorize in wallet → wallet confirmation → reconciled receipt in the chat', async ({ browser, request }) => {
  const journey = await proposal(browser, request, 'Authorize');
  const { page, region, owner } = journey, surface = signingSurface(page);
  // The minimal signing surface: no Canvas or stage navigation; the exact requested action is listed before anything is loaded.
  await expect(surface).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workflow stages' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Workflow canvas', exact: true })).toHaveCount(0);
  await expect(surface.getByRole('list', { name: 'Requested actions' })).toContainText('Base Sepolia');
  await proveConnectedEvmWallet(page, region, owner.address);
  await expect(region.getByRole('status')).toContainText('Ready for your review.');
  // FloFi prepared the fresh simulation for this wallet: the signer, the test-funds network and the reviewed limits are shown.
  await expect(surface.getByRole('button', { name: AUTHORIZE_IN_WALLET, exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(surface).toContainText('Public testnet · Test funds');
  await expect(surface).toContainText(new RegExp(owner.address, 'i'));
  await expect(surface).toContainText('Max slippage');
  await authorizeAndComplete(journey, surface);
  await expect(surface.locator('.signing-status')).toContainText('Execution completed', { timeout: 45_000 });
  await expect(surface.getByRole('list', { name: 'Transactions' }).getByRole('listitem')).toHaveCount(2);
  await expect(surface).toContainText('You can return to your conversation.');
  await surface.getByText('Transaction and reconciliation evidence', { exact: true }).click();
  const link = await surface.getByRole('link', { name: 'View receipt and evidence', exact: true }).getAttribute('href');
  const receipt = await receiptInChat(journey);
  expect(receipt).toBe(`${APP_ORIGIN}${link}`);
  await finish(journey, receipt);
});

test('optional Canvas: View in FloFi → action card → one Authorize in wallet → wallet confirmation → reconciled receipt in the chat', async ({ browser, request }) => {
  const journey = await proposal(browser, request, 'View in FloFi');
  const { page, region, owner } = journey;
  // The proposal's action card on the normal Canvas, before anything is loaded or simulated.
  await expect(page.getByRole('region', { name: 'Workflow canvas', exact: true })).toBeVisible();
  await expect(signingSurface(page)).toHaveCount(0);
  const card = page.locator('.build-flow-surface .composer-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Swap'); await expect(card).toContainText('Base Sepolia');
  await expect(page.locator('.canvas-primary-action button')).toBeDisabled();
  await proveConnectedEvmWallet(page, region, owner.address);
  await expect(region.getByRole('status')).toContainText('Ready for your review.');
  // FloFi prepared the fresh simulation and shows it on the Canvas's Simulate stage; the one owner action is on the Canvas.
  const stages = page.getByRole('navigation', { name: 'Workflow stages' });
  await expect(stages.getByRole('button', { name: 'Simulate', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: 'Simulation workflow graph', exact: true }).locator('.composer-card')).toContainText('Base Sepolia');
  const actions = page.locator('.canvas-primary-action');
  await authorizeAndComplete(journey, actions);
  await expect(stages.getByRole('button', { name: 'Execute', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.execution-summary')).toContainText('Execution completed', { timeout: 45_000 });
  await expect(page.locator('.execution-summary')).toContainText('1 of 1');
  await finish(journey, await receiptInChat(journey));
});
