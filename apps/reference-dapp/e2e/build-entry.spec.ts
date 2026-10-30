// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD0-UX-001 — Build 0, the intent entry before the existing builder (Build 1). A fresh /app visit opens on it without a wallet; a request
 * goes through the existing FloFi conversation (exact command grammar here: no Copilot model is configured) and opens Build 1 with the authored
 * workflow and the same conversation; an unsupported request keeps its text and says why; the chips only fill editable text; "Build manually"
 * opens Build 1. No network selector exists, and nothing is simulated, signed or sent.
 */
import type { Page } from '@playwright/test';
import { test, expect, readWorkflowIr } from './fixtures';
import { continueToBuilder } from './build-entry-navigation';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Workflow stages' });
/** Build 0's workspace (by class: its accessible name is translated in Portuguese). */
const entry = (page: Page) => page.locator('main.build-entry-workspace');
const request = (page: Page) => page.locator('#build-entry-request');
const create = (page: Page) => entry(page).getByRole('button', { name: /^(Create strategy|Criar estratégia)$/ });
const chat = (page: Page) => page.locator('.chat-messages[role="log"]');
/** The shell is inert until hydrated: an owner cannot type before then, so neither does the test. */
const open = async (page: Page) => { await page.goto('/app'); await expect(page.locator('.app-shell')).not.toHaveAttribute('inert'); };
const noOverflow = async (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test.beforeEach(async ({ page }) => {
  await page.route('**/api/build-estimate', route => route.fulfill({ json: { ok: false, code: 'ESTIMATE_UNAVAILABLE' } }));
});

test('a fresh visit opens on Build 0 without a wallet, with the reference composition and no network selector', async ({ page, networkGuard }) => {
  await page.setViewportSize({ width: 1240, height: 871 });
  await open(page);
  await expect(entry(page)).toBeVisible();
  await expect(nav(page).getByRole('button', { name: 'Build 0', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(nav(page).getByRole('button')).toHaveText(['Dashboard', '0Build', '1Build', '2Simulate', '3Execute']);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('What do you want to do?');
  await expect(entry(page)).toContainText('Describe your goal in one sentence. FloFi turns it into a workflow you can review before simulating or executing.');
  await expect(request(page)).toHaveAttribute('placeholder', 'I want to put 2,000 USDC to work on Solana with low risk.');
  await expect(request(page)).toHaveValue('');
  // The placeholder is not a request: nothing can be created until the owner types one.
  await expect(create(page)).toBeDisabled();
  await expect(entry(page).getByRole('group', { name: 'Example requests' }).getByRole('button')).toHaveText(['Earn yield', 'Swap assets', 'Provide liquidity', 'Use collateral', 'Multi-step strategy']);
  await expect(entry(page).getByRole('button', { name: 'Prefer the editor? Build manually', exact: true })).toBeVisible();
  await expect(entry(page)).toContainText('Nothing executes without your review and authorization.');
  await expect(entry(page)).toContainText('You can start without connecting a wallet.');
  await expect(entry(page).locator('img[src="/brand/flofi-droplet-wave.svg"]')).toBeVisible();
  await expect(page.locator('.wallet-connection')).toHaveText('Wallet not connected');
  // BUILD-FLOFI-MAINNET-PRODUCT-001: the old reference's Network / Mainnet-Testnet selector is not reintroduced.
  await expect(page.locator('.top-bar select, .top-bar [role="combobox"]')).toHaveCount(0);
  await expect(page.locator('.top-bar')).not.toContainText(/Network|Testnet|Devnet|Sepolia/);
  // Build 0 has no Canvas, chat panel or summary bar.
  await expect(page.locator('.canvas, .copilot, .summary-bar')).toHaveCount(0);
  await noOverflow(page);
  await page.screenshot({ path: '.tmp/build0-desktop-light.png' });
  networkGuard.assertClean();
});

test('suggestion chips only fill editable text; nothing is authored until the owner submits', async ({ page, networkGuard }) => {
  await open(page);
  await entry(page).getByRole('button', { name: 'Swap assets', exact: true }).click();
  await expect(request(page)).toHaveValue('Swap 50 USDC to SOL on Solana');
  await expect(request(page)).toBeFocused();
  await expect(create(page)).toBeEnabled();
  await entry(page).getByRole('button', { name: 'Earn yield', exact: true }).click();
  await expect(request(page)).toHaveValue('Supply 100 USDC to Aave on Base');
  await request(page).fill('Supply 250 USDC to Aave on Base');
  await expect(request(page)).toHaveValue('Supply 250 USDC to Aave on Base');
  // Still Build 0, and the canonical workflow is untouched (Build 1 shows the empty Canvas).
  await expect(nav(page).getByRole('button', { name: 'Build 0', exact: true })).toHaveAttribute('aria-current', 'page');
  await nav(page).getByRole('button', { name: 'Build', exact: true }).click();
  await expect(page.locator('.build-flow-surface .canvas-empty')).toContainText('Start your workflow');
  expect(JSON.parse(await readWorkflowIr(page)).revision).toBe(0);
  // The typed request survives a visit to Build 1.
  await nav(page).getByRole('button', { name: 'Build 0', exact: true }).click();
  await expect(request(page)).toHaveValue('Supply 250 USDC to Aave on Base');
  networkGuard.assertClean();
});

test('every Build 0 control is reachable with the keyboard and shows its focus', async ({ page, networkGuard }) => {
  await open(page);
  await expect(entry(page)).toBeVisible();
  await request(page).click();
  // The composer carries the field's focus ring.
  expect(await page.locator('form[aria-busy]').evaluate(form => getComputedStyle(form).boxShadow)).toMatch(/0px 0px 0px 4px/);
  await page.keyboard.type('Swap 1 USDC to WETH on Base slippage 50 bps');
  const order = [create(page), ...['Earn yield', 'Swap assets', 'Provide liquidity', 'Use collateral', 'Multi-step strategy'].map(name => entry(page).getByRole('button', { name, exact: true })),
    entry(page).getByRole('button', { name: 'Prefer the editor? Build manually', exact: true })];
  for (const control of order) {
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
    expect(await control.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
  }
  // Shift+Enter adds a line; Enter submits.
  await request(page).focus(); await page.keyboard.press('End');
  await page.keyboard.press('Shift+Enter');
  await expect(request(page)).toHaveValue('Swap 1 USDC to WETH on Base slippage 50 bps\n');
  await expect(entry(page)).toBeVisible();
  networkGuard.assertClean();
});

test('Create strategy runs the existing interpreter and opens Build 1 with the workflow and the same conversation, without a wallet', async ({ page, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  await request(page).fill('Swap 1 USDC to WETH on Base slippage 50 bps');
  await request(page).press('Enter');
  await expect(nav(page).getByRole('button', { name: 'Build', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(1);
  const workflow = JSON.parse(await readWorkflowIr(page)) as { revision: number; nodes: { actionType: string; chainId: string }[] };
  expect(workflow.revision).toBe(1);
  expect(workflow.nodes.filter(node => node.actionType === 'asset.swap.exact-input').map(node => node.chainId)).toEqual(['eip155:8453']);
  // The request and FloFi's answer are the chat's first exchange: the conversation continues in Build 1.
  await expect(chat(page).locator('.message.you > p')).toHaveText(['Swap 1 USDC to WETH on Base slippage 50 bps']);
  await expect(chat(page)).toContainText('Swap added to your workflow: 1 USDC');
  await expect(page.locator('.wallet-connection')).toHaveText('Wallet not connected');
  // Build 0 is reachable again; its composer is empty after the request was added.
  await nav(page).getByRole('button', { name: 'Build 0', exact: true }).click();
  await expect(request(page)).toHaveValue('');
  await expect(entry(page)).toContainText('Your workflow already has 1 action. A new request is added to it.');
  expect(errors).toEqual([]); networkGuard.assertClean();
});

test('an unsupported request keeps its text and says why; Build manually opens Build 1', async ({ page, networkGuard }) => {
  await open(page);
  const text = 'I want to put 2,000 USDC to work on Solana with low risk.';
  await request(page).fill(text);
  await create(page).click();
  const alert = entry(page).getByRole('alert');
  await expect(alert).toContainText('This request could not be understood. Check the action, amount, asset and chain, then try again.');
  await expect(alert).toContainText('Your text was kept.');
  await expect(request(page)).toHaveValue(text);
  await expect(nav(page).getByRole('button', { name: 'Build 0', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(JSON.parse(await readWorkflowIr(page)).revision).toBe(0);
  await alert.getByRole('button', { name: 'Build manually', exact: true }).click();
  await expect(nav(page).getByRole('button', { name: 'Build', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.build-flow-surface .canvas-empty')).toContainText('Start your workflow');
  await expect(page.locator('#mock-prompt')).toBeVisible();
  networkGuard.assertClean();
});

test('Build manually opens Build 1 directly, and the stages keep working from there', async ({ page, networkGuard }) => {
  await open(page);
  await continueToBuilder(page);
  await expect(page.locator('.build-flow-surface .canvas-empty')).toContainText('Start your workflow');
  await nav(page).getByRole('button', { name: 'Simulate', exact: true }).click();
  await expect(nav(page).getByRole('button', { name: 'Simulate', exact: true })).toHaveAttribute('aria-current', 'page');
  await nav(page).getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(nav(page).getByRole('button', { name: 'Execute', exact: true })).toHaveAttribute('aria-current', 'page');
  // A stage visit never sends the owner back to the entry.
  await nav(page).getByRole('button', { name: 'Build', exact: true }).click();
  await expect(page.locator('.build-flow-surface')).toBeVisible();
  networkGuard.assertClean();
});

test('Portuguese, dark theme and phone widths keep the composition', async ({ page, networkGuard }) => {
  await page.addInitScript(() => { if (!localStorage.getItem('flofi.language')) localStorage.setItem('flofi.language', 'PT'); localStorage.setItem('flofi.theme', 'dark'); });
  await page.setViewportSize({ width: 1240, height: 871 });
  await open(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('O que você quer fazer?');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(entry(page).getByRole('group', { name: 'Exemplos de pedidos' }).getByRole('button')).toHaveText(['Gerar rendimento', 'Trocar ativos', 'Fornecer liquidez', 'Usar colateral', 'Estratégia em várias etapas']);
  await expect(entry(page)).toContainText('Nada é executado sem a sua revisão e autorização.');
  await page.screenshot({ path: '.tmp/build0-desktop-dark-pt.png' });
  await page.evaluate(() => { localStorage.setItem('flofi.language', 'EN'); });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('What do you want to do?');
  await page.screenshot({ path: '.tmp/build0-desktop-dark.png' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(create(page)).toBeVisible();
    await noOverflow(page);
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: '.tmp/build0-mobile-dark.png', fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.screenshot({ path: '.tmp/build0-mobile-light.png', fullPage: true });
  // On phones the two Build stages keep their numbers.
  await expect(nav(page).locator('[data-build-stage] .stage-number')).toHaveText(['0', '1']);
  await expect(nav(page).locator('[data-build-stage="0"] .stage-number')).toBeVisible();
  networkGuard.assertClean();
});
