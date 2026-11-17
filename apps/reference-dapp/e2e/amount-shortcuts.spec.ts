// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (UX-02): 25% · 50% · 75% · Max under FloFi's amount question, in a real browser with the real component
 * and explicit balance fixtures (the portfolio server action is replaced by the page's fixture: no provider, wallet, signature or execution).
 * A pick only writes the amount as the person's answer; the figures are exact base-unit math rounded down; a native Max keeps the fee reserve;
 * an unknown balance or a missing wallet disables every shortcut with its reason; a stale balance is read again and never sent unchecked.
 */
import { test, expect } from './fixtures';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

let bundle: string, css: string;
const errors = new WeakMap<Page, string[]>();
test.beforeAll(async () => {
  const compiled = '../node_modules/next/dist/compiled/', aliases: Record<string, string> = {};
  for (const [name, path] of Object.entries({ 'node:crypto': 'crypto-browserify/index.js', buffer: 'buffer/index.js', 'node:buffer': 'buffer/index.js', stream: 'stream-browserify/index.js', events: 'events/events.js', string_decoder: 'string_decoder/string_decoder.js', util: 'util/util.js', vm: 'vm-browserify/index.js', process: 'process/browser.js' })) {
    aliases[name] = fileURLToPath(new URL(`${compiled}${path}`, import.meta.url));
  }
  const result = await build({ root: fileURLToPath(new URL('../../../', import.meta.url)), configFile: false, logLevel: 'error', resolve: { alias: aliases },
    plugins: [{ name: 'fixture-portfolio-provider', enforce: 'pre', resolveId(id) { if (id.endsWith('/app/portfolio-action')) return '\0portfolio-fixture'; },
      load(id) { if (id === '\0portfolio-fixture') return 'export const walletPortfolio = input => window.__flofiAmountShortcutsPortfolio(input);'; } }],
    define: { 'process.env.NODE_ENV': '"production"', __dirname: '"/"', global: 'globalThis' },
    build: { write: false, minify: false, rolldownOptions: { transform: { inject: { Buffer: ['buffer', 'Buffer'], process: 'process' } } },
      lib: { entry: fileURLToPath(new URL('../src/test-utils/amount-shortcuts-acceptance-harness.tsx', import.meta.url)), name: 'FloFiAmountShortcuts', formats: ['iife'] } } });
  const output = (Array.isArray(result) ? result : [result]).flatMap(result => 'output' in result ? result.output : []);
  const entry = output.find(item => item.type === 'chunk' && item.isEntry);
  if (!entry || entry.type !== 'chunk') throw new Error('Amount shortcuts acceptance bundle missing');
  bundle = entry.code;
  css = output.flatMap(item => item.type === 'asset' && item.fileName.endsWith('.css') ? [typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source)] : []).join('\n');
});
test.beforeEach(async ({ page }) => {
  const found: string[] = []; errors.set(page, found); page.on('pageerror', error => found.push(error.message));
  await page.clock.install({ time: new Date('2026-11-17T12:00:05.000Z') });
  await page.goto('/app/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1, exact: true })).toBeVisible();
  await page.route('**/__amount-shortcuts.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle }));
  await page.addStyleTag({ content: css }); await page.addScriptTag({ url: '/__amount-shortcuts.js' });
  await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('.main')!;
    for (const child of Array.from(main.children)) (child as HTMLElement).style.display = 'none';
    const root = document.createElement('div'); root.id = 'amount-shortcuts-root'; root.style.maxWidth = '420px'; main.append(root);
    (window as unknown as { FloFiAmountShortcuts: { mount(element: HTMLElement): void } }).FloFiAmountShortcuts.mount(root);
  });
});
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });
const group = (page: Page) => page.getByRole('group', { name: 'Amount shortcuts' });
const shortcut = (page: Page, key: string) => group(page).locator(`[data-shortcut="${key}"]`);
const note = (page: Page) => page.locator('#amount-shortcuts-root .amount-shortcuts-note');
const picks = (page: Page) => page.evaluate(() => window.flofiAmountShortcuts.picks());
const set = (page: Page, next: Record<string, unknown>) => page.evaluate(value => window.flofiAmountShortcuts.set(value as never), next);

test('a token balance gives exact, rounded-down amounts; a pick only writes that amount as the answer', async ({ page }) => {
  await expect(shortcut(page, '25')).toHaveAccessibleName('Use 25% of your balance: 0.625 USDC');
  await expect(shortcut(page, '50')).toHaveAccessibleName('Use 50% of your balance: 1.25 USDC');
  await expect(shortcut(page, '75')).toHaveAccessibleName('Use 75% of your balance: 1.875 USDC');
  await expect(shortcut(page, 'MAX')).toHaveAccessibleName('Use your maximum: 2.5 USDC');
  await expect(shortcut(page, 'MAX')).toContainText('Max');
  await expect(shortcut(page, '75')).toContainText('1.875 USDC');
  await expect(note(page)).toContainText('2.5 USDC');
  await expect(note(page)).toContainText('Nothing is signed: you still simulate and review.');
  expect(await picks(page)).toEqual([]);
  await shortcut(page, '50').click();
  expect(await picks(page)).toEqual(['1.25']);
  // Rounded down at the token's six decimals, never up: 75% of 0.000003 USDC is 0.000002.
  await set(page, { asset: 'SOL', units: '3' }); // another asset remounts the shortcuts (a new question)
  await set(page, { asset: 'USDC' });
  await expect(shortcut(page, '25')).toBeDisabled();
  await expect(shortcut(page, '75')).toHaveAccessibleName('Use 75% of your balance: 0.000002 USDC');
  await page.screenshot({ path: test.info().outputPath('amount-shortcuts-usdc.png') });
});

test('a native SOL Max keeps the network fee reserve, and below it nothing is offered', async ({ page }) => {
  await set(page, { asset: 'SOL', units: '1000000000' });
  await expect(shortcut(page, 'MAX')).toHaveAccessibleName('Use your maximum: 0.99 SOL');
  await expect(shortcut(page, '25')).toHaveAccessibleName('Use 25% of your balance: 0.25 SOL');
  await expect(note(page)).toContainText('Max keeps 0.01 SOL for network fees.');
  await shortcut(page, 'MAX').click();
  expect(await picks(page)).toEqual(['0.99']);
  await set(page, { asset: 'USDC' }); await set(page, { asset: 'SOL', units: '5000000' });
  await expect(note(page)).toContainText('0.005 SOL');
  for (const key of ['25', '50', '75', 'MAX']) await expect(shortcut(page, key)).toBeDisabled();
});

test('an unknown balance or a missing wallet disables every shortcut with its reason; nothing is estimated', async ({ page }) => {
  await set(page, { status: 'UNAVAILABLE' });
  await expect(note(page)).toHaveText('Your balance could not be read. Type an amount instead.');
  for (const key of ['25', '50', '75', 'MAX']) await expect(shortcut(page, key)).toBeDisabled();
  await set(page, { status: 'READ', owner: null });
  await expect(note(page)).toHaveText('Connect the wallet that will sign to use your balance. You can still type an amount.');
  for (const key of ['25', '50', '75', 'MAX']) await expect(shortcut(page, key)).toBeDisabled();
  expect(await picks(page)).toEqual([]);
});

test('a balance read more than 30 seconds ago is read again before a pick, and a changed amount is never sent', async ({ page }) => {
  await expect(shortcut(page, '50')).toHaveAccessibleName('Use 50% of your balance: 1.25 USDC');
  const before = await page.evaluate(() => window.flofiAmountShortcuts.requests());
  await set(page, { units: '4000000' }); // the wallet's balance changed after the read
  await page.clock.fastForward(31_000);
  await shortcut(page, '50').click();
  await expect(note(page)).toHaveText('Your balance changed. Check the amounts and choose again.');
  expect(await page.evaluate(() => window.flofiAmountShortcuts.requests())).toBe(before + 1);
  expect(await picks(page)).toEqual([]);
  await expect(shortcut(page, '50')).toHaveAccessibleName('Use 50% of your balance: 2 USDC');
  // FloFi stopped waiting for this amount while the balance was read again: nothing is sent (never an answer to another question).
  await set(page, { open: false });
  await page.clock.fastForward(31_000);
  await shortcut(page, '50').click();
  await expect(shortcut(page, '50')).toBeEnabled();
  expect(await picks(page)).toEqual([]);
  await set(page, { open: true });
  await shortcut(page, '50').click();
  expect(await picks(page)).toEqual(['2']);
});

test('Portuguese, phones, touch targets and the dark theme', async ({ page }) => {
  await page.evaluate(() => window.flofiAmountShortcuts.language('PT'));
  const pt = page.getByRole('group', { name: 'Atalhos de valor' });
  // Portuguese separators for people (2,5); the answer sent stays the canonical "2.5".
  await expect(pt.locator('[data-shortcut="MAX"]')).toHaveAccessibleName('Usar o máximo: 2,5 USDC');
  await expect(pt.locator('[data-shortcut="75"]')).toContainText('1,875 USDC');
  await expect(pt.locator('[data-shortcut="MAX"]')).toContainText('Máx');
  await expect(note(page)).toContainText('Nada é assinado: você ainda simula e revisa.');
  await page.setViewportSize({ width: 360, height: 760 });
  for (const key of ['25', '50', '75', 'MAX']) expect((await pt.locator(`[data-shortcut="${key}"]`).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await expect(pt.locator('[data-shortcut="50"]')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('amount-shortcuts-pt-dark-360.png') });
});
