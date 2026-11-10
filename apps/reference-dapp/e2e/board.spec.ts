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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import { codeFor, codeHash, linkTokenFor, sha256Hex, tokenIdFor, unsubscribeTokenFor } from '../src/flight/access';
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

const FINAL_CALL = Date.parse('2026-11-09T12:00:00-03:00'), GATE_CLOSED = Date.parse('2026-11-12T02:00:00-03:00');
const BOARDING = Date.parse('2026-11-12T10:00:00-03:00'), GROUP_TWO_OPEN = Date.parse('2026-11-19T09:30:00-03:00');
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
async function privy(page: Page, identity: { email?: string; wallet?: { address: string; chain?: 'ethereum' | 'solana' } }) {
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
/**
 * Nothing sideways at this width: the document does not scroll, and (since the page clips its own overflow) every visible heading,
 * text, control and split-flap row of the page lies inside the viewport. Decorative art (aria-hidden) may bleed off the edge.
 */
async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('main h1, main h2, main p, main a, main button, main input, main label, main li, main [role="img"], main [role="timer"]')]
    .filter(element => !element.closest('[aria-hidden="true"]') && element.getClientRects().length > 0)
    .filter(element => { const box = element.getBoundingClientRect(); return box.width > 1 && (box.left < -1 || box.right > innerWidth + 1); })
    .map(element => `${element.tagName.toLowerCase()} “${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 40)}”`))).toEqual([]);
}
/** The same page at phone widths (the narrowest supported and a common one). */
async function fitsPhones(page: Page) {
  const size = page.viewportSize();
  for (const width of [320, 360]) { await page.setViewportSize({ width, height: 800 }); await noOverflow(page); }
  if (size) await page.setViewportSize(size);
}
const flaps = (scope: Page | Locator, text: string) => scope.getByRole('img', { name: text, exact: true });
/** Evidence: a full-page screenshot of each state, kept with the run's results (CircleCI stores them as artifacts). */
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });

/** Language selection is a presentation preference; it never grants campaign or wallet authority. */
async function chooseLanguage(page: Page, value: 'EN' | 'PT', place: 'header' | 'footer' = 'header') {
  const scope = page.locator(place);
  const trigger = scope.getByRole('button', { name: /^(Language|Idioma)$/ });
  await trigger.click();
  await scope.getByRole('menuitem', { name: /^(Language|Idioma)/ }).click();
  await scope.getByRole('menuitemradio', { name: value === 'EN' ? 'English' : 'Português' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', value === 'EN' ? 'en' : 'pt-BR');
}

/** No public aggregate count of people anywhere (BUILD-FLOFI-FLIGHT-LAUNCH-001): page text, server HTML and the anonymous state API. */
const COUNT = /\d[\d.,]*\s*(ON THE LIST|BOARDED|NA LISTA|EMBARCARAM|EMBARCOU)|FOUNDING SEATS LEFT|ASSENTOS FOUNDING RESTANTES|\b(OF|DE) 100\b|\b100 \/ 100\b/i;
async function noCounters(page: Page) {
  // Visible text, every accessible name (split-flap rows carry their whole text as one: a count drawn in flaps is caught there), and the
  // server-rendered HTML.
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(COUNT);
  const labels = await page.locator('[aria-label]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? ''));
  for (const label of labels) expect(label).not.toMatch(COUNT);
  const html = await (await page.request.get(page.url())).text();
  expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(COUNT);
  const state = await page.evaluate(async () => await (await fetch('/api/board/state')).json() as Record<string, unknown>);
  expect(Object.keys(state)).not.toContain('counters');
  expect(JSON.stringify(state)).not.toMatch(/onList|foundingLeft|foundingTaken|"boarded":\d/);
}

test('a visitor reaches /board in Final call, on mobile and desktop; the beta list stores an address once and no count is shown', async ({ page, context }) => {
  await at(context, FINAL_CALL);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const response = await page.goto('/board');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Final call for the beta list.');
    await expect(page.getByRole('timer')).toHaveAttribute('aria-label', 'List closes in 2 days, 11 hours, 59 minutes');
    // The boarding day is the campaign calendar's (12 Nov 2026, 9:00 BRT), in the hero and the page description.
    await expect(hero(page)).toContainText('Flight FloFi · Closed beta · Boards Nov 12');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /^FloFi boards Nov 12\. /);
    await noCounters(page);
    // Nobody boards before boarding opens: the marquee says FINAL CALL, and the invite link is there for invited creators.
    await expect(page.locator('section#top')).toContainText('FINAL CALL · DEFI THE WAY YOU TALK');
    await expect(hero(page).getByRole('button', { name: 'I have an invite code' })).toBeVisible();
    await noOverflow(page);
    await shot(page, `state-1-final-call-${width}`);
  }
  for (const email of [BEA, ANA]) {
    await page.goto('/board');
    await page.getByLabel('Your email').fill(email);
    await page.getByRole('button', { name: 'Join the list' }).click();
    await expect(page.getByRole('status')).toHaveText('You’re on the list. First boarding goes to the beta list.');
  }
  expect(await query('SELECT flight, language, notice FROM flight_list_entries WHERE email = $1', [ANA])).toEqual([{ flight: 'FIRST', language: 'EN', notice: '2026-11-09' }]);
  // The same address again (another visitor, upper case): answered exactly the same way, stored once, counted once.
  const again = await context.newPage();
  await again.goto('/board');
  await again.getByLabel('Your email').fill(ANA.toUpperCase());
  await again.getByRole('button', { name: 'Join the list' }).click();
  await expect(again.getByRole('status')).toHaveText('You’re on the list. First boarding goes to the beta list.');
  expect(await query('SELECT count(*)::int AS n FROM flight_list_entries WHERE email = $1', [ANA])).toEqual([{ n: 1 }]);
  await again.reload();
  await noCounters(again);
  expect(await events('list_join', 'first')).toBe(2);
  // Each new beta-list address has its Email 1 waiting in the outbox once (the worker sends it; none runs in this test).
  expect(await query(`SELECT template, count(*)::int AS n FROM flight_emails WHERE recipient = $1 GROUP BY template`, [ANA])).toEqual([{ template: 'LIST_CONFIRMATION', n: 1 }]);
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
  await fitsPhones(page);
  await page.getByLabel('Your email').fill(LATE);
  await page.getByRole('button', { name: 'Join the next flight' }).click();
  await expect(page.getByRole('status')).toHaveText('You’re on the list for the next flight.');
  expect(await query('SELECT flight FROM flight_list_entries WHERE email = $1', [LATE])).toEqual([{ flight: 'NEXT' }]);
  await page.reload();
  await noCounters(page);
  expect(await query(`SELECT template FROM flight_emails WHERE recipient = $1`, [LATE])).toEqual([{ template: 'NEXT_FLIGHT' }]);
});

test('Now boarding: an example route fills the request; "Board now" signs a listed person in and opens /app with it as a draft', async ({ page, context }) => {
  await at(context, BOARDING);
  await privy(page, { email: ANA });
  await page.goto('/board');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Say where you’re going.');
  await expect(hero(page)).toContainText('CLOSED BETA · OPENING IN GROUPS');
  await noCounters(page);
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
  await fitsPhones(page);
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
    await fitsPhones(cidPage);
    await cidPage.evaluate(() => { (window as unknown as { __opened: string[] }).__opened = []; window.open = (url?: string | URL) => { (window as unknown as { __opened: string[] }).__opened.push(String(url)); return null; }; });
    await cidPage.getByRole('button', { name: 'Share on X' }).click();
    expect((await cidPage.evaluate(() => (window as unknown as { __opened: string[] }).__opened))[0]).toMatch(/^https:\/\/x\.com\/intent\/post\?.*url=https%3A%2F%2Fflofi\.xyz%2Fboard/);
    await cidPage.getByRole('button', { name: 'Join the next flight' }).click();
    await expect(cidPage.getByRole('status').filter({ hasText: 'next flight' })).toHaveText('You’re on the list for the next flight.');
    expect(await query('SELECT flight FROM flight_list_entries WHERE email = $1', [CID])).toEqual([{ flight: 'NEXT' }]);
    expect(await events('share_click', 'not_listed')).toBe(1);
  } finally { await cid.close(); }
});

test('an invite the team issues lets a person off the list board, and works once', async ({ page, context, browser }) => {
  const directory = await mkdtemp(join(tmpdir(), 'flofi-flight-fixture-invites-')), out = join(directory, 'invites.csv');
  let code: string;
  try {
    expect(await operator('issue-invites', '--count', '1', '--out', out)).toMatchObject({ issued: 1, out });
    code = (await readFile(out, 'utf8')).match(/FLF-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/)?.[0] ?? '';
    expect(code).toMatch(/^FLF-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
  await at(context, BOARDING);
  await privy(page, { email: CID });
  await signInFromBoard(page, CID);
  await page.goto('/board');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not on the list. Yet.');
  await page.getByRole('button', { name: 'Use it here' }).click();
  await page.getByLabel('Invite code').fill(code.toLowerCase());
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
    await danPage.getByLabel('Invite code').fill(code);
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
  // Screen 1 of the card flow: the optional X handle, printed on the card.
  await expect(page.getByRole('heading', { name: 'Who’s flying?' })).toBeVisible();
  await fitsPhones(page);
  await page.getByRole('textbox', { name: 'Your X handle' }).fill('@ana_flight');
  await page.getByRole('button', { name: 'Print my card' }).click();
  const pass = page.getByRole('article', { name: /BOARDING PASS: SOL → SOL, Founding Member #001/ });
  await expect(pass).toBeVisible();
  await expect(pass).toContainText('Swap');
  await expect(pass).toContainText('Jupiter · Solana');
  await expect(pass).toContainText('1 STEP · 1 NETWORK');
  await expect(pass).toContainText('12 NOV 2026');
  await expect(page.locator('#pass-invites-title')).toHaveText('Your 3 invites');
  await expect(page.locator('ul li').filter({ hasText: /^FLF-/ })).toHaveCount(3);
  await noCounters(page);
  // Screen 2: Share on X (the approved text and the card's own link), Download card (the server-rendered PNG), Copy link.
  const publicId = (await query<{ public_id: string }>(`SELECT p.public_id FROM flight_passes p JOIN flofi_account_identities i ON i.account_id = p.account_id
    AND i.tenant_id = p.tenant_id WHERE i.subject = $1`, [ANA]))[0]!.public_id;
  expect(publicId).toMatch(/^[a-z2-7]{12}$/);
  await page.evaluate(() => { (window as unknown as { __opened: string[] }).__opened = []; window.open = (url?: string | URL) => { (window as unknown as { __opened: string[] }).__opened.push(String(url)); return null; }; });
  await page.getByRole('button', { name: 'Share on X' }).click();
  const shared = new URL((await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened))[0]!);
  expect(shared.origin + shared.pathname).toBe('https://x.com/intent/post');
  expect(shared.searchParams.get('text')).toBe('I just boarded Flight FloFi ✈️ Founding Member #001. SOL → SOL in 1 step, and I approve every step. @FloFi_xyz');
  expect(shared.searchParams.get('url')).toBe(`https://flofi.xyz/card/${publicId}`);
  await expect(page.getByRole('link', { name: 'Download card' })).toHaveAttribute('href', `/card/${publicId}/image?download=1`);
  // Email 4a is waiting in the outbox for the address the person proved.
  expect(await query(`SELECT template FROM flight_emails WHERE recipient = $1 AND template LIKE 'CARD_%'`, [ANA])).toEqual([{ template: 'CARD_FOUNDING' }]);
  // Screen 4: the public card page, without signing in — the card, "Board too", the unverified-handle note, its own preview image.
  const visitor = await context.browser()!.newContext({ baseURL: E2E_APP_ORIGIN, storageState: returningVisitor(E2E_APP_ORIGIN) });
  try {
    const card = await visitor.newPage(), response = await card.goto(`/card/${publicId}`);
    expect(response?.status()).toBe(200);
    await expect(card.getByRole('heading', { level: 1 })).toHaveText('@ana_flight boarded Flight FloFi.');
    await expect(card.getByRole('link', { name: 'Board too' })).toHaveAttribute('href', `/board?source=card&ref=${publicId}`);
    await expect(card.locator('main')).toContainText('Handle typed by the passenger, not verified.');
    await expect(card.locator('main')).not.toContainText(ANA);
    await expect(card.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
    await expect(card.locator('meta[property="og:image"]')).toHaveAttribute('content', `https://flofi.xyz/card/${publicId}/image`);
    await expect(card.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await shot(card, 'card-public-page-1440');
    await card.setViewportSize({ width: 390, height: 900 });
    await noOverflow(card);
    const image = await card.request.get(`/card/${publicId}/image`), download = await card.request.get(`/card/${publicId}/image?download=1`);
    expect([image.status(), image.headers()['content-type']]).toEqual([200, 'image/png']);
    expect([...(await image.body()).subarray(16, 24)]).toEqual([0, 0, 4, 176, 0, 0, 2, 118]); // PNG IHDR: 1200 × 630.
    expect([...(await download.body()).subarray(16, 24)]).toEqual([0, 0, 6, 64, 0, 0, 3, 132]); // 1600 × 900.
    expect(download.headers()['content-disposition']).toBe('attachment; filename="flofi-boarding-card-001.png"');
    expect((await card.request.get('/card/aaaaaaaaaaaa')).status()).toBe(404);
  } finally { await visitor.close(); }
  // The holder's choice: their handle, shown on the public departures board.
  await expect(page.locator('section[aria-labelledby="departures-title"]')).toHaveCount(0);
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
  await expect(page.getByRole('note').filter({ hasText: 'FOUNDING FULL' })).toContainText('PASSENGER SEATS OPEN');
  await expect(hero(page)).toContainText('All 100 Founding seats are taken. You still board, as a passenger. You approve.');
  await noCounters(page);
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
  await page.getByRole('button', { name: 'Skip, print without a handle' }).click();
  await expect(page.getByRole('heading', { name: 'You’re on board. Middle seat.' })).toBeVisible();
  // Invited or late, a passenger gets no invites and no Founding promise.
  await expect(page.locator('#invites')).toHaveCount(0);
  await expect(flaps(page, '101E')).toBeVisible();
  await shot(page, 'passenger-pass-1440');
  await fitsPhones(page);
  expect(await query(`SELECT count(founding_seat)::int AS founding, max(boarding_no) AS last FROM flight_passes`)).toEqual([{ founding: 100, last: 101 }]);
  expect(await events('simulation_ok', 'passenger')).toBe(1);
});

/** An access email's link and code, as the worker would derive and record them (the test inserts the digests the worker would). */
async function accessEmail(email: string) {
  const secret = process.env.FLOFI_FLIGHT_E2E_ACCESS_SECRET!, emailId = `fem_${randomBytes(16).toString('hex')}`, tokenId = tokenIdFor(secret, emailId);
  const link = linkTokenFor(secret, emailId), code = codeFor(secret, emailId);
  // Times on the campaign clock this test runs at (the harness cookie), as the worker would record them at send time.
  await query(`INSERT INTO flight_access_tokens (tenant_id, token_id, entry_id, purpose, link_hash, code_hash, created_at, link_expires_at, code_expires_at)
    SELECT 'default', $1, entry_id, 'BOARDING', $2, $3, $5::timestamptz, $5::timestamptz + interval '72 hours', $5::timestamptz + interval '15 minutes'
    FROM flight_list_entries WHERE email = $4`, [tokenId, sha256Hex(link), codeHash(secret, tokenId, code), email, new Date(BOARDING).toISOString()]);
  return { link, code, tokenId };
}

test('Email 3 access: opening the link consumes nothing, Continue proves the address once; a code works on another device; unsubscribe is one click', async ({ browser }) => {
  const FREE = `free-${run}@flofi-e2e.test`, LISTED = `listed-${run}@flofi-e2e.test`, OTHER = `other-${run}@flofi-e2e.test`, CODED = `coded-${run}@flofi-e2e.test`;
  for (const email of [LISTED, CODED]) await query(`INSERT INTO flight_list_entries (tenant_id, entry_id, email, flight, language, notice) VALUES ('default', $1, $2, 'FIRST', 'EN', '2026-11-05')`,
    [`fle_${randomBytes(16).toString('hex')}`, email]);
  const ctx = await browser.newContext({ baseURL: E2E_APP_ORIGIN, storageState: returningVisitor(E2E_APP_ORIGIN) }), page = await ctx.newPage();
  try {
    await at(ctx, BOARDING);
    // Signed in with an address that is not on the list (a different login email): not on the list.
    await privy(page, { email: FREE });
    await signInFromBoard(page, FREE);
    await createSolanaWalletAndContinue(page);
    await page.goto('/board');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not on the list. Yet.');
    // The email's link: the page only offers "Continue"; a scanner or preview that opens it consumes nothing.
    const { link, tokenId } = await accessEmail(LISTED);
    await page.goto(`/board/access#t=${link}`);
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    expect(await query(`SELECT consumed_at FROM flight_access_tokens WHERE token_id = $1`, [tokenId])).toEqual([{ consumed_at: null }]);
    const scanner = await page.request.get(`/board/access#t=${link}`);
    expect(scanner.status()).toBe(200);
    expect(await query(`SELECT consumed_at FROM flight_access_tokens WHERE token_id = $1`, [tokenId])).toEqual([{ consumed_at: null }]);
    // The page names the address the link proves (masked), before the person confirms.
    await expect(page.locator('main')).toContainText(`This link is for l***@flofi-e2e.test.`);
    await page.setViewportSize({ width: 390, height: 900 });
    await noOverflow(page);
    await shot(page, 'access-continue-390');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Continue' }).click();
    // Proven: the entry is now this account's, and "Board now" continues to /app.
    await expect(page).toHaveURL(/\/app$/);
    expect(await query(`SELECT count(*)::int AS n FROM flight_access_claims c JOIN flight_list_entries e ON e.entry_id = c.entry_id WHERE e.email = $1`, [LISTED])).toEqual([{ n: 1 }]);
    // The link works once: a used link cannot be confirmed again (the page says so and offers a new link).
    await page.goto(`/board/access#t=${link}`);
    await expect(page.locator('p[role="alert"]')).toHaveText('That link or code is not valid. Ask for a new one.');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Send me a link and a code' })).toBeVisible();
  } finally { await ctx.close(); }
  // Another device: signed in there with yet another address, the person types the listed address and the six-digit code.
  const other = await browser.newContext({ baseURL: E2E_APP_ORIGIN, storageState: returningVisitor(E2E_APP_ORIGIN) }), device = await other.newPage();
  try {
    await at(other, BOARDING);
    await privy(device, { email: OTHER });
    await signInFromBoard(device, OTHER);
    await createSolanaWalletAndContinue(device);
    await device.goto('/board');
    await expect(device.getByRole('heading', { level: 1 })).toHaveText('Not on the list. Yet.');
    const { code } = await accessEmail(CODED);
    await device.getByLabel('Your beta-list email').fill(CODED);
    await device.getByLabel('6-digit code').fill(code === '000000' ? '111111' : '000000');
    await device.getByRole('button', { name: 'Use code' }).click();
    await expect(device.locator('p[role="alert"]')).toHaveText('That link or code is not valid. Ask for a new one.');
    await device.getByLabel('6-digit code').fill(code);
    await device.getByRole('button', { name: 'Use code' }).click();
    await expect(device.getByRole('heading', { level: 1 })).toHaveText('Say where you’re going.');
    // The "send me a link" form answers the same for any address and never says whether it is listed.
    const ask = (email: string) => device.evaluate(async address => (await fetch('/api/board/access/request', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: address, language: 'EN' }) })).text(), email);
    expect(await ask(`nobody-${run}@flofi-e2e.test`)).toBe(await ask(LISTED));
  } finally { await other.close(); }
  // Unsubscribe: opening the page changes nothing; the click suppresses the recipient of that email.
  const emailId = `fem_${randomBytes(16).toString('hex')}`;
  await query(`INSERT INTO flight_emails (tenant_id, email_id, dedupe_key, template, template_version, category, recipient, language, trigger, not_before, next_attempt_at)
    VALUES ('default', $1, $2, 'NEXT_FLIGHT', 1, 'CAMPAIGN', $3, 'EN', 'browser_test', now() + interval '1 day', now() + interval '1 day')`, [emailId, `e2e:${emailId}`, OTHER]);
  const viewer = await browser.newContext({ baseURL: E2E_APP_ORIGIN, storageState: returningVisitor(E2E_APP_ORIGIN) }), unsub = await viewer.newPage();
  try {
    await unsub.goto(`/board/unsubscribe?t=${unsubscribeTokenFor(process.env.FLOFI_FLIGHT_E2E_ACCESS_SECRET!, emailId, OTHER)}`);
    expect(await query(`SELECT count(*)::int AS n FROM flight_email_suppressions`)).toEqual([{ n: 0 }]);
    await unsub.getByRole('button', { name: 'Unsubscribe' }).click();
    await expect(unsub.getByRole('status')).toHaveText('Done. You won’t get Flight FloFi campaign emails any more.');
    expect(await query(`SELECT state, status_reason FROM flight_emails WHERE email_id = $1`, [emailId])).toEqual([{ state: 'CANCELLED', status_reason: 'UNSUBSCRIBED' }]);
    await unsub.goto(`/board/unsubscribe?t=fem_00000000000000000000000000000000.${'0'.repeat(64)}.AAAAAAAAAAAAAAAAAAAAAA`);
    await unsub.getByRole('button', { name: 'Unsubscribe' }).click();
    await expect(unsub.locator('p[role="alert"]')).toHaveText('This unsubscribe link is not valid.');
  } finally { await viewer.close(); }
});

test('every CTA and link resolves; the campaign posts link to a real page with the approved image; PT persists', async ({ page, context, request }) => {
  await at(context, BOARDING);
  await page.goto('/board');
  for (const [name, target] of [['How it works', '#how'], ['Founding', '#founding'], ['Routes', '#routes']] as const)
    await expect(page.getByRole('navigation', { name: 'Flight FloFi navigation' }).getByRole('link', { name })).toHaveAttribute('href', target);
  const footer = page.getByRole('navigation', { name: 'Footer navigation' });
  for (const [name, href] of [['Terms', '/terms'], ['Privacy', '/privacy'], ['Risks', '/terms#risks'], ['Discord', 'https://discord.gg/36rEhdUa'], ['X', 'https://x.com/FloFi_xyz']] as const)
    await expect(footer.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
  for (const path of ['/terms', '/privacy', '/docs/security', '/', '/login']) expect((await request.get(path)).status(), path).toBe(200);
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
  // The compact menu shares the product's persistent language preference.
  await page.goto('/board');
  await chooseLanguage(page, 'PT');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Diga para onde você vai.');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  // Portuguese is longer: every public state still fits a phone.
  for (const [clock, title] of [[FINAL_CALL, 'Última chamada'], [GATE_CLOSED, 'Portão fechado'], [BOARDING, 'Diga para onde você vai.']] as const) {
    await at(context, clock);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
    if (clock === FINAL_CALL) await expect(hero(page)).toContainText('Flight FloFi · Beta fechado · Embarca em 12/11');
    await fitsPhones(page);
    await noCounters(page);
  }
  await chooseLanguage(page, 'EN');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Say where you’re going.');
  // With the rollout flag disabled in this legacy campaign profile, the existing /app behavior is preserved.
  await page.goto('/app');
  await expect(page.getByRole('navigation', { name: 'Workflow stages' })).toBeVisible();
});


test('invite codes remain untouched before launch and show the exact opening message in EN and PT', async ({ page, context }) => {
  await at(context, FINAL_CALL);
  await page.goto('/board');
  const redemptions: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/board/invite')) redemptions.push(request.url()); });
  for (const language of ['EN', 'PT'] as const) {
    if (language === 'PT') { await chooseLanguage(page, 'PT'); await page.reload(); }
    await page.getByRole('button', { name: language === 'PT' ? 'Tenho um código de convite' : 'I have an invite code', exact: true }).click();
    await page.getByLabel(language === 'PT' ? 'Código de convite' : 'Invite code', { exact: true }).fill('FLF-AAAA-AAAA');
    await page.getByRole('button', { name: language === 'PT' ? 'Usar convite' : 'Use invite', exact: true }).click();
    await expect(page.locator('main').getByRole('alert')).toHaveText(language === 'PT' ? 'Seu código abre na quinta-feira, às 9h (horário de Brasília).' : 'Your code opens Thursday at 9:00 BRT');
    await expect(page).toHaveURL(/\/board$/);
  }
  expect(redemptions).toEqual([]);
});

test('compact language menus fit header and footer at every launch width, persist EN/PT, and support keyboard and pointer dismissal', async ({ page, context }) => {
  await at(context, FINAL_CALL);
  await page.goto('/board');
  for (const language of ['EN', 'PT'] as const) {
    if (language === 'PT') await chooseLanguage(page, language);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(page);
      for (const place of ['header', 'footer'] as const) {
        const scope = page.locator(place), trigger = scope.getByRole('button', { name: language === 'PT' ? 'Idioma' : 'Language', exact: true });
        await trigger.scrollIntoViewIfNeeded();
        const box = await trigger.boundingBox();
        expect(box?.width).toBe(44);
        expect(box?.height).toBe(44);
        // A full touch target with no decorative circle or border.
        await expect(trigger).toHaveCSS('border-top-width', '0px');
        await expect(trigger).toHaveCSS('border-radius', '6px');
        // Visual comparison: reconstruct only PR #178's exact trigger declarations on the same isolated page.
        // This is a CSS baseline, not evidence of a historical deployment or a second production build.
        const before = await page.addStyleTag({ content: `button.${await trigger.getAttribute('class')}{
          width:48px!important;border:2px solid rgba(255,255,255,.5)!important;border-radius:999px!important;
          padding:0 8px!important;font-size:24px!important;line-height:1}` });
        await expect(trigger).toHaveCSS('border-top-width', '2px');
        await page.screenshot({ path: test.info().outputPath(`language-${language}-${width}-${place}-pr178-trigger.png`) });
        await before.evaluate(element => element.parentNode?.removeChild(element));
        await expect(trigger).toHaveCSS('border-top-width', '0px');
        await trigger.hover();
        await page.screenshot({ path: test.info().outputPath(`language-${language}-${width}-${place}-hover.png`) });
        await trigger.focus();
        await page.screenshot({ path: test.info().outputPath(`language-${language}-${width}-${place}-focus.png`) });
        await trigger.press('ArrowDown');
        const category = scope.getByRole('menuitem', { name: language === 'PT' ? 'Idioma' : 'Language', exact: true });
        await expect(category).toBeFocused();
        await category.press('ArrowRight');
        const selected = scope.getByRole('menuitemradio', { name: language === 'PT' ? 'Português' : 'English' });
        await expect(selected).toBeFocused();
        await expect(selected).toHaveAttribute('aria-checked', 'true');
        await expect(scope.getByRole('menuitemradio', { checked: true })).toHaveCount(1);
        const panel = scope.locator('[role="menu"]').first(), panelBox = await panel.boundingBox(), anchor = await trigger.boundingBox();
        expect(panelBox!.x).toBeGreaterThanOrEqual(0);
        expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(width);
        if (place === 'footer') expect(panelBox!.y + panelBox!.height).toBeLessThan(anchor!.y);
        else expect(panelBox!.y).toBeGreaterThan(anchor!.y + anchor!.height);
        await page.screenshot({ path: test.info().outputPath(`language-${language}-${width}-${place}-open.png`) });
        await selected.press('End');
        await expect(scope.getByRole('menuitemradio', { name: 'Português' })).toBeFocused();
        await page.keyboard.press('Home');
        await expect(scope.getByRole('menuitemradio', { name: 'English' })).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(scope.getByRole('menuitemradio', { name: 'Português' })).toBeFocused();
        await page.keyboard.press('ArrowLeft');
        await expect(category).toBeFocused();
        await expect(scope.getByRole('menuitemradio')).toHaveCount(0);
        await category.press('Tab');
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        await expect(trigger).not.toBeFocused();
        await trigger.focus(); await trigger.press('ArrowDown');
        await expect(category).toBeFocused();
        await category.press('Escape');
        await expect(trigger).toBeFocused();
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        await page.screenshot({ path: test.info().outputPath(`language-${language}-${width}-${place}-closed.png`) });
        await trigger.click();
        await scope.getByRole('menuitem', { name: language === 'PT' ? 'Idioma' : 'Language', exact: true }).click();
        // A real pointer outside the panel closes it without stealing focus.
        await scope.click({ position: { x: 2, y: 2 } });
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      }
    }
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', language === 'PT' ? 'pt-BR' : 'en');
  }
  // Selecting from the upward footer menu updates both instances and survives reload.
  await chooseLanguage(page, 'EN', 'footer');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const compactTouch = await context.browser()!.newContext({ baseURL: E2E_APP_ORIGIN, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    storageState: returningVisitor(E2E_APP_ORIGIN) });
  try {
    const touch = await compactTouch.newPage();
    await compactTouch.addCookies([{ name: 'flofi_flight_clock', value: String(FINAL_CALL), url: E2E_APP_ORIGIN }]);
    await touch.route('**/*', route => new URL(route.request().url()).origin === E2E_APP_ORIGIN ? route.continue() : route.abort('blockedbyclient'));
    await touch.goto('/board');
    for (const place of ['header', 'footer'] as const) {
      const scope = touch.locator(place);
      await scope.getByRole('button', { name: /^(Language|Idioma)$/ }).tap();
      await scope.getByRole('menuitem', { name: /^(Language|Idioma)/ }).tap();
      await expect(scope.getByRole('menuitemradio', { name: 'Português' })).toBeVisible();
      await touch.screenshot({ path: test.info().outputPath(`language-390-${place}-touch-open.png`) });
      await scope.getByRole('menuitemradio', { name: 'Português' }).tap();
      await expect(scope.getByRole('button', { name: 'Idioma', exact: true })).toHaveAttribute('aria-expanded', 'false');
      await touch.screenshot({ path: test.info().outputPath(`language-PT-390-${place}-touch.png`) });
    }
  } finally { await compactTouch.close(); }
});

test('Terms and Privacy stay public, display one selected language, and preserve the risk and campaign links', async ({ page }) => {
  for (const language of ['EN', 'PT'] as const) {
    const termsTitle = language === 'PT' ? 'Termos de Uso' : 'Terms of Use', privacyTitle = language === 'PT' ? 'Política de Privacidade' : 'Privacy Policy';
    const termsResponse = await page.goto('/terms');
    expect(termsResponse?.status()).toBe(200);
    if (language === 'PT') await chooseLanguage(page, 'PT');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(termsTitle);
    await expect(page.locator('main')).not.toContainText(language === 'PT' ? 'Terms of Use' : 'Termos de Uso');
    await expect(page.locator('#risks h2')).toHaveText(language === 'PT' ? '6. Riscos' : '6. Risks');
    await expect(page.locator('main')).not.toContainText(language === 'PT' ? 'valor máximo' : 'maximum value');
    await expect(page.locator('main')).toContainText('flofi.xyz@gmail.com');
    await expect(page.locator('footer').getByRole('link', { name: language === 'PT' ? 'Privacidade' : 'Privacy', exact: true })).toHaveAttribute('href', '/privacy');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await noOverflow(page);
    }
    const privacyResponse = await page.goto('/privacy');
    expect(privacyResponse?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(privacyTitle);
    await expect(page.locator('main')).not.toContainText(language === 'PT' ? 'Privacy Policy' : 'Política de Privacidade');
    await expect(page.locator(language === 'PT' ? '#campanha-flight-flofi' : '#flight-flofi')).toContainText(language === 'PT' ? 'acesso Flight ativo' : 'active Flight access');
    await expect(page.locator('footer').getByRole('link', { name: language === 'PT' ? 'Termos' : 'Terms', exact: true })).toHaveAttribute('href', '/terms');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await noOverflow(page);
    }
    await shot(page, `privacy-${language}`);
  }
});


if (process.env.FLOFI_BETA_ACCESS === 'beta') test('closed beta protects direct product requests and returning linked-wallet sign-in', async ({ page, context, browser }) => {
  const email = `beta-${run}@flofi-e2e.test`;
  const post = (p: Page, path: string, data: object) => p.evaluate(async ({ path, data }) => {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() as unknown };
  }, { path, data });
  await at(context, BOARDING);
  await page.goto('/app');
  await expect(page).toHaveURL('/board');
  await expect(page.locator('.app-shell')).toHaveCount(0);
  const anonymous = await post(page, '/api/build-estimate', {});
  expect(anonymous.status).toBe(403);
  expect(anonymous.body).toMatchObject({ ok: false, code: 'BETA_SIGN_IN_REQUIRED' });
  await shot(page, 'closed-beta-anonymous-redirect');

  await query(`INSERT INTO flight_list_entries (tenant_id, entry_id, email, flight, language, notice)
    VALUES ('default', $1, $2, 'FIRST', 'EN', '2026-11-05')`, [`fle_${randomBytes(16).toString('hex')}`, email]);
  const address = '11111111111111111111111111111112';
  await privy(page, { wallet: { address, chain: 'solana' } });
  await page.goto('/login?returnTo=%2Fboard');
  await page.getByRole('button', { name: 'Web3 Wallet', exact: true }).click();
  await expect(page).toHaveURL('/board');
  const unproved = await post(page, '/api/build-estimate', {});
  expect(unproved.status).toBe(403);
  expect(unproved.body).toMatchObject({ code: 'BETA_ACCESS_DENIED' });
  expect((await post(page, '/api/board/board', {})).status).toBe(403);
  expect(await query('SELECT account_id FROM flight_beta_grants')).toEqual([]);

  const { code } = await accessEmail(email);
  expect((await post(page, '/api/board/access/code', { email, code })).status).toBe(200);
  const boarded = await post(page, '/api/board/board', {});
  expect(boarded.status).toBe(200);
  expect(boarded.body).toMatchObject({ flight: { access: { kind: 'eligible', origin: 'LIST' } } });
  const [grant] = await query<{ account_id: string }>('SELECT account_id FROM flight_beta_grants');
  expect(grant).toBeTruthy();
  await page.goto('/app');
  await expect(page).toHaveURL('/app');
  await expect(page.locator('.app-shell')).toBeVisible();
  expect((await post(page, '/api/build-estimate', {})).status).not.toBe(403);

  const returning = await browser.newContext({ baseURL: E2E_APP_ORIGIN, storageState: returningVisitor(E2E_APP_ORIGIN) });
  try {
    await at(returning, BOARDING);
    const later = await returning.newPage();
    await privy(later, { wallet: { address, chain: 'solana' } });
    await later.goto('/login');
    await later.getByRole('button', { name: 'Web3 Wallet', exact: true }).click();
    await expect(later).toHaveURL('/app');
    await expect(later.locator('.app-shell')).toBeVisible();
    expect(await query(`SELECT method FROM flofi_account_sessions WHERE account_id = $1 AND method = 'SOLANA'`, [grant!.account_id])).toEqual([{ method: 'SOLANA' }, { method: 'SOLANA' }]);
    await shot(later, 'closed-beta-returning-wallet');
    await query(`UPDATE flofi_account_sessions SET revoked_at = clock_timestamp() WHERE account_id = $1`, [grant!.account_id]);
    expect((await post(later, '/api/build-estimate', {})).status).toBe(403);
    await later.goto('/app');
    await expect(later).toHaveURL('/board');
  } finally { await returning.close(); }
});
