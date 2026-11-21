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
import { createSavedWorkflowStore } from '../src/server/saved-workflow-store';
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
  await expect(dialog.getByRole('alert')).toContainText('previous execution authorization');
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

test('dismissed history actions release focus and clear refusal messages across rows', async ({ page }, info) => {
  const owner = createTestWallet(), first = await seed(owner, true), second = await seed(owner, true);
  await open(page, [owner]);
  const more = (id: string) => card(page, id).getByRole('button', { name: 'More execution actions', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Delete permanently?', exact: true });
  const alerts = page.locator('.history-actions [role="alert"]');
  const refuse = async (id: string) => {
    await more(id).click();
    await card(page, id).getByRole('button', { name: 'Delete execution', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('previous execution authorization');
    await expect(alerts).toHaveCount(1);
  };
  await more(first).click();
  await expect(more(first)).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('heading', { name: 'Your workflows', exact: true }).click();
  await expect(more(first)).toHaveAttribute('aria-expanded', 'false');
  await refuse(first);
  await page.mouse.click(5, 5);
  await expect(dialog.getByRole('alert')).toBeVisible();
  await page.screenshot({ path: info.outputPath('history-refusal-desktop.png') });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(alerts).toHaveCount(0);
  await expect(more(first)).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await refuse(second);
  await page.screenshot({ path: info.outputPath('history-refusal-mobile.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(more(second)).toBeFocused();
  await expect(alerts).toHaveCount(0);
  await more(first).click();
  await more(second).click();
  await expect(more(first)).toHaveAttribute('aria-expanded', 'false');
  await expect(card(page, second).getByRole('button', { name: 'Archive execution', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(more(second)).toBeFocused();
  await expect(alerts).toHaveCount(0);

  // Fail a pending archive request after the user has already dismissed its menu.
  let finish!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/app/workflows', async route => {
    if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue();
    started();
    await release;
    await route.fulfill({ status: 503, body: 'Unavailable' });
  });
  try {
    await more(first).click();
    await card(page, first).getByRole('button', { name: 'Archive execution', exact: true }).click();
    await pending;
    await page.keyboard.press('Escape');
    await expect(more(first)).toBeFocused();
  } finally { finish(); }
  await expect(more(first)).toHaveAttribute('aria-describedby', /.+/);
  await expect(more(first)).toBeEnabled();
  await more(first).click();
  await expect(card(page, first).getByRole('alert')).toContainText('The result could not be confirmed');
  await page.getByRole('heading', { name: 'Your workflows', exact: true }).click();
  await expect(alerts).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('history-after-outside.png') });
  expect((await walletRequests(page)).filter(method => /send|signTransaction/i.test(method))).toEqual([]);
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

test('workflow and operation rows share compact alignment in both themes, with no wallet activity request', async ({ page }, info) => {
  const owner = createTestWallet(), id = await seed(owner);
  const flowName = 'My named workflow';
  const database = db();
  try {
    const spec = composeStrategy({ action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3' });
    if (!spec.ok) throw Error(spec.code);
    await createSavedWorkflowStore(database, 'default', { namespace: 'eip155', address: owner.address.toLowerCase() })
      .save({ workflow: { ...spec.workflow, workflowId: 'history-layout-flow' }, name: flowName, expectedVersion: 0 });
  } finally { await database.close(); }

  const activityRequests: string[] = [];
  await page.route('**/api/dashboard/activity**', route => { activityRequests.push(route.request().url()); return route.abort(); });
  await open(page, [owner]);
  const hub = page.getByRole('region', { name: 'Your workflows', exact: true });
  const flow = hub.locator('.ux-row').filter({ has: page.getByRole('heading', { name: flowName, exact: true }) });
  const operation = card(page, id).locator('.ux-row');
  await expect(flow.getByText('Saved', { exact: true })).toBeVisible();
  await expect(operation.getByText('Not started', { exact: true })).toBeVisible();
  await expect(operation.getByRole('link', { name: /^Open record: / })).toHaveAttribute('href', `/app/dashboard/runs/${id}`);
  await expect(flow.getByRole('button', { name: `Open workflow: ${flowName}` })).toBeEnabled();
  await expect(flow.getByRole('button', { name: 'More workflow actions' })).toBeVisible();
  await expect(operation.getByRole('button', { name: 'More execution actions' })).toBeVisible();

  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') {
      await settings.click();
      await page.getByRole('switch', { name: 'Theme', exact: true }).click();
      await settings.press('Escape');
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const measure = (row: typeof flow) => row.evaluate(element => {
        const box = (selector: string) => {
          const { x, y, width, height, right, bottom } = element.querySelector(selector)!.getBoundingClientRect();
          return { x, y, width, height, right, bottom };
        };
        return { height: element.getBoundingClientRect().height, icon: box('.ux-row-icon'), name: box('.ux-row-name'), time: box('time'),
          status: box('.ux-tag'), open: box('.ux-button'), menu: box('.history-actions > button') };
      });
      const [saved, run] = await Promise.all([measure(flow), measure(operation)]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(saved.height).toBeCloseTo(run.height, 0);
      expect(saved.icon.width).toBe(run.icon.width);
      expect(saved.icon.x).toBe(run.icon.x);
      expect(saved.name.x).toBe(run.name.x);
      expect(saved.open.width).toBe(run.open.width);
      expect(saved.open.height).toBe(run.open.height);
      expect(saved.menu.right).toBe(run.menu.right);
      for (const layout of [saved, run]) {
        expect(layout.time.x).toBe(layout.name.x);
        expect(layout.time.y).toBeGreaterThan(layout.name.y);
        expect(layout.status.right).toBeLessThan(layout.open.x);
        expect(layout.open.right).toBeLessThan(layout.menu.x);
        expect(layout.open.y).toBeCloseTo(layout.menu.y, 0);
        expect(layout.status.y + layout.status.height / 2).toBeCloseTo(layout.open.y + layout.open.height / 2, 0);
        if (width === 1440) expect(layout.open.y).toBeLessThan(layout.time.bottom);
        else expect(layout.open.y).toBeGreaterThan(layout.time.bottom);
      }
      await hub.screenshot({ path: info.outputPath(`history-${theme}-${width}.png`) });
    }
  }

  await expect(hub.getByRole('group', { name: 'Filter workflows', exact: true })).toBeVisible();
  await expect(hub.getByRole('group', { name: 'History view', exact: true })).toHaveCount(0);
  await expect(hub.locator('.wallet-activity')).toHaveCount(0);
  await expect(hub.getByRole('list', { name: 'Network coverage', exact: true })).toHaveCount(0);
  await expect(hub.getByRole('button', { name: 'Refresh wallet activity', exact: true })).toHaveCount(0);
  const refresh = hub.getByRole('button', { name: 'Refresh workflows', exact: true });
  await expect(refresh).toHaveCount(1);
  await refresh.click();
  await expect(flow).toBeVisible();
  await expect(operation).toBeVisible();
  expect(activityRequests).toEqual([]);
  expect((await walletRequests(page)).filter(method => /send|signTransaction/i.test(method))).toEqual([]);
});

test('Portuguese history on mobile keeps the primary refresh and workflow filters', async ({ page, context }) => {
  await chooseLanguage(context, 'PT');
  await page.setViewportSize({ width: 390, height: 844 });
  const owner = createTestWallet(), id = await seed(owner);
  await installJourneyWallet(page, [owner], { chain: '0xa4b1', transactionControl: async () => { throw Error('FINANCIAL_REQUEST_FORBIDDEN'); } });
  await page.goto('/app/workflows');
  const prove = page.getByRole('button', { name: 'Conectar carteira e verificar titularidade', exact: true });
  await prove.click(); await expect(prove).toHaveCount(0);
  await expect(card(page, id)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Atualizar fluxos', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Visualização do histórico', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Atividade da carteira', exact: true })).toHaveCount(0);
});
