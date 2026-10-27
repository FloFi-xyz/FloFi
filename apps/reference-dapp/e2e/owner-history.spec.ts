// SPDX-License-Identifier: AGPL-3.0-only
/** Real Chromium, sign-in signatures and PostgreSQL. Financial quotes are MOCKED in-process; no transaction is signed or submitted. */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { createDatabase, createLogger } from '@defi-workflow-engine/cloud-runtime';
import { parseArbitrumTokenList } from '@defi-workflow-engine/action-registry';
import { createTestWallet, type TestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { createBackend } from '../backend/app';
import { composeStrategy } from '../src/engine/strategy-engine';
import { registerNetworkCatalog } from '../src/domain/asset-catalogs';
import { validateSavedWorkflow } from '../src/domain/saved-workflow';
import { createDurablePublicTestnetService } from '../src/server/public-testnet-service';
import { createRobinhoodMockChain, mockCatalogRuntime } from '../src/server/robinhood-mainnet.test-harness';
import { guardedContext, installJourneyWallet, switchAccount, walletRequests } from './journey-fixtures';
import { test, expect } from './fixtures';

const db = () => {
  const connectionString = process.env.FLOFI_E2E_DATABASE_URL!;
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(connectionString).hostname)) throw Error('LOOPBACK_DATABASE_REQUIRED');
  return createDatabase({ connectionString, maxConnections: 2 });
};
async function seed(owner: TestWallet, authorized = false) {
  const database = db();
  try {
    const catalog = parseArbitrumTokenList(readFileSync(new URL('../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8'), new Date().toISOString());
    registerNetworkCatalog(catalog);
    const chain = createRobinhoodMockChain(catalog, { now: Date.now });
    const usdc = catalog.assets.find(a => a.symbol === 'USDC')!, weth = catalog.assets.find(a => a.symbol === 'WETH')!;
    chain.addPool(usdc.address!, weth.address!, { fee: 500, liquidity: 10n ** 20n, rate: { [usdc.address!]: 4n * 10n ** 26n, [weth.address!]: 2_500_000n } });
    chain.fund(usdc.address!, owner.address, 1_000_000_000n); chain.fundNative(owner.address, 10n ** 18n);
    const backend = createBackend({ db: database, env: {}, tenantId: 'default', holderId: 'history-browser-seed', evidenceStore: null,
      logger: createLogger({ service: 'history-browser-seed', sink: () => undefined }) });
    const financial = createDurablePublicTestnetService({ rpc: chain.rpc, rpcs: { [catalog.chain]: chain.rpc }, idPrefix: 'ars',
      storage: backend.storage('arbitrum-swap', 'default'), catalog: mockCatalogRuntime(catalog) });
    const spec = composeStrategy({ action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1' });
    if (!spec.ok) throw Error(spec.code);
    const prepared = await financial.prepare(validateSavedWorkflow(spec.workflow), owner.address), id = prepared.quote.executionId;
    if (authorized) await financial.review(id, prepared.quote.manifestHash);
    expect(chain.state.transactions.size).toBe(0);
    return id;
  } finally { await database.close(); }
}
async function inspect(id: string) {
  const database = db();
  try { return (await database.query(`SELECT
    (SELECT count(*)::int FROM execution_runs WHERE run_id=$1) AS runs,
    (SELECT count(*)::int FROM execution_log_segments WHERE name=$1||'.jsonl') AS segments,
    (SELECT count(*)::int FROM execution_purge_audit WHERE run_id=$1) AS purges,
    (SELECT count(*)::int FROM owner_history_visibility WHERE record_id=$1) AS archives`, [id])).rows[0]!; }
  finally { await database.close(); }
}
const card = (page: Page, id: string) => page.locator('.dashboard-run-card').filter({ has: page.locator(`a[href="/app/dashboard/runs/${id}"]`) });
async function signIn(page: Page) {
  await expect(page.getByRole('button', { name: 'Verify wallet for history', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Verify wallet for history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Verify wallet for history', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh history', exact: true })).toBeVisible();
}
async function open(page: Page, wallets: TestWallet[]) {
  await installJourneyWallet(page, wallets, { chain: '0xa4b1', transactionControl: async () => { throw Error('FINANCIAL_REQUEST_FORBIDDEN'); } });
  await page.goto('/app/dashboard'); await signIn(page);
}

test('permanent deletion removes real bytes and stays deleted after refresh, a new session, and wallet changes', async ({ page, browser }) => {
  const owner = createTestWallet(), other = createTestWallet(), id = await seed(owner);
  await open(page, [owner, other]); await expect(card(page, id)).toBeVisible();
  await card(page, id).getByRole('button', { name: 'Delete execution', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete permanently?', exact: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(card(page, id)).toBeVisible(); expect((await inspect(id)).runs).toBe(1);
  await card(page, id).getByRole('button', { name: 'Delete execution', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(card(page, id)).toHaveCount(0);
  expect(await inspect(id)).toEqual({ runs: 0, segments: 0, purges: 1, archives: 0 });
  await page.reload(); await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); await expect(card(page, id)).toHaveCount(0);
  await switchAccount(page, other.address); await signIn(page); await expect(card(page, id)).toHaveCount(0);
  expect((await walletRequests(page)).filter(m => m !== 'personal_sign' && /send|sign/i.test(m))).toEqual([]);
  const fresh = await guardedContext(browser);
  try {
    const second = await fresh.context.newPage(); await open(second, [owner]); await expect(card(second, id)).toHaveCount(0);
    await second.goto(`/app/dashboard/runs/${id}`); await expect(second.getByRole('heading', { name: 'Run not found', exact: true })).toBeVisible();
    expect(fresh.unexpected).toEqual([]);
  } finally { await fresh.context.close(); }
  expect(await inspect(id)).toEqual({ runs: 0, segments: 0, purges: 1, archives: 0 });
});

test('financial authorization refuses deletion, offers Archive, and preserves the raw history across sessions', async ({ page, browser }) => {
  const owner = createTestWallet(), stranger = createTestWallet(), id = await seed(owner, true);
  const before = await inspect(id); await open(page, [owner, stranger]);
  await switchAccount(page, stranger.address); await signIn(page); await expect(card(page, id)).toHaveCount(0);
  await switchAccount(page, owner.address); await signIn(page);
  await expect(card(page, id)).toBeVisible();
  await card(page, id).getByRole('button', { name: 'Delete execution', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete permanently?', exact: true });
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Archive it to preserve its history');
  expect(await inspect(id)).toEqual(before);
  await dialog.getByRole('button', { name: 'Archive instead', exact: true }).click(); await expect(card(page, id)).toHaveCount(0);
  await page.reload(); await expect(card(page, id)).toHaveCount(0);
  expect(await inspect(id)).toEqual({ ...before, archives: 1 });
  const fresh = await guardedContext(browser);
  try {
    const second = await fresh.context.newPage(); await open(second, [owner]); await expect(card(second, id)).toHaveCount(0);
    expect(fresh.unexpected).toEqual([]);
  } finally { await fresh.context.close(); }
  expect(await inspect(id)).toEqual({ ...before, archives: 1 });
});

test('Portuguese confirmation remains usable on a narrow screen and keeps the cancel action safe', async ({ page }, info) => {
  const owner = createTestWallet(), id = await seed(owner); await open(page, [owner]);
  await page.evaluate(() => localStorage.setItem('flofi.language', 'PT')); await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await card(page, id).getByRole('button', { name: 'Excluir execução', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Excluir definitivamente?', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Excluir definitivamente', exact: true })).toBeEnabled();
  expect(await dialog.evaluate(element => element.getBoundingClientRect().width <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('delete-confirmation-pt.png') });
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  expect((await inspect(id)).runs).toBe(1);
});
