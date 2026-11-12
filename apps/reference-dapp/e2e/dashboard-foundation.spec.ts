// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, assertNoFinancialCanvasAction } from './fixtures';
import { selectSettingsTheme } from './settings-fixtures';
import type { Page } from '@playwright/test';
import { closeNavigation, editorSteps, navigationDrawer, navigationLink, openBuilder, openDashboard, openEditorSection, openNavigation, reloadBuilder } from './build-entry-navigation';

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = []; pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(async ({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

test('Dashboard resolves inside the existing shell with no replacement wallet or navigation', async ({ page }) => {
  await page.goto('/app/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1, exact: true })).toBeVisible();
  await expect(page.locator('.top-bar')).toHaveCount(1);
  await expect(page.getByRole('group', { name: 'Wallet connection' })).toHaveCount(1);
  // BUILD-FLOFI-CHAT-EDITOR-UX-001 / P0 approved UX (board 03b): navigation lives in the ☰ drawer — New workflow (Chat), Editor, Dashboard (current
  // here); Simulate and Execute are the Editor's sections (its stepper is not shown on the Dashboard).
  await expect(editorSteps(page)).toHaveCount(0);
  const navigation = await openNavigation(page);
  await expect(navigation.getByRole('link').first()).toHaveText('New workflow');
  await expect(navigationLink(page, 'Editor')).toBeVisible();
  await expect(navigationLink(page, 'Dashboard')).toHaveAttribute('aria-current', 'page');
  await expect(navigationDrawer(page).getByRole('link', { name: /^(Simulate|Execute)$/ })).toHaveCount(0);
  await closeNavigation(page);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(1);
  await expect(page.getByRole('status')).toContainText('Connect your wallet to view your execution history');
  await expect(page.locator('.dashboard-run-list')).toHaveCount(0);
});

test('Build, Simulate and Execute retain their current workflow through Dashboard navigation', async ({ page }) => {
  await page.addInitScript(() => {
    const methods: string[] = [];
    Object.assign(window, { dashboardWalletMethods: methods, ethereum: { isMetaMask: true,
      async request({ method }: { method: string }) {
        methods.push(method);
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111'];
        if (method === 'eth_chainId') return '0x14a34';
        throw new Error(`Unexpected wallet method: ${method}`);
      }, on() {}, removeListener() {} } });
  });
  await openBuilder(page);
  await expect(page.locator('.build009-wallet-info')).toBeVisible();
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  const amount = page.getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  await expect(amount).toBeVisible();
  await amount.fill('2.5'); await amount.press('Enter');
  await openDashboard(page);
  await expect(page).toHaveURL(/\/app\/dashboard$/);
  await expect(page.getByRole('button', { name: 'Verify wallet for history', exact: true })).toBeVisible();
  await expect(page.locator('.dashboard-run-list')).toHaveCount(0);
  await page.getByRole('button', { name: 'Build workflow', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(amount).toHaveValue('2.5');
  // This navigation fixture configures no swap runtime. Keep its simulation gate closed and visit the stage without executing it.
  await expect(page.getByRole('button', { name: 'Simulate workflow', exact: true })).toBeDisabled();
  await openEditorSection(page, 'Simulate');
  await expect(page.locator('#simulation-review')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Simulation workflow graph', exact: true }).locator('.composer-amount')).toHaveText('2.5 USDC');
  await openDashboard(page);
  await openEditorSection(page, 'Simulate');
  await expect(page.locator('#simulation-review')).toBeVisible();
  await openEditorSection(page, 'Execute');
  await assertNoFinancialCanvasAction(page);
  await expect(page.getByRole('region', { name: 'Execution workflow graph', exact: true }).locator('.composer-amount')).toHaveText('2.5 USDC');
  await openDashboard(page);
  await page.goBack();
  await assertNoFinancialCanvasAction(page);
  expect(await page.evaluate(() => (window as unknown as { dashboardWalletMethods: string[] }).dashboardWalletMethods.filter(method => /send|sign/i.test(method)))).toEqual([]);
});

test('run-detail deep links and refresh stay inside the canonical wallet-scoped shell', async ({ page }) => {
  await page.goto('/app/dashboard/runs/absent-owned-run');
  await expect(page.getByRole('heading', { name: 'Connect the wallet used for this execution' })).toBeVisible();
  await expect(page.locator('.top-bar')).toHaveCount(1);
  await reloadBuilder(page);
  await expect(page.getByRole('heading', { name: 'Connect the wallet used for this execution' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Authorize in wallet', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to Dashboard' }).click();
  await expect(page).toHaveURL(/\/app\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1, exact: true })).toBeVisible();
});

for (const theme of ['light', 'dark']) test(`${theme} Dashboard inherits FloFi surfaces without a separate palette`, async ({ page }) => {
  await page.goto('/app/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await selectSettingsTheme(page, theme === 'light' ? 'Light' : 'Dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  expect(await page.locator('.dashboard-empty').evaluate(element => {
    const sample = document.createElement('div'); sample.style.backgroundColor = 'var(--paper)'; document.body.append(sample);
    const matches = getComputedStyle(sample).backgroundColor === getComputedStyle(element).backgroundColor; sample.remove(); return matches;
  })).toBe(true);
  await page.screenshot({ path: `.tmp/ux006a-dashboard-${theme}.png`, fullPage: true });
  for (const width of [1440, 1024, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1, exact: true })).toBeVisible();
  }
});
