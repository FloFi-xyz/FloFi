// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001 / BUILD-FLOFI-PRIVY-UX-001: landing → Privy sign-in (Google, email code, Web3 wallet) → Add your wallets
 * (one-click EVM/Solana creation, the dedicated private-key import screen, addresses in their cards) → app, Disconnect back to /login, My
 * wallets (Privy and legacy FloFi Wallet), and Privy-backed signing of a reviewed Solana mainnet swap (Jupiter) and a reviewed Base mainnet
 * transfer behind FloFi's reviewed-attempt gate, with refusals for what matches no Review or names a test network.
 * MOCKED loopback providers only (playwright.auth-wallets.config.ts): Privy is the loopback stand-in (e2e/privy-emulator.ts and its browser
 * half e2e/privy-emulator-client.js), Solana/Jupiter and Base are mainnet-shaped loopback harnesses. This proves FloFi's own flows, server
 * verification, isolation and authorization, never the live Privy, Google or chain services. Screenshots go to the test output directory.
 */
import { test as base, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JUPITER_SOLANA_MAINNET } from '@defi-workflow-engine/action-registry';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import { base58Encode } from '@defi-workflow-engine/reference-compiler';
import { createNativeTransferNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { E2E_APP_ORIGIN } from './app-origin';
import { openSimulationDetails } from './fixtures';
import { authorSolanaSwap, chooseSolanaWallet, jupiterControl } from './jupiter-fixtures';
import { createAccountStore } from '../src/accounts/account-store';
import { claimAttempt, signingDeps } from '../src/app/flofi-wallet-signing';
import { CATALOG_NETWORKS, localCatalogNetworkMode } from '../src/server/catalog-networks';
import { createJupiterService } from '../src/server/jupiter-service';
import { createJupiterHttp } from '../src/server/jupiter-http';
import { decodeSignedEip1559, resolveManagedSigning } from '../src/server/managed-signing';
import { createManagedWalletEvm, expectedBroadcast } from '../src/server/managed-wallet-evm';
import { createRobinhoodTransferService } from '../src/server/robinhood-transfer-service';
import { createSolanaRpc } from '../src/server/solana-rpc';
import { parseSigningContext } from '../src/wallet/flofi-signing';

const harness = process.env.FLOFI_ACCOUNT_HARNESS_ORIGIN ?? '';
/** The legacy FloFi Wallet (export only): the same loopback server under another host name, i.e. another origin. */
const WALLET = process.env.FLOFI_E2E_WALLET_ORIGIN ?? '';
const PRIVY = process.env.FLOFI_PRIVY_EMULATOR_ORIGIN ?? '';
const CLIENT_SCRIPT = fileURLToPath(new URL('./privy-emulator-client.js', import.meta.url));
const allowed = new Set([E2E_APP_ORIGIN, WALLET, harness, harness.replace(/:(\d+)$/, (_, p: string) => `:${Number(p) + 1}`), harness.replace(/:(\d+)$/, (_, p: string) => `:${Number(p) + 2}`)]);
/** Closed loop: the app (and the legacy wallet origin) only; the Privy stand-in is reached through the app origin's routed `/__privy-e2e/*`. */
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
test.describe.configure({ mode: 'serial' });

type Identity = { readonly google?: string; readonly email?: string; readonly wallet?: { readonly address: string; readonly chain?: 'ethereum' | 'solana' } };
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: false });
const db = () => createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
async function query<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  const database = db();
  try { return (await database.query(sql, values)).rows as T[]; } finally { await database.close(); }
}
const privyStats = async () => await (await fetch(`${PRIVY}/__e2e/stats`)).json() as { signatures: number; imports: number; creations: number; exports: number; logins: number };
const privyUser = async (by: { google?: string; email?: string }) => await (await fetch(`${PRIVY}/__e2e/user?${new URLSearchParams(by as Record<string, string>)}`)).json() as
  { id: string; wallets: string[]; tokens: number } | null;

/** The MOCKED Privy stand-in for this browser context: its browser half, the routed `/__privy-e2e/*` and the identity a sign-in will use. */
async function setup(page: Page, identity: Identity, { theme = 'dark', language = 'EN' }: { theme?: 'dark' | 'light'; language?: 'EN' | 'PT' } = {}) {
  const context = page.context();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await context.route(`${E2E_APP_ORIGIN}/__privy-e2e/**`, async route => {
    const path = new URL(route.request().url()).pathname.slice('/__privy-e2e/'.length);
    const response = await fetch(`${PRIVY}/client/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() ?? '{}' });
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  await context.addInitScript({ path: CLIENT_SCRIPT });
  await context.addInitScript(({ identity, theme, language }) => {
    (window as unknown as { __FLOFI_PRIVY_E2E_IDENTITY__: unknown }).__FLOFI_PRIVY_E2E_IDENTITY__ = identity;
    localStorage.setItem('flofi.theme', theme); localStorage.setItem('flofi.language', language);
  }, { identity, theme, language });
}
async function googleSignIn(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Google', exact: true }).click();
}
const accountCookie = async (context: BrowserContext) => (await context.cookies()).find(cookie => cookie.name === 'flofi_account_session');
const card = (page: Page, ecosystem: 'evm' | 'solana') => page.locator(`section[data-ecosystem="${ecosystem}"]`);
/** Every request this page sends to FloFi's own origin, with its body (to prove what never leaves the browser for FloFi). */
function recordAppRequests(context: BrowserContext) {
  const sent: { url: string; body: string; headers: string }[] = [];
  context.on('request', request => { if (request.url().startsWith(E2E_APP_ORIGIN) && !request.url().includes('/__privy-e2e/')) sent.push({ url: request.url(),
    body: request.postData() ?? '', headers: JSON.stringify(request.headers()) }); });
  return sent;
}
const privyDialog = (page: Page) => page.getByRole('dialog', { name: 'Privy confirmation (MOCKED)' });
/** This browser's Privy session token (the stand-in's) and whether the stand-in still accepts it. */
const privyToken = (page: Page) => page.evaluate(() => localStorage.getItem('flofi-e2e-privy-token'));
const privyAccepts = async (token: string | null) => (await fetch(`${PRIVY}/client/user`, { method: 'POST', body: JSON.stringify({ token }) })).ok;

test('every product-origin document carries a fresh nonce, including public and error pages, and blocks injected inline script', async ({ page }) => {
  await setup(page, {});
  const nonces = new Set<string>();
  for (const path of ['/', '/docs', '/privacy', '/unknown-privy-security-test', '/login']) {
    const response = await page.goto(path);
    expect(response!.status()).toBe(path.startsWith('/unknown') ? 404 : 200);
    const policy = response!.headers()['content-security-policy']!;
    const nonce = /script-src 'self' 'nonce-([A-Za-z0-9+/]{22}==)'/.exec(policy)?.[1];
    expect(nonce, path).toBeTruthy();
    expect(nonces.has(nonce!), path).toBe(false);
    nonces.add(nonce!);
    expect(policy, path).toContain("script-src-attr 'none'");
    expect(policy, path).not.toMatch(/strict-dynamic|script-src[^;]*unsafe-inline/);
    // Inspect the nonce property: browsers deliberately hide the attribute value from getAttribute.
    const inline = await page.locator('script:not([src])').evaluateAll(scripts => scripts.map(script => (script as HTMLScriptElement).nonce));
    expect(inline.length, path).toBeGreaterThan(0);
    expect(inline.every(value => value === nonce), path).toBe(true);
    const ran = await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.__flofiInjectedScriptRan = true';
      document.body.append(script);
      return (window as { __flofiInjectedScriptRan?: boolean }).__flofiInjectedScriptRan;
    });
    expect(ran, path).toBeUndefined();
  }
  await expect(page.getByRole('button', { name: 'Google', exact: true })).toBeEnabled();
});

test('the landing opens sign-in with exactly Google, Email and Web3 Wallet through Privy (desktop, mobile, PT/EN, light/dark)', async ({ page, request }) => {
  await setup(page, {});
  await page.goto('/');
  await page.goto('/login');
  const methods = page.getByRole('group', { name: 'Sign-in methods' });
  await expect(methods.getByRole('button')).toHaveText(['Google', 'Email', 'Web3 Wallet']);
  for (const button of await methods.getByRole('button').all()) await expect(button).toBeEnabled();
  await expect(page.getByText(/turnkey/i)).toHaveCount(0);
  await shot(page, '01-login-desktop-dark');
  // The account pages' nonce policy allows Privy's API and wallet frame, and nothing else outside FloFi.
  const csp = (await request.get('/login')).headers()['content-security-policy']!;
  // Only FloFi's own scripts (BUILD-FLOFI-PRIVY-UX-001): a nonce and 'self', no 'strict-dynamic', no other host (no bot check declared here).
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]{22}==' 'unsafe-eval'; /);
  expect(csp).not.toContain('strict-dynamic');
  expect(csp).toContain("connect-src 'self' https://auth.privy.io https://*.rpc.privy.systems wss://*.rpc.privy.systems");
  expect(csp).toContain('frame-src https://auth.privy.io');
  expect(csp).not.toMatch(/walletconnect|turnkey/i);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, '02-login-mobile-dark');
  // A later init script runs after setup's own, so the next load is light and in Portuguese.
  await page.context().addInitScript(() => { localStorage.setItem('flofi.theme', 'light'); localStorage.setItem('flofi.language', 'PT'); });
  await page.reload();
  await expect(page.getByRole('group', { name: 'Métodos de login' }).getByRole('button')).toHaveText(['Google', 'Email', 'Carteira Web3']);
  await shot(page, '03-login-mobile-light-pt');
});

test('Google sign-in, then one click per ecosystem creates a real Privy wallet, shown at once in its card; no second sign-in or extra window', async ({ page, context }) => {
  await setup(page, { google: 'e2e-ana' });
  const pages: Page[] = [];
  context.on('page', opened => pages.push(opened));
  await googleSignIn(page);
  await expect(page).toHaveURL('/onboarding/wallets');
  expect(await accountCookie(context)).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
  await expect(page.getByRole('heading', { name: 'Add your wallets' })).toBeVisible();
  // The informational FloFi Wallet card is gone; each ecosystem card has Create wallet and Import key; nothing exists yet.
  await expect(page.getByText('Your wallets open in FloFi Wallet')).toHaveCount(0);
  for (const ecosystem of ['evm', 'solana'] as const) {
    await expect(card(page, ecosystem).getByRole('button', { name: /Create wallet/ })).toBeEnabled();
    await expect(card(page, ecosystem).getByRole('link', { name: /Import key/ })).toHaveAttribute('href', `/onboarding/wallets/import/${ecosystem}`);
  }
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await shot(page, '04-add-wallets-empty');

  const before = await privyStats();
  await card(page, 'evm').getByRole('button', { name: /Create wallet/ }).click();
  await expect(card(page, 'evm').locator('[data-wallet-address]')).toHaveAttribute('data-wallet-address', /^0x[0-9a-f]{40}$/);
  const evm = (await card(page, 'evm').locator('[data-wallet-address]').getAttribute('data-wallet-address'))!;
  // Done once: the card says so and offers no second Create (BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 P1-01: the address shows once, shortened,
  // with a copy button; the full address is never repeated in a row above the card).
  await expect(card(page, 'evm').getByRole('group', { name: /Wallet created/ })).toBeVisible();
  await expect(card(page, 'evm').getByRole('button', { name: /Create wallet/ })).toHaveCount(0);
  await expect(card(page, 'evm').getByText(evm, { exact: true })).toHaveCount(0);
  await expect(card(page, 'evm').getByRole('button', { name: /^Copy .* address$/ })).toHaveCount(1);
  await card(page, 'solana').getByRole('button', { name: /Create wallet/ }).click();
  await expect(card(page, 'solana').locator('[data-wallet-address]')).toHaveAttribute('data-wallet-address', /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const solana = (await card(page, 'solana').locator('[data-wallet-address]').getAttribute('data-wallet-address'))!;
  expect(await privyStats()).toMatchObject({ creations: before.creations + 2, logins: before.logins });
  // No second Google sign-in, no unlock screen, no extra window: still one page, still on Add your wallets.
  expect(pages).toEqual([]);
  await expect(page).toHaveURL('/onboarding/wallets');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  await shot(page, '05-add-wallets-created');

  // Saved only after FloFi's server confirmed with Privy that this account's own Privy user holds them.
  const rows = await query<{ ecosystem: string; address: string; origin: string; provider: string; export: string; provider_resource: string | null }>(
    "SELECT ecosystem, address, origin, provider, export, provider_resource FROM flofi_account_wallets WHERE provider='privy' ORDER BY ecosystem");
  expect(rows).toEqual([{ ecosystem: 'EVM', address: evm, origin: 'GENERATED', provider: 'privy', export: 'PRIVATE_KEY', provider_resource: expect.stringMatching(/^ew/) },
    { ecosystem: 'SOLANA', address: solana, origin: 'GENERATED', provider: 'privy', export: 'PRIVATE_KEY', provider_resource: expect.stringMatching(/^sw/) }]);
  expect((await privyUser({ google: 'e2e-ana' }))!.wallets.sort()).toEqual([evm, solana].sort());
  // A refresh keeps both, from the account.
  await page.reload();
  await expect(card(page, 'evm').locator(`[data-wallet-address="${evm}"]`)).toBeVisible();
  await expect(card(page, 'solana').locator(`[data-wallet-address="${solana}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL('/app');
  expect(await query("SELECT onboarding FROM flofi_accounts a JOIN flofi_account_identities i USING (tenant_id, account_id) WHERE i.kind='GOOGLE' AND i.subject='e2e-ana'"))
    .toEqual([{ onboarding: 'COMPLETED' }]);
});

test('Import key: a dedicated FloFi screen per ecosystem; the key goes only to Privy and never to FloFi, its storage or its database', async ({ page, context }) => {
  await setup(page, { google: 'e2e-ana' });
  const sent = recordAppRequests(context);
  await googleSignIn(page);
  await expect(page).toHaveURL(/\/(app|onboarding\/wallets)$/);
  await page.goto('/onboarding/wallets');
  await card(page, 'evm').getByRole('link', { name: /Import key/ }).click();
  await expect(page).toHaveURL('/onboarding/wallets/import/evm');
  await expect(page.getByRole('heading', { name: 'Import your EVM wallet' })).toBeVisible();
  const form = page.getByRole('form', { name: 'Import EVM wallet' });
  await expect(form.getByLabel('Wallet name')).toHaveValue('Imported EVM wallet');
  // A masked text field (never a password field a browser offers to save), with autocomplete off and nothing that names it for a form.
  const keyField = form.getByLabel('Private key');
  await expect(keyField).toHaveAttribute('type', 'text');
  await expect(keyField).toHaveAttribute('autocomplete', 'off');
  await expect(keyField).not.toHaveAttribute('name');
  expect(await keyField.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-text-security'))).toBe('disc');
  await shot(page, '06-import-evm');
  // A malformed key is refused before Privy is asked.
  await form.getByLabel('Private key').fill('not a key');
  await form.getByRole('button', { name: 'Import wallet' }).click();
  await expect(page.locator('p[role="alert"]')).toHaveText('That does not look like a private key for this network. Nothing was imported.');
  await expect(form.getByLabel('Private key')).toHaveValue('');
  const evmKey = `0x${randomBytes(32).toString('hex')}`;
  await form.getByLabel('Wallet name').fill('My Rabby key');
  await form.getByLabel('Private key').fill(evmKey);
  await form.getByRole('button', { name: 'Import wallet' }).click();
  await expect(page).toHaveURL('/onboarding/wallets');
  // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-01): the imported wallet is its card's tile (name, short address, copy), not a row above it.
  const imported = card(page, 'evm').locator('[data-wallet-address]', { hasText: 'My Rabby key' });
  await expect(imported).toContainText('Imported');

  // Solana: a 64-byte base58 secret key, as Phantom exports it.
  const pair = generateKeyPairSync('ed25519'), der = pair.privateKey.export({ type: 'pkcs8', format: 'der' }), spki = pair.publicKey.export({ type: 'spki', format: 'der' });
  const solanaKey = base58Encode(Buffer.concat([der.subarray(der.length - 32), spki.subarray(spki.length - 32)]));
  await card(page, 'solana').getByRole('link', { name: /Import key/ }).click();
  await expect(page).toHaveURL('/onboarding/wallets/import/solana');
  await page.getByLabel('Private key').fill(solanaKey);
  await page.getByRole('button', { name: 'Import wallet' }).click();
  await expect(page).toHaveURL('/onboarding/wallets');
  await expect(card(page, 'solana').locator(`[data-wallet-address="${base58Encode(spki.subarray(spki.length - 32))}"]`)).toContainText('Imported');

  // Neither key ever reached FloFi: no request to FloFi's origin, no browser storage, no database row carries it.
  for (const key of [evmKey, evmKey.slice(2), solanaKey]) {
    expect(sent.filter(request => request.body.includes(key) || request.url.includes(key) || request.headers.includes(key))).toEqual([]);
    expect(await page.evaluate(value => JSON.stringify({ ...localStorage }).includes(value) || JSON.stringify({ ...sessionStorage }).includes(value) || document.cookie.includes(value), key)).toBe(false);
    expect(await query('SELECT 1 FROM flofi_account_wallets t WHERE to_jsonb(t)::text LIKE $1', [`%${key}%`])).toEqual([]);
  }
  expect(await query("SELECT label, origin, export FROM flofi_account_wallets WHERE label='My Rabby key'")).toEqual([{ label: 'My Rabby key', origin: 'IMPORTED', export: 'PRIVATE_KEY' }]);
});

test('a wallet whose save never finished is recovered on the next visit, and Create never makes a second one', async ({ page }) => {
  await setup(page, { google: 'e2e-bruno' });
  await googleSignIn(page);
  await expect(page).toHaveURL('/onboarding/wallets');
  // Privy holds a wallet for this person that FloFi never saved (the tab closed during Create).
  const user = await privyUser({ google: 'e2e-bruno' });
  const { address } = await (await fetch(`${PRIVY}/__e2e/wallet`, { method: 'POST', body: JSON.stringify({ user: user!.id, ecosystem: 'evm' }) })).json() as { address: string };
  await page.reload();
  await expect(card(page, 'evm').locator(`[data-wallet-address="${address}"]`)).toBeVisible();
  await expect(card(page, 'evm').getByRole('group', { name: /Wallet created/ })).toBeVisible();
  await expect(card(page, 'evm').getByRole('button', { name: /Create wallet/ })).toHaveCount(0);
  expect((await privyUser({ google: 'e2e-bruno' }))!.wallets).toEqual([address]);
});

test('email code sign-in through Privy reaches the existing FloFi account of that address; a wrong code signs nobody in', async ({ page, context }) => {
  // An account from before Privy: its verified email identity, onboarding finished.
  const database = db();
  let accountId: string;
  try {
    const store = createAccountStore(database, 'default'), signed = await store.signIn({ kind: 'email', subject: 'carla@flofi-e2e.test', label: 'carla@flofi-e2e.test' });
    await store.setOnboarding(signed.accountId, 'completed');
    await store.revokeSession(signed);
    accountId = signed.accountId;
  } finally { await database.close(); }
  await setup(page, { email: 'carla@flofi-e2e.test' });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Email', exact: true }).click();
  await page.getByLabel('Email address').fill('carla@flofi-e2e.test');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByLabel(/Enter the 6-digit code/).fill('000000');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page.locator('p[role="alert"]')).toHaveText('That code is not valid or has expired. Request a new one.');
  expect(await accountCookie(context)).toBeUndefined();
  await page.getByRole('button', { name: 'Send a new code' }).click();
  await page.getByLabel(/Enter the 6-digit code/).fill('135790');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page).toHaveURL('/app');
  expect(await query<{ kind: string }>('SELECT kind FROM flofi_account_identities WHERE account_id=$1 ORDER BY kind', [accountId])).toEqual([{ kind: 'EMAIL' }, { kind: 'PRIVY' }]);
  expect(await query('SELECT method FROM flofi_account_sessions WHERE account_id=$1 AND revoked_at IS NULL', [accountId])).toEqual([{ method: 'EMAIL' }]);
});

test('Web3 Wallet sign-in through Privy: the proven wallet is the account’s sign-in identity, never a FloFi-managed wallet; FloFi opens directly (T05)', async ({ page }) => {
  const address = `0x${randomBytes(20).toString('hex')}`;
  await setup(page, { wallet: { address } });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Web3 Wallet', exact: true }).click();
  // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-05): a wallet sign-in needs no "Add your wallets"; no embedded wallet is created for it.
  await expect(page).toHaveURL('/app');
  const [row] = await query<{ account_id: string }>("SELECT account_id FROM flofi_account_identities WHERE kind='EIP155' AND subject=$1", [address]);
  expect(row).toBeTruthy();
  expect(await query("SELECT 1 FROM flofi_account_wallets WHERE address=$1 AND provider='privy'", [address])).toEqual([]);
});

test('Disconnect revokes the session, logs out of Privy and lands on /login; Back and a reload never sign anyone in again', async ({ page, context }) => {
  await setup(page, { google: 'e2e-ana' });
  await googleSignIn(page);
  await expect(page).toHaveURL(/\/(app|onboarding\/wallets)$/);
  const session = (await accountCookie(context))!, token = await privyToken(page);
  expect(await privyAccepts(token)).toBe(true);
  const ANA = "account_id IN (SELECT account_id FROM flofi_account_identities WHERE kind='GOOGLE' AND subject='e2e-ana')";
  const live = async () => (await query<{ n: number }>(`SELECT count(*)::int AS n FROM flofi_account_sessions WHERE revoked_at IS NULL AND ${ANA}`))[0]!.n;
  const wallets = async () => (await query<{ n: number }>(`SELECT count(*)::int AS n FROM flofi_account_wallets WHERE ${ANA}`))[0]!.n;
  const [liveBefore, walletsBefore] = [await live(), await wallets()];
  await page.goto('/app/credentials');
  await expect(page.getByRole('region', { name: 'Wallets', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'My wallets' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings' }).click();
  // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-04): one Disconnect, no separate Sign out.
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page).toHaveURL('/login');
  expect(await accountCookie(context)).toBeUndefined();
  expect(await privyAccepts(token)).toBe(false);
  expect(await privyToken(page)).toBeNull();
  // This browser's session record is revoked; other browsers of the account keep theirs (Disconnect is per browser).
  expect(await live()).toBe(liveBefore - 1);
  // The old cookie is useless even if replayed: its server-side record is revoked.
  await context.addCookies([{ ...session, sameSite: 'Lax' }]);
  await page.goto('/onboarding/wallets');
  await expect(page).toHaveURL(/\/login/);
  await context.clearCookies({ name: 'flofi_account_session' });
  // Back never shows the signed-in pages again, and /login stays a sign-in page.
  await page.goBack();
  await expect(page.getByRole('region', { name: 'Wallets', exact: true }).getByText('Sign in to save wallet addresses')).toBeVisible({ timeout: 15_000 }).catch(async () => {
    await expect(page).toHaveURL(/\/login/);
  });
  await page.goto('/login');
  await page.reload();
  await expect(page.getByRole('group', { name: 'Sign-in methods' })).toBeVisible();
  expect(await accountCookie(context)).toBeUndefined();
  // Nothing about the account, its wallets or history was deleted.
  expect(await wallets()).toBe(walletsBefore);
});

test('signer pages render Privy from the server render on (no remount, no false "not configured" text)', async ({ page }) => {
  await setup(page, { email: 'keep@flofi-e2e.test' });
  const html = await (await page.request.get('/login')).text();
  expect(html).not.toContain('not configured on this deployment');
  // The page stays mounted once loaded: what is typed survives Privy becoming ready, and the document is never reloaded.
  await page.goto('/login');
  await page.getByRole('button', { name: 'Email', exact: true }).click();
  await page.getByLabel('Email address').fill('keep@flofi-e2e.test');
  await expect(page.getByRole('button', { name: 'Email me a code' })).toBeEnabled();
  await expect(page.getByLabel('Email address')).toHaveValue('keep@flofi-e2e.test');
  expect(await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type)).toBe('navigate');
});

test('a Privy session left in the browser is never reused by /login on its own', async ({ page, context }) => {
  await setup(page, { google: 'e2e-ana' });
  await googleSignIn(page);
  await expect(page).toHaveURL(/\/(app|onboarding\/wallets)$/);
  const token = await privyToken(page);
  expect(await privyAccepts(token)).toBe(true);
  // The FloFi session ends (cookie gone) while the Privy session stays in this browser.
  await context.clearCookies({ name: 'flofi_account_session' });
  await page.goto('/login');
  await expect(page.getByRole('group', { name: 'Sign-in methods' })).toBeVisible();
  await expect.poll(async () => privyAccepts(token)).toBe(false);
  expect(await accountCookie(context)).toBeUndefined();
  // Not even through a URL that looks like Privy's OAuth return: a session that already existed is ended, never signed in.
  await googleSignIn(page);
  await expect(page).toHaveURL(/\/(app|onboarding\/wallets)$/);
  const second = await privyToken(page);
  await context.clearCookies({ name: 'flofi_account_session' });
  await page.goto('/login?privy_oauth_code=e2e-crafted&privy_oauth_state=e2e-crafted');
  await expect.poll(async () => privyAccepts(second)).toBe(false);
  await expect(page.getByRole('group', { name: 'Sign-in methods' })).toBeVisible();
  expect(await accountCookie(context)).toBeUndefined();
});

// --- Privy-backed signing behind FloFi's reviewed-attempt gate (MOCKED loopback mainnet harnesses) ---
const JUPITER_RUN = /^jupiter-[a-f0-9]{32}$/, BASE_TRANSFER_RUN = /^bat-[a-f0-9]{32}$/, SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function mockedJournal(flow: 'jupiter' | 'base'): string {
  const [gate, journal, prefix] = flow === 'jupiter' ? [process.env.GRYLOO_JUPITER_E2E, process.env.GRYLOO_JUPITER_JOURNAL, 'gryloo-build014-']
    : [process.env.GRYLOO_BASE_MAINNET_E2E, process.env.GRYLOO_BASE_JOURNAL, 'gryloo-base-001-'];
  if (gate !== 'MOCKED_LOOPBACK_ONLY' || !journal?.startsWith(join(tmpdir(), prefix))) throw Error('MOCK_MAINNET_DENIED');
  return journal;
}
const JUPITER_HARNESS = 'http://127.0.0.1:8551';
const jupiterSwapService = () => createJupiterService({ journalDir: mockedJournal('jupiter'), provenance: 'MOCKED', executionEnabled: true,
  rpc: createSolanaRpc(`${JUPITER_HARNESS}/rpc`, true), http: createJupiterHttp(`${JUPITER_HARNESS}/swap/v2/build`, undefined) });
const BASE_HARNESS_ENV = Object.freeze({ GRYLOO_BASE_MAINNET_HARNESS: 'MOCKED_LOOPBACK_ONLY' });
function baseTransferService() {
  const network = CATALOG_NETWORKS.base;
  expect(localCatalogNetworkMode(network, BASE_HARNESS_ENV)).toBe('harness');
  return createRobinhoodTransferService({ journalDir: join(mockedJournal('base'), 'mainnet-transfer'), idPrefix: network.prefixes.transfer, provenance: 'MOCKED',
    rpcs: { [network.chain]: network.rpc('harness', BASE_HARNESS_ENV) }, catalogFor: network.catalogFor('harness'), executionEnabled: network.ownerExecutionEnabled('harness', BASE_HARNESS_ENV) });
}
const managedEvm = () => createManagedWalletEvm({ env: BASE_HARNESS_ENV, mode: network => localCatalogNetworkMode(network, BASE_HARNESS_ENV) });
const baseChain = async (body: Record<string, unknown>) => (await (await fetch('http://127.0.0.1:8562/__harness/chain', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as { result: unknown }).result;
const definition = (scope: Locator, label: string) => scope.getByRole('term').filter({ hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) })
  .locator('xpath=following-sibling::dd[1]');
const jupiterPanel = (page: Page) => page.getByRole('region', { name: 'Jupiter swap', exact: true });
type Answer = { ok: boolean; code?: string; result?: { signedTransaction?: string } };
/** One request through FloFi's own signing path on this page (src/wallet/flofi-privy-signer.ts): FloFi's gate, then Privy's confirmation. */
async function requestThroughFloFi(page: Page, request: Record<string, unknown>): Promise<Answer> {
  await page.waitForFunction(() => Boolean((window as unknown as { __FLOFI_PRIVY_E2E__?: { flofi?: unknown } }).__FLOFI_PRIVY_E2E__?.flofi));
  return page.evaluate(request => (window as unknown as { __FLOFI_PRIVY_E2E__: { flofi: { request(r: unknown): Promise<unknown> } } }).__FLOFI_PRIVY_E2E__.flofi.request(request)
    .then(result => ({ ok: true, result }), (error: Error) => ({ ok: false, code: error.message })), request) as Promise<Answer>;
}
async function signedInWithWallets(page: Page, google: string) {
  await setup(page, { google });
  await googleSignIn(page);
  await expect(page).toHaveURL(/\/(app|onboarding\/wallets)$/);
  await page.goto('/onboarding/wallets');
  for (const ecosystem of ['evm', 'solana'] as const) {
    const create = card(page, ecosystem).getByRole('button', { name: /Create wallet/ }), done = card(page, ecosystem).getByRole('group', { name: /Wallet created/ });
    // Wait until Privy is ready here (Create enabled) or the wallet already exists, then create it once.
    await expect.poll(async () => await done.count() > 0 || await create.isEnabled()).toBe(true);
    if (await done.count() === 0) await create.click();
    await expect(card(page, ecosystem).locator('[data-wallet-address]').first()).toBeVisible();
  }
  const evm = (await card(page, 'evm').locator('[data-wallet-address]').first().getAttribute('data-wallet-address'))!;
  const solana = (await card(page, 'solana').locator('[data-wallet-address]').first().getAttribute('data-wallet-address'))!;
  return { evm, solana };
}

test('a reviewed Solana mainnet swap (Jupiter) is signed by the person’s Privy wallet after FloFi’s gate; FloFi submits and reconciles it', async ({ page }) => {
  const { solana: owner } = await signedInWithWallets(page, 'e2e-dora');
  expect(owner).toMatch(SOLANA_ADDRESS);
  await rm(mockedJournal('jupiter'), { recursive: true, force: true });
  await page.goto('/app');
  await authorSolanaSwap(page);
  await page.getByRole('button', { name: 'Simulate workflow' }).click();
  await openSimulationDetails(page);
  // The person's Privy Solana wallet is offered as "FloFi Wallet" next to Phantom & co.; connecting shares its public address only.
  await chooseSolanaWallet(jupiterPanel(page), 'FloFi Wallet');
  await expect(jupiterPanel(page).locator('p', { hasText: 'Wallet connected:' }).locator('span')).toHaveText(owner);
  await jupiterControl({ action: 'reset', owner });
  await jupiterPanel(page).getByRole('button', { name: 'Simulate swap' }).click();
  await expect(definition(jupiterPanel(page), 'Provider')).toHaveText('Jupiter');
  const runId = await page.evaluate(() => (JSON.parse(localStorage.getItem('gryloo:build014:jupiter') ?? 'null') as { id?: string } | null)?.id ?? '');
  expect(runId).toMatch(JUPITER_RUN);
  // The owner's Review acceptance and Execute's durable attempt (the product UI does not authorize MOCKED results).
  const service = jupiterSwapService(), run = await service.load(runId);
  expect(run).toMatchObject({ provenance: 'MOCKED', review: { owner, chain: JUPITER_SOLANA_MAINNET.chain, cluster: 'mainnet-beta' } });
  await service.review(runId, run.review.commitment, run.review.workflow);
  const { unsignedTransaction } = await service.begin(runId, owner, run.review.workflow);
  const before = await privyStats();

  // Refused before Privy is asked (nothing claimed, nothing signed): one changed byte, the exact bytes without FloFi's binding, Devnet.
  const tampered = Buffer.from(unsignedTransaction, 'base64');
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
  for (const [request, code] of [
    [{ op: 'solana_sign_transaction', address: owner, chain: 'solana:mainnet', transaction: tampered.toString('base64'), signing: { flow: 'jupiter-swap', runId } }, /^FLOFI_WALLET_NO_MATCHING_REVIEW$/],
    [{ op: 'solana_sign_transaction', address: owner, chain: 'solana:mainnet', transaction: unsignedTransaction }, /^FLOFI_WALLET_REQUEST_INVALID$/],
    [{ op: 'solana_sign_transaction', address: owner, chain: 'solana:devnet', transaction: unsignedTransaction, signing: { flow: 'jupiter-swap', runId } },
      /^FLOFI_WALLET_(REQUEST_INVALID|NETWORK_UNSUPPORTED|NO_MATCHING_REVIEW)$/],
  ] as const) expect((await requestThroughFloFi(page, request)).code, JSON.stringify(request.chain)).toMatch(code);
  await expect(privyDialog(page)).toHaveCount(0);
  expect((await privyStats()).signatures).toBe(before.signatures);

  const answered = requestThroughFloFi(page, { op: 'solana_sign_transaction', address: owner, chain: 'solana:mainnet', transaction: unsignedTransaction,
    signing: { flow: 'jupiter-swap', runId } });
  // Privy's confirmation shows FloFi's server summary of the reviewed attempt (built from its own Review), and signs only on Approve.
  const dialog = privyDialog(page);
  await expect(dialog).toContainText('FloFi reviewed strategy');
  await expect(dialog).toContainText('Solana (real funds)');
  await expect(dialog).toContainText('You pay: 10 USDC');
  await expect(dialog).toContainText(`FloFi run ${runId}`);
  expect((await privyStats()).signatures).toBe(before.signatures);
  await shot(page, '07-privy-confirm-solana');
  await dialog.getByRole('button', { name: 'Approve' }).click();
  const answer = await answered;
  expect(answer.ok).toBe(true);
  const signed = Buffer.from(answer.result!.signedTransaction!, 'base64'), unsigned = Buffer.from(unsignedTransaction, 'base64');
  expect(signed.length).toBe(unsigned.length);
  expect(signed.subarray(65).equals(unsigned.subarray(65))).toBe(true);
  expect(signed.subarray(1, 65).some(byte => byte !== 0)).toBe(true);
  expect(await jupiterControl({ action: 'sent' })).toBe(0);
  // One signature per reviewed attempt: the same request again is refused before Privy is asked.
  expect(await requestThroughFloFi(page, { op: 'solana_sign_transaction', address: owner, chain: 'solana:mainnet', transaction: unsignedTransaction,
    signing: { flow: 'jupiter-swap', runId } })).toMatchObject({ ok: false, code: 'FLOFI_WALLET_ALREADY_SIGNED' });
  await expect(privyDialog(page)).toHaveCount(0);
  // FloFi's own submit verifies the signed bytes against the Review, broadcasts them once and reconciles independently.
  let record = await service.submit(runId, answer.result!.signedTransaction!);
  expect(record.attempt).toMatchObject({ state: 'PENDING', signature: base58Encode(signed.subarray(1, 65)) });
  for (let poll = 0; poll < 10 && !record.evidence; poll++) record = await service.observe(runId);
  expect(record).toMatchObject({ verdict: 'RECONCILED', provenance: 'MOCKED', evidenceClass: 'MOCKED', attempt: { state: 'CONFIRMED' } });
  expect(await jupiterControl({ action: 'sent' })).toBe(1);
  expect((await privyStats()).signatures).toBe(before.signatures + 1);
});

test('a reviewed Base mainnet transfer: a test network or other bytes are refused before Privy; Cancel signs nothing; FloFi broadcasts and reconciles', async ({ page }) => {
  const { evm: owner } = await signedInWithWallets(page, 'e2e-dora');
  await page.goto('/app');
  await rm(join(mockedJournal('base'), 'mainnet-transfer'), { recursive: true, force: true });
  await baseChain({ action: 'reset', owner, wei: (10n ** 16n).toString() });
  const service = baseTransferService();
  const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, resourceEdges: [],
    nodes: [createNativeTransferNode('node-002', { chain: 'eip155:8453', amount: '1000000000000000', recipient: '0x3333333333333333333333333333333333333333' })] };
  const simulated = await service.simulate(workflow, owner), runId = simulated.id;
  expect(runId).toMatch(BASE_TRANSFER_RUN);
  await service.review(runId, simulated.review.commitment, workflow);
  const { record: prepared, transaction } = await service.begin(runId, owner, workflow);
  await service.handoff(runId);
  const tx = { from: owner, to: transaction.to, value: transaction.value, data: transaction.data, chainId: transaction.chainId,
    nonce: `0x${BigInt(prepared.attempt!.nonce).toString(16)}`, gas: transaction.gas, maxFeePerGas: transaction.maxFeePerGas, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas };
  const signing = { flow: 'base-mainnet-transfer', runId }, before = await privyStats();

  // Refused before Privy is asked: Base Sepolia (84532), other bytes, no FloFi binding.
  for (const [request, code] of [[{ op: 'evm_sign_transaction', address: owner, tx: { ...tx, chainId: '0x14a34' }, signing }, /^FLOFI_WALLET_(NO_MATCHING_REVIEW|NETWORK_UNSUPPORTED)$/],
    [{ op: 'evm_sign_transaction', address: owner, tx: { ...tx, value: '0x1' }, signing }, /^FLOFI_WALLET_NO_MATCHING_REVIEW$/],
    [{ op: 'evm_sign_transaction', address: owner, tx }, /^FLOFI_WALLET_REQUEST_INVALID$/]] as const) {
    expect((await requestThroughFloFi(page, request)).code).toMatch(code);
  }
  await expect(privyDialog(page)).toHaveCount(0);
  expect((await privyStats()).signatures).toBe(before.signatures);

  // Cancel in Privy's confirmation: a rejection (nothing signed), and that attempt cannot be signed again: simulate again to retry.
  const cancelled = requestThroughFloFi(page, { op: 'evm_sign_transaction', address: owner, tx, signing });
  await expect(privyDialog(page)).toContainText('Base (real funds)');
  await expect(privyDialog(page)).toContainText(`FloFi run ${runId}`);
  await privyDialog(page).getByRole('button', { name: 'Cancel' }).click();
  expect(await cancelled).toMatchObject({ ok: false, code: 'FLOFI_WALLET_REJECTED' });
  expect((await privyStats()).signatures).toBe(before.signatures);
  expect(await requestThroughFloFi(page, { op: 'evm_sign_transaction', address: owner, tx, signing })).toMatchObject({ ok: false, code: 'FLOFI_WALLET_ALREADY_SIGNED' });

  // A fresh reviewed attempt is signed after Approve, then broadcast once by FloFi and reconciled. (The cancelled attempt keeps its nonce
  // reserved, as FloFi's transfer service does until it is proven unsubmitted; the MOCKED journal is reset to start that fresh attempt.)
  await rm(join(mockedJournal('base'), 'mainnet-transfer'), { recursive: true, force: true });
  const again = await service.simulate(workflow, owner), next = again.id;
  await service.review(next, again.review.commitment, workflow);
  const { record: attempt, transaction: second } = await service.begin(next, owner, workflow);
  await service.handoff(next);
  const tx2 = { from: owner, to: second.to, value: second.value, data: second.data, chainId: second.chainId, nonce: `0x${BigInt(attempt.attempt!.nonce).toString(16)}`,
    gas: second.gas, maxFeePerGas: second.maxFeePerGas, maxPriorityFeePerGas: second.maxPriorityFeePerGas };
  const answered = requestThroughFloFi(page, { op: 'evm_sign_transaction', address: owner, tx: tx2, signing: { flow: 'base-mainnet-transfer', runId: next } });
  await expect(privyDialog(page)).toContainText('You send: 0.001 ETH');
  await shot(page, '08-privy-confirm-base');
  await privyDialog(page).getByRole('button', { name: 'Approve' }).click();
  const answer = await answered;
  expect(answer.ok).toBe(true);
  const raw = answer.result!.signedTransaction!, decoded = decodeSignedEip1559(raw)!;
  // Exactly the nine fields FloFi's gate approved (the signer drops anything else before it returns), signed by the owner.
  expect(decoded.tx).toEqual({ from: owner, to: tx2.to.toLowerCase(), value: BigInt(tx2.value), data: tx2.data.toLowerCase(), chainId: 8453n, nonce: BigInt(tx2.nonce),
    gas: BigInt(tx2.gas), maxFeePerGas: BigInt(tx2.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx2.maxPriorityFeePerGas) });
  const database = db();
  try {
    const store = createAccountStore(database, 'default'), accountId = (await store.walletHolder('evm', owner))!;
    const resolved = await resolveManagedSigning(parseSigningContext({ flow: 'base-mainnet-transfer', runId: next })!, { ecosystem: 'evm', tx: decoded.tx },
      { ...signingDeps(await store.wallets(accountId)), load: async () => await service.load(next), filledBoundedAtSigning: true });
    expect(resolved).toMatchObject({ ok: true, value: { owner, evm: { chainId: 8453 } } });
    const match = (resolved as Extract<typeof resolved, { ok: true }>).value;
    expect(await claimAttempt(store, 'broadcast', match.attempt, match.expiresAtMs)).toBe(true);
    // One broadcast per reviewed attempt.
    expect(await claimAttempt(store, 'broadcast', match.attempt, match.expiresAtMs)).toBe(false);
    expect(await managedEvm().broadcast('0x2105', raw.toLowerCase(), expectedBroadcast(decoded.tx, decoded.hash))).toEqual({ kind: 'HASH', hash: decoded.hash });
  } finally { await database.close(); }
  await service.report(next, { kind: 'HASH', hash: decoded.hash });
  await baseChain({ action: 'mine', blocks: 2 });
  const record = await service.observe(next);
  expect(record).toMatchObject({ verdict: 'RECONCILED', provenance: 'MOCKED', attempt: { state: 'CONFIRMED', transactionHash: decoded.hash } });
  expect((await privyStats()).signatures).toBe(before.signatures + 1);
});

test('a legacy FloFi Wallet (Turnkey) wallet stays listed with its address, export-only, when its account signs in with Privy', async ({ page }) => {
  const address = `0x${randomBytes(20).toString('hex')}`;
  const database = db();
  try {
    const store = createAccountStore(database, 'default'), signed = await store.signIn({ kind: 'google', subject: 'e2e-legacy', label: null });
    await store.setOnboarding(signed.accountId, 'completed');
    await store.setWalletOrganization(signed.accountId, { provider: 'turnkey', organization: 'org-e2e-legacy01', user: 'user-e2e-legacy01', login: 'google' });
    await store.saveWallet(signed.accountId, { ecosystem: 'evm', address, origin: 'generated', provider: 'turnkey', providerName: 'FloFi wallet', providerResource: 'wallet-e2e-legacy01', label: 'EVM wallet' });
    await store.revokeSession(signed);
  } finally { await database.close(); }
  await setup(page, { google: 'e2e-legacy' });
  await googleSignIn(page);
  await expect(page).toHaveURL('/app');
  await page.goto('/app/credentials');
  const legacy = page.getByRole('region', { name: 'Wallets', exact: true }).locator('article', { hasText: address.slice(0, 6) });
  await expect(legacy).toContainText('Legacy FloFi Wallet');
  await expect(legacy).toContainText('Wallets created in the earlier FloFi Wallet can be exported, not used to sign.');
  await page.goto('/onboarding/wallets');
  await expect(card(page, 'evm').locator(`[data-wallet-address="${address}"]`)).toContainText('Legacy FloFi Wallet');
  expect(await query('SELECT provider, origin, export, provider_resource FROM flofi_account_wallets WHERE address=$1', [address]))
    .toEqual([{ provider: 'turnkey', origin: 'GENERATED', export: 'RECOVERY_PHRASE', provider_resource: 'wallet-e2e-legacy01' }]);
});

test('the legacy FloFi Wallet origin serves only its own export-only routes; the product origin holds no wallet key', async ({ page, request }) => {
  expect(WALLET).toMatch(/^http:\/\/localhost:\d+$/);
  expect((await request.get(`${WALLET}/app`)).status()).toBe(404);
  expect((await request.get(`${WALLET}/login`)).status()).toBe(404);
  expect((await request.get(`${E2E_APP_ORIGIN}/wallet`)).status()).toBe(404);
  expect((await request.post(`${WALLET}/wallet`, { headers: { 'next-action': '0'.repeat(42) } })).status()).toBe(404);
  // Nothing new is saved or signed there any more.
  expect((await request.post(`${WALLET}/api/wallet/wallets`, { headers: { origin: WALLET, 'sec-fetch-site': 'same-origin' }, data: { ids: [] } })).status()).toBe(410);
  expect((await request.post(`${WALLET}/api/wallet/sign-context`, { headers: { origin: WALLET, 'sec-fetch-site': 'same-origin' }, data: {} })).status()).toBe(404);
  await setup(page, {});
  await page.goto('/app');
  expect(await page.evaluate(async () => (await indexedDB.databases()).map(database => database.name))).not.toContain('TurnkeyStamperDB');
});

test('the database holds no secret-shaped value for any account', async () => {
  // `export` is a capability label (NONE / RECOVERY_PHRASE / PRIVATE_KEY), not secret material: every other value is scanned.
  const rows = await query<{ row: string }>(`SELECT (to_jsonb(t) - 'export')::text AS row FROM (SELECT * FROM flofi_account_wallets) t UNION ALL
    SELECT to_jsonb(t)::text FROM (SELECT * FROM flofi_account_identities) t UNION ALL SELECT to_jsonb(t)::text FROM (SELECT * FROM flofi_accounts) t
    UNION ALL SELECT to_jsonb(t)::text FROM (SELECT * FROM flofi_account_sessions) t`);
  expect(rows.length).toBeGreaterThan(5);
  // JWT shape (header.payload), not a bare `eyJ` substring — base58 Solana addresses can contain `eYj`.
  for (const { row } of rows) expect(String(row)).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|mnemonic|private.?key|\bseed\b|secret|0x[0-9a-f]{64}/i);
});
