// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 — managing an existing Uniswap v3 position from the Dashboard and the Editor (PR #219 stages) on the MOCKED
 * Base mainnet loopback harness (e2e/base-mainnet-serve.ts `/__harness/uniswap`, 127.0.0.1:8562): the catalog USDC/WETH 0.05% pool with positions
 * opened outside FloFi (recorded owed tokens, then fees accrued that only a collect or decrease pokes into the record).
 *
 *   Dashboard: the owner verifies the wallet (one sign-in message), "My DeFi Positions" discovers the positions with their facts (range and state,
 *   current price, principal, recorded owed tokens and fees, what a collect pays now, last verification) and only the actions the verified view
 *   offers; an action PREPARES the workflow and opens the Editor (Operate, Create) — nothing is simulated, signed or sent from the Dashboard.
 *   Editor: Simulate runs the position operation's read-only simulation on the real server actions (a `balp-` run of the in-process MOCKED runtime);
 *   Execute shows the Review, and a MOCKED result never offers an enabled Authorize (the product's provenance boundary,
 *   release-financial-provenance.spec.ts). The owner's explicit authorization and the run's ONE wallet request to the NonfungiblePositionManager are
 *   therefore made by the test through the very runtime the server actions run (e2e/liquidity-position-fixtures.ts, the uniswap-continuation
 *   pattern); the browser then recovers the run after a reload and shows it reconciled, with its step evidence. A 50% withdrawal, a fees-only
 *   collect, an exit that closes the position, a declined wallet request (recorded as not sent; "Refresh & review" refreshes the same run in place)
 *   and an expired Review (refused before anything is prepared) are covered, one path in Portuguese. Create, Simulate and Execute name the
 *   operation from the canonical marker (never a deposit); after a reconciled operation the Dashboard reads the position again at once.
 *
 * MOCKED loopback only: the browser reaches only the app origin (the shared network guard) and its wallet double answers accounts, chain and the
 * sign-in message, and refuses any transaction; the server reads only the loopback harness; nothing is signed with a real key or broadcast, and none
 * of this is evidence of a mainnet execution.
 */
import type { Page } from '@playwright/test';
import { createTestWallet, type TestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { chooseLanguage } from './app-origin';
import { expectEditorSection, openEditorSection } from './build-entry-navigation';
import { assertNoFinancialCanvasAction, expect, openSimulationDetails, test, continueToAuthorization } from './fixtures';
import { installJourneyWallet, walletRequests } from './journey-fixtures';
import { advanceBasePositions, BASE_CHAIN_HEX, harnessBalances, harnessPosition, harnessSends, ownerManages, ownerRuntime, POSITION_RUN_KEY,
  resetBasePositions } from './liquidity-position-fixtures';
import type { SeededPosition } from './base-mainnet-serve';

/**
 * Selected (FLOFI_LIQUIDITY_POSITIONS_E2E), this proof runs or FAILS: a missing prerequisite is never a skip the guarded runner would count as a pass.
 * Not selected, it is skipped. Only the names of what is missing are reported, never a value.
 */
const SELECTED = process.env.FLOFI_LIQUIDITY_POSITIONS_E2E === 'MOCKED_LOOPBACK_ONLY';
const MISSING = [...process.env.GRYLOO_BASE_MAINNET_E2E === 'MOCKED_LOOPBACK_ONLY' ? [] : ['GRYLOO_BASE_MAINNET_E2E'],
  ...process.env.GRYLOO_BASE_JOURNAL?.trim() ? [] : ['GRYLOO_BASE_JOURNAL']];
if (SELECTED && MISSING.length) throw new Error(`LIQUIDITY_POSITIONS_E2E_PREREQUISITE_MISSING: ${MISSING.join(', ')}`);
test.skip(!SELECTED, 'Runs only in the MOCKED liquidity-positions profile (FLOFI_LIQUIDITY_POSITIONS_E2E=MOCKED_LOOPBACK_ONLY)');
test.setTimeout(180_000);

const NPM = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';
/** In range: 0.671728 WETH + 2,016.46 USDC of principal, 0.001 WETH + 3 USDC recorded owed, then 0.0021 WETH + 6.5 USDC of fees accrued since. */
const IN_RANGE: SeededPosition = { tickLower: -197_000, tickUpper: -195_500, liquidity: '1000000000000000', owed0: '1000000000000000', owed1: '3000000',
  fees0: '2100000000000000', fees1: '6500000' };
/** Out of range (its ticks are below the pool's: the quote price, WETH per USDC, is above the range). */
const OUT_OF_RANGE: SeededPosition = { tickLower: -199_000, tickUpper: -198_000, liquidity: '400000000000000' };
const IDS = ['9001', '9002'] as const;
/** Wallet methods that would ask the owner for a transaction, a network or a permission (only the sign-in message is ever answered). */
const ASKING = /^(eth_sendTransaction|eth_sendRawTransaction|eth_signTypedData.*|eth_sign|wallet_sendCalls|wallet_switchEthereumChain|wallet_addEthereumChain|wallet_requestPermissions)$/;

/** The few visible words this proof reads, in the interface language it runs in. */
const WORDS = {
  EN: { verify: 'Verify wallet for history', history: 'Saved history is unavailable in this environment', positions: 'My DeFi Positions', actions: 'Position actions', collect: 'Collect fees', remove: 'Remove liquidity',
    close: 'Close position', share: 'Share of liquidity to remove', shareLabel: 'Share to remove', prepare: 'Prepare removal', mocked: 'Test data (MOCKED)',
    range: 'Range', price: 'Current price', liquidity: 'Liquidity', principal: 'Principal', owed: 'Owed tokens and fees (recorded)', collectable: 'Collectable now',
    verified: 'Last verified', open: 'Open (has liquidity)', inRange: 'In range', aboveRange: 'Out of range (above)', unit: 'WETH per USDC', simulate: 'Simulate workflow',
    review: 'Continue to authorization', authorize: 'Authorize workflow', completed: 'Execution completed', reconciled: 'Reconciled', notSent: 'Transaction not submitted',
    declined: 'You declined this request in your wallet.', local: 'Local execution · no public-chain transactions', stays: 'Stays in your wallet',
    note: 'These actions prepare the workflow only. You review it and confirm in your wallet; nothing is executed here.' },
  PT: { verify: 'Verificar carteira para consultar o histórico', history: 'O histórico salvo está indisponível neste ambiente', positions: 'Minhas posições DeFi', actions: 'Ações da posição', collect: 'Coletar taxas',
    remove: 'Remover liquidez', close: 'Fechar posição', share: 'Parte da liquidez a remover', shareLabel: 'Parte a remover', prepare: 'Preparar remoção',
    mocked: 'Dados de teste (MOCKED)', range: 'Intervalo', price: 'Preço atual', liquidity: 'Liquidez', principal: 'Capital', owed: 'Tokens devidos e taxas (registrados)',
    collectable: 'Coletável agora', verified: 'Última verificação', open: 'Aberta (com liquidez)', inRange: 'Dentro da faixa', aboveRange: 'Fora da faixa (acima)',
    simulate: 'Simular fluxo', review: 'Continuar para autorização', authorize: 'Autorizar fluxo', completed: 'Execução concluída', reconciled: /Reconciliad[ao]/,
    notSent: 'Transação não enviada', declined: 'Você recusou esta solicitação na carteira.', local: 'Execução local · sem transações numa rede pública',
    stays: 'Continua na sua carteira',
    note: 'Estas ações apenas preparam o fluxo. Você o revisa e confirma na sua carteira; nada é executado aqui.' },
} as const;
type Language = keyof typeof WORDS;

const footer = (page: Page) => page.locator('footer.summary-bar');
const positionRun = (page: Page) => page.evaluate(key => (JSON.parse(window.localStorage.getItem(key) ?? 'null') as { id?: string } | null)?.id ?? null, POSITION_RUN_KEY);
/** The page itself never asked the wallet for a transaction, a network or a permission. */
async function expectNothingAsked(page: Page) {
  expect((await walletRequests(page)).filter(method => ASKING.test(method))).toEqual([]);
}
async function setup(page: Page, language: Language = 'EN'): Promise<{ wallet: TestWallet; owner: string }> {
  const wallet = createTestWallet(), owner = wallet.address.toLowerCase();
  const seeded = await resetBasePositions(owner, [IN_RANGE, OUT_OF_RANGE]);
  expect(seeded).toMatchObject({ tokenIds: [...IDS], positionManager: NPM });
  // The wallet double answers accounts, chain and the sign-in message only; any transaction request fails the step that made it.
  await installJourneyWallet(page, [wallet], { chain: BASE_CHAIN_HEX, transactionControl: async () => { throw new Error('FINANCIAL_REQUEST_FORBIDDEN'); } });
  if (language === 'PT') await chooseLanguage(page.context(), 'PT');
  return { wallet, owner };
}
/**
 * Dashboard → the wallet's one sign-in message (asked once per browser session; a wallet already verified here is not asked again) → "My DeFi
 * Positions" → the Base Uniswap scan.
 */
async function openPositions(page: Page, language: Language = 'EN') {
  const W = WORDS[language];
  await page.goto('/app/dashboard');
  const verify = page.getByRole('button', { name: W.verify, exact: true });
  await expect(verify.or(page.getByText(W.history, { exact: true }))).toBeVisible({ timeout: 30_000 });
  if (await verify.count()) {
    await verify.click();
    await expect(verify).toHaveCount(0);
  }
  const disclosure = page.getByRole('button', { name: W.positions, exact: true });
  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  const scan = page.getByRole('region', { name: 'Uniswap V3 · Base', exact: true });
  await expect(scan.locator('[data-liquidity-position]').first()).toBeVisible({ timeout: 30_000 });
  return scan;
}
const position = (page: Page, id: string) => page.locator(`[data-liquidity-position="${id}"]`);
const fact = (page: Page, id: string, term: string) => position(page, id).locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${term.replace(/[()]/g, '\\$&')}$`) }) }).locator('dd');
/**
 * An action PREPARES the workflow and opens the Editor on Create (Operate): one pool card, no new run (the run pointer is still `run`), nothing sent
 * by the harness wallet and nothing asked of the browser wallet.
 */
async function prepared(page: Page, language: Language = 'EN', run: string | null = null) {
  await expectEditorSection(page, 'Build');
  await expect(page.getByRole('navigation', { name: language === 'PT' ? 'Áreas do produto' : 'Product areas', exact: true })
    .getByRole('link', { name: language === 'PT' ? 'Operar' : 'Operate', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(1);
  await expect(page.locator('.build-flow-surface .composer-card')).toContainText('Uniswap');
  expect(await positionRun(page)).toBe(run);
  await expectNothingAsked(page);
}
/** Dashboard → Remove liquidity → a share → Prepare removal (prepares only; the Editor opens on Create). */
async function prepareShare(page: Page, share: '2500' | '5000' | '7500', language: Language = 'EN') {
  const W = WORDS[language];
  await openPositions(page, language);
  const run = await positionRun(page), sends = await harnessSends();
  await position(page, '9001').getByRole('group', { name: W.actions, exact: true }).getByRole('button', { name: W.remove, exact: true }).click();
  const group = position(page, '9001').getByRole('group', { name: W.share, exact: true });
  await group.getByLabel(W.shareLabel).selectOption(share);
  await group.getByRole('button', { name: W.prepare, exact: true }).click();
  await prepared(page, language, run);
  expect(await harnessSends()).toBe(sends);
}
/** Create's ONE action simulates the staged operation (read-only): Simulate opens with a fresh `balp-` run of the in-process MOCKED runtime. */
async function simulate(page: Page, language: Language = 'EN', previous: string | null = null): Promise<string> {
  const W = WORDS[language];
  await footer(page).locator('.canvas-primary-action').getByRole('button', { name: W.simulate, exact: true }).click();
  await expectEditorSection(page, 'Simulate', { timeout: 30_000 });
  // The run pointer still names the previous run until the new simulation answers.
  await expect.poll(async () => { const id = await positionRun(page); return id !== previous && /^balp-[a-f0-9]{32}$/.test(id ?? ''); }, { timeout: 60_000 }).toBe(true);
  const id = (await positionRun(page))!;
  await expect(continueToAuthorization(page)).toBeEnabled({ timeout: 30_000 });
  expect(await harnessSends()).toBe(0);
  return id;
}
/** Execute (C1) shows the Review; a MOCKED result never offers an enabled Authorize, and nothing is requested from the wallet. */
async function mockedBoundary(page: Page, language: Language = 'EN') {
  const W = WORDS[language];
  await continueToAuthorization(page).click();
  await expectEditorSection(page, 'Execute');
  await expect(footer(page).getByRole('button', { name: W.authorize, exact: true })).toBeDisabled();
  await assertNoFinancialCanvasAction(page);
  expect(await harnessSends()).toBe(0);
  await expectNothingAsked(page);
}
/** After a new page load of the Editor the browser recovers the run from FloFi (its pointer) and Execute shows it; nothing is sent again. */
async function recoveredExecute(page: Page) {
  await page.goto('/app');
  await openEditorSection(page, 'Execute');
  return page.locator('#workspace');
}

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const errors: string[] = []; pageErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message)); });
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

test('Dashboard → 50% withdrawal: discovered facts and capability-driven actions, prepared in the Editor, simulated, ONE Position Manager request, reconciled',
  async ({ page, networkGuard }) => {
    const W = WORDS.EN;
    const { owner } = await setup(page);
    const scan = await openPositions(page);
    await expect(scan).toContainText(W.mocked);
    await expect(scan).toContainText('Liquidity position · 9001');
    // The position's facts, read at one block: never "yield", never a zero for what could not be read.
    await expect(fact(page, '9001', W.range)).toHaveText(`0.00030905276–0.00035906538 ${W.unit} · ${W.inRange}`);
    await expect(fact(page, '9001', W.price)).toHaveText(`0.00033312182 ${W.unit}`);
    await expect(fact(page, '9001', W.liquidity)).toHaveText(W.open);
    await expect(fact(page, '9001', W.principal)).toHaveText('0.671728 WETH + 2,016.46 USDC');
    await expect(fact(page, '9001', W.owed)).toHaveText('0.001 WETH + 3 USDC');
    // What a collect pays NOW includes the fees accrued since the last checkpoint (the manager's own static collect), never the stale record alone.
    await expect(fact(page, '9001', W.collectable)).toHaveText('0.0031 WETH + 9.5 USDC');
    await expect(fact(page, '9001', W.verified)).toHaveText(/\d{4}/);
    await expect(fact(page, '9002', W.range)).toContainText(W.aboveRange);
    // Only the actions the verified view offers, and they only prepare.
    const actions = position(page, '9001').getByRole('group', { name: W.actions, exact: true });
    await expect(actions.getByRole('button')).toHaveText([W.collect, W.remove, W.close]);
    await expect(position(page, '9001')).toContainText(W.note);
    await expect(page.getByRole('button', { name: /^(Authorize|Execute|Sign)/ })).toHaveCount(0);
    await actions.getByRole('button', { name: W.remove, exact: true }).click();
    const share = position(page, '9001').getByRole('group', { name: W.share, exact: true });
    await expect(share.getByLabel(W.shareLabel)).toHaveValue('5000');
    await share.getByRole('button', { name: W.prepare, exact: true }).click();
    await prepared(page);

    // Create → Simulate: the read-only simulation of exactly this operation (50% of position #9001), then Execute's Review (MOCKED: no Authorize).
    const id = await simulate(page);
    const runtime = ownerRuntime(), run = await runtime.positionStatus(id);
    expect(run).toMatchObject({ provenance: 'MOCKED', owner, authorization: null, attempts: [], verdict: 'PENDING',
      request: { operation: 'DECREASE', tokenId: '9001', partBps: 5_000, close: false }, review: { network: 'Base', chainId: 8453, liquidityToRemove: '500000000000000' } });
    await mockedBoundary(page);

    // The owner's explicit authorization, then the run's ONE wallet request: a multicall to the NonfungiblePositionManager from the owner, no value.
    const { begun, record } = await ownerManages(runtime, id, run.workflow, owner);
    expect(begun.transaction).toMatchObject({ from: owner, to: NPM, chainId: BASE_CHAIN_HEX, value: '0x0' });
    expect(begun.transaction.data.slice(0, 10)).toBe('0xac9650d8');
    expect(record).toMatchObject({ verdict: 'RECONCILED', result: { tokenId: '9001', operation: 'DECREASE', liquidityRemoved: '500000000000000',
      liquidityAfter: '500000000000000', burned: false } });
    expect(await harnessSends()).toBe(1);
    expect(await harnessPosition('9001')).toMatchObject({ owner, liquidity: '500000000000000', owed0: '0', owed1: '0', pending0: '0', pending1: '0' });

    // The browser recovers the run and shows it reconciled with its evidence; the page itself never asked the wallet for a transaction.
    const workspace = await recoveredExecute(page);
    await expect(workspace).toContainText(W.completed, { timeout: 30_000 });
    await expect(workspace).toContainText('1. Remove liquidity');
    await expect(workspace).toContainText('50% · #9001');
    await expect(workspace).toContainText(W.reconciled);
    await expect(workspace).toContainText(W.stays);
    await expect(workspace).toContainText(W.local);
    expect(await positionRun(page)).toBe(id);
    expect(await harnessSends()).toBe(1);
    await expectNothingAsked(page);
    networkGuard.assertClean();
  });

test('Collect fees only: Simulate states the fees-only collection; the owner\'s one request collects exactly what is owed, liquidity unchanged; the Dashboard reads it back',
  async ({ page, networkGuard }) => {
    const W = WORDS.EN;
    const { owner } = await setup(page);
    await openPositions(page);
    await position(page, '9001').getByRole('group', { name: W.actions, exact: true }).getByRole('button', { name: W.collect, exact: true }).click();
    await prepared(page);
    const id = await simulate(page);
    // The opted-in loopback diagnostics show the simulation's own result for the position (read-only; MOCKED offers no acceptance there either).
    await openSimulationDetails(page);
    const details = page.getByRole('region', { name: 'Uniswap position', exact: true });
    await expect(details).toContainText('Collect fees · #9001');
    await expect(details).toContainText('Collect owed tokens and fees (liquidity unchanged)');
    await expect(details).toContainText('Collected, at least0.0031 WETH + 9.5 USDC');
    await expect(details).toContainText('Wallet requests1');
    await expect(details.getByRole('button', { name: /^(Accept position review|Execute in wallet)$/ })).toHaveCount(0);
    const before = await harnessBalances(), runtime = ownerRuntime(), run = await runtime.positionStatus(id);
    expect(run.request).toEqual({ operation: 'COLLECT', tokenId: '9001', partBps: null, close: false });
    const { record } = await ownerManages(runtime, id, run.workflow, owner);
    expect(record).toMatchObject({ verdict: 'RECONCILED', result: { operation: 'COLLECT', collected0: '3100000000000000', collected1: '9500000',
      liquidityAfter: '1000000000000000', burned: false } });
    const after = await harnessBalances();
    expect([BigInt(after.token0) - BigInt(before.token0), BigInt(after.token1) - BigInt(before.token1)]).toEqual([3_100_000_000_000_000n, 9_500_000n]);
    expect(await harnessSends()).toBe(1);
    const workspace = await recoveredExecute(page);
    await expect(workspace).toContainText(W.completed, { timeout: 30_000 });
    await expect(workspace).toContainText('1. Collect fees');
    await expect(workspace).toContainText(W.reconciled);
    // The Dashboard reads the position again at once: still open, nothing owed or collectable now (a read value of zero, not an unavailable one).
    // Its earlier scan predates the reconciled operation, so the server dropped it from its 30 s cache when it read the reconciled run (no Refresh).
    await openPositions(page);
    await expect(fact(page, '9001', W.owed)).toHaveText('0 WETH + 0 USDC');
    await expect(fact(page, '9001', W.collectable)).toHaveText('0 WETH + 0 USDC');
    await expect(fact(page, '9001', W.liquidity)).toHaveText(W.open);
    await expectNothingAsked(page);
    networkGuard.assertClean();
  });

test('Close position: the exit withdraws everything, collects and burns the NFT in one request; the Dashboard no longer lists it', async ({ page, networkGuard }) => {
  const W = WORDS.EN;
  const { owner } = await setup(page);
  await openPositions(page);
  await position(page, '9001').getByRole('group', { name: W.actions, exact: true }).getByRole('button', { name: W.close, exact: true }).click();
  await prepared(page);
  const id = await simulate(page);
  await mockedBoundary(page);
  const runtime = ownerRuntime(), run = await runtime.positionStatus(id);
  expect(run.request).toEqual({ operation: 'EXIT', tokenId: '9001', partBps: null, close: true });
  expect(run.review.innerCalls).toEqual(['DECREASE_LIQUIDITY', 'COLLECT', 'BURN']);
  const { record } = await ownerManages(runtime, id, run.workflow, owner);
  expect(record).toMatchObject({ verdict: 'RECONCILED', result: { operation: 'EXIT', liquidityRemoved: '1000000000000000', burned: true, liquidityAfter: null } });
  expect(await harnessPosition('9001')).toBeNull();
  expect(await harnessSends()).toBe(1);
  const workspace = await recoveredExecute(page);
  await expect(workspace).toContainText(W.completed, { timeout: 30_000 });
  await expect(workspace).toContainText('1. Close position');
  await expect(workspace).toContainText(W.reconciled);
  // The pre-operation scan is never served again (no Refresh needed): the closed position is gone at once.
  await openPositions(page);
  await expect(position(page, '9001')).toHaveCount(0);
  await expect(position(page, '9002')).toBeVisible();
  await expectNothingAsked(page);
  networkGuard.assertClean();
});

test('PT-BR: a declined wallet request is recorded as not sent; an expired Review is refused before anything is prepared; a fresh one is authorized and reconciled',
  async ({ page, networkGuard }) => {
    const W = WORDS.PT;
    const { owner } = await setup(page, 'PT');
    await openPositions(page, 'PT');
    // Read in Portuguese: the price unit says "por" (never "per") and the status is the adjective "Aberta" (never the verb "Abrir").
    await expect(fact(page, '9001', W.range)).toHaveText(`0.00030905276–0.00035906538 WETH por USDC · ${W.inRange}`);
    await expect(fact(page, '9001', W.price)).toHaveText('0.00033312182 WETH por USDC');
    await expect(fact(page, '9001', W.liquidity)).toHaveText(W.open);
    await expect(fact(page, '9001', W.principal)).toHaveText('0,671728 WETH + 2.016,46 USDC');
    await expect(fact(page, '9001', W.owed)).toHaveText('0,001 WETH + 3 USDC');
    await expect(fact(page, '9001', W.collectable)).toHaveText('0,0031 WETH + 9,5 USDC');
    const actions = position(page, '9001').getByRole('group', { name: W.actions, exact: true });
    await expect(actions.getByRole('button')).toHaveText([W.collect, W.remove, W.close]);
    await expect(position(page, '9001')).toContainText(W.note);
    await actions.getByRole('button', { name: W.remove, exact: true }).click();
    const share = position(page, '9001').getByRole('group', { name: W.share, exact: true });
    await share.getByLabel(W.shareLabel).selectOption('2500');
    await share.getByRole('button', { name: W.prepare, exact: true }).click();
    await prepared(page, 'PT');
    const first = await simulate(page, 'PT');
    await mockedBoundary(page, 'PT');
    const runtime = ownerRuntime(), run = await runtime.positionStatus(first);
    expect(run.request).toEqual({ operation: 'DECREASE', tokenId: '9001', partBps: 2_500, close: false });

    // The owner declines the one wallet request: nothing is sent and the run records it; after a reload the browser says so, in Portuguese.
    const declined = await ownerManages(runtime, first, run.workflow, owner, { decline: true });
    expect(declined.record).toMatchObject({ verdict: 'PENDING', error: 'UNISWAP_REJECTED' });
    expect(declined.record.attempts.map(a => [a.state, a.transactionHash ?? null])).toEqual([['CANCELLED', null]]);
    expect(await harnessSends()).toBe(0);
    const workspace = await recoveredExecute(page);
    await expect(workspace).toContainText(W.notSent, { timeout: 30_000 });
    await expect(workspace).toContainText(W.declined);
    await expect(workspace).toContainText(W.local);
    // Nothing was sent, so the one lifecycle action refreshes this run's Review in place ("Atualizar e revisar"), never a dead end.
    // The footer still states the run's status (it needs attention); its ONE action is now that refresh, never a status with no action.
    await expect(footer(page).locator('.canvas-primary-action button')).toHaveText(['Atualizar e revisar']);
    await expect(footer(page).getByRole('button', { name: 'Atualizar e revisar', exact: true })).toBeEnabled();
    expect(await harnessPosition('9001')).toMatchObject({ liquidity: '1000000000000000' });

    // A fresh preparation of the same position (50%; the declined run stays recorded), then a Review the owner lets expire: its authorization is
    // refused by the runtime before anything is prepared or requested (the Base Review is valid for 60 s; harness clock and chain move together).
    await prepareShare(page, '5000', 'PT');
    const second = await simulate(page, 'PT', first);
    const stale = await runtime.positionStatus(second);
    await advanceBasePositions(70);
    await expect(runtime.positionReview(second, stale.review.commitment, stale.workflow)).rejects.toThrow('UNISWAP_REVIEW_EXPIRED');
    expect((await runtime.positionStatus(second)).attempts).toEqual([]);
    expect(await harnessSends()).toBe(0);

    // A MOCKED Review's validity is not presented by the Editor (it presents no MOCKED result), so the owner's next choice (75%) is a new
    // revision with its own fresh simulation; the owner authorizes it and its ONE request is reconciled. The declined and expired runs sent nothing.
    await prepareShare(page, '7500', 'PT');
    const third = await simulate(page, 'PT', second);
    const fresh = await runtime.positionStatus(third);
    expect(fresh.request).toEqual({ operation: 'DECREASE', tokenId: '9001', partBps: 7_500, close: false });
    const { record } = await ownerManages(runtime, third, fresh.workflow, owner);
    expect(record).toMatchObject({ verdict: 'RECONCILED', result: { liquidityRemoved: '750000000000000', liquidityAfter: '250000000000000' } });
    expect(await harnessSends()).toBe(1);
    expect((await runtime.positionStatus(first)).attempts.map(a => a.transactionHash ?? null)).toEqual([null]);
    const done = await recoveredExecute(page);
    await expect(done).toContainText(W.completed, { timeout: 30_000 });
    await expect(done).toContainText(W.reconciled);
    await expect(done).toContainText('75% · #9001');
    await expectNothingAsked(page);
    networkGuard.assertClean();
  });

/**
 * The Editor names the position OPERATION on every stage, from the canonical marker (never the pool node's descriptive maxima as a deposit): the Canvas
 * card ("Remove 50% of liquidity", "Uniswap v3 position #9001", no amount textboxes), Simulate's operations as configured and Execute's "Operation
 * summary". A MOCKED result is never presented as a Review (the provenance boundary), so Execute shows the configured operation and no "You are
 * authorizing" rows: the C1 position rows (Token permission: None, Wallet requests: 1) and the C2 expired Review are presented only for a live result
 * (review-summary-panel-position.test.tsx renders them from real runs read as public); here they are asserted absent.
 */
test('Create, Simulate and Execute name the position operation from its marker, never a deposit', async ({ page, networkGuard }) => {
  const W = WORDS.EN;
  await setup(page);
  await openPositions(page);
  await position(page, '9001').getByRole('group', { name: W.actions, exact: true }).getByRole('button', { name: W.remove, exact: true }).click();
  await position(page, '9001').getByRole('group', { name: W.share, exact: true }).getByRole('button', { name: W.prepare, exact: true }).click();
  await prepared(page);
  const DEPOSIT = /Pool \/ Liquidity|2,?016\.46|0\.6717/;
  const card = page.locator('.build-flow-surface .composer-card');
  await expect(card).toHaveAttribute('data-position-operation', 'DECREASE');
  await expect(card.locator('.composer-action-name')).toHaveText('Remove 50% of liquidity');
  await expect(card).toContainText('Uniswap v3 position #9001');
  await expect(card).toContainText('Uniswap v3 · Base');
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await expect(card).not.toContainText(DEPOSIT);
  await simulate(page);
  const panel = page.locator('.simulation-context-panel');
  await expect(panel).toHaveAttribute('data-position-operation', 'DECREASE');
  await expect(panel.locator('.operation-summary li[data-position-operation="DECREASE"]')).toHaveCount(1);
  await expect(panel).toContainText('Remove 50% of liquidity');
  await expect(panel).toContainText('Uniswap v3 position #9001');
  await expect(panel).not.toContainText(DEPOSIT);
  await mockedBoundary(page);
  const review = page.locator('.review-panel-execute');
  await expect(review).toHaveAttribute('data-position-operation', 'DECREASE');
  const summary = review.getByRole('region', { name: 'Operation summary', exact: true });
  await expect(summary.locator('li[data-position-operation="DECREASE"]')).toHaveCount(1);
  await expect(summary).toContainText('Remove 50% of liquidity');
  await expect(summary).toContainText('Uniswap v3 position #9001');
  await expect(summary).toContainText('Base');
  await expect(review).not.toContainText(DEPOSIT);
  // MOCKED: no Review is presented, so neither its C1 rows nor an expired C2 Review (both are live-only); the footer's Authorize stays disabled.
  await expect(review).toHaveAttribute('data-review-state', 'pending');
  await expect(page.locator('[data-position-row]')).toHaveCount(0);
  await expect(page.locator('#workspace')).not.toContainText(/You are authorizing|Review before authorizing|Check your operation|Your review expired/);
  await expectNothingAsked(page);
  networkGuard.assertClean();
});

/**
 * A declined wallet request sent nothing (CANCELLED before any broadcast), so the run is not a dead end: Create's and Execute's one lifecycle action is
 * "Refresh & review", which refreshes the SAME run's Review in place (read-only; never a resend, never a new run). The owner then authorizes the
 * refreshed Review (through the runtime, the MOCKED precedent) and its one request is reconciled; the declined attempt stays recorded unsent.
 */
test('a declined request: Create and Execute offer Refresh & review, which refreshes the same run in place; the refreshed Review is authorized and reconciled',
  async ({ page, networkGuard }) => {
    const W = WORDS.EN;
    const { owner } = await setup(page);
    await openPositions(page);
    await position(page, '9001').getByRole('group', { name: W.actions, exact: true }).getByRole('button', { name: W.collect, exact: true }).click();
    await prepared(page);
    const id = await simulate(page);
    await mockedBoundary(page);
    const runtime = ownerRuntime(), run = await runtime.positionStatus(id);
    const declined = await ownerManages(runtime, id, run.workflow, owner, { decline: true });
    expect(declined.record.attempts.map(a => [a.state, a.note, a.transactionHash ?? null])).toEqual([['CANCELLED', 'UNISWAP_REJECTED', null]]);
    const workspace = await recoveredExecute(page);
    await expect(workspace).toContainText(W.notSent, { timeout: 30_000 });
    await expect(workspace).toContainText('Wallet request declined');
    const refresh = footer(page).getByRole('button', { name: 'Refresh & review', exact: true });
    await expect(refresh).toBeEnabled();
    // The status line still says the run needs attention; the ONE lifecycle action is the refresh (before the fix: a status with no action).
    await expect(footer(page).locator('.canvas-primary-action button')).toHaveText(['Refresh & review']);
    await openEditorSection(page, 'Build');
    await expect(footer(page).getByRole('button', { name: 'Refresh & review', exact: true })).toBeEnabled();
    await expect(footer(page).locator('.canvas-primary-action button')).toHaveText(['Refresh & review']);
    await openEditorSection(page, 'Execute');
    await refresh.click();
    // The SAME run gets a fresh read-only Review; the declined attempt stays recorded unsent; nothing is sent or asked of the browser wallet.
    await expect.poll(async () => (await runtime.positionStatus(id)).review.commitment, { timeout: 30_000 }).not.toBe(declined.record.review.commitment);
    const refreshed = await runtime.positionStatus(id);
    expect(refreshed).toMatchObject({ verdict: 'PENDING', authorization: null, error: null });
    expect(refreshed.attempts.map(a => [a.state, a.transactionHash ?? null])).toEqual([['CANCELLED', null]]);
    expect(await positionRun(page)).toBe(id);
    await expect(footer(page).getByRole('button', { name: 'Refresh & review', exact: true })).toHaveCount(0);
    await expect(footer(page).getByRole('button', { name: W.authorize, exact: true })).toBeDisabled();
    expect(await harnessSends()).toBe(0);
    await expectNothingAsked(page);
    // The owner authorizes the refreshed Review: its one request is reconciled on the same run.
    const { record } = await ownerManages(runtime, id, refreshed.workflow, owner);
    expect(record).toMatchObject({ id, verdict: 'RECONCILED', result: { operation: 'COLLECT', burned: false } });
    expect(record.attempts.map(a => [a.state, Boolean(a.transactionHash)])).toEqual([['CANCELLED', false], ['CONFIRMED', true]]);
    expect(await harnessSends()).toBe(1);
    const done = await recoveredExecute(page);
    await expect(done).toContainText(W.completed, { timeout: 30_000 });
    await expect(done).toContainText('1. Collect fees');
    await expect(done).toContainText(W.reconciled);
    await expectNothingAsked(page);
    networkGuard.assertClean();
  });
