// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from './fixtures';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

// The real portfolio component with explicit presentation fixtures. No real balance provider or wallet is called.
let bundle: string, css: string;
const errors = new WeakMap<Page, string[]>();
test.beforeAll(async () => {
  const compiled = '../node_modules/next/dist/compiled/', aliases: Record<string, string> = {};
  for (const [name, path] of Object.entries({ 'node:crypto': 'crypto-browserify/index.js', buffer: 'buffer/index.js', 'node:buffer': 'buffer/index.js', stream: 'stream-browserify/index.js', events: 'events/events.js', string_decoder: 'string_decoder/string_decoder.js', util: 'util/util.js', vm: 'vm-browserify/index.js', process: 'process/browser.js' })) {
    aliases[name] = fileURLToPath(new URL(`${compiled}${path}`, import.meta.url));
  }
  const result = await build({ root: fileURLToPath(new URL('../../../', import.meta.url)), configFile: false, logLevel: 'error', resolve: { alias: aliases },
    plugins: [{ name: 'isolated-portfolio-provider', enforce: 'pre', resolveId(id) { if (id.endsWith('/app/portfolio-action')) return '\0portfolio-provider'; },
      load(id) { if (id === '\0portfolio-provider') return 'export const walletPortfolio = () => { throw Error("Unexpected production portfolio read"); };'; } }],
    define: { 'process.env.NODE_ENV': '"production"', __dirname: '"/"', global: 'globalThis' },
    build: { write: false, minify: false, rolldownOptions: { transform: { inject: { Buffer: ['buffer', 'Buffer'], process: 'process' } } },
      lib: { entry: fileURLToPath(new URL('../src/test-utils/portfolio-acceptance-harness.tsx', import.meta.url)), name: 'FloFiPortfolioAcceptance', formats: ['iife'] } } });
  const output = (Array.isArray(result) ? result : [result]).flatMap(result => 'output' in result ? result.output : []);
  const entry = output.find(item => item.type === 'chunk' && item.isEntry);
  if (!entry || entry.type !== 'chunk') throw new Error('Portfolio acceptance bundle missing');
  bundle = entry.code;
  css = output.flatMap(item => item.type === 'asset' && item.fileName.endsWith('.css') ? [typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source)] : []).join('\n');
});
test.beforeEach(async ({ page }) => {
  const found: string[] = []; errors.set(page, found); page.on('pageerror', error => found.push(error.message));
  await page.goto('/app/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1, exact: true })).toBeVisible();
  await page.route('**/__portfolio-ux004.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle }));
  await page.addStyleTag({ content: css }); await page.addScriptTag({ url: '/__portfolio-ux004.js' });
  await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('.main')!;
    for (const child of Array.from(main.children)) (child as HTMLElement).style.display = 'none';
    const root = document.createElement('div'); root.id = 'portfolio-acceptance-root'; main.append(root);
    (window as unknown as { FloFiPortfolioAcceptance: { mount(element: HTMLElement): void } }).FloFiPortfolioAcceptance.mount(root);
  });
  await expect(page.locator('#portfolio-acceptance-root [data-portfolio="ready"]')).toBeVisible();
});
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });
const portfolio = (page: Page) => page.locator('#portfolio-acceptance-root');
/**
 * P0 approved UX (board 10): "Your wallet" shows the total and the top holdings; the assets table and the allocation by network (bars, no chart)
 * open behind "View all assets", and the pricing notes sit in the collapsed "About the values". This opens the assets when they are closed.
 */
async function showAssets(page: Page) {
  const view = portfolio(page).getByRole('button', { name: 'View all assets', exact: true });
  if (await view.isVisible()) await view.click();
  await expect(portfolio(page).getByRole('button', { name: 'Hide details', exact: true })).toBeVisible();
}
/** BUILD-FLOFI-UX-005: the network filter is a FloFi listbox button (not a native select). */
const filterButton = (page: Page) => portfolio(page).getByRole('button', { name: /^Network filter/ });
async function chooseNetwork(page: Page, name: string) {
  await filterButton(page).click();
  const list = portfolio(page).getByRole('listbox', { name: 'Network filter' });
  await expect(list).toBeVisible();
  await list.getByRole('option', { name, exact: true }).click();
  await expect(list).toHaveCount(0);
  await expect(filterButton(page)).toHaveAccessibleName(`Network filter ${name}`);
}

test('real presentation shows partial pricing, all represented networks, exact allocation and a complete assets breakdown', async ({ page }) => {
  const root = portfolio(page);
  await expect(root).toContainText('≈ $9,600.00'); await expect(root).toContainText('4 of 5 holdings priced');
  await expect(root).toContainText('1 holding has no available valuation.');
  await expect(root.getByRole('list', { name: 'Top holdings' })).toBeVisible();
  await showAssets(page);
  const allocations = root.getByRole('region', { name: 'Allocation by network' });
  await expect(allocations).toContainText('Ethereum'); await expect(allocations).toContainText('Base'); await expect(allocations).toContainText('Arbitrum One');
  await expect(allocations).toContainText('Robinhood Chain'); await expect(allocations).toContainText('Solana'); await expect(allocations).toContainText('Valuation unavailable');
  // Largest-remainder rounding assigns Base the final tenth so the displayed shares total 100%.
  for (const share of ['62.5%', '26.1%', '10.4%', '1%']) await expect(allocations).toContainText(share);
  await page.evaluate(() => window.flofiPortfolioAcceptance.mode('full'));
  await expect(root).toContainText('5 of 5 holdings priced'); await expect(root).toContainText('≈ $10,100.00');
  await showAssets(page);
  await expect(allocations).not.toContainText('Valuation unavailable');
  await page.evaluate(() => window.flofiPortfolioAcceptance.mode('partial'));
  await expect(root).toContainText('4 of 5 holdings priced');
  await chooseNetwork(page, 'Solana');
  await expect(root).toContainText('No verified USD price for these assets.'); await expect(root).not.toContainText('$0');
  await showAssets(page);
  await expect(root.getByRole('table')).toContainText('SOL'); await expect(root.getByRole('table')).toContainText('Valuation unavailable');
  await root.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(root.getByRole('button', { name: 'View all assets', exact: true })).toBeFocused();
  await chooseNetwork(page, 'Base');
  await expect(root).toContainText('≈ $2,500.00'); await showAssets(page); await expect(allocations).toContainText('100%');
  await expect(root).toContainText('1 of 1 holdings priced');
});

test('empty, unavailable, single-network and all-unpriced states never fabricate values', async ({ page }) => {
  const root = portfolio(page);
  await page.evaluate(() => window.flofiPortfolioAcceptance.mode('empty'));
  await expect(root).toContainText('No balances found on the networks read.'); await expect(root.getByRole('table')).toHaveCount(0);
  await page.evaluate(() => window.flofiPortfolioAcceptance.mode('unpriced'));
  await expect(root).toContainText('No verified USD price for these assets.'); await expect(root).not.toContainText('$0');
  await showAssets(page);
  await expect(root.getByRole('region', { name: 'Allocation by network' })).toContainText('Valuation unavailable');
  await page.evaluate(() => window.flofiPortfolioAcceptance.mode('single'));
  await expect(root).toContainText('≈ $6,000.00'); await showAssets(page); await expect(root.getByRole('region', { name: 'Allocation by network' })).toContainText('100%');
  await expect(filterButton(page)).toHaveCount(0);
  await page.evaluate(() => window.flofiPortfolioAcceptance.mode('failure'));
  await expect(root.getByRole('alert')).toContainText('Wallet balances are unavailable right now.'); await expect(root).not.toContainText('$');
  await expect(root.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('the network filter follows the FloFi controls and works by keyboard, outside click and Escape', async ({ page }) => {
  const root = portfolio(page), button = filterButton(page);
  await expect(root.locator('select')).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(button).toHaveAccessibleName('Network filter All networks');
  // P0 approved UX (board 10): the filter is a field-style control (40 px, 12 px corners, 1 px border), beside the small Refresh button.
  const own = await button.evaluate(node => { const style = getComputedStyle(node);
    return { height: Math.round(node.getBoundingClientRect().height), radius: style.borderRadius, border: style.borderTopWidth }; });
  expect(own).toEqual({ height: 40, radius: '12px', border: '1px' });
  await expect(root.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  // Keyboard: arrows open on the current value and move; Enter chooses; focus returns to the button.
  await button.focus(); await page.keyboard.press('ArrowDown');
  const list = root.getByRole('listbox', { name: 'Network filter' });
  await expect(list).toBeFocused();
  await expect(list.getByRole('option', { selected: true })).toHaveText('All networks');
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0); await expect(button).toBeFocused();
  await expect(button).toHaveAccessibleName('Network filter Solana');
  await expect(root).toContainText('No verified USD price for these assets.');
  // Escape and a click outside close it without changing the value.
  await page.keyboard.press('Enter'); await expect(list).toBeVisible();
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0); await expect(button).toBeFocused(); await expect(button).toHaveAccessibleName('Network filter Solana');
  await button.click(); await expect(list).toBeVisible();
  await root.getByRole('heading', { name: 'Your wallet' }).click(); await expect(list).toHaveCount(0);
  await chooseNetwork(page, 'All networks');
  await expect(root).toContainText('4 of 5 holdings priced');
  await button.click(); await expect(list).toBeVisible();
  await root.screenshot({ path: '/tmp/flofi-ux005-network-filter-1440.png' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await root.screenshot({ path: '/tmp/flofi-ux005-network-filter-1440-dark.png' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.keyboard.press('Escape');
  // The open menu stays inside a phone's width.
  await page.setViewportSize({ width: 320, height: 900 });
  await button.click(); await expect(list).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await list.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  await root.screenshot({ path: '/tmp/flofi-ux005-network-filter-320.png' });
  await page.keyboard.press('Escape');
});

test('refresh calls the provider, reports stale data honestly and recovers', async ({ page }) => {
  const root = portfolio(page), before = await page.evaluate(() => window.flofiPortfolioAcceptance.requests());
  await page.evaluate(() => window.flofiPortfolioAcceptance.failNext());
  await root.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(root.getByRole('alert')).toContainText('Refresh failed. Showing the last available balances');
  await expect(root).toContainText('≈ $9,600.00');
  await root.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(root.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.flofiPortfolioAcceptance.requests())).toBe(before + 2);
});

test('portfolio fits desktop and mobile, retains themes, and localizes Portuguese', async ({ page }) => {
  const root = portfolio(page);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1440, 1024, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(root.getByRole('button', { name: 'View all assets', exact: true })).toBeVisible();
      if (width === 1440 || width === 320) await root.screenshot({ path: `/tmp/flofi-ux004-portfolio-${theme}-${width}.png` });
    }
  }
  await page.evaluate(() => window.flofiPortfolioAcceptance.language('PT'));
  await expect(root).toContainText('Sua carteira'); await expect(root).toContainText('≈ US$ 9.600,00');
  await expect(root.getByRole('button', { name: 'Ver todos os ativos', exact: true })).toBeVisible();
  await root.getByRole('button', { name: 'Ver todos os ativos', exact: true }).click();
  await expect(root.getByRole('table')).toContainText('Saldo');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
