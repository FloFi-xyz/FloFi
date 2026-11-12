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
import { createAccountStore } from '../src/accounts/account-store';
import { ACCOUNT_SESSION_COOKIE, sealAccountSession, type AccountSessionToken } from '../src/accounts/account-session';
import { APP_ORIGIN, chooseLanguage } from './app-origin';
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
// P0 approved UX (board 11): each execution record is a row of Your workflows' one list.
const card = (page: Page, id: string) => page.locator('.ux-record').filter({ has: page.locator(`a[href="/app/dashboard/runs/${id}"]`) });
/**
 * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the execution history lives in Your workflows. A wallet that no signed-in FloFi account holds (these
 * test wallets have no account) proves itself once there — one sign-in signature for the saved workflows and the history together.
 */
async function signIn(page: Page) {
  const prove = page.getByRole('button', { name: 'Connect wallet and prove ownership', exact: true });
  await expect(prove).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify wallet for history', exact: true })).toHaveCount(0);
  await prove.click();
  await expect(prove).toHaveCount(0);
  // P0 approved UX (board 11): Your workflows has one Refresh, which re-reads the workflows and their execution records together.
  await expect(page.getByRole('button', { name: 'Refresh workflows', exact: true })).toBeVisible();
}
async function open(page: Page, wallets: TestWallet[]) {
  await installJourneyWallet(page, wallets, { chain: '0xa4b1', transactionControl: async () => { throw Error('FINANCIAL_REQUEST_FORBIDDEN'); } });
  await page.goto('/app/workflows'); await signIn(page);
}

test('permanent deletion removes real bytes and stays deleted after refresh, a new session, and wallet changes', async ({ page, browser }) => {
  const owner = createTestWallet(), other = createTestWallet(), id = await seed(owner);
  await open(page, [owner, other]); await expect(card(page, id)).toBeVisible();
  await card(page, id).getByRole('button', { name: 'More execution actions', exact: true }).click();
  await card(page, id).getByRole('button', { name: 'Delete execution', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete permanently?', exact: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(card(page, id)).toBeVisible(); expect((await inspect(id)).runs).toBe(1);
  await card(page, id).getByRole('button', { name: 'More execution actions', exact: true }).click();
  await card(page, id).getByRole('button', { name: 'Delete execution', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(card(page, id)).toHaveCount(0);
  expect(await inspect(id)).toEqual({ runs: 0, segments: 0, purges: 1, archives: 0 });
  await page.reload(); await page.getByRole('button', { name: 'Refresh workflows', exact: true }).click(); await expect(card(page, id)).toHaveCount(0);
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

test('compact rows expose metadata on demand, support keyboard actions and archive without deleting history', async ({ page }) => {
  const owner = createTestWallet(), id = await seed(owner);
  await open(page, [owner]);
  const row = card(page, id), more = row.getByRole('button', { name: 'More execution actions', exact: true });
  await expect(row).toBeVisible();
  expect((await row.boundingBox())!.height).toBeLessThan(90);
  const disclosure = row.getByRole('button', { name: /^Show details for / });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(row.locator('.dashboard-run-message')).toBeHidden();
  await disclosure.click();
  await expect(row.getByRole('button', { name: /^Hide details for / })).toHaveAttribute('aria-expanded', 'true');
  await expect(row.locator('.dashboard-run-message')).toBeVisible();
  await row.getByRole('button', { name: /^Hide details for / }).click();
  await more.focus(); await page.keyboard.press('Enter');
  await expect(row.getByRole('button', { name: 'Archive execution', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  await expect(row.getByRole('button', { name: 'Delete execution', exact: true })).toBeHidden();
  await page.setViewportSize({ width: 375, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(row.getByRole('link', { name: /^Open record: / })).toBeVisible();
  const before = await inspect(id);
  await more.click(); await row.getByRole('button', { name: 'Archive execution', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(await inspect(id)).toEqual({ ...before, archives: 1 });
  expect((await walletRequests(page)).filter(method => /send|signTransaction/i.test(method))).toEqual([]);
});

test('financial authorization refuses deletion, offers Archive, and preserves the raw history across sessions', async ({ page, browser }) => {
  const owner = createTestWallet(), stranger = createTestWallet(), id = await seed(owner, true);
  const before = await inspect(id); await open(page, [owner, stranger]);
  await switchAccount(page, stranger.address); await signIn(page); await expect(card(page, id)).toHaveCount(0);
  await switchAccount(page, owner.address); await signIn(page);
  await expect(card(page, id)).toBeVisible();
  await card(page, id).getByRole('button', { name: 'More execution actions', exact: true }).click();
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
  // P0 hotfix (locale contract): the language cookie is authoritative (storage alone no longer overrides the suite's English cookie).
  await chooseLanguage(page.context(), 'PT'); await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await card(page, id).getByRole('button', { name: 'Mais ações da execução', exact: true }).click();
  await card(page, id).getByRole('button', { name: 'Excluir execução', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Excluir definitivamente?', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Excluir definitivamente', exact: true })).toBeEnabled();
  expect(await dialog.evaluate(element => element.getBoundingClientRect().width <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('delete-confirmation-pt.png') });
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  expect((await inspect(id)).runs).toBe(1);
});

/**
 * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001 (owner decision on PR #155): signed in with a FloFi email account, the history of a wallet that account
 * holds opens in Your workflows with no wallet-proof signature. The account session is created by the account store exactly as an email
 * sign-in creates it, and its cookie is sealed with this run's deployment secret exactly as the sign-in route seals it (the email-code
 * screens themselves are covered by auth-wallets.spec.ts). Another account, or the same browser after sign-out, never sees that history.
 */
async function emailAccount(email: string, wallet: string | null): Promise<AccountSessionToken> {
  const database = db();
  try {
    const store = createAccountStore(database, 'default'), session = await store.signIn({ kind: 'email', subject: email, label: email });
    await store.setOnboarding(session.accountId, 'completed');
    // A FloFi-managed wallet of this account (public metadata only, as the wallet onboarding saves it).
    if (wallet) await store.saveWallet(session.accountId, { ecosystem: 'evm', address: wallet, origin: 'generated', provider: 'privy', providerName: 'FloFi wallet',
      providerResource: null, label: 'Main wallet' });
    return session;
  } finally { await database.close(); }
}
async function revoke(session: AccountSessionToken) {
  const database = db();
  try { await createAccountStore(database, 'default').revokeSession(session); } finally { await database.close(); }
}
async function signedInAs(page: Page, session: AccountSessionToken) {
  const secret = process.env.FLOFI_E2E_SESSION_SECRET;
  if (!secret) throw Error('SESSION_SECRET_REQUIRED');
  await page.context().addCookies([{ name: ACCOUNT_SESSION_COOKIE, url: APP_ORIGIN, httpOnly: true, sameSite: 'Lax',
    value: sealAccountSession({ FLOFI_SESSION_SECRET: secret }, session, new URL(APP_ORIGIN).host, new Date()) }]);
}
const proveButton = (page: Page) => page.getByRole('button', { name: 'Connect wallet and prove ownership', exact: true });

test('a signed-in email account sees its own wallet history without a wallet proof; another account and a signed-out browser do not', async ({ page, browser }) => {
  const owner = createTestWallet(), id = await seed(owner);
  const erin = await emailAccount(`erin-${Date.now()}@flofi-e2e.test`, owner.address);
  await installJourneyWallet(page, [owner], { chain: '0xa4b1', transactionControl: async () => { throw Error('FINANCIAL_REQUEST_FORBIDDEN'); } });
  await signedInAs(page, erin);
  await page.goto('/app/workflows');
  await expect(card(page, id)).toBeVisible();
  await expect(proveButton(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Verify wallet for history', exact: true })).toHaveCount(0);
  // The account opened it: no message or transaction was ever asked of the wallet.
  expect((await walletRequests(page)).filter(method => /sign|send/i.test(method))).toEqual([]);
  // Its record opens too (the detail read takes the same account path), with the way back to Your workflows.
  await card(page, id).locator(`a[href="/app/dashboard/runs/${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/app/dashboard/runs/${id}`));
  await expect(page.locator('.dashboard-run-detail')).toBeVisible();
  await expect(page.locator('.dashboard-detail-empty')).toHaveCount(0);

  // Another email account (no wallet of its own) in another browser, with the same wallet connected: the history stays closed.
  const other = await guardedContext(browser);
  try {
    const second = await other.context.newPage();
    await installJourneyWallet(second, [owner], { chain: '0xa4b1', transactionControl: async () => { throw Error('FINANCIAL_REQUEST_FORBIDDEN'); } });
    await signedInAs(second, await emailAccount(`finn-${Date.now()}@flofi-e2e.test`, null));
    await second.goto('/app/workflows');
    await expect(proveButton(second)).toBeVisible();
    await expect(card(second, id)).toHaveCount(0);
    expect(other.unexpected).toEqual([]);
  } finally { await other.context.close(); }

  // Signed out (the server-side session revoked): the same browser no longer reads that history.
  await revoke(erin);
  await page.goto('/app/workflows');
  await expect(proveButton(page)).toBeVisible();
  await expect(card(page, id)).toHaveCount(0);
});
