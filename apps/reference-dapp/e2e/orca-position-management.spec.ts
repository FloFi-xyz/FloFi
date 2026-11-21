// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 — managing an existing Orca Whirlpools position on Solana mainnet-beta from the Dashboard and the Editor
 * (PR #219 stages), in the public Mainnet-only product, on the MOCKED loopback copy of the verified SOL/USDC pool (e2e/solana-devnet-harness.mjs
 * `/mainnet-rpc` and `/mainnet-control`, 127.0.0.1:8552): positions opened outside FloFi (the owner's Token-2022 position token, amount 1), one of
 * them delegated, with fees recorded and fees accrued since that only a checkpoint (collect, decrease) credits.
 *
 *   Dashboard: the owner connects a Solana wallet and proves it once (Sign-In With Solana, the wallet's only request), "My DeFi Positions" scans
 *   the loopback pool and shows each position's verified facts (range and state, current price, principal, recorded owed fees, what a collect pays
 *   now — unavailable, never 0, because the scan cannot verify unchecked fees — and the last verification) and only the actions the verified view
 *   offers; a delegated position is listed with its reason and offers none. An action PREPARES the workflow and opens the Editor (Operate, Create):
 *   nothing is simulated, signed or sent from the Dashboard.
 *   Editor: Create names the Orca operation and position; Simulate runs that exact operation (never an OPEN deposit) on the real server actions (an
 *   `orcalp-` run of the app's in-process MOCKED Orca mainnet runtime) and the opted-in loopback diagnostics show its result; Execute presents the
 *   operation, and a MOCKED result never offers an enabled Authorize (the product's provenance boundary, release-financial-provenance.spec.ts).
 *   The owner's explicit authorization and the run's ONE signed transaction are therefore made by the test through the very runtime the server
 *   actions run (e2e/orca-position-fixtures.ts, the uniswap-continuation pattern); the browser then recovers the run after a reload and shows it
 *   reconciled. A 50% withdrawal then an exit that closes the position (English), and a fees-only collect (Portuguese), are covered.
 *
 * MOCKED loopback only: the browser reaches only the app origin (the shared network guard) and its Wallet Standard double answers connect and the
 * sign-in message, and refuses any transaction; the server reads only the loopback harness; the owner's disposable key lives in the test process
 * and its signatures reach the loopback harness only. Nothing is broadcast, and none of this is evidence of a mainnet execution.
 */
import type { Page } from '@playwright/test';
import { createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { chooseLanguage } from './app-origin';
import { expectEditorSection, navigateTo, openEditorSection } from './build-entry-navigation';
import { assertNoFinancialCanvasAction, chooseWallet, expect, openSimulationDetails, test, continueToAuthorization } from './fixtures';
import { installSolanaWallet, MOCKED_SOLANA_WALLET, signMessageRequests, signRequests } from './jupiter-fixtures';
import { ORCA_RUN_KEY, orcaBalances, orcaOwnerRuntime, orcaPosition, orcaSent, orcaTrade, ownerManagesOrca, resetOrcaPositions, type OrcaOwnerWallet,
  type SeededOrcaPosition } from './orca-position-fixtures';

/**
 * Selected (FLOFI_ORCA_POSITIONS_E2E), this proof runs or FAILS: a missing prerequisite is never a skip the guarded runner would count as a pass.
 * Not selected, it is skipped. Only the names of what is missing are reported, never a value.
 */
const SELECTED = process.env.FLOFI_ORCA_POSITIONS_E2E === 'MOCKED_LOOPBACK_ONLY';
const MISSING = [...process.env.GRYLOO_SOLANA_DEVNET_E2E === 'MOCKED_LOOPBACK_ONLY' ? [] : ['GRYLOO_SOLANA_DEVNET_E2E'],
  ...process.env.GRYLOO_ORCA_MAINNET_JOURNAL?.trim() ? [] : ['GRYLOO_ORCA_MAINNET_JOURNAL'],
  ...process.env.FLOFI_E2E_NETWORK_SCOPE === 'PUBLIC_MAINNET' ? [] : ['FLOFI_E2E_NETWORK_SCOPE']];
if (SELECTED && MISSING.length) throw new Error(`ORCA_POSITIONS_E2E_PREREQUISITE_MISSING: ${MISSING.join(', ')}`);
test.skip(!SELECTED, 'Runs only in the MOCKED Orca positions profile (FLOFI_ORCA_POSITIONS_E2E=MOCKED_LOOPBACK_ONLY)');
test.setTimeout(240_000);

/** The verified pool's range around the MOCKED price (about 22.36 USDC per SOL, tick −38,008; spacing 64). */
const RANGE = { tickLower: -39_104, tickUpper: -36_992 } as const;
/** In range: 3.31031 SOL + 79.7778 USDC (six significant digits) of principal, 0.001234 SOL + 0.56 USDC of fees recorded; 0.0021 SOL + 0.65 USDC accrued since. */
const MANAGED: SeededOrcaPosition = { ...RANGE, liquidity: '10000000000', feeOwedA: '1234000', feeOwedB: '560000' };
const ACCRUED = { a: '2100000', b: '650000' } as const;
/** Its position token carries an approved delegate: listed, never managed. */
const delegated = (): SeededOrcaPosition => ({ ...RANGE, liquidity: '2000000000', delegate: createMockedSolanaWallet().owner });

/** The few visible words this proof reads, in the interface language it runs in. */
const WORDS = {
  EN: { connect: 'Connect Wallet', prove: 'Connect Solana wallet and prove ownership', positions: 'My DeFi Positions', actions: 'Position actions',
    collect: 'Collect fees', remove: 'Remove liquidity', close: 'Close position', share: 'Share of liquidity to remove', shareLabel: 'Share to remove',
    prepare: 'Prepare removal', mocked: 'Test data (MOCKED)', range: 'Range', price: 'Current price', liquidity: 'Liquidity', principal: 'Principal',
    owed: 'Owed tokens and fees (recorded)', collectable: 'Collectable now', verified: 'Last verified', unavailable: 'Unavailable', inRange: 'In range',
    open: 'Open (has liquidity)', refresh: 'Refresh', simulate: 'Simulate workflow', review: 'Continue to authorization', authorize: 'Authorize workflow', completed: 'Execution completed',
    reconciled: 'Reconciled', areas: 'Product areas', operate: 'Operate', unit: 'USDC per SOL', local: 'Local execution · no public-chain transactions',
    delegated: 'This position token is delegated, so FloFi does not manage it.',
    note: 'These actions prepare the workflow only. You review it and confirm in your wallet; nothing is executed here. Closing an Orca position refunds its account rent.' },
  PT: { connect: 'Conectar carteira', prove: 'Conectar carteira Solana e verificar titularidade', positions: 'Minhas posições DeFi', actions: 'Ações da posição',
    collect: 'Coletar taxas', remove: 'Remover liquidez', close: 'Fechar posição', share: 'Parte da liquidez a remover', shareLabel: 'Parte a remover',
    prepare: 'Preparar remoção', mocked: 'Dados de teste (MOCKED)', range: 'Intervalo', price: 'Preço atual', liquidity: 'Liquidez', principal: 'Capital',
    owed: 'Tokens devidos e taxas (registrados)', collectable: 'Coletável agora', verified: 'Última verificação', unavailable: 'Indisponível', inRange: 'Dentro da faixa',
    open: 'Aberta (com liquidez)', refresh: 'Atualizar', simulate: 'Simular fluxo', review: 'Continuar para autorização', authorize: 'Autorizar fluxo', completed: 'Execução concluída',
    reconciled: /Reconciliad[ao]/, areas: 'Áreas do produto', operate: 'Operar', unit: 'USDC per SOL', local: 'Execução local · sem transações numa rede pública',
    delegated: 'Este token de posição está delegado, então a FloFi não o gerencia.',
    note: 'Estas ações apenas preparam o fluxo. Você o revisa e confirma na sua carteira; nada é executado aqui. Fechar uma posição Orca devolve o aluguel (rent) da conta.' },
} as const;
type Language = keyof typeof WORDS;
/** The canonical marker's operation (`data-position-operation`). */
type Operation = 'DECREASE' | 'COLLECT' | 'EXIT';

const footer = (page: Page) => page.locator('footer.summary-bar');
const orcaRun = (page: Page) => page.evaluate(key => (JSON.parse(window.localStorage.getItem(key) ?? 'null') as { id?: string } | null)?.id ?? null, ORCA_RUN_KEY);
/** The page itself never asked the wallet for a transaction: its only request is the one sign-in message. */
async function expectNothingAsked(page: Page) {
  expect(await signRequests(page)).toBe(0);
}
type Setup = { wallet: OrcaOwnerWallet; owner: string; managed: string; delegated: string };
async function setup(page: Page, language: Language = 'EN'): Promise<Setup> {
  const { wallet, mints } = await resetOrcaPositions([MANAGED, delegated()], ACCRUED);
  expect(mints).toHaveLength(2);
  // A Wallet Standard double on Solana mainnet-beta: it connects and signs the sign-in message; any transaction request fails the step that made it.
  await installSolanaWallet(page, wallet, { chains: ['solana:mainnet'], signMessage: true, forbidTransactions: true });
  if (language === 'PT') await chooseLanguage(page.context(), 'PT');
  return { wallet, owner: wallet.owner, managed: mints[0]!, delegated: mints[1]! };
}
/**
 * The owner connects the Solana wallet (header) and proves it once in Your workflows (Sign-In With Solana: the wallet's one message request); the
 * proven wallet's positions are then readable from the Dashboard.
 */
async function connectAndProve(page: Page, language: Language = 'EN') {
  const W = WORDS[language];
  await page.goto('/app/workflows');
  await page.getByRole('button', { name: W.connect, exact: true }).click();
  await chooseWallet(page, MOCKED_SOLANA_WALLET, 'Solana', language);
  const prove = page.getByRole('button', { name: W.prove, exact: true });
  await prove.click();
  await expect(prove).toHaveCount(0, { timeout: 30_000 });
  expect(await signMessageRequests(page)).toBe(1);
  await expectNothingAsked(page);
}
/** Dashboard (in-app navigation; the wallet session stays) → "My DeFi Positions" → the Orca scan on Solana. */
async function openPositions(page: Page, language: Language = 'EN') {
  const W = WORDS[language];
  await navigateTo(page, 'Dashboard');
  const disclosure = page.getByRole('button', { name: W.positions, exact: true });
  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  const scan = page.getByRole('region', { name: 'Orca Whirlpools · Solana', exact: true });
  await expect(scan.locator('[data-liquidity-position]').first()).toBeVisible({ timeout: 30_000 });
  return scan;
}
/**
 * The Dashboard's "Refresh" until `check` holds. The server keeps a wallet's complete scan for 30 s (`src/server/defi-positions.ts`), so a read
 * right after the owner's own operation can still be the earlier scan; it is never presented as newer than its "Last verified" time.
 */
async function rescanUntil(page: Page, check: () => Promise<unknown>, language: Language = 'EN') {
  const panel = page.getByRole('region', { name: WORDS[language].positions, exact: true });
  await expect(async () => {
    await panel.getByRole('button', { name: WORDS[language].refresh, exact: true }).click();
    await expect(panel.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
    await check();
  }).toPass({ timeout: 75_000, intervals: [5_000] });
}
const position = (page: Page, id: string) => page.locator(`[data-liquidity-position="${id}"]`);
const fact = (page: Page, id: string, term: string) => position(page, id).locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${term.replace(/[()]/g, '\\$&')}$`) }) }).locator('dd');
const actions = (page: Page, id: string, language: Language = 'EN') => position(page, id).getByRole('group', { name: WORDS[language].actions, exact: true });
/** The Create card of a prepared Orca operation: its one pool card names the operation and the position, never a deposit. */
const card = (page: Page) => page.locator('.build-flow-surface .composer-card');
const short = (mint: string) => `${mint.slice(0, 4)}…${mint.slice(-4)}`;
/**
 * An action PREPARES the workflow and opens the Editor on Create (Operate): one pool card naming the operation, no new run (the run pointer is
 * still `run`), nothing sent by the harness and nothing asked of the browser wallet.
 */
async function prepared(page: Page, operation: Operation, language: Language = 'EN', run: string | null = null) {
  const W = WORDS[language];
  await expectEditorSection(page, 'Build');
  await expect(page.getByRole('navigation', { name: W.areas, exact: true }).getByRole('link', { name: W.operate, exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(card(page)).toHaveCount(1);
  await expect(card(page)).toHaveAttribute('data-position-operation', operation);
  expect(await orcaRun(page)).toBe(run);
  await expectNothingAsked(page);
}
/** The stage panel of a position workflow: it names the operation (its canonical marker) and the position, and never a deposit's amounts. */
async function expectOperationPresented(page: Page, panel: string, operation: Operation, subject: string) {
  const section = page.locator(`section${panel}[data-position-operation="${operation}"]`);
  await expect(section).toBeVisible();
  await expect(section).toContainText(subject);
  await expect(section).not.toContainText(/Expected pool contribution|Contribuição esperada|Deposit at most|Depositar no máximo/);
}
/**
 * Create's ONE action simulates the staged operation (read-only): Simulate opens with a fresh `orcalp-` run of the in-process MOCKED runtime. The
 * Simulate panel names that operation and position; a MOCKED result's figures are never presented as the product's own (no result rows).
 */
async function simulate(page: Page, operation: Operation, subject: string, language: Language = 'EN', previous: string | null = null): Promise<string> {
  const W = WORDS[language], sent = await orcaSent();
  await footer(page).locator('.canvas-primary-action').getByRole('button', { name: W.simulate, exact: true }).click();
  await expectEditorSection(page, 'Simulate', { timeout: 30_000 });
  // The run pointer still names the previous run until the new simulation answers.
  await expect.poll(async () => { const id = await orcaRun(page); return id !== previous && /^orcalp-[a-f0-9]{32}$/.test(id ?? ''); }, { timeout: 60_000 }).toBe(true);
  await expect(continueToAuthorization(page)).toBeEnabled({ timeout: 30_000 });
  await expectOperationPresented(page, '.simulation-context-panel', operation, subject);
  await expect(page.locator('.simulation-result-rows')).toHaveCount(0);
  expect(await orcaSent()).toBe(sent);
  return (await orcaRun(page))!;
}
/**
 * Execute presents the operation it would authorize (its summary, not a MOCKED figure: no position rows); a MOCKED result never offers an enabled
 * Authorize, and nothing is requested from the wallet.
 */
async function mockedBoundary(page: Page, operation: Operation, subject: string, language: Language = 'EN') {
  const W = WORDS[language], sent = await orcaSent();
  await continueToAuthorization(page).click();
  await expectEditorSection(page, 'Execute');
  await expectOperationPresented(page, '.review-panel-execute', operation, subject);
  await expect(page.locator('section.review-panel-execute')).toHaveAttribute('data-review-state', 'pending');
  await expect(page.locator('[data-position-row]')).toHaveCount(0);
  await expect(footer(page).getByRole('button', { name: W.authorize, exact: true })).toBeDisabled();
  await assertNoFinancialCanvasAction(page);
  expect(await orcaSent()).toBe(sent);
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

test('Dashboard → 50% withdrawal, then Close position: verified Orca facts, a delegated position offers nothing, each operation simulated as itself and reconciled through ONE owner signature',
  async ({ page, networkGuard }) => {
    const W = WORDS.EN;
    const { wallet, owner, managed, delegated: held } = await setup(page);
    await connectAndProve(page);
    const scan = await openPositions(page);
    await expect(scan).toContainText(W.mocked);
    await expect(scan).toContainText(`Liquidity position · ${short(managed)}`);
    // The position's facts, read at one slot: what a collect pays now is unavailable (fees accrued since the last checkpoint are credited only on
    // chain), never a zero.
    await expect(fact(page, managed, W.range)).toHaveText(`20.036403–24.747889 ${W.unit} · ${W.inRange}`);
    await expect(fact(page, managed, W.price)).toHaveText(`22.358560 ${W.unit}`);
    await expect(fact(page, managed, W.liquidity)).toHaveText(W.open);
    await expect(fact(page, managed, W.principal)).toHaveText('3.31031 SOL + 79.7778 USDC');
    await expect(fact(page, managed, W.owed)).toHaveText('0.001234 SOL + 0.56 USDC');
    await expect(fact(page, managed, W.collectable)).toHaveText(W.unavailable);
    await expect(fact(page, managed, W.verified)).toHaveText(/\d{4}/);
    // Only the actions the verified view offers; they only prepare. The share choices are 25/50/75% (an Orca exit is "Close position").
    await expect(actions(page, managed).getByRole('button')).toHaveText([W.collect, W.remove, W.close]);
    await expect(position(page, managed)).toContainText(W.note);
    await expect(page.getByRole('button', { name: /^(Authorize|Execute|Sign)/ })).toHaveCount(0);
    // The delegated position is listed with its facts and its reason, and offers no action.
    await expect(fact(page, held, W.principal)).toHaveText('0.662063 SOL + 15.9555 USDC');
    await expect(position(page, held)).toContainText(W.delegated);
    await expect(position(page, held).getByRole('group')).toHaveCount(0);
    // A delegated position offers no action: its only control is the exact-value disclosure of a shortened amount (never an operation).
    await expect(position(page, held).locator('button:not(.token-amount-short)')).toHaveCount(0);
    await expect(position(page, held).getByRole('button', { name: /^(Collect|Remove|Close|Coletar|Remover|Fechar)/ })).toHaveCount(0);

    await actions(page, managed).getByRole('button', { name: W.remove, exact: true }).click();
    const share = position(page, managed).getByRole('group', { name: W.share, exact: true });
    await expect(share.getByLabel(W.shareLabel)).toHaveValue('5000');
    await expect(share.getByLabel(W.shareLabel).locator('option')).toHaveText(['25%', '50%', '75%']);
    await share.getByRole('button', { name: W.prepare, exact: true }).click();
    await prepared(page, 'DECREASE');
    await expect(card(page)).toContainText('Remove 50% of liquidity');
    await expect(card(page)).toContainText(`Orca position ${short(managed)}`);

    // Create → Simulate: the read-only simulation of exactly this operation (50% of this position), never an OPEN deposit.
    const subject = `Orca position ${short(managed)}`;
    const id = await simulate(page, 'DECREASE', subject);
    const runtime = orcaOwnerRuntime(), run = await runtime.load(id);
    expect(run).toMatchObject({ provenance: 'MOCKED', operation: 'DECREASE_PARTIAL', positionMint: managed, authorization: null, attempt: null, verdict: 'PENDING',
      review: { owner, operation: 'DECREASE_PARTIAL', partBps: 5_000, operationPlan: { liquidityDelta: '5000000000', decrease: true, close: false },
        expected: { positionLiquidityAfter: '5000000000' } } });
    expect(run.review.instructionSummary.map(i => i.name)).not.toContain('open_position_with_token_extensions');
    await mockedBoundary(page, 'DECREASE', subject);
    // The opted-in loopback diagnostics show the simulation's own result for this position (read-only; MOCKED offers no acceptance there).
    await openEditorSection(page, 'Simulate');
    await openSimulationDetails(page);
    const details = page.getByRole('region', { name: 'Solana liquidity', exact: true });
    await expect(details).toContainText('Partially remove liquidity and collect fees');
    await expect(details).toContainText(`existing position mint ${managed}`);
    await expect(details).not.toContainText('Expected contribution');
    await expect(details.getByRole('button', { name: /^(Accept liquidity review|Execute )/ })).toHaveCount(0);

    // The owner's explicit authorization, then the run's ONE signed transaction, submitted once and reconciled.
    const before = await orcaBalances(owner);
    const { begun, record } = await ownerManagesOrca(runtime, id, wallet);
    expect(begun).toMatchObject({ walletChain: 'solana:mainnet', signers: [owner] });
    expect(record).toMatchObject({ verdict: 'RECONCILED', evidenceClass: 'MOCKED', attempt: { state: 'CONFIRMED' } });
    expect(record.observations.at(-1)!.effects).toMatchObject({ collectedFeesA: '3334000', collectedFeesB: '1210000' });
    expect(await orcaSent()).toBe(1);
    expect(await orcaPosition(managed)).toMatchObject({ liquidity: '5000000000', feeOwedA: '0', feeOwedB: '0', tokenOwner: owner, tokenAmount: '1', delegate: null });
    expect(BigInt((await orcaBalances(owner)).usdc) - BigInt(before.usdc)).toBeGreaterThan(1_210_000n);

    // The browser recovers the run and shows it reconciled; the page itself never asked the wallet for a transaction.
    const workspace = await recoveredExecute(page);
    await expect(workspace).toContainText(W.completed, { timeout: 30_000 });
    await expect(workspace).toContainText('1. Remove 50% of liquidity');
    await expect(workspace).toContainText(W.reconciled);
    // The reconciled effects as recorded: half the principal back, the recorded and accrued fees collected, no rent moved.
    await expect(workspace).toContainText(/Actual withdrawn · Token 1\s*1\.655158611 SOL/);
    await expect(workspace).toContainText(/Actual withdrawn · Token 2\s*39\.888944 USDC/);
    await expect(workspace).toContainText(/Fees collected · Token 1\s*0\.003334 SOL/);
    await expect(workspace).toContainText(/Fees collected · Token 2\s*1\.21 USDC/);
    await expect(workspace).toContainText(W.local);
    expect(await orcaRun(page)).toBe(id);
    await expectNothingAsked(page);

    // The Dashboard reads the position again: half the liquidity, nothing recorded as owed; then the owner closes it.
    await openPositions(page);
    await rescanUntil(page, () => expect(fact(page, managed, W.principal)).toHaveText('1.65515 SOL + 39.8889 USDC', { timeout: 2_000 }));
    await expect(fact(page, managed, W.owed)).toHaveText('0 SOL + 0 USDC');
    await expect(fact(page, managed, W.collectable)).toHaveText(W.unavailable);
    // More trading since that checkpoint: the fees it earns are credited to the position only at its next checkpoint (the recorded owed fees
    // stay 0), which is why the scan never states what a collect pays now.
    await orcaTrade({ a: '500000', b: '120000' });
    expect(await orcaPosition(managed)).toMatchObject({ liquidity: '5000000000', feeOwedA: '0', feeOwedB: '0' });
    await actions(page, managed).getByRole('button', { name: W.close, exact: true }).click();
    await prepared(page, 'EXIT', 'EN', id);
    await expect(card(page)).toContainText('Close position');
    const exit = await simulate(page, 'EXIT', subject, 'EN', id);
    const closing = await runtime.load(exit);
    expect(closing.review).toMatchObject({ operation: 'EXIT', partBps: null, operationPlan: { liquidityDelta: '5000000000', close: true }, expected: { positionLiquidityAfter: '0' } });
    await mockedBoundary(page, 'EXIT', subject);
    // The exit's checkpoint credits the fees earned since, and its one transaction collects them with the remaining principal.
    expect(closing.review.simulationResult).toMatchObject({ collectedFeesA: '500000', collectedFeesB: '120000' });
    const closed = await ownerManagesOrca(runtime, exit, wallet);
    expect(closed.record).toMatchObject({ verdict: 'RECONCILED', evidenceClass: 'MOCKED', attempt: { state: 'CONFIRMED' } });
    expect(closed.record.observations.at(-1)!.effects).toMatchObject({ collectedFeesA: '500000', collectedFeesB: '120000' });
    expect(await orcaPosition(managed)).toBeNull();
    expect(await orcaSent()).toBe(2);
    const done = await recoveredExecute(page);
    await expect(done).toContainText(W.completed, { timeout: 30_000 });
    await expect(done).toContainText('1. Close position');
    await expect(done).toContainText(W.reconciled);
    // Everything that remained came back, and the position's three accounts were closed: their rent (0.00607568 SOL) refunded.
    await expect(done).toContainText(/Actual withdrawn · Token 1\s*1\.655158611 SOL/);
    await expect(done).toContainText(/Fees collected · Token 1\s*0\.0005 SOL/);
    await expect(done).toContainText(/Fees collected · Token 2\s*0\.12 USDC/);
    await expect(done).toContainText(/Account rent refunded\s*0\.00607568 SOL/);
    // The closed position is no longer listed; the delegated one still is, still without an action.
    await openPositions(page);
    await rescanUntil(page, () => expect(position(page, managed)).toHaveCount(0, { timeout: 2_000 }));
    await expect(position(page, held)).toContainText(W.delegated);
    await expectNothingAsked(page);
    expect(await signMessageRequests(page)).toBe(0);
    networkGuard.assertClean();
  });

test('PT-BR: Coletar taxas — Simulate runs the fees-only collection; the owner\'s one signature collects the recorded and accrued fees, liquidity unchanged; the Dashboard reads it back',
  async ({ page, networkGuard }) => {
    const W = WORDS.PT;
    const { wallet, owner, managed, delegated: held } = await setup(page, 'PT');
    await connectAndProve(page, 'PT');
    const scan = await openPositions(page, 'PT');
    await expect(scan).toContainText(W.mocked);
    await expect(fact(page, managed, W.range)).toContainText(W.inRange);
    await expect(fact(page, managed, W.principal)).toHaveText('3,31031 SOL + 79,7778 USDC');
    await expect(fact(page, managed, W.owed)).toHaveText('0,001234 SOL + 0,56 USDC');
    await expect(fact(page, managed, W.collectable)).toHaveText(W.unavailable);
    await expect(actions(page, managed, 'PT').getByRole('button')).toHaveText([W.collect, W.remove, W.close]);
    await expect(position(page, managed)).toContainText(W.note);
    await expect(position(page, held)).toContainText(W.delegated);
    // A delegated position offers no action: its only control is the exact-value disclosure of a shortened amount (never an operation).
    await expect(position(page, held).locator('button:not(.token-amount-short)')).toHaveCount(0);
    await expect(position(page, held).getByRole('button', { name: /^(Collect|Remove|Close|Coletar|Remover|Fechar)/ })).toHaveCount(0);

    await actions(page, managed, 'PT').getByRole('button', { name: W.collect, exact: true }).click();
    await prepared(page, 'COLLECT', 'PT');
    await expect(card(page)).toContainText(W.collect);
    await expect(card(page)).toContainText(`Posição Orca ${short(managed)}`);
    await expect(card(page)).not.toContainText('Remover');
    const subject = `Posição Orca ${short(managed)}`;
    const id = await simulate(page, 'COLLECT', subject, 'PT');
    const runtime = orcaOwnerRuntime(), run = await runtime.load(id);
    // A fees-only collection: a checkpoint (update_fees_and_rewards) then collect_fees_v2; no liquidity moves, nothing is opened or closed.
    expect(run.review).toMatchObject({ operation: 'COLLECT', partBps: null, operationPlan: { liquidityDelta: '0', decrease: false, close: false, refreshFees: true },
      expected: { positionLiquidityAfter: '10000000000' } });
    expect(run.review.simulationResult).toMatchObject({ collectedFeesA: '3334000', collectedFeesB: '1210000' });
    await mockedBoundary(page, 'COLLECT', subject, 'PT');

    const before = await orcaBalances(owner);
    const { record } = await ownerManagesOrca(runtime, id, wallet);
    expect(record).toMatchObject({ verdict: 'RECONCILED', evidenceClass: 'MOCKED', operation: 'COLLECT' });
    expect(record.observations.at(-1)!.effects).toMatchObject({ collectedFeesA: '3334000', collectedFeesB: '1210000', withdrawnPrincipalA: '0', withdrawnPrincipalB: '0' });
    expect(BigInt((await orcaBalances(owner)).usdc) - BigInt(before.usdc)).toBe(1_210_000n);
    expect(await orcaPosition(managed)).toMatchObject({ liquidity: '10000000000', feeOwedA: '0', feeOwedB: '0' });
    expect(await orcaSent()).toBe(1);
    const workspace = await recoveredExecute(page);
    await expect(workspace).toContainText(W.completed, { timeout: 30_000 });
    await expect(workspace).toContainText(`1. ${W.collect}`);
    await expect(workspace).toContainText(W.reconciled);
    await expect(workspace).toContainText(W.local);

    // The Dashboard reads the position again: still open with the same principal; nothing recorded as owed (a read zero, not an unavailable one).
    await openPositions(page, 'PT');
    await rescanUntil(page, () => expect(fact(page, managed, W.owed)).toHaveText('0 SOL + 0 USDC', { timeout: 2_000 }), 'PT');
    await expect(fact(page, managed, W.principal)).toHaveText('3,31031 SOL + 79,7778 USDC');
    await expect(fact(page, managed, W.collectable)).toHaveText(W.unavailable);
    await expectNothingAsked(page);
    networkGuard.assertClean();
  });
