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
/** FloFi Wallet: the same loopback server under another host name, i.e. another origin (playwright.auth-wallets.config.ts). */
const WALLET = process.env.FLOFI_E2E_WALLET_ORIGIN ?? '';
const allowed = new Set([E2E_APP_ORIGIN, WALLET, harness, harness.replace(/:(\d+)$/, (_, p: string) => `:${Number(p) + 1}`), harness.replace(/:(\d+)$/, (_, p: string) => `:${Number(p) + 2}`)]);
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
  // A per-request nonce policy: only Next.js's own scripts and what they load run; an injected inline handler does not.
  const policy = headers['content-security-policy']!, nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic'/);
  expect(policy).toContain("connect-src 'self'");
  expect(/'nonce-([^']+)'/.exec((await page.request.get('/login')).headers()['content-security-policy']!)?.[1]).not.toBe(nonce);
  const violations = await page.evaluate(() => new Promise<{ ran: boolean; blocked: string[] }>(resolve => {
    const blocked: string[] = [];
    document.addEventListener('securitypolicyviolation', event => blocked.push(event.effectiveDirective));
    const holder = document.createElement('div');
    holder.innerHTML = '<img alt="" src="data:," onerror="window.__flofiInjected = true">';
    document.body.append(holder);
    setTimeout(() => { holder.remove(); resolve({ ran: (window as unknown as { __flofiInjected?: boolean }).__flofiInjected === true, blocked }); }, 500);
  }));
  expect(violations.ran).toBe(false);
  expect(violations.blocked).toContain('script-src-attr');
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

/** Opens FloFi Wallet by a click on the product page; returns its window once it shows the account it serves. */
async function walletWindow(page: Page, click: () => Promise<unknown>, account: string | RegExp) {
  const [popup] = await Promise.all([page.waitForEvent('popup'), click()]);
  await popup.waitForLoadState('domcontentloaded');
  expect(new URL(popup.url()).origin).toBe(WALLET);
  expect(popup.url()).not.toContain('handoff'); // the account arrives by postMessage from its opener, never in a URL
  await expect(popup.getByText(account).first()).toBeVisible();
  return popup;
}
/** Unlock with the account's Google identity through FloFi Wallet's own client, in a child window opened by FloFi Wallet. */
async function unlockWithGoogle(popup: Page, user: string) {
  const [child] = await Promise.all([popup.waitForEvent('popup'), popup.getByRole('button', { name: 'Continue with Google' }).click()]);
  await expect(child.getByRole('heading', { name: /MOCKED Google sign-in/ })).toBeVisible();
  await child.getByRole('button', { name: `Continue as ${user} (MOCKED)` }).click();
  await expect(popup.getByText(/^Unlocked/).first()).toBeVisible();
}
/** FloFi Wallet arms Sign only after its request has been on screen in a focused window for a moment. */
async function confirmInWallet(popup: Page, name: string | RegExp) {
  await popup.bringToFront();
  const button = popup.getByRole('button', { name, exact: typeof name === 'string' });
  await expect(button).toBeEnabled();
  await button.click();
}

test('first Google sign-in: wallet introduction, then create and import in FloFi Wallet on its own origin, Build 0, persistence', async ({ page, context }) => {
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
  // Account pages frame nothing: every provider frame lives in FloFi Wallet, on its own origin.
  expect((await page.request.get('/onboarding/wallets')).headers()['content-security-policy']).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'.*frame-src 'none'/);
  await expect(page.getByRole('note').filter({ hasText: 'Your wallets open in FloFi Wallet' })).toBeVisible();
  expect(await page.locator('input[type=password], textarea, iframe').count()).toBe(0);
  const proceed = page.getByRole('button', { name: 'Continue to FloFi' });
  await expect(proceed).toBeDisabled();

  // Create EVM: FloFi Wallet opens inside the click, receives the account by postMessage, and asks for an unlock first.
  const popup = await walletWindow(page, () => page.getByRole('button', { name: 'Create EVM wallet' }).click(), 'e2e-google-ana@flofi-e2e.test');
  await expect(popup.getByRole('heading', { name: 'Create a EVM wallet' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Create wallet' })).toBeDisabled();
  await shot(popup, '08-flofi-wallet-locked');
  await unlockWithGoogle(popup, 'e2e-google-ana');
  await popup.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'EVM wallet created' })).toBeVisible();
  await expect(proceed).toBeEnabled();
  // Solana: the same window, still unlocked: no second unlock.
  await page.getByRole('button', { name: 'Create Solana wallet' }).click();
  await expect(popup.getByRole('heading', { name: 'Create a Solana wallet' })).toBeVisible();
  await popup.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Solana wallet created' })).toBeVisible();
  // Import: the key is typed only into the provider's frame inside FloFi Wallet; the product page never has a key field.
  await page.getByRole('button', { name: 'Import EVM key' }).click();
  await expect(popup.getByRole('heading', { name: 'Import a EVM key' })).toBeVisible();
  await popup.frameLocator('#flofi-import-evm').getByRole('textbox', { name: 'Private key' }).fill('not-a-real-key-e2e-only');
  await shot(popup, '09-flofi-wallet-import');
  await popup.getByRole('button', { name: 'Import wallet', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'EVM key imported' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Wallets saved to your account' }).getByRole('listitem')).toHaveCount(3);
  expect(await page.locator('input[type=password], textarea, iframe').count()).toBe(0);
  await shot(page, '04-create-import-wallets-dark');
  await page.getByRole('switch', { name: 'Dark theme' }).click(); await shot(page, '07-create-import-wallets-light');
  await page.getByRole('switch', { name: 'Dark theme' }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await shot(page, '04-create-import-wallets-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });
  // The product origin never holds a provider key or session.
  expect(await page.evaluate(async () => (await indexedDB.databases()).map(database => database.name))).toEqual([]);
  await proceed.click();
  await expect(page).toHaveURL('/app');
  await expect(page.locator('.app-shell')).toBeVisible();

  await page.goto('/app/credentials');
  const mine = page.getByRole('region', { name: 'My wallets' });
  await expect(mine.locator('.workspace-wallet-card')).toHaveCount(3);
  await expect(mine.locator('[data-origin="generated"]')).toHaveCount(2);
  await expect(mine.locator('[data-origin="imported"]')).toHaveCount(1);
  await expect(mine.getByText('FloFi wallet · Ethereum · Generated')).toBeVisible();
  // Managed wallets sign in FloFi Wallet, after the person reviews the transaction in FloFi.
  await expect(mine.locator('[data-managed-signing="flofi-wallet"]')).toHaveCount(3);
  await expect(mine.locator('[data-origin="generated"]').first()).toContainText('Signs in FloFi Wallet, after you review the transaction in FloFi.');
  await page.reload();
  await expect(page.getByRole('region', { name: 'My wallets' }).locator('.workspace-wallet-card')).toHaveCount(3);
  await shot(page, '05-credentials-my-wallets');
  await page.goto('/login'); await expect(page).toHaveURL('/app');
});

test('export: only in FloFi Wallet, after a fresh unlock and an explicit acknowledgement, shown only in the provider frame', async ({ page }) => {
  await setup(page);
  await googleSignIn(page, 'e2e-google-ana');
  await expect(page).toHaveURL('/app');
  await page.goto('/app/credentials');
  const mine = page.getByRole('region', { name: 'My wallets' });
  const generated = mine.locator('[data-origin="generated"]').first(), imported = mine.locator('[data-origin="imported"]').first();
  await imported.getByRole('button', { name: /^Export / }).click();
  let dialog = page.getByRole('dialog', { name: 'Export wallet' });
  // An imported key has no recovery phrase, and none is ever derived from it.
  await expect(dialog.getByRole('button', { name: 'Export private key in FloFi Wallet' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Export recovery phrase in FloFi Wallet' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await generated.getByRole('button', { name: /^Export / }).click();
  dialog = page.getByRole('dialog', { name: 'Export wallet' });
  await expect(dialog.getByRole('note')).toContainText('Never share your private key or recovery phrase');
  await shot(page, '06-export-wallet-modal-dark');
  // The product page shows no secret and no frame of its own: it only opens FloFi Wallet.
  const popup = await walletWindow(page, () => dialog.getByRole('button', { name: 'Export recovery phrase in FloFi Wallet' }).click(), 'e2e-google-ana@flofi-e2e.test');
  await expect(popup.getByRole('heading', { name: /Show the recovery phrase of/ })).toBeVisible();
  const show = popup.getByRole('button', { name: 'Show recovery phrase' });
  await expect(show).toBeDisabled();
  await unlockWithGoogle(popup, 'e2e-google-ana');
  await expect(show).toBeDisabled(); // still needs the acknowledgement
  await popup.getByRole('checkbox').check();
  await confirmInWallet(popup, 'Show recovery phrase');
  await expect(popup.frameLocator('#flofi-export-wallet').getByText(/MOCKED recovery phrase would be shown here/)).toBeVisible();
  await shot(popup, '06-export-revealed-in-flofi-wallet');
  await popup.getByRole('button', { name: 'Done' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Export finished in FloFi Wallet.' })).toBeVisible();
  expect(await page.locator('iframe').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { clipboardWrites: string[] }).clipboardWrites)).toEqual([]);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toMatch(/mnemonic|seed|privateKey|private_key|exportBundle|mock-export-bundle|recovery/i);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await generated.getByRole('button', { name: /^Export / }).click();
  await shot(page, '07-export-wallet-modal-light');
});

test('an email account unlocks FloFi Wallet only with its own 8-character code; a sign-in code never unlocks it', async ({ page, context }) => {
  await setup(page);
  const bodies: string[] = [];
  context.on('request', request => { const origin = new URL(request.url()).origin; if (origin === E2E_APP_ORIGIN || origin === WALLET) bodies.push(request.postData() ?? ''); });
  await page.goto('/login');
  await expect(async () => {
    if (!await page.getByLabel('Email address').isVisible()) await page.getByRole('button', { name: 'Email', exact: true }).click();
    await expect(page.getByLabel('Email address')).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await page.getByLabel('Email address').fill('erin@flofi-e2e.test');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByLabel(/Enter the 6-digit code/).fill('246810');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page).toHaveURL('/onboarding');
  await page.goto('/onboarding/wallets');
  const popup = await walletWindow(page, () => page.getByRole('button', { name: 'Create Solana wallet' }).click(), 'erin@flofi-e2e.test');
  await popup.getByRole('button', { name: 'Email me a code' }).click();
  await expect(popup.getByText('We emailed an 8-character FloFi Wallet code to erin@flofi-e2e.test.')).toBeVisible();
  // The sign-in code shape is refused before anything is sent; then the wallet code unlocks.
  await popup.getByLabel('FloFi Wallet code').fill('246810');
  await popup.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(popup.getByRole('alert').filter({ hasText: 'Enter the 8-character code from the email.' }).first()).toBeVisible();
  await shot(popup, '10-flofi-wallet-email-code-refused');
  await popup.getByLabel('FloFi Wallet code').fill('FLOFI246');
  await popup.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(popup.getByText(/^Unlocked/).first()).toBeVisible();
  await popup.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Solana wallet created' })).toBeVisible();
  // Neither code ever travelled in plaintext to FloFi's product or wallet origin.
  expect(bodies.filter(body => /246810|FLOFI246/.test(body))).toEqual([]);
  // Lock ends FloFi Wallet's session in this browser: nothing can be signed from the window until FloFi opens it again (and it is unlocked).
  await popup.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(popup.getByRole('heading', { name: 'FloFi Wallet is locked' })).toBeVisible();
  expect((await popup.request.get(`${WALLET}/api/wallet/session`)).status()).toBe(401);
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

test('FloFi Wallet is another origin: each host serves only its own routes and the product origin holds no wallet key or provider route', async ({ page, request }) => {
  expect(WALLET).toMatch(/^http:\/\/localhost:\d+$/);
  // The wallet host serves only FloFi Wallet; the product host has none of it; no server action runs on the wallet host.
  expect((await request.get(`${WALLET}/app`)).status()).toBe(404);
  expect((await request.get(`${WALLET}/login`)).status()).toBe(404);
  expect((await request.get(`${E2E_APP_ORIGIN}/wallet`)).status()).toBe(404);
  expect((await request.get(`${E2E_APP_ORIGIN}/api/wallet/session`)).status()).toBe(404);
  expect((await request.post(`${WALLET}/wallet`, { headers: { 'next-action': '0'.repeat(42) } })).status()).toBe(404);
  // The old product-origin provider relay no longer exists: no provider request can be stamped or relayed from the product origin.
  expect((await request.post(`${E2E_APP_ORIGIN}/api/account/provider/submit/export_wallet`, { data: '{}' })).status()).toBe(404);
  const wallet = await request.get(`${WALLET}/wallet`);
  expect(wallet.headers()['content-security-policy']).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic';/);
  expect(wallet.headers()['content-security-policy']).not.toContain('unsafe-eval');
  expect(wallet.headers()['x-frame-options']).toBe('DENY');
  // A product page cannot use FloFi Wallet's routes: a cross-origin POST is refused before anything else.
  await setup(page);
  await page.goto('/app');
  const status = await page.evaluate(async origin => (await fetch(`${origin}/api/wallet/session`, { method: 'POST', mode: 'no-cors', credentials: 'include',
    body: '{"handoff":"x"}' }).then(() => 'sent', () => 'failed')), WALLET);
  // The product page's own policy (connect-src 'self') stops it in the browser; a form post or another client is refused by the server (below).
  expect(status).toBe('failed');
  const refused = await request.post(`${WALLET}/api/wallet/session`, { headers: { origin: E2E_APP_ORIGIN, 'sec-fetch-site': 'same-site' }, data: { handoff: 'x' } });
  expect(refused.status()).toBe(403);
  // No provider key store on the product origin.
  expect(await page.evaluate(async () => (await indexedDB.databases()).map(database => database.name))).not.toContain('TurnkeyStamperDB');
});

test('Apple and email sign-in create verified accounts; a wrong email code signs nobody in', async ({ page, context }) => {
  await setup(page);
  // The code is encrypted to the provider in the browser: no request to FloFi carries it in plaintext.
  const bodies: string[] = [];
  page.on('request', request => { if (new URL(request.url()).origin === E2E_APP_ORIGIN) bodies.push(request.postData() ?? ''); });
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
  expect(bodies.some(body => body.includes('encryptedOtpBundle') || body.includes('encappedPublic'))).toBe(true);
  expect(bodies.filter(body => body.includes('246810') || body.includes('000000'))).toEqual([]);
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
  // The person's own wallet signs FloFi workflows as before: no managed-wallet signing notice on it.
  await expect(card.locator('[data-managed-signing]')).toHaveCount(0);
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
