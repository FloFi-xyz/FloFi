// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from './fixtures';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

// Exercise the actual Dashboard components with explicit read-only browser fixtures.
let bundle: string, bundleCss: string;
const errors = new WeakMap<Page, string[]>();
test.beforeAll(async () => {
  const compiled = '../node_modules/next/dist/compiled/';
  const aliases: Record<string, string> = {};
  for (const [name, path] of Object.entries({ 'node:crypto': 'crypto-browserify/index.js', buffer: 'buffer/index.js', 'node:buffer': 'buffer/index.js', stream: 'stream-browserify/index.js', events: 'events/events.js', string_decoder: 'string_decoder/string_decoder.js', util: 'util/util.js', vm: 'vm-browserify/index.js', process: 'process/browser.js' })) {
    aliases[name] = fileURLToPath(new URL(`${compiled}${path}`, import.meta.url));
  }
  const result = await build({ root: fileURLToPath(new URL('../../../', import.meta.url)), configFile: false, logLevel: 'error', resolve: { alias: aliases },
    define: { 'process.env.NODE_ENV': '"production"', __dirname: '"/"', global: 'globalThis' },
    build: { write: false, minify: false, rolldownOptions: { transform: { inject: { Buffer: ['buffer', 'Buffer'], process: 'process' } } },
      lib: { entry: fileURLToPath(new URL('../src/test-utils/dashboard-acceptance-harness.tsx', import.meta.url)), name: 'FloFiDashboardAcceptance', formats: ['iife'] } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []);
  const entry = outputs.find(output => output.type === 'chunk' && output.isEntry);
  bundleCss = outputs.filter(output => output.type === 'asset' && output.fileName.endsWith('.css')).map(output => output.type === 'asset' ? String(output.source) : '').join('\n');
  if (!entry || entry.type !== 'chunk') throw new Error('Dashboard acceptance bundle missing');
  bundle = entry.code;
});
test.beforeEach(async ({ page }) => {
  const found: string[] = []; errors.set(page, found);
  page.on('pageerror', error => found.push(error.message));
  await page.goto('/app/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1, exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.main').evaluate(element => getComputedStyle(element).paddingLeft)).not.toBe('0px');
  const fontClasses = await page.locator('html').getAttribute('class');
  const styles = await page.locator('link[rel="stylesheet"]').evaluateAll(links => links.map(link => link.outerHTML).join(''));
  await page.route('**/__ux006b-acceptance.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle }));
  await page.route('**/__ux006b-acceptance', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html class="${fontClasses ?? ''}" data-theme="light"><head><meta charset="utf-8">${styles}</head><body><div class="app-shell"><main class="main"><div id="acceptance-root"></div></main></div><script src="/__ux006b-acceptance.js"></script></body></html>` }));
  await page.goto('/__ux006b-acceptance');
  await page.addStyleTag({ content: bundleCss });
  await page.evaluate(() => (window as unknown as { FloFiDashboardAcceptance: { mount(element: HTMLElement): void } }).FloFiDashboardAcceptance.mount(document.getElementById('acceptance-root')!));
  await expect(page.locator('.dashboard-current')).toBeVisible();
});
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

/** P0 approved UX (board 11): Your workflows' records are ONE list behind filter chips (All, Needs attention, Saved, Executed). */
async function filterRecords(page: Page, chip: 'All' | 'Needs attention' | 'Saved' | 'Executed') {
  await page.getByRole('group', { name: 'Filter workflows', exact: true }).getByRole('button', { name: new RegExp(`^${chip}`) }).click();
  return page.locator('.ux-workflow-list');
}

test('current execution and saved cards retain status, evidence and distinct review actions', async ({ page }) => {
  const current = page.getByRole('region', { name: 'Current execution', exact: true });
  await expect(current).toContainText('Unresolved');
  await expect(current.locator('.dashboard-run-message')).toBeHidden();
  await current.getByRole('button', { name: /^Show details for / }).click();
  await expect(current.locator('.dashboard-run-message')).toBeVisible();
  await expect(current).toContainText('0 of 1 step confirmed');
  // BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the Dashboard summarizes the records; the history itself is in Your workflows. P0 approved UX (board 10):
  // "Needs you" lists the records that need the owner (never the current run again) and History is one line.
  const needs = page.getByRole('region', { name: 'Needs you', exact: true });
  await expect(needs.getByRole('listitem')).toHaveCount(2);
  await expect(needs.locator('.ux-count')).toHaveAccessibleName('2 records need you');
  await expect(page.getByRole('region', { name: 'History', exact: true })).toContainText('1 workflow executed');
  await expect(page.locator('.dashboard-run-list')).toHaveCount(0);
  await expect(page.locator('.ux-record-current')).toHaveCount(1);
  await current.getByRole('link').focus(); await current.getByRole('link').press('Enter');
  await expect(page.locator('.dashboard-result-summary')).toContainText('Unresolved');
  await expect(page.getByRole('button', { name: 'Open current execution', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.flofiDashboardAcceptance.counts().executed)).toBe(0);
  await page.getByRole('button', { name: 'Back to Dashboard' }).click();
  await page.evaluate(() => window.flofiDashboardAcceptance.view('records'));
  // Each run is listed once: executed history, or the records that need attention (unresolved, incomplete or in progress).
  await filterRecords(page, 'Executed');
  await expect(page.getByRole('list', { name: 'Executed', exact: true }).getByRole('listitem')).toHaveCount(1);
  await filterRecords(page, 'Needs attention');
  const attention = page.getByRole('list', { name: 'Needs attention', exact: true });
  await expect(attention.getByRole('listitem')).toHaveCount(3);
  for (const row of await attention.locator('.ux-record').all()) await row.getByRole('button', { name: /^Show details for / }).click();
  await expect(attention).toContainText('Execution status unresolved');
  await expect(attention).toContainText('Review the incomplete action');
  await expect(page.locator('.ux-record')).toHaveCount(3);
  await filterRecords(page, 'All');
  await expect(page.getByRole('list', { name: 'All', exact: true }).getByRole('listitem')).toHaveCount(4);
  // The completed run is the one executed record (its row's Open names the workflow).
  await filterRecords(page, 'Executed');
  await page.getByRole('list', { name: 'Executed', exact: true }).getByRole('link', { name: 'Open record: Swap', exact: true }).click();
  await expect(page.locator('.dashboard-result-summary')).toContainText('Completed');
  await expect(page.getByRole('button', { name: 'Open current execution', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Authorize in wallet', exact: true })).toHaveCount(0);
});

test('loading, verification and unavailable history preserve the current execution and its attention', async ({ page }) => {
  for (const mode of ['loading', 'verify', 'unavailable', 'not-configured', 'current-only'] as const) {
    await page.evaluate(value => window.flofiDashboardAcceptance.mode(value), mode);
    await expect(page.locator('.dashboard-current')).toBeVisible();
    await expect(page.locator('.dashboard-current')).toContainText('Unresolved');
    await expect(page.getByRole('region', { name: 'History', exact: true })).toBeVisible();
    await expect(page.getByText('No workflows executed yet', { exact: true })).toHaveCount(0);
  }
  await page.evaluate(() => window.flofiDashboardAcceptance.view('records'));
  for (const mode of ['loading', 'verify', 'unavailable', 'not-configured', 'current-only'] as const) {
    await page.evaluate(value => window.flofiDashboardAcceptance.mode(value), mode);
    await filterRecords(page, 'Needs attention');
    const attention = page.getByRole('list', { name: 'Needs attention', exact: true });
    const disclosure = attention.getByRole('button', { name: /^Show details for / });
    if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click();
    await expect(attention.locator('.dashboard-run-message')).toBeVisible();
    await expect(attention).toContainText('Execution status unresolved');
    // Board 11: "No workflows executed yet" is claimed only where the records were read and none is executed.
    await filterRecords(page, 'Executed');
    if (mode === 'current-only') await expect(page.locator('.ux-list-empty')).toHaveText('No workflows executed yet');
    else await expect(page.getByText('No workflows executed yet', { exact: true })).toHaveCount(0);
  }
  await page.evaluate(() => window.flofiDashboardAcceptance.view('dashboard'));
  await page.evaluate(() => window.flofiDashboardAcceptance.mode('verify'));
  await page.getByRole('button', { name: 'Verify wallet for history', exact: true }).click();
  expect(await page.evaluate(() => window.flofiDashboardAcceptance.counts().verified)).toBe(1);
  await page.evaluate(() => window.flofiDashboardAcceptance.mode('unavailable'));
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
  expect(await page.evaluate(() => window.flofiDashboardAcceptance.counts().refreshed)).toBe(1);
  expect(await page.evaluate(() => window.flofiDashboardAcceptance.counts().executed)).toBe(0);
});

test('verified empty and disconnected states have no fabricated history or financial values', async ({ page }) => {
  await page.evaluate(() => { window.flofiDashboardAcceptance.mode('empty'); window.flofiDashboardAcceptance.view('records'); });
  await expect(page.locator('.ux-list-empty')).toHaveText('No workflows executed yet');
  await expect(page.locator('.ux-record')).toHaveCount(0);
  await filterRecords(page, 'Needs attention');
  await expect(page.locator('.ux-list-empty')).toContainText('No available runs need attention');
  // P0 approved UX (board 10): with nothing in progress the Dashboard's Current execution offers the one way to start, Create workflow.
  await page.evaluate(() => window.flofiDashboardAcceptance.view('dashboard'));
  await expect(page.locator('.dashboard-current')).toContainText('No execution in progress.');
  await page.locator('.dashboard-current').getByRole('button', { name: 'Create workflow', exact: true }).click();
  expect(await page.evaluate(() => window.flofiDashboardAcceptance.counts().built)).toBe(1);
  await page.evaluate(() => { window.flofiDashboardAcceptance.mode('disconnected'); window.flofiDashboardAcceptance.view('dashboard'); });
  await expect(page.getByRole('status')).toContainText('Connect your wallet to view your execution history');
  await expect(page.locator('.ux-panel-attention,.dashboard-current,.ux-history')).toHaveCount(0);
  expect(await page.locator('.dashboard-workspace').innerText()).not.toMatch(/\$|APY|PnL|0 ETH|0 USDC/);
});

for (const theme of ['light', 'dark'] as const) test(`${theme} Dashboard cards, attention, details and long titles fit wide and narrow widths`, async ({ page }) => {
  await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
  // The in-progress record is listed under Needs attention in Your workflows.
  await page.evaluate(() => window.flofiDashboardAcceptance.view('records'));
  const colors = await page.locator('.dashboard-status-progress').evaluate(element => {
    const sample = document.createElement('span'); sample.style.color = 'var(--accent-ink)'; document.body.append(sample);
    const status = getComputedStyle(element).color, token = getComputedStyle(sample).color; sample.remove(); return { status, token };
  });
  expect(colors.status).toBe(colors.token);
  await page.evaluate(() => window.flofiDashboardAcceptance.view('dashboard'));
  // Board 10: what needs the owner and the current execution first, then the one line of history, at every width.
  for (const width of [1440, 1024, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const current = await page.locator('.dashboard-current').boundingBox(), records = await page.locator('.ux-history').boundingBox();
    expect(current).not.toBeNull(); expect(records).not.toBeNull();
    expect(current!.y + current!.height).toBeLessThan(records!.y);
  }
  // Your workflows: the filter chips, then one list (records that need attention first), at every width.
  await page.evaluate(() => window.flofiDashboardAcceptance.view('records'));
  for (const width of [1440, 1024, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const chips = await page.getByRole('group', { name: 'Filter workflows', exact: true }).boundingBox(), list = await page.locator('.ux-workflow-rows').boundingBox();
    expect(chips).not.toBeNull(); expect(list).not.toBeNull();
    expect(chips!.y + chips!.height).toBeLessThan(list!.y);
  }
  await page.evaluate(() => window.flofiDashboardAcceptance.view('dashboard'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: `.tmp/ux006b-dashboard-${theme}.png`, fullPage: true });
  await page.evaluate(() => window.flofiDashboardAcceptance.longTitle());
  await page.setViewportSize({ width: 320, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.dashboard-current').getByRole('link').click();
  await expect(page.locator('.dashboard-result-summary')).toContainText('Unresolved');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByText('View technical details', { exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.tmp/ux006b-run-detail-${theme}-320.png`, fullPage: true });
});
