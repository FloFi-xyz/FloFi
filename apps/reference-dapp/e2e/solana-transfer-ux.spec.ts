// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SOLANA_DEVNET_TRANSFER } from '@defi-workflow-engine/action-registry';
import { solanaTransferReviewFixture } from '../src/test-utils/solana-transfer-review-fixture';
import { reviewFixture, reviewNow } from '../src/test-utils/review-fixture';
import type { ExecutionControlsState } from '../src/state/execution-controls';
let bundle: string, styles: string;
test.beforeAll(async () => {
  const aliases: Record<string, string> = {}, compiled = '../node_modules/next/dist/compiled/';
  for (const name of ['workflow-store', 'capability-store', 'uniswap-liquidity-store', 'solana-liquidity-store', 'asset-catalog-store'])
    aliases[`../state/${name}`] = fileURLToPath(new URL('../src/test-utils/execute-acceptance-workflow.tsx', import.meta.url));
  for (const [name, path] of Object.entries({ 'node:crypto': 'crypto-browserify/index.js', buffer: 'buffer/index.js', 'node:buffer': 'buffer/index.js', stream: 'stream-browserify/index.js', events: 'events/events.js', string_decoder: 'string_decoder/string_decoder.js', util: 'util/util.js', vm: 'vm-browserify/index.js', process: 'process/browser.js' }))
    aliases[name] = fileURLToPath(new URL(`${compiled}${path}`, import.meta.url));
  const result = await build({ root: fileURLToPath(new URL('../../../', import.meta.url)), configFile: false, logLevel: 'error', resolve: { alias: aliases },
    define: { 'process.env.NODE_ENV': '"production"', __dirname: '"/"', global: 'globalThis' }, build: { write: false, minify: false,
      rolldownOptions: { transform: { inject: { Buffer: ['buffer', 'Buffer'], process: 'process' } } },
      lib: { entry: fileURLToPath(new URL('../src/test-utils/signing-acceptance-harness.tsx', import.meta.url)), name: 'FloFiSigningAcceptance', formats: ['iife'] } } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk' && output.isEntry);
  if (!entry || entry.type !== 'chunk') throw Error('Signing component bundle missing'); bundle = entry.code;
  styles = await readFile(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  styles += await readFile(new URL('../node_modules/@xyflow/react/dist/style.css', import.meta.url), 'utf8');
});
async function open(page: Page, data: ExecutionControlsState, width = 390, language: 'EN' | 'PT' = 'EN') {
  const errors: string[] = [], egress: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 }); await page.clock.install({ time: reviewNow });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:3119') { egress.push(url.href); await route.abort(); return; }
    if (route.request().resourceType() === 'document') await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body><div id="fixture"></div></body></html>` });
    else await route.fulfill({ status: 404, body: '' });
  });
  await page.routeWebSocket('**/*', async route => { egress.push(route.url()); await route.close(); });
  await page.goto('http://127.0.0.1:3119/approve'); await page.addScriptTag({ content: bundle });
  await page.evaluate(({ fixture, language }) => (window as unknown as { FloFiSigningAcceptance: { mount(element: HTMLElement, data: unknown, language: string): void } }).FloFiSigningAcceptance.mount(document.getElementById('fixture')!, fixture, language), { fixture: JSON.parse(JSON.stringify(data)), language });
  await expect(page.getByRole('main', { name: language === 'PT' ? 'Autorizar com a sua carteira' : 'Authorize with your wallet' })).toBeVisible();
  return () => { expect(errors).toEqual([]); expect(egress).toEqual([]); };
}
for (const network of ['evm', 'solana', 'devnet'] as const) test(`${network}: chat-first authorization needs one FloFi action and waits for the wallet`, async ({ page }) => {
  const data: ExecutionControlsState = network === 'evm' ? { ...reviewFixture(), execution: { ready: true, started: false, start: null, prompt: null, expiresAt: null } }
    : await solanaTransferReviewFixture(network === 'devnet' ? SOLANA_DEVNET_TRANSFER : undefined);
  const verify = await open(page, data);
  if (network === 'evm') {
    await expect(page.getByText('0.025 WETH', { exact: true })).toBeVisible();
    await expect(page.getByText('Minimum received · 0.024875 WETH', { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('region', { name: 'Workflow canvas', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.flofiSigningAcceptance.counts())).toEqual({ reviews: 0, walletRequests: 0 });
  const authorize = page.getByRole('button', { name: 'Authorize in wallet', exact: true }); await expect(authorize).toBeEnabled(); await authorize.click();
  await expect(page.getByRole('button', { name: 'Waiting for wallet…' })).toBeDisabled();
  expect(await page.evaluate(() => window.flofiSigningAcceptance.counts())).toEqual({ reviews: 1, walletRequests: 1 });
  await expect(page.getByRole('checkbox')).toHaveCount(0); verify();
});
test('PT mobile signing preserves Mainnet funds disclosure while the wallet is on Devnet', async ({ page }) => {
  const data = await solanaTransferReviewFixture();
  data.wallet = { ...data.wallet, chain: SOLANA_DEVNET_TRANSFER.chain, environment: 'testnet' };
  const verify = await open(page, data, 320, 'PT');
  await expect(page.getByText('Mainnet · Fundos reais', { exact: true })).toBeVisible();
  await expect(page.getByText('Testnet pública · Fundos de teste', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Autorizar na carteira', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mudar para Solana', exact: true }).click();
  expect(await page.evaluate(() => window.flofiSigningAcceptance.networkRequests())).toEqual([data.authorization.chain]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => window.flofiSigningAcceptance.counts())).toEqual({ reviews: 0, walletRequests: 0 }); verify();
});
test('wallet changes require a new review and never carry over authorization', async ({ page }) => {
  const verify = await open(page, await solanaTransferReviewFixture());
  await page.evaluate(() => window.flofiSigningAcceptance.changeWallet());
  await expect(page.getByRole('button', { name: 'Simulate again', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.flofiSigningAcceptance.counts())).toEqual({ reviews: 0, walletRequests: 0 }); verify();
});
for (const width of [320, 1440]) test(`optional Canvas and normal Back to Build geometry at ${width}px`, async ({ page }) => {
  const verify = await open(page, await solanaTransferReviewFixture(), width);
  await expect(page.locator('body')).not.toContainText(/mock-read|mock:local|sample units|beta testing/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open Canvas', exact: true }).click();
  const back = page.getByRole('button', { name: 'Back to Build', exact: true }); await expect(back).toBeVisible();
  const rect = await back.boundingBox(); expect(rect!.height).toBeLessThanOrEqual(52); expect(rect!.width).toBeLessThan(180);
  expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => window.flofiSigningAcceptance.counts())).toEqual({ reviews: 0, walletRequests: 0 }); verify();
});
