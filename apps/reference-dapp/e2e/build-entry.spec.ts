// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD0-UX-001 — Build 0, the intent entry before the existing builder (Build 1). BUILD-FLOFI-CHAT-EDITOR-UX-001: Build 0 is presented as Chat
 * and Build 1 as the Editor (navigation Dashboard | Chat | Editor, unnumbered); Simulate and Execute are the Editor's sections. A fresh /app visit opens on it without a wallet; a request
 * goes through the existing FloFi conversation (exact command grammar here: no Copilot model is configured) and opens Build 1 with the authored
 * workflow and the same conversation; an unsupported request keeps its text and says why; the chips only fill editable text; "Build manually"
 * opens Build 1. No network selector exists, and nothing is simulated, signed or sent.
 * P0 approved UX (board 03 / 03b): navigation lives only in the ☰ drawer (New workflow = Chat, Editor, Dashboard; no stage tabs in the top bar);
 * the entry is a heading, one request field, one "Create workflow" button and five intent chips that fill an editable sentence template. The
 * former "Prefer the editor? Build manually" link and trust block are gone: the Editor is reached through the drawer.
 */
import type { Page } from '@playwright/test';
import { test, expect, readWorkflowIr } from './fixtures';
import { continueToBuilder, editorSteps, expectChatSection, expectEditorSection, navigationDrawer, navigationLink, navigationTrigger, openChat, openEditorSection, openNavigation } from './build-entry-navigation';

/** The drawer's first three items: New workflow (Chat), Editor, Dashboard. */
const primaryItems = (page: Page) => navigationDrawer(page).getByRole('link').filter({ hasNotText: /Your workflows|Automations|Credentials|Agents|Passkeys|Seus fluxos|Automações|Credenciais|Agentes|Chaves de acesso/ });
/** Build 0's workspace (by class: its accessible name is translated in Portuguese). */
const entry = (page: Page) => page.locator('main.build-entry-workspace');
const request = (page: Page) => page.locator('#build-entry-request');
const create = (page: Page) => entry(page).getByRole('button', { name: /^(Create workflow|Criar fluxo)$/ });
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
  await expectChatSection(page);
  // P0 approved UX (board 03b): no stage tabs in the top bar; the drawer offers New workflow (Chat), Editor and Dashboard, unnumbered.
  await expect(page.getByRole('navigation', { name: 'Workflow stages' })).toHaveCount(0);
  await openNavigation(page);
  await expect(primaryItems(page)).toHaveText(['New workflow', 'Editor', 'Dashboard']);
  await expect(navigationDrawer(page).locator('.stage-number, [data-build-stage]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('What do you want to do?');
  // Board 03: no subtitle (the placeholder and chips show how to start).
  await expect(entry(page)).not.toContainText('Describe your goal in one sentence.');
  await expect(request(page)).toHaveAttribute('placeholder', 'e.g. swap 10 USDC for ETH on Base');
  await expect(request(page)).toHaveAccessibleName('Describe what you want to do');
  await expect(request(page)).toHaveValue('');
  // The placeholder is not a request: nothing can be created until the owner types one.
  await expect(create(page)).toBeDisabled();
  await expect(entry(page).getByRole('button')).toHaveCount(6);
  await expect(entry(page).getByRole('group', { name: 'Example requests' }).getByRole('button')).toHaveText(['Swap tokens', 'Earn yield', 'Provide liquidity', 'Use as collateral', 'Multi-step workflow']);
  // Board 03: the Editor is reached from the drawer only (no duplicate "Build manually" link) and the trust block is gone.
  await expect(entry(page).getByRole('button', { name: 'Prefer the editor? Build manually', exact: true })).toHaveCount(0);
  await expect(entry(page)).not.toContainText('Nothing executes without your review and authorization.');
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
  // Board 03: a chip fills an editable sentence template and selects its first bracketed part, so typing replaces it.
  const selection = () => request(page).evaluate(field => { const input = field as HTMLTextAreaElement; return input.value.slice(input.selectionStart, input.selectionEnd); });
  await entry(page).getByRole('button', { name: 'Swap tokens', exact: true }).click();
  await expect(request(page)).toHaveValue('Swap [amount] [token] for [token] on [network]');
  await expect(request(page)).toBeFocused();
  await expect.poll(selection).toBe('[amount]');
  await expect(create(page)).toBeEnabled();
  await entry(page).getByRole('button', { name: 'Earn yield', exact: true }).click();
  await expect(request(page)).toHaveValue('Supply [amount] [token] to Aave on [network]');
  await request(page).fill('Supply 250 USDC to Aave on Base');
  await expect(request(page)).toHaveValue('Supply 250 USDC to Aave on Base');
  // Still Build 0, and the canonical workflow is untouched (Build 1 shows the empty Canvas).
  await expectChatSection(page);
  await openEditorSection(page, 'Build');
  await expect(page.locator('.build-flow-surface .canvas-empty')).toContainText('Start your workflow');
  expect(JSON.parse(await readWorkflowIr(page)).revision).toBe(0);
  // The typed request survives a visit to Build 1.
  await openChat(page);
  await expect(request(page)).toHaveValue('Supply 250 USDC to Aave on Base');
  networkGuard.assertClean();
});

test('the request field grows with its text, has no resize handle, scrolls inside at its limit and still submits', async ({ page, networkGuard }) => {
  for (const width of [1240, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const field = request(page), form = page.locator('form[aria-busy]');
    const size = () => field.evaluate(node => ({ height: node.getBoundingClientRect().height, scroll: node.scrollHeight, client: node.clientHeight,
      resize: getComputedStyle(node).resize, max: parseFloat(getComputedStyle(node).maxHeight) }));
    const button = () => create(page).boundingBox();
    const empty = await size(), buttonBefore = await button();
    expect(empty.resize).toBe('none');
    // A short request keeps the one-line composer.
    await field.fill('Swap 1 USDC');
    expect((await size()).height).toBe(empty.height);
    // A longer one grows the field line by line, with nothing hidden.
    await field.fill('Swap 1 USDC to WETH on Base slippage 50 bps\nthen supply it to Aave\nand keep the rest');
    const grown = await size();
    expect(grown.height).toBeGreaterThan(empty.height); expect(grown.scroll).toBeLessThanOrEqual(grown.client + 1);
    // The button keeps its size while the field grows.
    expect((await button())!.height).toBeCloseTo(buttonBefore!.height, 0);
    // Past the limit it stops growing and scrolls inside, without breaking the layout.
    await field.fill(Array.from({ length: 14 }, (_, line) => `line ${line + 1} of a long request`).join('\n'));
    const capped = await size();
    expect(capped.height).toBeCloseTo(capped.max, 0); expect(capped.scroll).toBeGreaterThan(capped.client);
    await noOverflow(page);
    await form.screenshot({ path: test.info().outputPath(`build0-request-capped-${width}.png`) });
    // Cleared, it returns to one line.
    await field.fill('');
    expect((await size()).height).toBe(empty.height);
  }
  // Submit is unchanged: Enter sends the request (the conversation answers and Build 1 opens).
  await page.setViewportSize({ width: 1240, height: 871 });
  await request(page).fill('Swap 1 USDC to WETH on Base slippage 50 bps');
  await request(page).press('Enter');
  await expectEditorSection(page, 'Build');
  await expect(chat(page)).toContainText('Swap added to your workflow: 1 USDC');
  networkGuard.assertClean();
});

test('every Build 0 control is reachable with the keyboard and shows its focus', async ({ page, networkGuard }) => {
  await open(page);
  await expect(entry(page)).toBeVisible();
  await request(page).click();
  // The composer carries the field's focus ring.
  expect(await page.locator('form[aria-busy]').evaluate(form => getComputedStyle(form).boxShadow)).toMatch(/0px 0px 0px 4px/);
  await page.keyboard.type('Swap 1 USDC to WETH on Base slippage 50 bps');
  // Board 03: the create button, then the five chips (the former "Build manually" link is gone; the drawer is in the top bar, before the field).
  const order = [create(page), ...['Swap tokens', 'Earn yield', 'Provide liquidity', 'Use as collateral', 'Multi-step workflow'].map(name => entry(page).getByRole('button', { name, exact: true }))];
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
  await expectEditorSection(page, 'Build');
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(1);
  const workflow = JSON.parse(await readWorkflowIr(page)) as { revision: number; nodes: { actionType: string; chainId: string }[] };
  expect(workflow.revision).toBe(1);
  expect(workflow.nodes.filter(node => node.actionType === 'asset.swap.exact-input').map(node => node.chainId)).toEqual(['eip155:8453']);
  // The request and FloFi's answer are the chat's first exchange: the conversation continues in Build 1.
  await expect(chat(page).locator('.message.you > p')).toHaveText(['Swap 1 USDC to WETH on Base slippage 50 bps']);
  await expect(chat(page)).toContainText('Swap added to your workflow: 1 USDC');
  await expect(page.locator('.wallet-connection')).toHaveText('Wallet not connected');
  // Build 0 is reachable again (the drawer's New workflow); its composer is empty after the request was added.
  await openChat(page);
  await expect(request(page)).toHaveValue('');
  await expect(entry(page)).toContainText('Your workflow already has 1 step. A new request is added to it.');
  // P0 approved UX: with steps already on the workflow, the entry's one action adds to it.
  await expect(entry(page).getByRole('button', { name: 'Add to workflow', exact: true })).toBeVisible();
  await expect(entry(page).getByRole('button', { name: 'Create workflow', exact: true })).toHaveCount(0);
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
  await expectChatSection(page);
  expect(JSON.parse(await readWorkflowIr(page)).revision).toBe(0);
  await alert.getByRole('button', { name: 'Build manually', exact: true }).click();
  await expectEditorSection(page, 'Build');
  await expect(page.locator('.build-flow-surface .canvas-empty')).toContainText('Start your workflow');
  await expect(page.locator('#mock-prompt')).toBeVisible();
  networkGuard.assertClean();
});

test('Build manually opens Build 1 directly, and the stages keep working from there', async ({ page, networkGuard }) => {
  await open(page);
  await continueToBuilder(page);
  await expect(page.locator('.build-flow-surface .canvas-empty')).toContainText('Start your workflow');
  // BUILD-FLOFI-CHAT-EDITOR-UX-001 / P0 approved UX (board 03b): no Simulate, Execute or numbered Build navigation item; the Editor's stepper in
  // the top bar opens its simulation and execution sections.
  await openNavigation(page);
  await expect(navigationDrawer(page).getByRole('link', { name: /^(Build|Simulate|Execute)$/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(editorSteps(page)).toBeVisible();
  await openEditorSection(page, 'Simulate');
  await expectEditorSection(page, 'Simulate');
  await openEditorSection(page, 'Execute');
  await expectEditorSection(page, 'Execute');
  // A stage visit never sends the owner back to the entry.
  await openEditorSection(page, 'Build');
  await expect(page.locator('.build-flow-surface')).toBeVisible();
  networkGuard.assertClean();
});

test('Portuguese, dark theme and phone widths keep the composition', async ({ page, networkGuard }) => {
  await page.addInitScript(() => { if (!localStorage.getItem('flofi.language')) localStorage.setItem('flofi.language', 'PT'); localStorage.setItem('flofi.theme', 'dark'); });
  await page.setViewportSize({ width: 1240, height: 871 });
  await open(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('O que você quer fazer?');
  // P0 approved UX (board 03b): the drawer's items are translated (New workflow = "Novo fluxo", Dashboard = "Painel").
  await openNavigation(page);
  await expect(primaryItems(page)).toHaveText(['Novo fluxo', 'Editor', 'Painel']);
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(create(page)).toHaveText('Criar fluxo');
  await expect(entry(page).getByRole('group', { name: 'Exemplos de pedidos' }).getByRole('button')).toHaveText(['Trocar moedas', 'Render juros', 'Prover liquidez', 'Usar como garantia', 'Fluxo com vários passos']);
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
  // P0 approved UX (board 03b): on phones too, the drawer offers New workflow, Editor and Dashboard, without stage numbers.
  await expect(navigationTrigger(page)).toBeVisible();
  await openNavigation(page);
  await expect(primaryItems(page)).toHaveText(['New workflow', 'Editor', 'Dashboard']);
  for (const item of ['Chat', 'Editor'] as const) await expect(navigationLink(page, item)).toBeVisible();
  await expect(navigationDrawer(page).locator('.stage-number, [data-build-stage]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  networkGuard.assertClean();
});
