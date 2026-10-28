// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reviewNow } from '../src/test-utils/review-fixture';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = fileURLToPath(new URL('./visual-evidence/build-caio-ux-final-001/', import.meta.url));
const capture = process.env.FLOFI_CAIO_CAPTURE === '1';
let bundle: string, styles: string;
test.beforeAll(async () => {
  const before = process.env.FLOFI_CAIO_BEFORE === '1';
  if (before && !capture) throw Error('Baseline mode is restricted to explicit visual capture');
  const aliases: Record<string, string> = {};
  for (const [name, path] of Object.entries({ 'node:crypto': 'crypto-browserify/index.js', buffer: 'buffer/index.js', 'node:buffer': 'buffer/index.js', stream: 'stream-browserify/index.js', events: 'events/events.js', string_decoder: 'string_decoder/string_decoder.js', util: 'util/util.js', vm: 'vm-browserify/index.js', process: 'process/browser.js' })) aliases[name] = fileURLToPath(new URL(`../node_modules/next/dist/compiled/${path}`, import.meta.url));
  const result = await build({ root, configFile: false, logLevel: 'error', resolve: { alias: aliases },
    plugins: before ? [{ name: 'read-only-main-baseline', load(id) {
      if (!id.startsWith(root + 'apps/reference-dapp/src/')) return;
      const path = id.slice(root.length);
      // Compile original modules at their original paths, without a checkout/worktree or modifying source files.
      try { return execFileSync('git', ['show', `origin/main:${path}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return; }
    } }] : [],
    define: { 'process.env.NODE_ENV': '"production"', __dirname: '"/"', global: 'globalThis' }, build: { write: false, minify: false,
      rolldownOptions: { transform: { inject: { Buffer: ['buffer', 'Buffer'], process: 'process' } } },
      lib: { entry: fileURLToPath(new URL('../src/test-utils/caio-ux-acceptance-harness.tsx', import.meta.url)), name: 'FloFiCaioAcceptance', formats: ['iife'] } } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(result => 'output' in result ? result.output : []).find(row => row.type === 'chunk' && row.isEntry);
  if (!entry || entry.type !== 'chunk') throw Error('Missing isolated UX bundle'); bundle = entry.code;
  styles = before ? execFileSync('git', ['show', 'origin/main:apps/reference-dapp/src/app/globals.css'], { cwd: root }).toString() : await readFile(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  styles = await readFile(new URL('../src/app/base.css', import.meta.url), 'utf8') + await readFile(new URL('../src/app/fonts.css', import.meta.url), 'utf8') + styles;
  styles += await readFile(new URL('../node_modules/@xyflow/react/dist/style.css', import.meta.url), 'utf8');
});
async function open(page: Page, area: string, width = 1440, language: 'EN' | 'PT' = 'EN') {
  const errors: string[] = [], external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width, height: 1000 }); await page.clock.install({ time: reviewNow });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:3119') { external.push(url.href); await route.abort(); return; }
    if (route.request().resourceType() === 'document') await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html class="flofi-fonts" lang="${language === 'PT' ? 'pt-BR' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body><div id="fixture"></div></body></html>` });
    else if ((url.pathname.startsWith('/brand/') || url.pathname.startsWith('/fonts/'))) await route.fulfill({ path: fileURLToPath(new URL(`../public${url.pathname}`, import.meta.url)) });
    else await route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://127.0.0.1:3119/caio'); await page.addScriptTag({ content: bundle });
  await page.evaluate(({ area, language }) => (window as unknown as { FloFiCaioAcceptance: { mount(el: HTMLElement, area: string, language: string): void } }).FloFiCaioAcceptance.mount(document.getElementById('fixture')!, area, language), { area, language });
  await expect(page.locator('.caio-fixture')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return () => { expect(errors).toEqual([]); expect(external).toEqual([]); };
}
for (const area of ['simulation', 'technical', 'canvas', 'execution', 'history', 'bridge']) {
  test(`${area}: desktop/mobile bilingual financial hierarchy and visual evidence`, async ({ page }) => {
    const verify = await open(page, area, 1440);
    if (capture) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: `${evidence}/${process.env.FLOFI_CAIO_BEFORE === '1' ? 'before' : 'after'}-${area}.png`, fullPage: area !== 'canvas' });
      verify(); return;
    }
    if (area === 'simulation' || area === 'technical') {
      await expect(page.getByText('You send', { exact: true })).toBeVisible();
      await expect(page.getByText('100 USDC', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('0.025 WETH', { exact: true })).toBeVisible();
      await expect(page.getByText('Minimum received · 0.024875 WETH', { exact: true })).toBeVisible();
      await expect(page.getByText('Token approvals', { exact: true })).toBeVisible();
    }
    if (area === 'execution') {
      await expect(page.getByRole('region', { name: 'Financial outcome' })).toContainText('0.0243 WETH');
      await expect(page.getByRole('region', { name: 'Financial outcome' })).toContainText('0.0003 ETH');
    }
    if (area === 'bridge') {
      const stages = page.getByRole('region', { name: 'Bridge progress' });
      await expect(stages.getByText('Source confirmation', { exact: true })).toBeVisible();
      await expect(stages.getByText('Awaiting observation', { exact: true })).toBeVisible();
      await expect(page.getByText('Final destination amount awaits reconciliation')).toBeVisible();
    }
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const summaries = page.locator('summary');
    if (await summaries.count()) { await summaries.first().focus(); await page.keyboard.press('Enter'); await expect(summaries.first().locator('..')).toHaveAttribute('open', ''); }
    verify();
  });
}
test('cursor-anchored mouse zoom, Shift touchpad pan, Escape, page scroll and keyboard controls never move nodes', async ({ page }) => {
  const verify = await open(page, 'canvas');
  const flow = page.locator('.react-flow'), pane = page.locator('.react-flow__pane');
  const view = () => page.locator('.react-flow__viewport').evaluate(el => { const m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return { x: m.e, y: m.f, zoom: m.a }; });
  const before = await view(), node = await page.locator('.react-flow__node').getAttribute('style');
  const box = (await pane.boundingBox())!, point = { x: box.x + 500, y: box.y + 150 };
  await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, 100);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0); expect(await view()).toEqual(before);
  await page.evaluate(() => scrollTo(0, 0)); await flow.getByRole('button', { name: 'Wheel navigation' }).click();
  await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, -50);
  await expect.poll(async () => (await view()).zoom).toBeGreaterThan(before.zoom);
  const after = await view();
  expect((point.x - box.x - after.x) / after.zoom).toBeCloseTo((point.x - box.x - before.x) / before.zoom, 2);
  expect((point.y - box.y - after.y) / after.zoom).toBeCloseTo((point.y - box.y - before.y) / before.zoom, 2);
  await pane.dispatchEvent('wheel', { deltaX: 25, deltaY: 40, shiftKey: true, bubbles: true, cancelable: true });
  await expect.poll(async () => (await view()).x).toBeCloseTo(after.x - 25, 1);
  await page.keyboard.press('Escape'); await expect(flow.getByRole('button', { name: 'Wheel navigation' })).toHaveAttribute('aria-pressed', 'false');
  await flow.getByRole('button', { name: 'Zoom out', exact: true }).focus(); await page.keyboard.press('Enter');
  await flow.getByRole('button', { name: 'Fit workflow' }).click();
  expect(await page.locator('.react-flow__node').getAttribute('style')).toBe(node); verify();
});

for (const area of ['simulation', 'technical', 'canvas', 'execution', 'history', 'bridge']) test(`${area}: PT-BR mobile labels and accessible disclosures`, async ({ page }) => {
  const verify = await open(page, area, 375, 'PT');
  if (area === 'simulation' || area === 'technical') await expect(page.getByText('Você envia', { exact: true })).toBeVisible();
  if (area === 'execution' || area === 'bridge') await expect(page.getByRole('region', { name: 'Resultado financeiro' })).toBeVisible();
  if (area === 'canvas') await expect(page.getByRole('button', { name: 'Navegação com a roda do mouse' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  verify();
});

test('mobile touch pan and pinch preserve workflow nodes and every navigation control stays reachable', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 812 } });
  const page = await context.newPage();
  const verify = await open(page, 'canvas', 320);
  const flow = page.locator('.react-flow'), pane = page.locator('.react-flow__pane');
  const position = await page.locator('.react-flow__node').getAttribute('style');
  const viewport = () => page.locator('.react-flow__viewport').getAttribute('style');
  const before = await viewport(), box = (await pane.boundingBox())!;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 40, y: box.y + 80, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 80, y: box.y + 120, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(viewport).not.toBe(before);
  const pan = await viewport();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 80, y: box.y + 160, id: 1 }, { x: box.x + 160, y: box.y + 160, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 60, y: box.y + 160, id: 1 }, { x: box.x + 180, y: box.y + 160, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(viewport).not.toBe(pan);
  for (const button of await flow.locator('.canvas-navigator button').all()) await expect(button).toBeInViewport();
  expect(await page.locator('.react-flow__node').getAttribute('style')).toBe(position);
  verify(); await context.close();
});
