// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 — regression for the post-merge red on main 0ea35d5 (CircleCI certification-browser-3, swap-read-acceptance):
 * while a runtime's availability was still being checked, the Simulate panel showed its BLOCKER layout ("not available"); when the answer arrived
 * it switched to its normal layout, and the "Technical details" the owner had opened were re-created closed. The real panel component is driven
 * through those states with its props replaced in place (no server, wallet or chain; nothing is simulated or signed).
 */
import { test, expect } from './fixtures';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { reviewNow } from '../src/test-utils/review-fixture';

let bundle: string;
const errors = new WeakMap<Page, string[]>();
test.beforeAll(async () => {
  const compiled = '../node_modules/next/dist/compiled/', aliases: Record<string, string> = {};
  for (const [name, path] of Object.entries({ 'node:crypto': 'crypto-browserify/index.js', buffer: 'buffer/index.js', 'node:buffer': 'buffer/index.js', stream: 'stream-browserify/index.js', events: 'events/events.js', string_decoder: 'string_decoder/string_decoder.js', util: 'util/util.js', vm: 'vm-browserify/index.js', process: 'process/browser.js' })) {
    aliases[name] = fileURLToPath(new URL(`${compiled}${path}`, import.meta.url));
  }
  const result = await build({ root: fileURLToPath(new URL('../../../', import.meta.url)), configFile: false, logLevel: 'error', resolve: { alias: aliases },
    define: { 'process.env.NODE_ENV': '"production"', __dirname: '"/"', global: 'globalThis' },
    build: { write: false, minify: false, rolldownOptions: { transform: { inject: { Buffer: ['buffer', 'Buffer'], process: 'process' } } },
      lib: { entry: fileURLToPath(new URL('../src/test-utils/simulate-panel-acceptance-harness.tsx', import.meta.url)), name: 'FloFiSimulatePanelAcceptance', formats: ['iife'] } } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk' && output.isEntry);
  if (!entry || entry.type !== 'chunk') throw new Error('Simulate panel acceptance bundle missing');
  bundle = entry.code;
});
test.beforeEach(async ({ page }) => {
  const found: string[] = []; errors.set(page, found); page.on('pageerror', error => found.push(error.message));
  // The fixture's simulation is valid at its own time (client clock only).
  await page.clock.install({ time: reviewNow + 10_000 });
  await page.goto('/app/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1, exact: true })).toBeVisible();
  const styles = await page.locator('link[rel="stylesheet"]').evaluateAll(links => links.map(link => link.outerHTML).join(''));
  const fontClasses = await page.locator('html').getAttribute('class');
  await page.route('**/__simulate-panel-acceptance.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle }));
  await page.route('**/__simulate-panel-acceptance', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html class="${fontClasses ?? ''}" data-theme="light"><head><meta charset="utf-8">${styles}</head><body><div class="app-shell"><main class="main"><div id="acceptance-root" style="max-width:420px"></div></main></div><script src="/__simulate-panel-acceptance.js"></script></body></html>` }));
  await page.goto('/__simulate-panel-acceptance');
  await page.evaluate(() => (window as unknown as { FloFiSimulatePanelAcceptance: { mount(element: HTMLElement): void } }).FloFiSimulatePanelAcceptance.mount(document.getElementById('acceptance-root')!));
  await expect(page.locator('.canvas-review-dock > section')).toBeVisible();
});
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

const show = (page: Page, state: 'checking' | 'blocked' | 'pending' | 'ready') => page.evaluate(value => window.flofiSimulatePanelAcceptance.show(value), state);

test('availability still being checked is never shown as a blocker, and opened Technical details survive every panel layout', async ({ page }) => {
  const panel = page.locator('.canvas-review-dock > section');
  // Checking: the waiting layout (never the blocker), with the closed control's reason; nothing claims the simulation is unavailable.
  await expect(panel).toHaveAttribute('data-review-state', 'pending');
  await expect(page.locator('.review-panel-blocked')).toHaveCount(0);
  await expect(panel.getByRole('status')).toHaveText('Checking whether simulation is available on this network…');
  await expect(panel).not.toContainText('not available');
  const technical = panel.locator('details.review-panel-technical');
  await expect(technical).not.toHaveAttribute('open', '');
  await technical.locator('summary').click();
  await expect(technical).toHaveAttribute('open', '');
  // A refused simulation uses the blocker layout; the owner's open choice stays.
  await show(page, 'blocked');
  await expect(page.locator('.review-panel-blocked')).toBeVisible();
  await expect(page.locator('.review-panel-blocked details.review-panel-technical')).toHaveAttribute('open', '');
  // Back to the waiting layout, then a valid result: still open, and its content is visible.
  await show(page, 'pending');
  await expect(panel).toHaveAttribute('data-review-state', 'pending');
  await expect(panel.locator('details.review-panel-technical')).toHaveAttribute('open', '');
  await show(page, 'ready');
  await expect(panel).toHaveAttribute('data-review-state', 'ready');
  await expect(panel.locator('details.review-panel-technical')).toHaveAttribute('open', '');
  await expect(page.getByRole('complementary', { name: 'Simulation Summary', exact: true }).getByRole('region', { name: 'Expected result' })).toHaveText('Fixture result');
  // Closing it is remembered the same way.
  await panel.locator('details.review-panel-technical > summary').click();
  await show(page, 'pending');
  await expect(panel.locator('details.review-panel-technical')).not.toHaveAttribute('open', '');
});
