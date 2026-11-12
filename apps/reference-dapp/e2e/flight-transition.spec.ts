// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Flight transition), under playwright.flight.config.ts in the guarded `flight-closed-beta` profile (FLOFI_BETA_ACCESS=beta;
 * `--grep 'closed beta protects'` selects these tests by title): entering FloFi never shows a broken Flight Board and never jumps abruptly.
 * - back from sign-in, the board shows FloFi's checking state from its first paint (the board is never painted and then replaced) and opens
 *   /app once the check is eligible;
 * - a person the product already admits arriving on /board?board=1 is redirected to /app by the server: no board document is ever painted;
 * - a refused person lands on the board as its own document, styled by its own CSS (no product stylesheet), the same in light and dark;
 * - when access cannot be checked (the loopback database's grant table is taken offline), /app shows "We could not check your access" with
 *   Try again, no product content and no hop to /board;
 * - a re-render of /app that loses access (a Server Action's re-render, checked at the HTTP level; a client-router refresh in the browser)
 *   never redirects inside the product document: a full navigation loads /board with its own styles.
 * Same MOCKED loopback stand-ins and disposable LOOPBACK PostgreSQL database as e2e/board.spec.ts; test identities only. Nothing signs,
 * simulates or moves funds; no public network is reached (every other origin is refused). Paints are recorded in the page itself.
 */
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import { codeFor, codeHash, linkTokenFor, sha256Hex, tokenIdFor } from '../src/flight/access';
import { E2E_APP_ORIGIN } from './app-origin';

const PRIVY = process.env.FLOFI_PRIVY_EMULATOR_ORIGIN ?? '';
const harness = process.env.FLOFI_ACCOUNT_HARNESS_ORIGIN ?? '';
const WALLET = process.env.FLOFI_E2E_WALLET_ORIGIN ?? '';
const CLIENT_SCRIPT = fileURLToPath(new URL('./privy-emulator-client.js', import.meta.url));
const ACTION_MANIFEST = fileURLToPath(new URL('../.next/server/server-reference-manifest.json', import.meta.url));
const allowed = new Set([E2E_APP_ORIGIN, WALLET, harness]);
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
test.skip(process.env.FLOFI_FLIGHT_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Runs only under playwright.flight.config.ts');

const BOARDING = Date.parse('2026-11-12T10:00:00-03:00');
const run = randomBytes(3).toString('hex');
let people = 0;

async function query<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  try { return (await db.query(sql, values)).rows as T[]; } finally { await db.close(); }
}
async function at(context: BrowserContext, clock: number) {
  await context.addCookies([{ name: 'flofi_flight_clock', value: String(clock), url: E2E_APP_ORIGIN }]);
}
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** A fresh Solana address (the public half of a throwaway in-memory Ed25519 key; the private half is never kept or written). */
function solanaAddress(): string {
  const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  let value = BigInt(`0x${raw.toString('hex')}`), text = '';
  while (value > 0n) { text = BASE58[Number(value % 58n)]! + text; value /= 58n; }
  for (const byte of raw) { if (byte !== 0) break; text = `1${text}`; }
  return text;
}
/** The MOCKED Privy stand-in for this context and the wallet a sign-in will use. */
async function privy(page: Page, address: string) {
  const context = page.context();
  await context.route(`${E2E_APP_ORIGIN}/__privy-e2e/**`, async route => {
    const path = new URL(route.request().url()).pathname.slice('/__privy-e2e/'.length);
    const response = await fetch(`${PRIVY}/client/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() ?? '{}' });
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  await context.addInitScript({ path: CLIENT_SCRIPT });
  const identity = { wallet: { address, chain: 'solana' } };
  await context.addInitScript(value => { (window as unknown as { __FLOFI_PRIVY_E2E_IDENTITY__: unknown }).__FLOFI_PRIVY_E2E_IDENTITY__ = value; }, identity);
}
/** A beta-list entry and the email code the campaign would send for it (as e2e/board.spec.ts's accessEmail). */
async function listedWithCode(email: string): Promise<string> {
  await query(`INSERT INTO flight_list_entries (tenant_id, entry_id, email, flight, language, notice) VALUES ('default', $1, $2, 'FIRST', 'EN', '2026-11-05')`,
    [`fle_${randomBytes(16).toString('hex')}`, email]);
  const secret = process.env.FLOFI_FLIGHT_E2E_ACCESS_SECRET!, emailId = `fem_${randomBytes(16).toString('hex')}`, tokenId = tokenIdFor(secret, emailId);
  const link = linkTokenFor(secret, emailId), code = codeFor(secret, emailId);
  await query(`INSERT INTO flight_access_tokens (tenant_id, token_id, entry_id, purpose, link_hash, code_hash, created_at, link_expires_at, code_expires_at)
    SELECT 'default', $1, entry_id, 'BOARDING', $2, $3, $5::timestamptz, $5::timestamptz + interval '72 hours', $5::timestamptz + interval '72 hours'
    FROM flight_list_entries WHERE email = $4`, [tokenId, sha256Hex(link), codeHash(secret, tokenId, code), email, new Date(BOARDING).toISOString()]);
  return code;
}
const post = (page: Page, path: string, data: object) => page.evaluate(async ({ path, data }) => {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}, { path, data });
const accountOf = async (address: string) => (await query<{ account_id: string }>(
  `SELECT account_id FROM flofi_account_identities WHERE kind = 'SOLANA' AND subject = $1`, [address]))[0]?.account_id ?? null;
/** Grants this suite created are removed again, so other closed-beta tests on this database see only their own. */
const created: string[] = [];
test.afterEach(async () => {
  if (created.length) await query('DELETE FROM flight_beta_grants WHERE account_id = ANY($1::text[])', [created.splice(0)]);
});

/** A signed-in person (Solana wallet login) whose list entry is claimed; with `board`, "Board now" already granted product access. */
async function person(page: Page, { board }: { board: boolean }) {
  const address = solanaAddress(), email = `transition-${run}-${++people}@flofi-e2e.test`, code = await listedWithCode(email);
  await at(page.context(), BOARDING);
  await privy(page, address);
  await page.goto('/login?returnTo=%2Fboard');
  await page.getByRole('button', { name: 'Web3 Wallet', exact: true }).click();
  await expect(page).toHaveURL('/board');
  expect((await post(page, '/api/board/access/code', { email, code })).status).toBe(200);
  const account = await accountOf(address);
  expect(account).toBeTruthy();
  created.push(account!);
  if (board) expect((await post(page, '/api/board/board', {})).body).toMatchObject({ ok: true, flight: { access: { kind: 'eligible' } } });
  return { address, account: account!, email };
}

/**
 * What each document paints: on every DOM change and every animation frame, which of FloFi's surfaces is actually rendered (laid out and
 * visible) and whether the document is the one /app loaded (`__productDocument`, set by the test). Deduplicated, reported to the test.
 */
type Paint = { path: string; productDocument: boolean; transition: boolean; board: boolean; retry: boolean; app: boolean };
async function recordPaints(page: Page): Promise<Paint[]> {
  const paints: Paint[] = [];
  await page.exposeFunction('__flightPaint', (paint: Paint) => { paints.push(paint); });
  await page.addInitScript(() => {
    const seen = new Set<string>();
    const shown = (selector: string) => {
      const element = document.querySelector(selector);
      return Boolean(element && element.getClientRects().length > 0 && element.checkVisibility({ visibilityProperty: true }));
    };
    const sample = () => {
      if (!document.body) return;
      const paint = { path: location.pathname, productDocument: (window as unknown as { __productDocument?: boolean }).__productDocument === true,
        transition: shown('[data-flight-transition]'), board: shown('#top'), retry: shown('[data-flight-gate="retry"]'), app: shown('.app-shell') };
      const key = JSON.stringify(paint);
      if (seen.has(key)) return;
      seen.add(key);
      void (window as unknown as { __flightPaint: (value: unknown) => Promise<void> }).__flightPaint(paint);
    };
    new MutationObserver(sample).observe(document, { subtree: true, childList: true, attributes: true });
    const frame = () => { sample(); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
  return paints;
}

/** The board's own look, read from the page: canvas, type, colour scheme, header and hero, and whether any product stylesheet is loaded. */
const boardLook = (page: Page) => page.evaluate(() => {
  const style = (element: Element | null) => element ? getComputedStyle(element) : null;
  const html = style(document.documentElement)!, body = style(document.body)!, root = style(document.querySelector('[data-flight-page]'));
  const header = style(document.querySelector('[data-flight-page] header')), heading = style(document.querySelector('#top h1'));
  const productCss = [...document.styleSheets].some(sheet => { try { return [...sheet.cssRules].some(rule => rule.cssText.includes('.app-shell')); } catch { return false; } });
  return { htmlBackground: html.backgroundColor, htmlScheme: html.colorScheme, bodyBackground: body.backgroundColor, bodyColor: body.color,
    bodyFont: /Outfit/.test(body.fontFamily), rootSize: root?.fontSize, rootColor: root?.color, rootScheme: root?.colorScheme,
    header: header?.backgroundColor, headingLarge: Number.parseFloat(heading?.fontSize ?? '0') >= 52, productCss };
});
const BOARD_LOOK = { htmlBackground: 'rgb(255, 255, 255)', htmlScheme: 'light', bodyBackground: 'rgb(255, 255, 255)', bodyColor: 'rgb(4, 27, 61)', bodyFont: true,
  rootSize: '16px', rootColor: 'rgb(4, 27, 61)', rootScheme: 'light', header: 'rgb(35, 67, 217)', headingLarge: true, productCss: false };
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });

/** The id of a Server Action of this build, from Next.js's own server reference manifest (no guessed protocol values). */
function serverAction(exportedName: string, file: string): string {
  const manifest = JSON.parse(readFileSync(ACTION_MANIFEST, 'utf8')) as { node?: Record<string, { exportedName?: string; filename?: string }> };
  const ids = Object.entries(manifest.node ?? {}).filter(([, entry]) => entry.exportedName === exportedName && (entry.filename ?? file).includes(file)).map(([id]) => id);
  if (ids.length !== 1) throw new Error(`SERVER_ACTION_NOT_IN_MANIFEST ${exportedName} (${ids.length})`);
  return ids[0]!;
}

if (process.env.FLOFI_BETA_ACCESS === 'beta') {
  test('closed beta protects the Flight transition: back from sign-in the board paints FloFi’s checking state, never the board, and opens /app', async ({ page }) => {
    const address = solanaAddress(), email = `transition-${run}-${++people}@flofi-e2e.test`, code = await listedWithCode(email);
    await at(page.context(), BOARDING);
    // A link's code proves the list address before sign-in (an HttpOnly pending session); "Board now" then asks to sign in.
    await page.goto('/board');
    expect((await post(page, '/api/board/access/code', { email, code })).body).toMatchObject({ ok: true, status: 'SESSION' });
    await privy(page, address);
    const paints = await recordPaints(page);
    await page.reload();
    await page.getByRole('button', { name: 'Board now' }).click();
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fboard%3Fboard%3D1$/);
    paints.length = 0;
    await page.getByRole('button', { name: 'Web3 Wallet', exact: true }).click();
    // Sign-in returns to /board?board=1; the board's own check binds the proven entry, boards the person and opens /app.
    await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });
    await expect(page.locator('.app-shell')).toBeVisible();
    const onBoard = paints.filter(paint => paint.path === '/board');
    expect(onBoard.length).toBeGreaterThan(0);
    expect(onBoard.filter(paint => paint.board)).toEqual([]);
    expect(onBoard.some(paint => paint.transition)).toBe(true);
    const account = await accountOf(address);
    created.push(account!);
    expect(await query('SELECT source FROM flight_beta_grants WHERE account_id = $1', [account])).toEqual([{ source: 'LIST' }]);
    expect(await page.evaluate(() => sessionStorage.getItem('flofi.flight.boarding'))).toBe('1');
  });

  test('closed beta protects the Flight transition: an admitted person back on /board?board=1 is redirected to /app before any board paints', async ({ page }) => {
    await person(page, { board: true });
    const paints = await recordPaints(page);
    const response = await page.goto('/board?board=1');
    expect(new URL(response!.url()).pathname).toBe('/app');
    const hop = response!.request().redirectedFrom();
    expect(hop && new URL(hop.url()).pathname + new URL(hop.url()).search).toBe('/board?board=1');
    expect((await hop!.response())?.status()).toBe(307);
    await expect(page.locator('.app-shell')).toBeVisible();
    // No /board document was ever committed, so nothing of the board could paint.
    expect(paints.filter(paint => paint.path === '/board')).toEqual([]);
    await shot(page, 'flight-transition-admitted-app');
  });

  test('closed beta protects the Flight transition: a refused person sees the board as its own page, styled the same in light and dark', async ({ page }) => {
    await at(page.context(), BOARDING);
    await page.goto('/app');
    await expect(page).toHaveURL('/board');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Say where you’re going.');
    await expect(page.locator('.app-shell')).toHaveCount(0);
    expect(await boardLook(page)).toEqual(BOARD_LOOK);
    await shot(page, 'flight-transition-refused-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await boardLook(page)).toEqual(BOARD_LOOK);
    // A product theme left on <html> (as the product sets it) changes nothing either.
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    expect(await boardLook(page)).toEqual(BOARD_LOOK);
    await shot(page, 'flight-transition-refused-dark');
  });

  test('closed beta protects the Flight transition: when access cannot be checked, /app offers Try again with no product content and no hop to /board', async ({ page }) => {
    await person(page, { board: true });
    await page.goto('/app');
    await expect(page.locator('.app-shell')).toBeVisible();
    // The access store becomes unavailable (the loopback database's grant table is taken offline), then comes back.
    await query('ALTER TABLE flight_beta_grants RENAME TO flight_beta_grants_e2e_offline');
    try {
      await page.goto('/app');
      await expect(page).toHaveURL('/app');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('We could not check your access');
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
      await expect(page.locator('.app-shell')).toHaveCount(0);
      await expect(page.locator('[data-flight-page]')).toHaveCount(0);
      await shot(page, 'flight-transition-unavailable');
    } finally { await query('ALTER TABLE flight_beta_grants_e2e_offline RENAME TO flight_beta_grants'); }
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page).toHaveURL('/app');
    await expect(page.locator('.app-shell')).toBeVisible();
  });

  test('closed beta protects the Flight transition: a re-render of /app that loses access loads /board as its own document, never inside the product', async ({ page }) => {
    const { account } = await person(page, { board: true });
    const paints = await recordPaints(page);
    await page.goto('/app');
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.evaluate(() => { (window as unknown as { __productDocument: boolean }).__productDocument = true; });
    await query('UPDATE flight_beta_grants SET revoked_at = clock_timestamp() WHERE account_id = $1', [account]);
    // A Server Action that sets a cookie (here: clearing this browser's wallet proofs) re-renders /app in its response. That re-render now
    // carries the full-page hand-off to /board — never a redirect into the product document, never any workspace content.
    const action = await page.evaluate(async id => {
      const response = await fetch('/app', { method: 'POST', headers: { 'next-action': id, accept: 'text/x-component', 'content-type': 'text/plain;charset=UTF-8' }, body: '[]' });
      return { status: response.status, redirect: response.headers.get('x-action-redirect'), body: await response.text() };
    }, serverAction('walletSignOut', 'wallet-session-action'));
    expect(action.status).toBe(200);
    expect(action.redirect).toBeNull();
    expect(action.body).toContain('"response":"HANDOFF"');
    expect(action.body).not.toContain('initialWorkflowId');
    // The browser's own client-router re-render of /app gets the same hand-off and leaves with a full navigation.
    await page.evaluate(() => { (window as unknown as { next: { router: { refresh(): void } } }).next.router.refresh(); });
    await expect(page).toHaveURL('/board');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __productDocument?: boolean }).__productDocument)).toBeUndefined();
    expect(await boardLook(page)).toEqual(BOARD_LOOK);
    // The board was never drawn inside the product's document.
    expect(paints.filter(paint => paint.path === '/board' && paint.productDocument)).toEqual([]);
    expect(paints.some(paint => paint.path === '/app' && paint.transition)).toBe(true);
    await shot(page, 'flight-transition-lost-access-board');
  });
}
