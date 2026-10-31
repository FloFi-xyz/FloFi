// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: landing → sign-in → wallet onboarding → Build 0, My wallets and export, on normal routes.
 * MOCKED loopback providers only (playwright.auth-wallets.config.ts): this proves FloFi's own flows, verification and isolation,
 * never the live Google, Apple or Turnkey services. Screenshots go to the test output directory.
 */
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet.ts';
import { E2E_APP_ORIGIN } from './app-origin';
import { chooseWallet } from './fixtures';
import { installJourneyWallet } from './journey-fixtures';

const harness = process.env.FLOFI_ACCOUNT_HARNESS_ORIGIN ?? '';
const allowed = new Set([E2E_APP_ORIGIN, harness, harness.replace(/:(\d+)$/, (_, p: string) => `:${Number(p) + 1}`), harness.replace(/:(\d+)$/, (_, p: string) => `:${Number(p) + 2}`)]);
/** Closed loop: the app and the MOCKED loopback harness only; any other request fails the test. */
const test = base.extend<{ guard: string[] }>({
  guard: [async ({ context }, use) => {
    const unexpected: string[] = [];
    await context.route('**/*', async route => {
      let origin = '';
      try { origin = new URL(route.request().url()).origin; } catch { /* invalid URL is refused */ }
      if (allowed.has(origin)) await route.continue(); else { unexpected.push(route.request().url()); await route.abort('blockedbyclient'); }
    });
    await use(unexpected);
    expect(unexpected).toEqual([]);
  }, { auto: true }],
});
test.skip(process.env.FLOFI_AUTH_WALLETS_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Runs only under playwright.auth-wallets.config.ts');

const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: false });
async function setup(page: Page, { theme = 'dark', language = 'EN' }: { theme?: 'dark' | 'light'; language?: 'EN' | 'PT' } = {}) {
  // Reduced motion: no transition or floating animation runs, so every screenshot shows a settled frame.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(({ theme, language }) => {
    localStorage.setItem('flofi.theme', theme); localStorage.setItem('flofi.language', language);
    const writes: string[] = [];
    Object.defineProperty(window, 'clipboardWrites', { get: () => writes });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text); } } });
  }, { theme, language });
}
async function googleSignIn(page: Page, user: 'e2e-google-ana' | 'e2e-google-bruno') {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Google', exact: true }).click();
  await expect(page.getByRole('heading', { name: /MOCKED Google sign-in/ })).toBeVisible();
  await page.getByRole('button', { name: `Continue as ${user} (MOCKED)` }).click();
}
const accountCookie = async (context: BrowserContext) => (await context.cookies()).find(cookie => cookie.name === 'flofi_account_session');

test.describe.configure({ mode: 'serial' });

test('the landing opens sign-in with exactly Apple, Google, Email and Web3 Wallet (desktop, mobile, PT/EN, light/dark)', async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => sessionStorage.setItem('flofi-alive-intro-v1', 'seen'));
  await page.goto('/');
  await page.locator('header').getByRole('link', { name: 'Launch Beta FloFi', exact: true }).click();
  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign inyour way');
  // Never framed by another site (clickjacking), never referred.
  const headers = (await page.request.get('/login')).headers();
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  const methods = page.getByRole('group', { name: 'Sign-in methods' }).getByRole('button');
  expect(await methods.allInnerTexts()).toEqual(['Apple', 'Google', 'Email', 'Web3 Wallet']);
  await expect(page.getByText(/Telegram|Passkey|TON/)).toHaveCount(0);
  for (const button of await methods.all()) await expect(button).toBeEnabled();
  // Keyboard: the methods are reachable in order.
  await page.getByRole('button', { name: 'Apple', exact: true }).focus();
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Google', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 }); await shot(page, '01-sign-in-desktop-dark');
  await page.getByRole('switch', { name: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light'); await shot(page, '07-sign-in-desktop-light');
  await page.getByRole('switch', { name: 'Dark theme' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, '02-sign-in-mobile-dark');
  await page.getByRole('button', { name: 'PT', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Entrardo seu jeito');
  await expect(page.getByRole('button', { name: 'Carteira Web3', exact: true })).toBeVisible();
  await shot(page, '02-sign-in-mobile-dark-pt');
  await page.getByRole('button', { name: 'EN', exact: true }).click();
});

test('a provider cancellation or a tampered state signs nobody in', async ({ page, context }) => {
  await setup(page);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Google', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/\/login\?error=OIDC_CANCELLED/);
  await expect(page.getByRole('alert').filter({ hasText: 'Sign-in was cancelled. Nothing changed.' })).toBeVisible();
  // A callback without this browser's flow cookie (another browser, replay) is refused.
  await page.goto('/auth/callback/google?code=forged&state=forged');
  await expect(page).toHaveURL(/error=OIDC_STATE_INVALID/);
  expect(await accountCookie(context)).toBeUndefined();
});

test('first Google sign-in: verified server session, wallet introduction, create + import, Save wallets, Build 0, persistence', async ({ page, context }) => {
  await setup(page);
  await googleSignIn(page, 'e2e-google-ana');
  await expect(page).toHaveURL('/onboarding');
  const cookie = await accountCookie(context);
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  expect(await page.evaluate(() => document.cookie)).not.toContain('flofi_account_session');
  await expect(page.getByRole('heading', { name: 'Your wallets. One FloFi account.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Signed-in account' })).toContainText('e2e-google-ana@flofi-e2e.test');
  await expect(page.getByText(/These are the ecosystems FloFi supports today/)).toBeVisible();
  await expect(page.getByText(/\bTON\b/)).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 }); await shot(page, '03-wallet-introduction-dark');

  await page.getByRole('link', { name: 'Add wallets' }).click();
  await expect(page).toHaveURL('/onboarding/wallets');
  const save = page.getByRole('button', { name: 'Save wallets' });
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Create EVM wallet' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'EVM wallet created' })).toBeVisible();
  await expect(save).toBeEnabled();
  await page.getByRole('button', { name: 'Create Solana wallet' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Solana wallet created' })).toBeVisible();
  // Import: the key is typed only into the provider's frame (another origin); FloFi's page has no key field of its own.
  await page.getByRole('button', { name: 'Import EVM key' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import EVM key' });
  await expect(dialog).toBeVisible();
  expect(await page.locator('input[type=password], textarea').count()).toBe(0);
  const frame = page.frameLocator('#flofi-import-evm');
  await frame.getByRole('textbox', { name: 'Private key' }).fill('not-a-real-key-e2e-only');
  await dialog.getByRole('button', { name: 'Import wallet' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'EVM key imported' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Wallets ready to save' }).getByRole('listitem')).toHaveCount(3);
  await shot(page, '04-create-import-wallets-dark');
  await page.getByRole('switch', { name: 'Dark theme' }).click(); await shot(page, '07-create-import-wallets-light');
  await page.getByRole('switch', { name: 'Dark theme' }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await shot(page, '04-create-import-wallets-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });
  await save.click();
  // Build 0 after onboarding.
  await expect(page).toHaveURL('/app');
  await expect(page.locator('.app-shell')).toBeVisible();

  await page.goto('/app/credentials');
  const mine = page.getByRole('region', { name: 'My wallets' });
  await expect(mine.locator('.workspace-wallet-card')).toHaveCount(3);
  await expect(mine.locator('[data-origin="generated"]')).toHaveCount(2);
  await expect(mine.locator('[data-origin="imported"]')).toHaveCount(1);
  await expect(mine.getByText('FloFi wallet · Ethereum · Generated')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'My wallets' }).locator('.workspace-wallet-card')).toHaveCount(3);
  await shot(page, '05-credentials-my-wallets');
  // The onboarding is not shown again to a completed account.
  await page.goto('/login'); await expect(page).toHaveURL('/app');
});

test('export: only managed wallets, explicit confirmation, provider frame only, no clipboard or storage writes', async ({ page }) => {
  await setup(page);
  await googleSignIn(page, 'e2e-google-ana');
  await expect(page).toHaveURL('/app');
  await page.goto('/app/credentials');
  const mine = page.getByRole('region', { name: 'My wallets' });
  const generated = mine.locator('[data-origin="generated"]').first(), imported = mine.locator('[data-origin="imported"]').first();
  await imported.getByRole('button', { name: /^Export / }).click();
  let dialog = page.getByRole('dialog', { name: 'Export wallet' });
  await expect(dialog.getByRole('button', { name: 'Copy private key' })).toBeDisabled();
  // An imported key has no recovery phrase, and none is ever derived from it.
  await expect(dialog.getByRole('button', { name: 'Copy recovery phrase' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await generated.getByRole('button', { name: /^Export / }).click();
  dialog = page.getByRole('dialog', { name: 'Export wallet' });
  await expect(dialog.getByRole('note')).toContainText('Never share your private key or recovery phrase');
  await expect(dialog.getByRole('button', { name: 'Copy recovery phrase' })).toBeDisabled();
  await shot(page, '06-export-wallet-modal-dark');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Copy recovery phrase' }).click();
  await expect(page.frameLocator('#flofi-export-wallet').getByText(/MOCKED recovery phrase would be shown here/)).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText('FloFi cannot read it');
  await shot(page, '06-export-wallet-revealed-in-provider-frame');
  expect(await page.evaluate(() => (window as unknown as { clipboardWrites: string[] }).clipboardWrites)).toEqual([]);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toMatch(/mnemonic|seed|privateKey|private_key|exportBundle|mock-export-bundle|recovery/i);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await generated.getByRole('button', { name: /^Export / }).click();
  await shot(page, '07-export-wallet-modal-light');
});

test('skip for now reaches Build 0 and is remembered; another account sees none of the first account’s wallets; deletion', async ({ page, context }) => {
  await setup(page);
  await googleSignIn(page, 'e2e-google-bruno');
  await expect(page).toHaveURL('/onboarding');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page).toHaveURL('/app');
  await page.goto('/login'); await expect(page).toHaveURL('/app');
  await page.goto('/app/credentials');
  await expect(page.getByRole('region', { name: 'My wallets' }).getByText('No wallets in your account yet')).toBeVisible();
  // Deleting the account (recent sign-in) removes it and signs out; the wallets themselves are untouched.
  const mine = page.getByRole('region', { name: 'My wallets' });
  await mine.getByRole('button', { name: 'Delete FloFi account' }).click();
  await expect(mine.getByText(/Your wallets and their funds are not affected/)).toBeVisible();
  const cookie = (await accountCookie(context))!;
  await mine.getByRole('button', { name: 'Delete account', exact: true }).click();
  await expect(page).toHaveURL('/login');
  // The deleted session's cookie (replayed, or tampered) is rejected by the server: nobody is signed in.
  await context.addCookies([cookie]);
  await page.goto('/onboarding'); await expect(page).toHaveURL(/\/login/);
  await context.addCookies([{ ...cookie, value: cookie.value.replace(/.$/, c => c === 'A' ? 'B' : 'A') }]);
  await page.goto('/onboarding'); await expect(page).toHaveURL(/\/login/);
});

test('Apple and email sign-in create verified accounts; a wrong email code signs nobody in', async ({ page, context }) => {
  await setup(page);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Apple', exact: true }).click();
  await page.getByRole('button', { name: 'Continue as e2e-apple-carla (MOCKED)' }).click();
  await expect(page).toHaveURL('/onboarding');
  await expect(page.getByRole('region', { name: 'Signed-in account' })).toContainText('Apple');
  await page.getByRole('region', { name: 'Signed-in account' }).getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/login');
  expect(await accountCookie(context)).toBeUndefined();

  // After the full-page sign-out redirect, a click before hydration is lost: retry until the email form is open.
  await expect(async () => {
    if (!await page.getByLabel('Email address').isVisible()) await page.getByRole('button', { name: 'Email', exact: true }).click();
    await expect(page.getByLabel('Email address')).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await page.getByLabel('Email address').fill('dora@flofi-e2e.test');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByLabel(/Enter the 6-digit code we sent to dora@flofi-e2e.test/).fill('000000');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /not valid or has expired/ })).toBeVisible();
  expect(await accountCookie(context)).toBeUndefined();
  await page.getByRole('button', { name: 'Send a new code' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'A new code was sent to dora@flofi-e2e.test.' })).toBeVisible();
  await page.getByLabel(/Enter the 6-digit code/).fill('246810');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page).toHaveURL('/onboarding');
  await expect(page.getByRole('region', { name: 'Signed-in account' })).toContainText('dora@flofi-e2e.test');
});

test('Web3 Wallet sign-in proves ownership with a signature, skips onboarding and never offers key export', async ({ page, context }) => {
  const wallet = createTestWallet(), transactions: string[] = [];
  await setup(page);
  // Any transaction-path call would land here, in the test process: sign-in must never make one.
  await installJourneyWallet(page, [wallet], { chain: '0x2105', transactionControl: async (method: string) => { transactions.push(method); throw new Error('NO_TRANSACTIONS_IN_SIGN_IN'); } });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Web3 Wallet', exact: true }).click();
  await page.getByRole('button', { name: 'EVM wallet', exact: true }).click();
  await chooseWallet(page, 'Browser wallet');
  await expect(page).toHaveURL('/app');
  // The server sealed the wallet session only after verifying the EIP-4361 signature, then the account session from it.
  const cookies = await context.cookies();
  expect(cookies.find(cookie => cookie.name === 'flofi_wallet_session')).toMatchObject({ httpOnly: true });
  expect(cookies.find(cookie => cookie.name === 'flofi_account_session')).toMatchObject({ httpOnly: true });
  expect(transactions).toEqual([]);
  await page.goto('/app/credentials');
  const card = page.getByRole('region', { name: 'My wallets' }).locator('[data-origin="external"]');
  await expect(card).toHaveCount(1);
  await expect(card.locator('code')).toHaveAttribute('title', wallet.address.toLowerCase());
  await expect(card.getByRole('button', { name: /^Export / })).toHaveCount(0);
  await expect(page.getByText('Creating or importing wallets needs')).toHaveCount(0);
});

test('the database holds no secret-shaped value for any account', async () => {
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  try {
    // `export` is a capability label (NONE / RECOVERY_PHRASE / PRIVATE_KEY), not secret material: every other value is scanned.
    const { rows } = await db.query(`SELECT (to_jsonb(t) - 'export')::text AS row FROM (SELECT * FROM flofi_account_wallets) t UNION ALL
      SELECT to_jsonb(t)::text FROM (SELECT * FROM flofi_account_identities) t UNION ALL SELECT to_jsonb(t)::text FROM (SELECT * FROM flofi_accounts) t
      UNION ALL SELECT to_jsonb(t)::text FROM (SELECT * FROM flofi_account_sessions) t`);
    expect(rows.length).toBeGreaterThan(5);
    for (const { row } of rows) expect(String(row)).not.toMatch(/not-a-real-key|mock-encrypted|mock-export|vt\.|eyJ|mnemonic|private.?key|seed/i);
  } finally { await db.close(); }
});
