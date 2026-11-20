// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from './fixtures';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 — local visual evidence only (never part of a certification profile): the execution-history record of each
 * state (completed, partially completed, failed, unresolved, bridge) at desktop and phone widths, with its technical details collapsed and expanded.
 * Isolated presentation fixtures only (the run-detail acceptance harness); nothing is read from a chain, signed or sent.
 *
 *   FLOFI_UX_EVIDENCE_DIR=<dir> [FLOFI_UX_EVIDENCE_LANG=PT] [FLOFI_UX_EVIDENCE_PREFIX=after]
 */
test.skip(!process.env.FLOFI_UX_EVIDENCE_DIR, 'Local evidence only (FLOFI_UX_EVIDENCE_DIR)');
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
      lib: { entry: fileURLToPath(new URL('../src/test-utils/run-detail-acceptance-harness.tsx', import.meta.url)), name: 'FloFiRunDetailAcceptance', formats: ['iife'] } } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk' && output.isEntry);
  if (!entry || entry.type !== 'chunk') throw new Error('Run Details acceptance bundle missing');
  bundle = entry.code;
});
test.beforeEach(async ({ page }) => {
  const found: string[] = []; errors.set(page, found); page.on('pageerror', error => found.push(error.message));
  await page.goto('/app/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1, exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.main').evaluate(element => getComputedStyle(element).paddingLeft)).not.toBe('0px');
  const styles = await page.locator('link[rel="stylesheet"]').evaluateAll(links => links.map(link => link.outerHTML).join(''));
  const fontClasses = await page.locator('html').getAttribute('class');
  await page.route('**/__ux006c-acceptance.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle }));
  await page.route('**/__ux006c-acceptance', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html class="${fontClasses ?? ''}" data-theme="light"><head><meta charset="utf-8">${styles}</head><body><div class="app-shell"><main class="main"><div id="acceptance-root"></div></main></div><script src="/__ux006c-acceptance.js"></script></body></html>` }));
  await page.goto('/__ux006c-acceptance');
  await page.evaluate(language => (window as unknown as { FloFiRunDetailAcceptance: { mount(element: HTMLElement, language: 'EN' | 'PT'): void } }).FloFiRunDetailAcceptance.mount(document.getElementById('acceptance-root')!, language), (process.env.FLOFI_UX_EVIDENCE_LANG === 'PT' ? 'PT' : 'EN') as 'EN' | 'PT');
  await expect(page.locator('.dashboard-run-detail')).toBeVisible();
});

test('evidence: execution history records, technical details collapsed and expanded, desktop and phone', async ({ page }) => {
  test.setTimeout(240_000);
  const dir = process.env.FLOFI_UX_EVIDENCE_DIR!, prefix = process.env.FLOFI_UX_EVIDENCE_PREFIX ?? 'after';
  mkdirSync(dir, { recursive: true });
  for (const mode of ['completed', 'partial', 'failed', 'unresolved', 'bridge-completed'] as const) {
    await page.evaluate(value => window.flofiRunDetailAcceptance.show(value), mode);
    for (const [width, height, label] of [[1440, 900, 'desktop'], [390, 844, 'mobile']] as const) {
      await page.setViewportSize({ width, height });
      const details = page.locator('.dashboard-run-detail details').last();
      if (await details.getAttribute('open') !== null) await details.locator('> summary').click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${dir}/${prefix}-history-${mode}-${label}-collapsed.png`, fullPage: true });
      await details.locator('> summary').click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${dir}/${prefix}-history-${mode}-${label}-expanded.png`, fullPage: true });
      await details.locator('> summary').click();
    }
  }
});
