// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-CHAT-E2E-FIX-002 — a workflow of several owner-wallet actions, run from the FloFi chat as an ordered sequence of one-action steps:
 * every step is simulated with its own runtime, presented in the chat beside the whole ordered workflow, confirmed, signed in the wallet and
 * reconciled before the next step is simulated; a funded step spends what the earlier step actually delivered. Before this build such a workflow
 * could not be simulated at all (each runtime serves one action). Blocks (an unapplied Canvas amount, the wallet on another network, too little
 * balance, no provider quote) are resolved or explained in the chat.
 *
 * Runs on the execution-continuity harness (real public-swap UI/API/durable runtime, synthetic loopback RPC that prices USDC ⇄ WETH both ways,
 * scripted owner confirmations): MOCKED, no public provider, RPC or broadcast; a chat message is never a signature.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, readWorkflowIr } from './fixtures';
import { installJourneyWallet, walletRequests } from './journey-fixtures';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet';

test.skip(process.env.FLOFI_SWAP_EXECUTION_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Requires the opt-in loopback swap execution harness');
test.setTimeout(180_000);
const BASE_SEPOLIA = '0x14a34', ARBITRUM_SEPOLIA = '0x66eee';
const chat = (page: Page) => page.locator('.chat-messages[role="log"]');
/** FloFi's latest message (the live execution card, always last in the log, is not a message). */
const flofi = (page: Page) => chat(page).locator('.message:not(.you):not(.conversation-execution-message)').last();
const cards = (page: Page) => page.locator('.build-flow-surface .composer-card');
const stage = (page: Page, name: 'Build' | 'Simulate' | 'Execute') => page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name, exact: true });
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
/** Every wallet send waits for the test; the wallet starts on `chain`. */
async function setup(page: Page, request: APIRequestContext, options: { chain?: string } = {}) {
  await control(request, 'MOCK_reset');
  const confirmations: (() => void)[] = []; let requested = 0;
  const owner = createTestWallet();
  await installJourneyWallet(page, [owner], { chain: options.chain ?? BASE_SEPOLIA, transactionControl: async (method, params) => {
    if (method !== 'MOCK_send') throw Error('MOCK_METHOD_DENIED');
    requested += 1;
    await new Promise<void>(resolve => confirmations.push(resolve));
    return control(request, method, params);
  } });
  await page.addInitScript(() => {
    const w = window as unknown as { ethereum: unknown };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { provider: w.ethereum, info: { rdns: 'io.metamask', name: 'MetaMask', uuid: 'chat-sequence-metamask' } } })));
  });
  await page.goto('/app');
  await expect(page.locator('.header-wallet-provider')).toHaveAttribute('title', 'MetaMask');
  return { requested: () => requested, sends: () => control(request, 'MOCK_sends'),
    confirm: async () => { await expect.poll(() => confirmations.length).toBe(1); confirmations.shift()!(); } };
}
/** The runtime's availability read has answered (a cold server answers it late). */
async function runtimeReady(page: Page) {
  await expect(page.locator('.canvas-primary-action [data-lifecycle-action="simulate"]')).toBeEnabled({ timeout: 30_000 });
}
async function added(page: Page, sentence: string, text: RegExp | string) {
  await say(page, sentence);
  await expect(flofi(page)).toContainText(text);
}
/** Confirms the open Review and execution questions, then confirms every wallet request of the step (approval, then the swap). */
async function executeStep(page: Page, owner: Awaited<ReturnType<typeof setup>>, step: number, total: number) {
  await expect(flofi(page)).toContainText(step === 1 ? 'Do you confirm this workflow?' : `Do you confirm step ${step} of ${total}?`, { timeout: 30_000 });
  await pick(page, 'Yes, I confirm');
  await expect(flofi(page)).toContainText(`Would you like to execute step ${step} of ${total} now?`);
  const before = owner.requested();
  await pick(page, 'Yes, execute');
  await expect.poll(owner.requested).toBe(before + 1);
  await owner.confirm();
  await expect(flofi(page)).toContainText('The previous wallet request is confirmed.', { timeout: 30_000 });
  await pick(page, 'Continue');
  await expect.poll(owner.requested).toBe(before + 2);
  await owner.confirm();
}

test('Swap → Swap funded by the first: each step simulated, confirmed, signed and reconciled in order; the second spends what the first delivered', async ({ page, request, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const owner = await setup(page, request);
  await added(page, 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps', 'Swap added to your workflow: 1 USDC');
  await added(page, 'swap 0.001 WETH to USDC on Base Sepolia slippage 50 bps', 'Swap added to your workflow: 0.001 WETH');
  await expect(cards(page)).toHaveCount(2);
  const authored = JSON.stringify(JSON.parse(await readWorkflowIr(page)));
  await runtimeReady(page);
  await pick(page, 'Review workflow');
  // The whole workflow is reviewed in the chat: step 1 simulated now, step 2 funded by it and simulated after step 1 reconciles.
  await expect(flofi(page)).toContainText('Here is the review of step 1 of 2.', { timeout: 30_000 });
  const review = flofi(page).getByRole('region', { name: 'Workflow review', exact: true });
  await expect(review.locator('[data-sequence-state]')).toHaveCount(2);
  await expect(review.locator('[data-sequence-state="CURRENT"]')).toContainText('1. Swap');
  await expect(review.locator('[data-sequence-state="NEXT"]')).toContainText('Funded by step 1: spends the smaller of 0.001 WETH and what step 1 actually delivers');
  await expect(review).toContainText('Quoted output'); await expect(review).toContainText('Minimum received'); await expect(review).toContainText('Estimated total cost');
  await expect(review).toContainText('Excludes:'); await expect(review).toContainText('Step 2 (simulated after the steps before it)');
  await expect(review).toContainText('This workflow runs as 2 separate wallet transactions');
  await expect(stage(page, 'Build')).toHaveAttribute('aria-current', 'page');
  expect(owner.requested()).toBe(0);
  await executeStep(page, owner, 1, 2);
  // Step 1 reconciled: FloFi says what it delivered and simulates step 2 by itself (read-only), bound to that delivery.
  await expect(chat(page)).toContainText('Step 1 of 2 is completed and reconciled: it delivered 0.0005 WETH.', { timeout: 45_000 });
  await expect(flofi(page)).toContainText('Here is the review of step 2 of 2.', { timeout: 45_000 });
  const second = flofi(page).getByRole('region', { name: 'Workflow review', exact: true });
  await expect(second.locator('[data-sequence-state="COMPLETED"]')).toContainText('Completed and reconciled · delivered 0.0005 WETH');
  await expect(second.locator('[data-sequence-state="CURRENT"]')).toContainText('0.0005 WETH');
  await expect(second.locator('[data-sequence-state="CURRENT"]')).toContainText('Funded by step 1: spends 0.0005 WETH (what step 1 delivered, at most 0.001 WETH)');
  // The canonical workflow is unchanged: the bound amount is the step's runtime input, never an edit of the owner's workflow.
  expect(JSON.stringify(JSON.parse(await readWorkflowIr(page)))).toBe(authored);
  await executeStep(page, owner, 2, 2);
  await expect(chat(page)).toContainText('All 2 steps of this workflow are completed and reconciled.', { timeout: 45_000 });
  expect(await owner.sends()).toBe(4);
  expect((await walletRequests(page)).filter(method => method === 'eth_sendTransaction')).toHaveLength(4);
  expect(errors).toEqual([]); networkGuard.assertClean();
});

test('independent steps: an unapplied Canvas amount is resolved in the chat, then the real simulation runs without leaving the chat', async ({ page, request, networkGuard }) => {
  const owner = await setup(page, request);
  await added(page, 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps', 'Swap added to your workflow: 1 USDC');
  await added(page, 'swap 2 USDC to WETH on Base Sepolia slippage 50 bps', 'Swap added to your workflow: 2 USDC');
  await runtimeReady(page);
  // An amount typed on step 2's card that cannot be applied (a valid draft is applied as soon as the card loses focus) blocks every simulation;
  // the chat names it — step, action, typed value — instead of failing, and changes nothing without an explicit answer.
  const amount = cards(page).nth(1).getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  await amount.fill('0');
  await say(page, 'Review workflow');
  await expect(flofi(page)).toContainText('Step 2 (Swap) has an amount you typed but did not apply: 0 USDC.');
  await expect(flofi(page)).toContainText('Should I apply it before reviewing the workflow?');
  await pick(page, 'Apply it');
  await expect(flofi(page)).toContainText('That amount cannot be applied: Enter a valid amount greater than 0.');
  await say(page, 'revisar workflow');
  await expect(flofi(page)).toContainText('A etapa 2 (Trocar) tem um montante digitado que não foi aplicado: 0 USDC.');
  await pick(page, 'Descartar');
  await expect(chat(page)).toContainText('Descartado. A etapa mantém o montante anterior.');
  await expect(flofi(page)).toContainText('Esta é a revisão da etapa 1 de 2.', { timeout: 30_000 });
  // Independent steps: step 2 is not funded by step 1, and both keep exactly their authored amounts.
  await expect(flofi(page).locator('[data-sequence-state="NEXT"]')).not.toContainText('Financiada pela etapa');
  const workflow = JSON.parse(await readWorkflowIr(page)) as { nodes: { userConstraints: { kind: string; quantity?: { amount: string } }[] }[] };
  expect(workflow.nodes.map(node => node.userConstraints.find(c => c.kind === 'MAXIMUM_INPUT')?.quantity?.amount)).toEqual(['1000000', '2000000']);
  expect(owner.requested()).toBe(0); networkGuard.assertClean();
});

test('the wallet on another network than the step: the chat offers the existing network switch and continues the review by itself', async ({ page, request, networkGuard }) => {
  const owner = await setup(page, request, { chain: ARBITRUM_SEPOLIA });
  await added(page, 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps', 'Swap added to your workflow: 1 USDC');
  await added(page, 'swap 0.001 WETH to USDC on Base Sepolia slippage 50 bps', 'Swap added to your workflow: 0.001 WETH');
  await say(page, 'Review workflow');
  await expect(flofi(page)).toContainText('but this step runs on Base Sepolia. Switch your wallet to Base Sepolia; I will continue the review once it is done.');
  await pick(page, 'Switch to Base Sepolia');
  await expect(chat(page)).toContainText('Your wallet is now on Base Sepolia. Continuing the review.', { timeout: 30_000 });
  await expect(flofi(page)).toContainText('Here is the review of step 1 of 2.', { timeout: 30_000 });
  expect((await walletRequests(page)).filter(method => method === 'wallet_switchEthereumChain')).toHaveLength(1);
  expect(owner.requested()).toBe(0); networkGuard.assertClean();
});

test('too little balance and a missing provider quote are explained exactly; nothing is signed or sent', async ({ page, request, networkGuard }) => {
  const owner = await setup(page, request);
  await added(page, 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps', 'Swap added to your workflow: 1 USDC');
  await added(page, 'swap 0.001 WETH to USDC on Base Sepolia slippage 50 bps', 'Swap added to your workflow: 0.001 WETH');
  await runtimeReady(page);
  await control(request, 'MOCK_quotes', ['unavailable']);
  await pick(page, 'Review workflow');
  await expect(flofi(page)).toContainText('The simulation did not produce a review:', { timeout: 60_000 });
  await expect(flofi(page)).not.toContainText('Do you confirm');
  await control(request, 'MOCK_quotes', ['available']);
  // 0.1 USDC for a 1 USDC step: the wallet request never starts; the chat says why and nothing is sent.
  await control(request, 'MOCK_balance', ['100000']);
  await say(page, 'Review workflow');
  await expect(flofi(page)).toContainText('Here is the review of step 1 of 2.', { timeout: 30_000 });
  await pick(page, 'Yes, I confirm'); await pick(page, 'Yes, execute');
  await expect(chat(page)).toContainText('The wallet request could not start, and nothing was sent. The status below shows the recorded state. Your available balance is too low for this workflow.', { timeout: 30_000 });
  await page.waitForTimeout(500);
  expect(owner.requested()).toBe(0); expect(await owner.sends()).toBe(0);
  await expect(chat(page)).not.toContainText('completed and reconciled');
  networkGuard.assertClean();
});

for (const width of [1920, 1440, 1280, 1024, 390, 375]) test(`chat-first layout at ${width}px: no third column beside the chat, summaries optional, nothing overflows`, async ({ page, request, networkGuard }, testInfo) => {
  await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
  const owner = await setup(page, request);
  await added(page, 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps', 'Swap added to your workflow: 1 USDC');
  await added(page, 'swap 0.001 WETH to USDC on Base Sepolia slippage 50 bps', 'Swap added to your workflow: 0.001 WETH');
  await runtimeReady(page);
  await say(page, 'Review workflow');
  await expect(flofi(page)).toContainText('Here is the review of step 1 of 2.', { timeout: 30_000 });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  // The Review in the chat never overflows its own column.
  expect(await flofi(page).locator('.conversation-review').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath(`build-${width}.png`) });
  for (const [name, grid, summary, details] of [['Simulate', '.simulate-workspace-grid', '.simulation-summary', '.simulation-details'],
    ['Execute', '.execute-workspace-grid', '.execution-summary', '.execution-details']] as const) {
    await stage(page, name).click();
    await expect(page.locator(grid)).toBeVisible();
    // One column: the canvas (or timeline). The summary is an optional, collapsed details surface — never a third column beside the chat.
    expect((await page.locator(grid).evaluate(element => getComputedStyle(element).gridTemplateColumns)).trim().split(/\s+/)).toHaveLength(1);
    await expect(page.locator(summary)).toBeHidden();
    await expect(page.locator(`${details} > summary`)).toBeVisible();
    const chatBox = (await page.locator('.stage-with-chat > .copilot').boundingBox())!, stageBox = (await page.locator('.stage-with-chat > .main').boundingBox())!;
    expect(chatBox.width).toBeGreaterThanOrEqual(Math.min(300, width - 32));
    // Wide screens keep the chat beside the stage; narrower screens stack it below, at full width.
    if (width > 1280) expect(chatBox.x).toBeGreaterThanOrEqual(stageBox.x + stageBox.width - 1); else expect(chatBox.y).toBeGreaterThanOrEqual(stageBox.y + stageBox.height - 1);
    await page.locator('.stage-with-chat #mock-prompt').scrollIntoViewIfNeeded();
    await expect(page.locator('.stage-with-chat #mock-prompt')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`${name.toLowerCase()}-${width}.png`), fullPage: true });
    // The details stay one click away, and opening them never adds a column or overflows.
    await page.locator(`${details} > summary`).click();
    await expect(page.locator(summary)).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.locator(`${details} > summary`).click();
  }
  expect(owner.requested()).toBe(0); networkGuard.assertClean();
});
