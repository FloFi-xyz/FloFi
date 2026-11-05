// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: flofi.xyz/board end to end, under playwright.flight.config.ts — a disposable LOOPBACK database, the MOCKED Privy
 * emulator and the MOCKED Solana mainnet Jupiter harness, the app on the embedded runtime (the hosted code path). The campaign clock is the
 * loopback-only harness cookie. Test data only: no real inscription, identity, key, fund or public network is touched.
 *
 * The visitor reaches /board; joins the beta list (persisted once, a repeat answered the same way); the five states and their transitions
 * (Final call → Gate closed → Now boarding; group still closed → its group opens; not on the list → next flight; Founding full); the
 * operator CLI creates a group and issues an invite that works once; "Board now" signs a person in, keeps their request and opens /app with
 * it as a draft; a real server-side simulation issues their Founding pass with the real route; the CTAs and the campaign posts' links
 * resolve; sign-in and /app keep working.
 */
import { test as base, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import { E2E_APP_ORIGIN, returningVisitor } from './app-origin';
import { openSimulationDetails } from './fixtures';
import { authorSolanaSwap, chooseSolanaWallet, jupiterControl } from './jupiter-fixtures';

const PRIVY = process.env.FLOFI_PRIVY_EMULATOR_ORIGIN ?? '';
const harness = process.env.FLOFI_ACCOUNT_HARNESS_ORIGIN ?? '';
const WALLET = process.env.FLOFI_E2E_WALLET_ORIGIN ?? '';
const CLIENT_SCRIPT = fileURLToPath(new URL('./privy-emulator-client.js', import.meta.url));
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const EMAIL_CODE = '135790';
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
test.describe.configure({ mode: 'serial' });

const FINAL_CALL = Date.parse('2026-11-13T12:00:00-03:00'), GATE_CLOSED = Date.parse('2026-11-17T02:00:00-03:00');
const BOARDING = Date.parse('2026-11-17T10:00:00-03:00'), GROUP_TWO_OPEN = Date.parse('2026-11-19T09:30:00-03:00');
const run = `${randomBytes(3).toString('hex')}`;
const ANA = `ana-${run}@flofi-e2e.test`, BEA = `bea-${run}@flofi-e2e.test`, CID = `cid-${run}@flofi-e2e.test`, DAN = `dan-${run}@flofi-e2e.test`;
const LATE = `late-${run}@flofi-e2e.test`;
const ETH_SOL = 'Swap my ETH, bring it to Solana and add liquidity on Orca';

async function query<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  try { return (await db.query(sql, values)).rows as T[]; } finally { await db.close(); }
}
const events = async (event: string, detail = '') => Number((await query<{ n: string }>(
  'SELECT coalesce(sum(events), 0) AS n FROM flight_daily_events WHERE event = $1 AND detail = $2', [event, detail]))[0]!.n);
/** The operator CLI, as the team runs it (DATABASE_URL is the authorization). */
async function operator(...args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await promisify(execFile)(process.execPath, ['backend/flight-admin.ts', ...args, '--tenant', 'default'],
    { cwd: APP_DIR, timeout: 60_000, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', DATABASE_URL: process.env.FLOFI_E2E_DATABASE_URL! } });
  return JSON.parse(stdout) as Record<string, unknown>;
}
async function at(context: BrowserContext, clock: number) {
  await context.addCookies([{ name: 'flofi_flight_clock', value: String(clock), url: E2E_APP_ORIGIN }]);
}
/** The MOCKED Privy stand-in for this context and the identity a sign-in will use. */
async function privy(page: Page, identity: { email?: string }) {
  const context = page.context();
  await context.route(`${E2E_APP_ORIGIN}/__privy-e2e/**`, async route => {
    const path = new URL(route.request().url()).pathname.slice('/__privy-e2e/'.length);
    const response = await fetch(`${PRIVY}/client/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() ?? '{}' });
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  await context.addInitScript({ path: CLIENT_SCRIPT });
  await context.addInitScript(identity => { (window as unknown as { __FLOFI_PRIVY_E2E_IDENTITY__: unknown }).__FLOFI_PRIVY_E2E_IDENTITY__ = identity; }, identity);
}
async function emailSignIn(page: Page, email: string) {
  await page.getByRole('button', { name: 'Email', exact: true }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByLabel(/Enter the 6-digit code/).fill(EMAIL_CODE);
  await page.getByRole('button', { name: 'Verify and continue' }).click();
}
/** A new account's wallet onboarding: create its Solana wallet, then continue (back to /board after "Board now"). */
async function createSolanaWalletAndContinue(page: Page) {
  await expect(page).toHaveURL(/\/onboarding\/wallets$/);
  const card = page.locator('section[data-ecosystem="solana"]'), create = card.getByRole('button', { name: /Create wallet/ });
  await expect.poll(async () => await card.getByRole('group', { name: /Wallet created/ }).count() > 0 || await create.isEnabled()).toBe(true);
  if (await card.getByRole('group', { name: /Wallet created/ }).count() === 0) await create.click();
  await expect(card.locator('[data-wallet-address]').first()).toBeVisible();
  const address = (await card.locator('[data-wallet-address]').first().getAttribute('data-wallet-address'))!;
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  // Onboarding navigates on its own (to /app, or back to /board after "Board now"); wait for it before the next navigation.
  await expect(page).not.toHaveURL(/\/onboarding\//);
  await page.waitForLoadState('load');
  return address;
}
async function signInFromBoard(page: Page, email: string) {
  await page.goto('/login?returnTo=%2Fboard');
  await emailSignIn(page, email);
  // Signed in only once FloFi has left sign-in (to /board, or wallet onboarding for a new account).
  await expect(page).not.toHaveURL(/\/login/);
  await page.waitForLoadState('load');
}
const hero = (page: Page) => page.locator('#top');
async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
const flaps = (scope: Page | Locator, text: string) => scope.getByRole('img', { name: text, exact: true });
/** Evidence: a full-page screenshot of each state, kept with the run's results (CircleCI stores them as artifacts). */
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });

test('a visitor reaches /board in Final call, on mobile and desktop; the beta list stores an address once and the counter is real', async ({ page, context }) => {
  await at(context, FINAL_CALL);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const response = await page.goto('/board');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Final call for the beta list.');
    await expect(page.getByRole('timer')).toHaveAttribute('aria-label', 'List closes in 3 D 11 H 59 M');
    await expect(hero(page)).toContainText('0 ON THE LIST');
    await noOverflow(page);
    await shot(page, `state-1-final-call-${width}`);
  }
  for (const email of [BEA, ANA]) {
    await page.goto('/board');
    await page.getByLabel('Your email').fill(email);
    await page.getByRole('button', { name: 'Join the list' }).click();
    await expect(page.getByRole('status')).toHaveText('You’re on the list. First boarding goes to the beta list.');
  }
  expect(await query('SELECT flight, language, notice FROM flight_list_entries WHERE email = $1', [ANA])).toEqual([{ flight: 'FIRST', language: 'EN', notice: '2026-11-05' }]);
  // The same address again (another visitor, upper case): answered exactly the same way, stored once, counted once.
  const again = await context.newPage();
  await again.goto('/board');
  await again.getByLabel('Your email').fill(ANA.toUpperCase());
  await again.getByRole('button', { name: 'Join the list' }).click();
  await expect(again.getByRole('status')).toHaveText('You’re on the list. First boarding goes to the beta list.');
  expect(await query('SELECT count(*)::int AS n FROM flight_list_entries WHERE email = $1', [ANA])).toEqual([{ n: 1 }]);
  await again.reload();
  await expect(hero(again)).toContainText('2 ON THE LIST');
  expect(await events('list_join', 'first')).toBe(2);
  // A malformed address is refused in place.
  await again.getByLabel('Your email').fill('not-an-email');
  await again.getByRole('button', { name: 'Join the list' }).click();
  await expect(again.locator('p[role="alert"]')).toHaveText('Enter a valid email address.');
  // The privacy notice beside the form says joining is agreeing, and leads to the campaign's section of the policy.
  await expect(hero(again)).toContainText('We only use your email for the FloFi beta. By joining, you agree to this use under our Privacy Policy.');
  await expect(again.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy#flight-flofi');
  // A new and a repeated address get byte-identical answers (no counter, nothing about the address).
  const answer = (email: string) => again.evaluate(async address => (await fetch('/api/board/list', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: address, language: 'EN', consent: true }) })).text(), email);
  expect(await answer(`new-${run}@flofi-test.dev`)).toBe(await answer(ANA));
  expect(await answer(ANA)).toBe('{"ok":true,"flight":"FIRST"}');
  await query('DELETE FROM flight_list_entries WHERE email = $1', [`new-${run}@flofi-test.dev`]); // Keeps the next tests' counts.
});

test('Gate closed: the approved post’s words, and a new address joins the next flight, not the beta list', async ({ page, context }) => {
  await at(context, GATE_CLOSED);
  await page.goto('/board');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Gate closed. Boarding starts tomorrow.');
  await expect(hero(page)).toContainText('9:00 BRT. See you on board.');
  await shot(page, 'gate-closed-1440');
  await page.getByLabel('Your email').fill(LATE);
  await page.getByRole('button', { name: 'Join the next flight' }).click();
  await expect(page.getByRole('status')).toHaveText('You’re on the list for the next flight.');
  expect(await query('SELECT flight FROM flight_list_entries WHERE email = $1', [LATE])).toEqual([{ flight: 'NEXT' }]);
  await page.reload();
  await expect(hero(page)).toContainText('2 ON THE LIST');
});

test('Now boarding: an example route fills the request; "Board now" signs a listed person in and opens /app with it as a draft', async ({ page, context }) => {
  await at(context, BOARDING);
  await privy(page, { email: ANA });
  await page.goto('/board');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Say where you’re going.');
  await expect(hero(page)).toContainText('0 BOARDED');
  await expect(hero(page)).toContainText('100 FOUNDING SEATS LEFT');
  await shot(page, 'state-2-now-boarding-1440');
  await page.locator('#routes').getByRole('button', { name: 'Use this route' }).nth(1).click();
  await expect(page.getByLabel(/Where you’re going/)).toHaveValue(ETH_SOL);
  await page.getByRole('button', { name: 'Board now' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fboard%3Fboard%3D1$/);
  await emailSignIn(page, ANA);
  // A new account adds its wallet first, then comes back to /board, which checks the list and opens /app.
  await createSolanaWalletAndContinue(page);
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.locator('#build-entry-request')).toHaveValue(ETH_SOL);
  expect(await events('board_click')).toBe(1);
  expect(await events('route_example_click', 'eth_sol')).toBe(1);
  expect(await events('prompt_submit')).toBe(1);
  expect(await events('access_result', 'list')).toBe(1);
});

test('a group still closed (state 3) opens at its own time; not on the list (state 4) joins the next flight; the operator CLI runs the groups', async ({ page, context }) => {
  // The team's operator CLI: group 2 opens on 19 Nov; the earliest unassigned entry (Bea) goes into it.
  expect(await operator('create-batch', '--batch', '2', '--opens-at', '2026-11-19T09:00:00-03:00')).toMatchObject({ batch: 2, opensAt: '2026-11-19T12:00:00.000Z' });
  expect(await operator('assign-batch', '--batch', '2', '--count', '1')).toMatchObject({ assigned: 1 });
  expect(await query('SELECT batch_no FROM flight_list_entries WHERE email = $1', [BEA])).toEqual([{ batch_no: 2 }]);
  await at(context, BOARDING);
  await privy(page, { email: BEA });
  await signInFromBoard(page, BEA);
  await createSolanaWalletAndContinue(page);
  await page.goto('/board');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('You’re on the list. Your group boards soon.');
  await expect(flaps(page, 'GROUP 2')).toBeVisible();
  await expect(hero(page)).toContainText('Your boarding opens Nov 19 at 9:00. We’ll email you the moment it does.');
  await expect(page.getByRole('link', { name: 'Add to calendar' })).toHaveAttribute('href', /^data:text\/calendar/);
  await shot(page, 'state-3-group-closed-1440');
  // Its group opens: the same person now sees Now boarding.
  await at(context, GROUP_TWO_OPEN);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Say where you’re going.');
  // Not on the list: the approved door, the next flight and sharing.
  const cid = await context.browser()!.newContext({ baseURL: E2E_APP_ORIGIN, storageState: returningVisitor(E2E_APP_ORIGIN) });
  const cidPage = await cid.newPage();
  try {
    await at(cid, BOARDING);
    await privy(cidPage, { email: CID });
    await signInFromBoard(cidPage, CID);
    await createSolanaWalletAndContinue(cidPage);
    await cidPage.goto('/board');
    await expect(cidPage.getByRole('heading', { level: 1 })).toHaveText('Not on the list. Yet.');
    await expect(flaps(cidPage, 'NOT LISTED')).toBeVisible();
    await shot(cidPage, 'state-4-not-on-the-list-1440');
    await cidPage.evaluate(() => { (window as unknown as { __opened: string[] }).__opened = []; window.open = (url?: string | URL) => { (window as unknown as { __opened: string[] }).__opened.push(String(url)); return null; }; });
    await cidPage.getByRole('button', { name: 'Share on X' }).click();
    expect((await cidPage.evaluate(() => (window as unknown as { __opened: string[] }).__opened))[0]).toMatch(/^https:\/\/x\.com\/intent\/post\?.*url=https%3A%2F%2Fflofi\.xyz%2Fboard/);
    await cidPage.getByRole('button', { name: 'Join the next flight' }).click();
    await expect(cidPage.getByRole('status')).toHaveText('You’re on the list for the next flight.');
    expect(await query('SELECT flight FROM flight_list_entries WHERE email = $1', [CID])).toEqual([{ flight: 'NEXT' }]);
    expect(await events('share_click', 'not_listed')).toBe(1);
  } finally { await cid.close(); }
});

test('an invite the team issues lets a person off the list board, and works once', async ({ page, context, browser }) => {
  const { codes } = await operator('issue-invites', '--count', '1') as { codes: string[] };
  expect(codes[0]).toMatch(/^FLF-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  await at(context, BOARDING);
  await privy(page, { email: CID });
  await signInFromBoard(page, CID);
  await page.goto('/board');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not on the list. Yet.');
  await page.getByRole('button', { name: 'Use it here' }).click();
  await page.getByLabel('Invite code').fill(codes[0]!.toLowerCase());
  await page.getByRole('button', { name: 'Use invite' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Invite accepted' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Say where you’re going.');
  expect(await events('invite_redeem')).toBe(1);
  const dan = await browser.newContext({ baseURL: E2E_APP_ORIGIN, storageState: returningVisitor(E2E_APP_ORIGIN) }), danPage = await dan.newPage();
  try {
    await at(dan, BOARDING);
    await privy(danPage, { email: DAN });
    await signInFromBoard(danPage, DAN);
    await createSolanaWalletAndContinue(danPage);
    await danPage.goto('/board');
    await danPage.getByRole('button', { name: 'Use it here' }).click();
    await danPage.getByLabel('Invite code').fill(codes[0]!);
    await danPage.getByRole('button', { name: 'Use invite' }).click();
    await expect(danPage.locator('p[role="alert"]')).toHaveText('That invite code was already used.');
  } finally { await dan.close(); }
});

async function simulateSolanaSwap(page: Page, owner: string) {
  await rm(process.env.GRYLOO_JUPITER_JOURNAL ?? '/nonexistent', { recursive: true, force: true });
  await authorSolanaSwap(page);
  await page.getByRole('button', { name: 'Simulate workflow' }).click();
  await openSimulationDetails(page);
  const panel = page.getByRole('region', { name: 'Jupiter swap', exact: true });
  await chooseSolanaWallet(panel, 'FloFi Wallet');
  await jupiterControl({ action: 'reset', owner });
  await panel.getByRole('button', { name: 'Simulate swap' }).click();
}

test('a real simulation issues the boarding pass: Founding seat #001, the real route, three invites; the holder chooses the departures board', async ({ page, context }) => {
  await at(context, BOARDING);
  await privy(page, { email: ANA });
  await signInFromBoard(page, ANA);
  await expect(page).toHaveURL(/\/board$/);
  const owner = (await query<{ address: string }>(`SELECT w.address FROM flofi_account_wallets w JOIN flofi_account_identities i ON i.account_id = w.account_id
    AND i.tenant_id = w.tenant_id WHERE i.subject = $1 AND w.ecosystem = 'SOLANA'`, [ANA]))[0]!.address;
  // No pass without the server's own record of a simulation: a request naming any workflow (or carrying a route) is refused.
  const forged = await page.evaluate(async () => (await fetch('/api/board/pass', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId: 'forged' }) })).json());
  expect(forged).toEqual({ ok: false, code: 'FLIGHT_SIMULATION_NOT_FOUND' });
  expect(await page.evaluate(async () => (await fetch('/api/board/pass', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId: 'x'.repeat(201) }) })).status)).toBe(400);
  await page.getByRole('button', { name: 'Board now' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await simulateSolanaSwap(page, owner);
  // The fresh Review asks the server for the pass; the server checks its own record of this simulation.
  await expect(page.getByRole('status').filter({ hasText: 'Your Flight FloFi boarding pass is ready.' })).toBeVisible();
  expect(await query(`SELECT origin, founding_seat, boarding_no, route->>'from' AS "from", route->>'to' AS "to", route->'steps' AS steps FROM flight_passes p
    JOIN flofi_account_identities i ON i.account_id = p.account_id AND i.tenant_id = p.tenant_id WHERE i.subject = $1`, [ANA]))
    .toEqual([{ origin: 'LIST', founding_seat: 1, boarding_no: 1, from: 'SOL', to: 'SOL', steps: [{ action: 'Swap', detail: 'Jupiter · Solana' }] }]);
  expect(await query(`SELECT count(*)::int AS n FROM flight_simulations`)).not.toEqual([{ n: 0 }]);
  expect(await events('simulation_ok', 'founding')).toBe(1);
  await page.getByRole('link', { name: 'See your boarding pass' }).click();
  await expect(page).toHaveURL(/\/board#pass$/);
  const pass = page.getByRole('article', { name: /BOARDING PASS: SOL → SOL, Founding Member #001/ });
  await expect(pass).toBeVisible();
  await expect(pass).toContainText('Swap');
  await expect(pass).toContainText('Jupiter · Solana');
  await expect(pass).toContainText('1 STEP · 1 NETWORK');
  await expect(pass).toContainText('17 NOV 2026');
  await expect(page.locator('#pass-invites-title')).toHaveText('Your 3 invites');
  await expect(page.locator('ul li').filter({ hasText: /^FLF-/ })).toHaveCount(3);
  await expect(hero(page)).toContainText('1 BOARDED');
  await expect(hero(page)).toContainText('99 FOUNDING SEATS LEFT');
  await expect(page.locator('#founding')).toContainText('1 OF 100 FOUNDING SEATS TAKEN');
  // The holder's choice: their handle, shown on the public departures board.
  await expect(page.locator('section[aria-labelledby="departures-title"]')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Your X handle' }).fill('@ana_flight');
  await page.getByRole('checkbox', { name: /public departures board/ }).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  const departures = page.locator('section[aria-labelledby="departures-title"]');
  await expect(departures.getByRole('img', { name: '@ana_flight' })).toBeVisible();
  await expect(departures.getByRole('img', { name: '#001' })).toBeVisible();
  await shot(page, 'founding-pass-and-departures-1440');
  await page.setViewportSize({ width: 390, height: 900 });
  await noOverflow(page);
  // Phones get the departures stacked, every field inside the board's own width (no sideways scrolling).
  const stacked = departures.getByRole('list', { name: 'Latest boarding passes' });
  await expect(stacked.getByRole('img', { name: '@ana_flight' })).toBeVisible();
  await expect(stacked.getByRole('img', { name: 'Seat: #001' })).toBeVisible();
  expect(await departures.locator('[class*="departuresBoard"]').evaluate(board => board.scrollWidth <= board.clientWidth)).toBe(true);
  await expect(departures.getByRole('table')).toBeHidden();
  await shot(page, 'founding-pass-390');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(pass).toContainText('@ana_flight');
});

test('Founding full (state 5): after the 100th seat the banner shows and the next pass is a passenger’s middle seat', async ({ page, context }) => {
  // Test data in the disposable database only: 99 more Founding passes fill seats #002–#100, and the issuance counter with them.
  await query(`WITH a AS (INSERT INTO flofi_accounts (tenant_id, account_id) SELECT 'default', 'acct_' || md5('flight-${run}-' || s) FROM generate_series(2, 100) s RETURNING account_id)
    INSERT INTO flight_passes (tenant_id, pass_id, account_id, origin, boarding_no, founding_seat, route, run_id)
    SELECT 'default', 'flp_' || md5(account_id), account_id, 'LIST', row_number() OVER () + 1, row_number() OVER () + 1,
      '{"from":"ETH","to":"BASE","steps":[{"action":"Bridge","detail":"Ethereum → Base"}],"stepCount":1,"networkCount":2}', 'seeded' FROM a`);
  await query(`UPDATE flight_issuance SET boarded = 100, founding = 100 WHERE tenant_id = 'default'`);
  await at(context, GROUP_TWO_OPEN);
  await page.goto('/board');
  await expect(page.getByRole('note').filter({ hasText: 'FOUNDING FULL' })).toContainText('100 / 100');
  await expect(hero(page)).toContainText('All 100 Founding seats are taken. You still board, as a passenger. You approve.');
  await expect(hero(page)).toContainText('100 BOARDED');
  await expect(hero(page)).not.toContainText('FOUNDING SEATS LEFT');
  await shot(page, 'state-5-founding-full-1440');
  // Bea's group is open now: her simulation issues a passenger pass (boarding number 101, the middle seat).
  await privy(page, { email: BEA });
  await signInFromBoard(page, BEA);
  const owner = (await query<{ address: string }>(`SELECT w.address FROM flofi_account_wallets w JOIN flofi_account_identities i ON i.account_id = w.account_id
    AND i.tenant_id = w.tenant_id WHERE i.subject = $1 AND w.ecosystem = 'SOLANA'`, [BEA]))[0]!.address;
  await page.getByRole('button', { name: 'Board now' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await simulateSolanaSwap(page, owner);
  await expect(page.getByRole('status').filter({ hasText: 'Your Flight FloFi boarding pass is ready.' })).toBeVisible();
  await page.goto('/board#pass');
  await expect(page.getByRole('heading', { name: 'You’re on board. Middle seat.' })).toBeVisible();
  await expect(flaps(page, '101E')).toBeVisible();
  await shot(page, 'passenger-pass-1440');
  expect(await query(`SELECT count(founding_seat)::int AS founding, max(boarding_no) AS last FROM flight_passes`)).toEqual([{ founding: 100, last: 101 }]);
  expect(await events('simulation_ok', 'passenger')).toBe(1);
});

test('every CTA and link resolves; the campaign posts link to a real page with the approved image; PT is one choice away', async ({ page, context, request }) => {
  await at(context, BOARDING);
  await page.goto('/board');
  for (const [name, target] of [['How it works', '#how'], ['Founding', '#founding'], ['Routes', '#routes']] as const)
    await expect(page.getByRole('navigation', { name: 'Flight FloFi navigation' }).getByRole('link', { name })).toHaveAttribute('href', target);
  const footer = page.getByRole('navigation', { name: 'Footer navigation' });
  for (const [name, href] of [['Privacy', '/privacy'], ['Risks', '/docs/security'], ['Discord', 'https://discord.gg/36rEhdUa'], ['X', 'https://x.com/FloFi_xyz']] as const)
    await expect(footer.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
  for (const path of ['/privacy', '/docs/security', '/', '/login']) expect((await request.get(path)).status(), path).toBe(200);
  await expect(page.locator('footer')).toContainText('DeFi involves risk. A simulation does not guarantee price or outcome.');
  // Every approved post links flofi.xyz/board: the page answers, with the fixed 1200 × 630 Open Graph image.
  const board = await request.get('/board');
  expect(board.status()).toBe(200);
  const html = await board.text();
  expect(html).toMatch(/<meta property="og:image" content="https:\/\/flofi\.xyz\/board\/opengraph-image\.png[^"]*"/);
  expect(html).toContain('<meta property="og:image:width" content="1200"');
  const image = await request.get(html.match(/og:image" content="https:\/\/flofi\.xyz(\/board\/opengraph-image\.png[^"]*)"/)![1]!);
  expect([image.status(), image.headers()['content-type']]).toEqual([200, 'image/png']);
  // The landing keeps "Open"; "Board now" lives only on /board.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Board now' })).toHaveCount(0);
  // PT is one choice away, and it is the product's shared preference.
  await page.goto('/board');
  await page.getByRole('navigation', { name: 'Flight FloFi navigation' }).getByRole('button', { name: 'PT' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Diga para onde você vai.');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await page.getByRole('navigation', { name: 'Navegação do Flight FloFi' }).getByRole('button', { name: 'EN' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Say where you’re going.');
  // Sign-in and /app keep working for anyone, whatever their campaign state.
  await page.goto('/app');
  await expect(page.getByRole('navigation', { name: 'Workflow stages' })).toBeVisible();
});
