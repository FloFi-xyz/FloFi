// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-CONVERSATIONAL-001 — the whole workflow through the FloFi chat: a chat request becomes a card at once (no proposal), "Review workflow"
 * runs the real simulation without leaving Build, the chat presents that Review, then asks for the workflow confirmation and, separately, for
 * execution; only the second explicit answer opens the existing wallet request. Follow-up comes from the durable record. Runs on the
 * execution-continuity harness (real public-swap UI/API/durable runtime, synthetic loopback RPC, scripted owner confirmations): MOCKED, no
 * public provider, RPC or broadcast; a chat message is never a signature.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, readWorkflowIr } from './fixtures';
import { installJourneyWallet, walletRequests } from './journey-fixtures';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { openBuilder } from './build-entry-navigation';

test.skip(process.env.FLOFI_SWAP_EXECUTION_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Requires the opt-in loopback swap execution harness');
test.setTimeout(120_000);
const stage = (page: Page, name: 'Build' | 'Simulate' | 'Execute') => page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name, exact: true });
/** The conversation log (by class: its accessible name is translated in Portuguese). */
const chat = (page: Page) => page.locator('.chat-messages[role="log"]');
/** FloFi's latest message. BUILD0-UX-001: the chat has no execution report card; the class stays excluded for older builds' markup. */
const flofi = (page: Page) => chat(page).locator('.message:not(.you):not(.conversation-execution-message)').last();
const cards = (page: Page) => page.locator('.build-flow-surface .composer-card');
/** BUILD0-UX-001: the removed execution report card (steps, operations, networks, hashes); the chat keeps FloFi's short messages only. */
const executionCard = (page: Page) => chat(page).locator('.conversation-execution');
async function say(page: Page, text: string) {
  await page.locator('#mock-prompt').fill(text);
  await page.locator('.chat-form button[type=submit]').click();
}
async function pick(page: Page, option: string) { await flofi(page).getByRole('button', { name: option, exact: true }).click(); }
async function control(request: APIRequestContext, method: string, params: unknown[] = []) {
  const response = await request.post('https://127.0.0.1:8558/control', { ignoreHTTPSErrors: true, data: { jsonrpc: '2.0', id: 1, method, params } });
  expect(response.ok()).toBe(true);
  return (await response.json() as { result: unknown }).result;
}
/** Every wallet send waits for the test; `decline` makes that request the wallet's user rejection; `lose` loses the wallet's response. */
async function setup(page: Page, request: APIRequestContext, options: { decline?: number; lose?: number; language?: 'PT'; viewport?: { width: number; height: number }; entry?: boolean } = {}) {
  await control(request, 'MOCK_reset');
  const confirmations: (() => void)[] = []; let requested = 0;
  const owner = createTestWallet(), other = createTestWallet();
  await installJourneyWallet(page, [owner, other], { transactionControl: async (method, params) => {
    if (method !== 'MOCK_send') throw Error('MOCK_METHOD_DENIED');
    const number = ++requested;
    await new Promise<void>(resolve => confirmations.push(resolve));
    if (number === options.decline) throw Error('MOCK_USER_REJECTED');
    const hash = await control(request, method, params);
    if (number === options.lose) throw Error('MOCK_WALLET_RESPONSE_LOST');
    return hash;
  } });
  await page.addInitScript(() => {
    const w = window as unknown as { ethereum: { request(input: unknown): Promise<unknown> } }, original = w.ethereum.request;
    w.ethereum.request = async input => {
      try { return await original(input); } catch (error) {
        if (String((error as Error)?.message ?? error).includes('MOCK_USER_REJECTED')) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        throw error;
      }
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { provider: w.ethereum, info: { rdns: 'io.metamask', name: 'MetaMask', uuid: 'conversational-metamask' } } })));
  });
  if (options.language) await page.addInitScript(language => localStorage.setItem('flofi.language', language), options.language);
  if (options.viewport) await page.setViewportSize(options.viewport);
  // BUILD0-UX-001: `entry` keeps the visit on Build 0, where the owner's first request is typed.
  if (options.entry) await page.goto('/app'); else await openBuilder(page);
  await expect(page.locator('.header-wallet-provider')).toHaveAttribute('title', 'MetaMask');
  await expect(page.locator('.wallet-connection')).toHaveAttribute('title', /Base Sepolia/);
  return { owner: owner.address, other: other.address, requested: () => requested, sends: () => control(request, 'MOCK_sends'),
    confirm: async () => { await expect.poll(() => confirmations.length).toBe(1); confirmations.shift()!(); } };
}
/** "Swap 1 USDC to WETH on Base Sepolia" through the chat: the card appears at once, with no proposal to accept. */
async function chatSwap(page: Page, amount = '1') {
  await say(page, `swap ${amount} USDC to WETH on Base Sepolia slippage 50 bps`);
  await expect(flofi(page)).toContainText(`Swap added to your workflow: ${amount} USDC`);
  await expect(flofi(page)).toContainText('Would you like to add another action or review your workflow?');
  await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(0);
}
/** The runtime's availability read has answered (a cold server answers it late; asked earlier, the chat says it is unavailable). */
async function runtimeReady(page: Page) {
  await expect(page.locator('.canvas-primary-action [data-lifecycle-action="simulate"]')).toBeEnabled({ timeout: 30_000 });
}
/** "Review workflow": the real simulation runs without leaving Build, and the chat presents the Review with its confirmation question. */
async function chatReview(page: Page, option = 'Review workflow') {
  await runtimeReady(page);
  await pick(page, option);
  await expect(chat(page)).toContainText(/Simulating your workflow|Simulando o seu workflow/);
  await expect(flofi(page)).toContainText(/Do you confirm this workflow\?|Você confirma este workflow\?/, { timeout: 30_000 });
  await expect(stage(page, 'Build')).toHaveAttribute('aria-current', 'page');
}

test('Build 0 request → card at once → Review in chat → workflow confirmation → separate execution confirmation → wallet → reconciliation', async ({ page, request, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const owner = await setup(page, request, { entry: true });
  // BUILD0-UX-001: the first request is typed in Build 0; the same conversation commits it and continues in the Build 1 chat.
  await page.locator('#build-entry-request').fill('swap 1 USDC to WETH on Base Sepolia slippage 50 bps');
  await page.getByRole('button', { name: 'Create strategy', exact: true }).click();
  await expect(stage(page, 'Build')).toHaveAttribute('aria-current', 'page');
  await expect(chat(page).locator('.message.you > p')).toHaveText(['swap 1 USDC to WETH on Base Sepolia slippage 50 bps']);
  await expect(flofi(page)).toContainText('Swap added to your workflow: 1 USDC');
  await expect(flofi(page)).toContainText('Would you like to add another action or review your workflow?');
  await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(0);
  await expect(cards(page)).toHaveCount(1);
  const authored = JSON.parse(await readWorkflowIr(page)) as { revision: number; nodes: { actionType: string }[] };
  expect(authored.revision).toBe(1); expect(authored.nodes.filter(node => node.actionType === 'asset.swap.exact-input')).toHaveLength(1);
  await expect(page.locator('.copilot')).toHaveAttribute('data-conversation-phase', 'READY_TO_REVIEW');
  await chatReview(page);
  // The chat's Review shows the simulation's own values, the same the Simulate stage presents; nothing is invented.
  const review = flofi(page).getByRole('region', { name: 'Workflow review', exact: true });
  await expect(review).toContainText('1 USDC'); await expect(review).toContainText('Quoted output'); await expect(review).toContainText('Minimum receipt');
  await expect(review).toContainText('Max slippage'); await expect(review).toContainText('Estimates from this simulation, not executed results.');
  await expect(review.locator('[data-unknown] dd').first()).toHaveText('Not provided by this simulation');
  // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the compact Review names it "Expected receipt" (the quote kind is the small note under the value).
  const quoted = (await review.locator('dt', { hasText: 'Expected receipt' }).first().locator('xpath=following-sibling::dd').evaluate(dd => dd.firstChild?.textContent ?? '')).trim();
  expect(quoted).toMatch(/^\d+(\.\d+)? WETH$/);
  await stage(page, 'Simulate').click();
  await expect(page.locator('.simulation-summary')).toContainText(quoted.split(' ')[0]!);
  // The conversation survives stage navigation, with its open question.
  const messages = await chat(page).locator('.message').count();
  await stage(page, 'Execute').click(); await stage(page, 'Build').click();
  await expect(chat(page).locator('.message')).toHaveCount(messages);
  await expect(page.locator('.copilot')).toHaveAttribute('data-conversation-phase', 'AWAITING_WORKFLOW_CONFIRMATION');
  // An unclear answer changes nothing.
  await say(page, 'yes but make it 2 USDC');
  await expect(flofi(page)).toContainText('Please answer yes or no.');
  await pick(page, 'Yes, I confirm');
  await expect(flofi(page)).toContainText('Nothing has been signed or sent.');
  await expect(flofi(page)).toContainText('Would you like to execute this workflow now?');
  await page.waitForTimeout(300); expect(owner.requested()).toBe(0);
  await pick(page, 'Yes, execute');
  // The existing Authorize-in-wallet control: Review acceptance and exactly the first wallet request.
  await expect.poll(owner.requested).toBe(1);
  await expect(chat(page)).toContainText('Preparing your reviewed wallet request: FloFi re-checks the quote, your wallet and its network first. Then confirm or reject it in your wallet; FloFi never signs for you.');
  await expect(page.locator('.copilot')).toHaveAttribute('data-conversation-phase', 'AWAITING_WALLET');
  await owner.confirm();
  // The approval is confirmed; the swap is a separate wallet request, asked for separately.
  await expect(flofi(page)).toContainText('The previous wallet request is confirmed.', { timeout: 30_000 });
  await page.waitForTimeout(300); expect(owner.requested()).toBe(1);
  await pick(page, 'Continue');
  await expect.poll(owner.requested).toBe(2);
  await owner.confirm();
  await expect(flofi(page)).toContainText('Execution completed', { timeout: 30_000 });
  // BUILD0-UX-001: no execution report in the chat (no step list, operations or transaction hashes); Execute and the Dashboard keep the record.
  await expect(executionCard(page)).toHaveCount(0);
  await expect(chat(page)).not.toContainText(/0x[0-9a-f]{4}…[0-9a-f]{4}/);
  await page.screenshot({ path: '.tmp/build0-chat-after-execution.png' });
  await stage(page, 'Execute').click();
  await expect(page.locator('.execution-status-panel')).toContainText('Execution completed');
  await page.screenshot({ path: '.tmp/build0-execute-result.png', fullPage: true });
  await expect(page.locator('.execution-status-panel')).toContainText('1 of 1');
  await expect(page.locator('.execution-plan')).toContainText('Action transaction');
  await expect(page.getByText(/^(Result details|View technical details)$/)).toHaveCount(0);
  await page.getByRole('button', { name: 'View in Dashboard', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/dashboard$/);
  expect(await owner.sends()).toBe(2);
  expect((await walletRequests(page)).filter(method => method === 'eth_sendTransaction')).toHaveLength(2);
  expect(errors).toEqual([]); networkGuard.assertClean();
});

test('a correction retires the Review; a second action keeps the first; an unsupported pair is explained; a declined wallet request is not submitted', async ({ page, request, networkGuard }) => {
  const owner = await setup(page, request, { decline: 1 });
  await chatSwap(page);
  await chatReview(page);
  await pick(page, 'No');
  await expect(flofi(page)).toContainText('Nothing was signed or sent.');
  // Correcting the reviewed step through the chat changes the revision and retires that Review.
  const nodeId = (JSON.parse(await readWorkflowIr(page)) as { nodes: { nodeId: string; actionType: string }[] }).nodes.find(node => node.actionType === 'asset.swap.exact-input')!.nodeId;
  await say(page, `set ${nodeId} amount 3`);
  await expect(flofi(page)).toContainText('Swap updated: 3 USDC');
  await expect(flofi(page)).toContainText('Any earlier simulation or review of this workflow no longer applies.');
  const corrected = JSON.parse(await readWorkflowIr(page)) as { revision: number; nodes: { nodeId: string }[] };
  expect(corrected.revision).toBe(2);
  // A second action keeps the first exactly as it is.
  await pick(page, 'Add another action');
  await expect(flofi(page)).toContainText('Describe the next action');
  await say(page, 'swap 2 USDC to WETH on Base Sepolia slippage 50 bps');
  await expect(flofi(page)).toContainText('Swap added to your workflow: 2 USDC');
  await expect(cards(page)).toHaveCount(2);
  const both = JSON.parse(await readWorkflowIr(page)) as { nodes: { nodeId: string }[] };
  expect(both.nodes.find(node => node.nodeId === nodeId)).toEqual(corrected.nodes.find(node => node.nodeId === nodeId));
  // BUILD-FLOFI-CHAT-E2E-FIX-002: two independent swaps run as a sequence (no runtime serves them as one route): the review lists both actions,
  // simulates step 1 now and step 2 after step 1 reconciles. Declining it changes nothing.
  await pick(page, 'Review workflow');
  await expect(flofi(page)).toContainText('Here is the review of step 1 of 2.', { timeout: 30_000 });
  await expect(flofi(page).locator('[data-sequence-state]')).toHaveCount(2);
  await expect(flofi(page)).toContainText('Do you confirm this workflow?');
  await pick(page, 'No');
  expect(owner.requested()).toBe(0);
  // The chat's Undo removes the second action only.
  await say(page, 'undo');
  await expect(flofi(page)).toContainText('Undone.');
  await expect(cards(page)).toHaveCount(1);
  await chatReview(page, 'Review workflow');
  await pick(page, 'Yes, I confirm'); await pick(page, 'Yes, execute');
  await expect.poll(owner.requested).toBe(1);
  await owner.confirm();
  // The wallet declined: nothing was submitted, and the chat never reports an execution (FloFi says so in one short message).
  await expect(flofi(page)).toContainText('Transaction not submitted', { timeout: 30_000 });
  await expect(executionCard(page)).toHaveCount(0);
  await expect(chat(page)).not.toContainText('Execution completed');
  expect(await owner.sends()).toBe(0);
  networkGuard.assertClean();
});

test('another wallet never inherits a confirmation: the conversation restarts, and a stale "yes" executes nothing', async ({ page, request, networkGuard }) => {
  const owner = await setup(page, request);
  await chatSwap(page);
  await chatReview(page);
  await pick(page, 'Yes, I confirm');
  await expect(flofi(page)).toContainText('Would you like to execute this workflow now?');
  await page.evaluate(address => (window as unknown as { flofiJourneyWallet: { switchAccount(address: string): void } }).flofiJourneyWallet.switchAccount(address), owner.other);
  // A different owner: nothing of the previous conversation (or its open question) carries over.
  await expect(chat(page).locator('.message:not(.conversation-execution-message)')).toHaveCount(1, { timeout: 15_000 });
  await expect(chat(page)).not.toContainText('Would you like to execute this workflow now?');
  await say(page, 'Yes, execute');
  await page.waitForTimeout(500);
  expect(owner.requested()).toBe(0); expect(await owner.sends()).toBe(0);
  networkGuard.assertClean();
});

test('an unresolved wallet response restored after reload is followed read-only: no duplicate submission', async ({ page, request, networkGuard }) => {
  const owner = await setup(page, request, { lose: 1 });
  await chatSwap(page);
  await chatReview(page);
  await pick(page, 'Yes, I confirm'); await pick(page, 'Yes, execute');
  await expect.poll(owner.requested).toBe(1);
  await owner.confirm();
  await expect(flofi(page)).toContainText(/unresolved|uncertain/i, { timeout: 30_000 });
  const sends = await owner.sends();
  await page.reload();
  // BUILD0-UX-001: the recovered run never stays behind Build 0: the visit opens Build 1 with the chat following it.
  await expect(stage(page, 'Build')).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
  await expect(chat(page)).toContainText('FloFi restored this workflow’s execution from its saved record.', { timeout: 30_000 });
  await expect(flofi(page)).toContainText(/unresolved|uncertain/i);
  await expect(executionCard(page)).toHaveCount(0);
  // Only observation is offered; asking for the status or a new review never resends anything.
  await say(page, 'check status');
  await say(page, 'Review workflow');
  await page.waitForTimeout(1_000);
  expect(owner.requested()).toBe(1); expect(await owner.sends()).toEqual(sends);
  await expect(chat(page).getByRole('button', { name: /Yes, execute|Continue/ })).toHaveCount(0);
  networkGuard.assertClean();
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) test(`Portuguese chat journey at ${viewport.width}px: card, Review and confirmation questions in PT-BR`, async ({ page, request, networkGuard }) => {
  const owner = await setup(page, request, { language: 'PT', viewport });
  await say(page, 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps');
  await expect(flofi(page)).toContainText('Quer adicionar outra ação ou revisar o seu workflow?');
  await runtimeReady(page);
  await say(page, 'Revisar workflow');
  await expect(flofi(page)).toContainText('Você confirma este workflow?', { timeout: 30_000 });
  await expect(flofi(page).locator('.conversation-review')).toHaveAttribute('aria-label', 'Revisão do workflow');
  await expect(flofi(page).locator('.conversation-review')).toContainText('Estimativas desta simulação');
  await pick(page, 'Sim, confirmo');
  await expect(flofi(page)).toContainText('Quer executar este workflow agora?');
  await pick(page, 'Agora não');
  await expect(flofi(page)).toContainText('Nada foi assinado nem enviado.');
  expect(owner.requested()).toBe(0);
  // The chat stays usable on every stage, and the layout never scrolls sideways.
  await page.locator('nav.tabs button', { hasText: 'Simular' }).click();
  await expect(page.locator('.stage-with-chat #mock-prompt')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  networkGuard.assertClean();
});
