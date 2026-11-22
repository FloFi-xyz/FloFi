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
  await expect(page.locator('.execution-receipt')).toContainText('Unresolved');
  await expect(page.getByRole('button', { name: 'Open current execution', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.flofiDashboardAcceptance.counts().executed)).toBe(0);
  await page.getByRole('button', { name: 'Back to Dashboard' }).click();
  await page.evaluate(() => window.flofiDashboardAcceptance.view('records'));
  // Each run is listed once: executed history, or the records that need attention (unresolved, incomplete or in progress).
  await filterRecords(page, 'Executed');
  await expect(page.getByRole('list', { name: 'Executed', exact: true }).locator(':scope > li')).toHaveCount(1);
  await filterRecords(page, 'Needs attention');
  const attention = page.getByRole('list', { name: 'Needs attention', exact: true });
  await expect(attention.locator(':scope > li')).toHaveCount(3);
  for (const row of await attention.locator('.ux-record').all()) await row.getByRole('button', { name: /^Show details for / }).click();
  await expect(attention).toContainText('Execution status unresolved');
  await expect(attention).toContainText('Review the incomplete action');
  await expect(page.locator('.ux-record')).toHaveCount(3);
  await filterRecords(page, 'All');
  await expect(page.getByRole('list', { name: 'All', exact: true }).locator(':scope > li')).toHaveCount(4);
  // The completed run is the one executed record (its row's Open names the workflow).
  await filterRecords(page, 'Executed');
  await page.getByRole('list', { name: 'Executed', exact: true }).getByRole('link', { name: 'Open record: Swap', exact: true }).click();
  await expect(page.locator('.execution-receipt')).toContainText('Completed');
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
  await expect(page.locator('.execution-receipt')).toContainText('Unresolved');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.execution-receipt-technical > summary').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.tmp/ux006b-run-detail-${theme}-320.png`, fullPage: true });
});

/**
 * BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (UX-01): the Current execution card of a partially completed run — its name, its network line, the
 * "Partially completed" status, "View current run" and the ··· menu — beside "Needs you". The actions used to keep their full width on one
 * line while the name took what was left, down to a one-character column (narrow card in the split layout, browser zoom). Browser zoom is
 * modelled as the CSS viewport it leaves (width ÷ zoom).
 */
test('the Current execution card keeps its name and network readable and its actions beside or below them at every width and zoom', async ({ page }) => {
  await page.evaluate(() => window.flofiDashboardAcceptance.mode('partial-current'));
  const card = page.locator('.dashboard-current .ux-record-current');
  await expect(card.getByRole('button', { name: /^Show details for Add liquidity: WETH\/USDC/ })).toBeVisible();
  await expect(card.locator('.dashboard-status')).toHaveText('Partially completed');
  for (const width of [320, 375, 768, 1024, 1280, 1440]) for (const zoom of [0.8, 0.9, 1, 1.25]) {
    const at = `${width}px at ${zoom * 100}%`;
    await page.setViewportSize({ width: Math.round(width / zoom), height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), at).toBe(true);
    const layout = await card.evaluate(element => {
      const box = (node: Element | null) => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const name = element.querySelector('.ux-row-name span[title]')!, meta = element.querySelector('.ux-row-meta')!;
      return { card: box(element), row: box(element.querySelector('.ux-row')), column: box(element.querySelector('.ux-row-main')), name: box(name), meta: box(meta),
        nameLine: parseFloat(getComputedStyle(name).lineHeight), metaLine: parseFloat(getComputedStyle(meta).lineHeight),
        actions: [box(element.querySelector('.dashboard-status')), box(element.querySelector('a.ux-button')), box(element.querySelector('.history-actions > button'))] };
    });
    const { card: c, row, column, name, meta } = layout;
    // The name and its network line keep a readable column (never a character per line) and wrap in at most a few lines.
    // 10rem at the app's 14 px root (the CSS minimum before the actions wrap), else the width beside the icon.
    expect(column!.width, `name column ${at}`).toBeGreaterThanOrEqual(Math.min(140, row!.width - 60));
    expect(name!.width, `name width ${at}`).toBeGreaterThan(80);
    expect(Math.round(name!.height / layout.nameLine), `name lines ${at}`).toBeLessThanOrEqual(3);
    expect(Math.round(meta!.height / layout.metaLine), `network lines ${at}`).toBeLessThanOrEqual(3);
    // Status, View current run and the menu are visible, inside the card, and never on top of the name or its network line.
    for (const [index, action] of layout.actions.entries()) {
      expect(action, `action ${index} ${at}`).not.toBeNull();
      expect(action!.width, `action ${index} ${at}`).toBeGreaterThan(0);
      expect(action!.x, `action ${index} inside ${at}`).toBeGreaterThanOrEqual(c!.x - 1);
      expect(action!.right, `action ${index} inside ${at}`).toBeLessThanOrEqual(c!.right + 1);
      for (const text of [name!, meta!]) {
        const overlap = action!.x < text.right && text.x < action!.right && action!.y < text.bottom && text.y < action!.bottom;
        expect(overlap, `action ${index} over text ${at}`).toBe(false);
      }
    }
  }
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.screenshot({ path: '.tmp/ux01-current-execution-1280-125.png', fullPage: true });
});

/** UX-01: no row label spills out of its button or tag, on the Dashboard ("Needs you" and Current execution) and in Your workflows. */
test('row buttons and status tags keep their text inside at every width and zoom, on the Dashboard and in Your workflows', async ({ page }) => {
  await page.evaluate(() => window.flofiDashboardAcceptance.mode('partial-current'));
  for (const view of ['dashboard', 'records'] as const) {
    await page.evaluate(value => window.flofiDashboardAcceptance.view(value), view);
    // In the product, Your workflows is a `ux-page` section; the shared harness frame is not, so this check gives the records the product's page.
    if (view === 'records') await page.evaluate(() => document.querySelector('#acceptance-root .dashboard-workspace')?.classList.add('ux-page', 'saved-workflows'));
    for (const width of [320, 375, 768, 1280]) for (const zoom of [1, 1.25]) {
      const at = `${view} ${width}px at ${zoom * 100}%`;
      await page.setViewportSize({ width: Math.round(width / zoom), height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), at).toBe(true);
      const rows = await page.locator('.ux-page .ux-row').evaluateAll(elements => elements.filter(row => (row as HTMLElement).offsetParent).map(row => {
        const main = row.querySelector('.ux-row-main'), box = row.getBoundingClientRect();
        const spill = [...row.querySelectorAll('.ux-row-actions .ux-button, .ux-row-actions .ux-tag')]
          .filter(item => (item as HTMLElement).scrollWidth > (item as HTMLElement).clientWidth + 1 || item.getBoundingClientRect().right > box.right + 1)
          .map(item => item.textContent);
        return { text: row.textContent?.slice(0, 40), main: main ? main.getBoundingClientRect().width : null, width: box.width, spill };
      }));
      expect(rows.length, at).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.spill, `${at}: ${row.text}`).toEqual([]);
        if (row.main !== null) expect(row.main, `${at}: ${row.text}`).toBeGreaterThanOrEqual(Math.min(140, row.width - 60));
      }
    }
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`My DeFi Positions loads only on disclosure and distinguishes a disconnected wallet in ${theme} mode`, async ({ page }) => {
    const requests: string[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/dashboard/positions')) requests.push(request.url()); });
    await page.addInitScript(value => localStorage.setItem('flofi.theme', value), theme);
    await page.goto('/app/dashboard');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('heading', { name: 'My DeFi Positions' })).toBeVisible();
    expect(requests).toHaveLength(0);
    const disclosure = page.getByRole('button', { name: 'My DeFi Positions', exact: true });
    await expect(disclosure).toBeEnabled();
    await expect(disclosure).toHaveCSS('border-top-left-radius', '10px');
    await expect(disclosure).toHaveCSS('min-height', '44px');
    await expect(disclosure).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await disclosure.hover();
    await expect(disclosure).toHaveCSS('border-top-width', '0px');
    await page.mouse.move(0, 0);
    await disclosure.press('Enter');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(disclosure).toHaveCSS('outline-style', 'solid');
    await expect(disclosure).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.getByText('Connect or link a wallet to view its DeFi positions.')).toBeVisible();
    expect(requests).toHaveLength(1);
    await disclosure.press('Enter');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('Connect or link a wallet to view its DeFi positions.')).toHaveCount(0);
  });
}
