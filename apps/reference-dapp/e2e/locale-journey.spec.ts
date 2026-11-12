// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (locale contract): the language the person chooses is the language of every FloFi surface — Editor, FloFi Assistant, Simulate,
 * Execute, Dashboard and Flight Board — from the first byte after a reload, and switching back changes everything back (FloFi's own chat
 * messages included). Closed loopback harness only (mocked swap read and execution, the journey wallet): no public provider, no real funds.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { installJourneyWallet } from './journey-fixtures';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { continueToBuilder, editorStep, openDashboard } from './build-entry-navigation';
import { conversationCopy } from '../src/domain/conversation-copy';
import { translate } from '../src/i18n/translate';

test.skip(process.env.FLOFI_SWAP_EXECUTION_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Requires the opt-in loopback swap execution harness');
test.setTimeout(240_000);

/** English interface phrases that must never appear on a Portuguese screen (and their Portuguese, never on an English one). */
const ENGLISH = ['Review workflow', 'Step 2 of 2', 'Pending confirmation', 'Review required', 'Simulate again', 'Waiting for your authorization', 'You are authorizing', 'Completed'];
const PORTUGUESE = [conversationCopy('PT').review, translate('PT', 'Step {0} of {1}', 2, 2), ...ENGLISH.slice(2).map(text => translate('PT', text))];
const PT = conversationCopy('PT'), EN = conversationCopy('EN');

const chat = (page: Page) => page.locator('.chat-messages[role="log"]');
const flofi = (page: Page) => chat(page).locator('.message:not(.you)').last();
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
/** The text a person can read on the page now (closed details and hidden nodes excluded). */
const visible = (page: Page) => page.locator('body').innerText();
async function expectNone(page: Page, phrases: readonly string[], where: string) {
  const text = await visible(page);
  for (const phrase of phrases) expect(text, `${where}: "${phrase}"`).not.toContain(phrase);
}
const languageCookie = async (page: Page) => (await page.context().cookies()).find(cookie => cookie.name === 'flofi_language')?.value;
/** The product's own language switch (Settings → Language), as a person uses it. */
async function switchLanguage(page: Page, from: 'EN' | 'PT') {
  await page.getByRole('button', { name: translate(from, 'Settings'), exact: true }).click();
  await page.getByRole('switch', { name: translate(from, 'Language'), exact: true }).click();
  await page.keyboard.press('Escape');
}

test('the chosen language holds across Editor, Assistant, Simulate, Execute, Dashboard and Flight Board, reloads, and switching back', async ({ page, request, networkGuard }) => {
  await control(request, 'MOCK_reset');
  const confirmations: (() => void)[] = []; let requested = 0;
  const owner = createTestWallet();
  await installJourneyWallet(page, [owner], { transactionControl: async (method, params) => {
    if (method !== 'MOCK_send') throw Error('MOCK_METHOD_DENIED');
    requested += 1;
    await new Promise<void>(resolve => confirmations.push(resolve));
    return control(request, method, params);
  } });
  const confirm = async () => { await expect.poll(() => confirmations.length).toBe(1); confirmations.shift()!(); };
  await page.addInitScript(() => {
    const w = window as unknown as { ethereum: unknown };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { provider: w.ethereum, info: { rdns: 'io.metamask', name: 'MetaMask', uuid: 'locale-journey-metamask' } } })));
  });
  await page.goto('/app');
  await continueToBuilder(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // Portuguese, chosen in the product: the cookie is written at once (before any refresh) and the page follows without a reload.
  await switchLanguage(page, 'EN');
  await expect.poll(() => languageCookie(page)).toBe('PT');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  // A reload renders Portuguese from the first byte: no English first paint, no flip after hydration.
  const reloaded = await page.reload();
  expect(await reloaded!.text()).toMatch(/<html lang="pt-BR"/);
  await continueToBuilder(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  expect(await page.evaluate(() => localStorage.getItem('flofi.language'))).toBe('PT');
  await expectNone(page, ENGLISH, 'Editor');

  // The FloFi Assistant answers in Portuguese, its Review included.
  await say(page, 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps');
  await expect(flofi(page)).toContainText(PT.nextQuestion);
  await expect(page.locator('.canvas-primary-action [data-lifecycle-action="simulate"]')).toBeEnabled({ timeout: 30_000 });
  await pick(page, PT.review);
  await expect(flofi(page)).toContainText(PT.confirmWorkflow, { timeout: 30_000 });
  await expectNone(page, ENGLISH, 'Assistant Review');

  // Simulate, in Portuguese.
  await editorStep(page, 'Simulate').click();
  await expect(editorStep(page, 'Simulate')).toHaveAttribute('aria-current', 'step');
  await expectNone(page, ENGLISH, 'Simulate');
  await editorStep(page, 'Build').click();

  // Execute through the Assistant: two explicit answers, then each wallet request (closed loopback wallet), in Portuguese throughout.
  await pick(page, PT.confirmYes);
  await expect(flofi(page)).toContainText(PT.executeQuestion);
  await pick(page, PT.executeYes);
  await expect.poll(() => requested).toBe(1);
  await expectNone(page, ENGLISH, 'Awaiting the wallet');
  await confirm();
  await expect(flofi(page).getByRole('button', { name: PT.continueYes, exact: true })).toBeVisible({ timeout: 30_000 });
  await pick(page, PT.continueYes);
  await expect.poll(() => requested).toBe(2);
  await confirm();
  await expect(flofi(page)).toContainText(translate('PT', 'Execution completed'), { timeout: 30_000 });
  await expectNone(page, ENGLISH, 'Assistant after execution');
  await editorStep(page, 'Execute').click();
  await expect(editorStep(page, 'Execute')).toHaveAttribute('aria-current', 'step');
  await expectNone(page, ENGLISH, 'Execute');

  // Dashboard and Flight Board keep the language (server-rendered from the cookie).
  await openDashboard(page);
  await expect(page.getByRole('main', { name: translate('PT', 'Dashboard'), exact: true })).toBeVisible();
  await expectNone(page, ENGLISH, 'Dashboard');
  const board = await page.goto('/board');
  expect(await board!.text()).toMatch(/<html lang="pt-BR"/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await expectNone(page, ENGLISH, 'Flight Board');

  // Back in the Editor, a new conversation in Portuguese; then English, chosen in the product: FloFi's own messages already written follow.
  await page.goto('/app');
  await continueToBuilder(page);
  await say(page, 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps');
  await expect(flofi(page)).toContainText(PT.nextQuestion);
  await expect(flofi(page).getByRole('button', { name: PT.review, exact: true })).toBeVisible();
  await switchLanguage(page, 'PT');
  await expect.poll(() => languageCookie(page)).toBe('EN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(flofi(page)).toContainText(EN.nextQuestion);
  await expect(flofi(page).getByRole('button', { name: EN.review, exact: true })).toBeVisible();
  await expectNone(page, PORTUGUESE, 'Editor after switching back');
  const english = await page.reload();
  expect(await english!.text()).toMatch(/<html lang="en"/);
  await continueToBuilder(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expectNone(page, PORTUGUESE, 'Editor after reload');
  await openDashboard(page);
  await expectNone(page, PORTUGUESE, 'Dashboard in English');
  networkGuard.assertClean();
});
