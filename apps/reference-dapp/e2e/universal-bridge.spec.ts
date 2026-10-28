// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001 browser journeys on the MOCKED loopback harness (five in-memory chains and a Relay double whose orders are
 * hashed for real; never a public network). The wallets are the test's own: a Wallet Standard Solana wallet and an EIP-1193 EVM wallet with
 * disposable in-memory keys that sign the real sign-in messages, so the server-side sessions are verified as in production.
 *
 * Product rule (same as every other MOCKED browser profile): Canvas "Authorize in wallet" stays disabled for MOCKED provenance. The
 * engineering panel's own Accept → Execute buttons drive the diagnostic lifecycle, as BUILD-ROUTER-001 and Solana composition do.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { test, expect, chooseWallet, openProposalReview, openSimulationDetails, AUTHORIZE_IN_WALLET } from './fixtures';
import { installSolanaWallet, MOCKED_SOLANA_WALLET, signRequests } from './jupiter-fixtures';
import { createTestWallet, personalSignText, type TestWallet } from '../../../packages/reference-reconciler/test/test-wallet.ts';
import type { BuildEstimateResult } from '../src/domain/build-estimate';
import { replayProviderLogos } from './asset-logo-replay';

const copilotSays = (page: Page) => page.getByRole('log', { name: 'Conversation' }).locator('.message.ai').last();
async function ask(page: Page, text: string) {
  await page.locator('#mock-prompt').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const panel = (page: Page) => page.getByRole('region', { name: 'Universal cross-chain bridge' });
test('Copilot keeps a destination question without buttons and resolves one token reply without repeating the request', async ({ page }) => {
  await page.goto('/app');
  const before = await counters();
  await ask(page, 'quero bridge de 1 USDT da Solana para Robinhood Chain');
  await expect(copilotSays(page)).toContainText('Qual ativo você quer receber');
  await ask(page, 'USDG');
  await expect(copilotSays(page)).toContainText('receive USDG');
  await openProposalReview(page);
  await expect(copilotSays(page)).toContainText('bridge 1 USDT from Solana to Robinhood Chain receive USDG via best slippage 100 bps');
  await expect(page.getByRole('dialog', { name: 'Proposed change' })).toContainText('Bridge 1 USDT');
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '0');
  expect(await counters()).toEqual(before);
});
async function control(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch('http://127.0.0.1:8566/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const value = await response.json() as { result?: unknown; error?: { message: string } };
  if (value.error) throw new Error(value.error.message);
  return value.result;
}
const counters = async () => await control('MOCK_counters') as { solanaSends: number; evmSends: number };
/** A fresh run journal and harness, funded for this test's own fresh wallets. */
async function reset(): Promise<{ solana: ReturnType<typeof createMockedSolanaWallet>; evm: TestWallet }> {
  const journal = process.env.GRYLOO_UNIVERSAL_ROUTER_JOURNAL;
  if (process.env.GRYLOO_UNIVERSAL_E2E !== 'MOCKED_LOOPBACK_ONLY' || !journal?.startsWith(join(tmpdir(), 'gryloo-universal-'))) throw new Error('MOCK_RESET_DENIED');
  await rm(journal, { recursive: true, force: true });
  const solana = createMockedSolanaWallet(), evm = createTestWallet();
  await control('MOCK_reset', [{ solana: solana.owner, evm: evm.address }]);
  return { solana, evm };
}
/** The test's EVM wallet (an injected EIP-1193 provider): signs sign-in messages; its only broadcast is the MOCKED loopback chain. */
async function installEvmWallet(page: Page, wallet: TestWallet, mode: 'normal' | 'pause-reject' = 'normal') {
  await page.exposeFunction('flofiUniversalControl', control);
  await page.exposeFunction('flofiUniversalSign', (message: unknown) => wallet.signMessage(personalSignText(message)));
  await page.addInitScript(({ owner, mode }) => {
    const state = { chain: '0x2105' };
    const w = window as unknown as { ethereum: unknown; flofiUniversalControl: (method: string, params: unknown[]) => Promise<unknown>;
      flofiUniversalSign: (message: unknown) => Promise<string>; evmSends: unknown[]; rejectEvmRequest?: () => void };
    w.evmSends = [];
    w.ethereum = { on() { /* no events */ }, removeListener() { /* no events */ }, request: async (input: { method: string; params?: unknown[] }) => {
      if (input.method === 'eth_accounts' || input.method === 'eth_requestAccounts') return [owner];
      if (input.method === 'eth_chainId') return state.chain;
      if (input.method === 'wallet_switchEthereumChain') { state.chain = (input.params?.[0] as { chainId: string }).chainId; return null; }
      if (input.method === 'personal_sign') return w.flofiUniversalSign(input.params?.[0]);
      if (input.method === 'eth_getTransactionCount') return w.flofiUniversalControl('MOCK_nonce', [...input.params ?? [], state.chain]);
      if (input.method === 'eth_sendTransaction') { w.evmSends.push(input.params?.[0]);
        if (mode === 'pause-reject') await new Promise((_resolve, reject) => { w.rejectEvmRequest = () => reject(Object.assign(new Error('Owner rejected'), { code: 4001 })); });
        return w.flofiUniversalControl('MOCK_evm_send', [{ ...input.params?.[0] as object, chainId: state.chain }]); }
      throw new Error('MOCK_WALLET_METHOD_DENIED');
    } };
  }, { owner: wallet.address, mode });
}
async function authorByChat(page: Page, sentence: string) {
  await page.goto('/app');
  await page.locator('#mock-prompt').fill(sentence);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await openProposalReview(page);
  const quote = page.waitForResponse(response => response.url().endsWith('/api/build-estimate') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Apply proposal' }).click();
  const response = await quote, result = await response.json() as BuildEstimateResult;
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.code);
  const card = page.locator('.build-flow-surface .composer-card');
  await expect(card.locator('.composer-destination-box .composer-amount-value')).toHaveText(result.estimate.expected);
  expect(result.estimate.correlationId).toBe(response.headers()['x-quote-correlation-id']);
  await expect(card).toContainText('simulation and Review still required');
  await page.screenshot({ path: test.info().outputPath('bridge-build-estimate.png'), fullPage: true });
  // MOCKED infrastructure: this proves the browser renders the actual endpoint amount, never public execution.
}
async function connectAndSignIn(page: Page) {
  await panel(page).getByRole('button', { name: 'Connect wallets' }).click();
  // Source Solana always needs an explicit selector choice. The injected EVM provider already answers eth_accounts, so the
  // destination wallet is reused passively and no second selector opens (same rule as the certified Router journeys).
  await chooseWallet(page, MOCKED_SOLANA_WALLET, 'Solana');
  const ethereum = page.locator('dialog.wallet-selector[open]');
  if (await ethereum.isVisible()) await chooseWallet(page, 'Browser wallet', 'Ethereum');
  await panel(page).getByRole('button', { name: 'Sign in with source wallet' }).click();
  await expect(panel(page).getByRole('button', { name: 'Sign in with source wallet' })).toHaveCount(0);
}
/** Engineering-panel accept + execute on Simulate (Canvas Authorize stays disabled for MOCKED). */
async function acceptAndExecute(page: Page) {
  await expect(page.locator('.canvas-primary-action').getByRole('button', { name: AUTHORIZE_IN_WALLET, exact: true })).toBeDisabled();
  await panel(page).getByRole('button', { name: 'Accept route review', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Execute with your wallet', exact: true }).click();
}
async function observeUntil(page: Page, done: () => Promise<boolean>) {
  for (let i = 0; i < 12 && !(await done()); i++) {
    await control('MOCK_mine', [{ blocks: 3 }]);
    const observe = panel(page).getByRole('button', { name: 'Observe bridge' });
    if (await observe.isVisible()) await observe.click();
    await expect(panel(page).getByText('Working…')).toHaveCount(0);
  }
}

let wallets: Awaited<ReturnType<typeof reset>>;
test.beforeEach(async ({ page }) => { wallets = await reset(); await replayProviderLogos(page); });

test('Solana USDC → Base: routes found, Review, one Solana signature, FloFi broadcasts once, delivery verified on Base, evidence', async ({ page, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await installSolanaWallet(page, wallets.solana, { chains: ['solana:mainnet'], signMessage: true });
  await installEvmWallet(page, wallets.evm);
  await authorByChat(page, 'bridge 25 USDC from Solana to Base');
  await page.getByRole('button', { name: 'Simulate workflow' }).click(); await openSimulationDetails(page);
  await expect(panel(page)).toContainText('Bridge 25 USDC from Solana to Base, receiving USDC.');
  await panel(page).getByRole('button', { name: 'Find routes' }).click();
  const routes = panel(page).getByRole('table', { name: 'Route options' });
  await expect(routes.getByRole('row').filter({ hasText: 'Relay' })).toContainText('Builder verified · simulation and Review still required · recommended');
  await expect(routes.getByRole('row').filter({ hasText: 'Across' })).toContainText('Across has no route for this network.');
  await connectAndSignIn(page);
  await expect(panel(page)).toContainText(`Source wallet: ${wallets.solana.owner} · destination wallet: ${wallets.evm.address}`);
  await panel(page).getByRole('button', { name: 'Get route and simulate' }).click();
  const review = panel(page).getByRole('definition');
  // Provider label · protocol (relay-depository), not the internal order kind (RELAY_V2).
  for (const text of ['Relay · relay-depository', '25 USDC on Solana', 'Guaranteed minimum', '0.1% of the completed workflow input', '1 wallet signature on the source network; nothing to sign on the destination network.',
    'simulateTransaction', 'Not simulated: the destination delivery and refunds.']) await expect(panel(page)).toContainText(text);
  await expect(review.filter({ hasText: wallets.evm.address.toLowerCase() })).toContainText('on Base (your connected wallet)');
  expect(await counters()).toEqual({ solanaSends: 0, evmSends: 0 });
  await acceptAndExecute(page);
  // Begin shows "prepared" before the broadcast; wait for FloFi to finish submit (one send) before counting.
  await expect(panel(page).getByText('Working…')).toHaveCount(0);
  await expect(panel(page).getByRole('list', { name: 'Source transactions' })).toContainText(/Bridge deposit: (pending|confirmed)/);
  expect(await signRequests(page)).toBe(1);
  expect((await counters()).solanaSends).toBe(1);
  await observeUntil(page, async () => (await panel(page).textContent())?.includes('Deposit confirmed on Solana (final)') ?? false);
  // Fill the reviewed order (not a later revalidation quote): order id is shown in the Review.
  const orderId = /order\s+(0x[0-9a-fA-F]{64})/.exec((await panel(page).textContent()) ?? '')?.[1];
  if (!orderId) throw new Error('MOCK_ORDER_MISSING');
  await control('MOCK_fill', [{ orderId }]);
  await observeUntil(page, () => panel(page).getByRole('region', { name: 'Bridge result' }).isVisible());
  const result = panel(page).getByRole('region', { name: 'Bridge result' });
  await expect(result).toContainText('Verified on both chains.');
  await expect(result).toContainText('Evidence: MOCKED');
  const href = await result.getByRole('link', { name: 'Download Evidence Bundle' }).getAttribute('href');
  const evidence = JSON.parse(decodeURIComponent(href!.split(',')[1]!));
  expect(evidence.bundle).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
  expect(await counters()).toEqual({ solanaSends: 1, evmSends: 0 });
  expect(await signRequests(page)).toBe(1);
  expect(errors).toEqual([]);
  networkGuard.assertClean();
});

test('a Phantom wallet that adds its verified Lighthouse protections still signs the reviewed deposit; FloFi broadcasts it once', async ({ page }) => {
  await installSolanaWallet(page, wallets.solana, { chains: ['solana:mainnet'], signMessage: true, lighthouse: true });
  await installEvmWallet(page, wallets.evm);
  await authorByChat(page, 'bridge 25 USDC from Solana to Base');
  await page.getByRole('button', { name: 'Simulate workflow' }).click(); await openSimulationDetails(page);
  await connectAndSignIn(page);
  await panel(page).getByRole('button', { name: 'Get route and simulate' }).click();
  await expect(panel(page)).toContainText('Guaranteed minimum');
  await acceptAndExecute(page);
  await expect(panel(page).getByText('Working…')).toHaveCount(0);
  await expect(panel(page).getByRole('list', { name: 'Source transactions' })).toContainText(/Bridge deposit: (pending|confirmed)/);
  expect(await counters()).toEqual({ solanaSends: 1, evmSends: 0 });
  await observeUntil(page, async () => (await panel(page).textContent())?.includes('Deposit confirmed on Solana (final)') ?? false);
});

test('a new Canvas Bridge card on mainnet offers Solana and applies a universal bridge (existing Router pairs keep their own card)', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await installEvmWallet(page, wallets.evm);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Add bridge', exact: true }).click();
  const card = page.locator('.build-flow-surface .composer-card');
  await card.getByRole('textbox').fill('12');
  await card.getByRole('button', { name: 'Configure source asset', exact: true }).click();
  const networks = page.getByRole('region', { name: 'Source network picker', exact: true });
  await expect(networks.getByRole('button', { name: 'Solana', exact: true })).toBeEnabled();
  await networks.getByRole('button', { name: 'Solana', exact: true }).click();
  // Selecting Solana authors a universal draft (provider label flips; Solana stays on the source chip).
  await expect(card).toContainText('Universal Router');
  await expect(card.getByRole('button', { name: 'Configure source asset', exact: true })).toContainText('USDC');
  const hide = page.getByRole('button', { name: 'Hide bridge picker', exact: true });
  if (await hide.isVisible()) await hide.click();
  await card.getByRole('textbox').press('Enter');
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
  await expect(card.locator('.composer-destination-box .composer-amount-value')).toHaveText(/^[0-9]+(?:\.[0-9]+)?$/);
  expect(errors).toEqual([]);
  const simulate = page.getByRole('button', { name: 'Simulate workflow' });
  await expect(simulate).toBeEnabled();
  await simulate.click(); await openSimulationDetails(page);
  await expect(panel(page)).toContainText(/Bridge 12 USDC from Solana to (Base|Arbitrum One|Ethereum|Robinhood Chain), receiving (USDC|USDG)\./);
});

test('chat authors Base → Solana receiving SOL through Relay; the Review needs the Solana destination wallet', async ({ page }) => {
  await installEvmWallet(page, wallets.evm);
  await authorByChat(page, 'bridge 10 USDC from Base to Solana receive SOL via relay');
  await page.getByRole('button', { name: 'Simulate workflow' }).click(); await openSimulationDetails(page);
  await expect(panel(page)).toContainText('Bridge 10 USDC from Base to Solana, receiving SOL.');
  await panel(page).getByRole('button', { name: 'Find routes' }).click();
  await expect(panel(page).getByRole('table', { name: 'Route options' }).getByRole('row').filter({ hasText: 'Relay' })).toContainText('Builder verified · simulation and Review still required');
});

for (const sentence of ['quero uma bridge de 1 USDC na Base para WETH na Arbitrum', 'I want to bridge 1 USDC on Base to WETH on Arbitrum']) {
  test(`P0 Copilot: ${sentence}; exact assets through discovery, simulation and Review`, async ({ page, networkGuard }) => {
    await installEvmWallet(page, wallets.evm);
    await authorByChat(page, sentence);
    await page.getByRole('button', { name: 'Simulate workflow' }).click(); await openSimulationDetails(page);
    await expect(panel(page)).toContainText('Bridge 1 USDC from Base to Arbitrum One, receiving WETH.');
    await panel(page).getByRole('button', { name: 'Find routes' }).click();
    await expect(panel(page).getByRole('table', { name: 'Route options' })).toContainText('Builder verified · simulation and Review still required');
    await expect(panel(page)).toContainText('Guaranteed minimum');
    await expect(panel(page)).toContainText('WETH');
    await expect(panel(page)).toContainText('eth_simulateV1');
    await expect(panel(page)).toContainText('0.1% of the completed workflow input');
    expect(await counters()).toEqual({ solanaSends: 0, evmSends: 0 });
    await page.screenshot({ path: test.info().outputPath('bridge-review.png'), fullPage: true });
    networkGuard.assertClean();
  });
}

test('P0 confirmed USDC approval survives expired Review and Canvas refresh in the same run without reporting Bridge completion', async ({ page, networkGuard }) => {
  await installEvmWallet(page, wallets.evm);
  await authorByChat(page, 'bridge 1 USDC from Base to Arbitrum receive WETH');
  // Test-only Relay order lifetime; production quote/Review expiry checks remain intact.
  await control('MOCK_quoteValidity', [{ seconds: 10 }]);
  await page.getByRole('button', { name: 'Simulate workflow' }).click(); await openSimulationDetails(page);
  await expect(panel(page)).toContainText('Guaranteed minimum');
  const run = () => page.evaluate(() => JSON.parse(localStorage.getItem('flofi:crosschain-universal:run') ?? 'null') as { id: string } | null);
  const before = await run(); expect(before?.id).toBeTruthy();
  await acceptAndExecute(page);
  await control('MOCK_mine', [{ blocks: 3 }]);
  await expect(panel(page).getByRole('list', { name: 'Source transactions' })).toContainText('Approval: confirmed', { timeout: 30_000 });
  await expect(panel(page)).toContainText('no longer — get a fresh route', { timeout: 20_000 });
  const transactions = panel(page).getByRole('list', { name: 'Source transactions' });
  const approval = await transactions.getByRole('link', { name: 'view transaction' }).getAttribute('href');
  expect(await counters()).toEqual({ solanaSends: 0, evmSends: 1 });
  await control('MOCK_quoteValidity', [{ seconds: 180 }]);
  await page.getByRole('button', { name: 'Simulate again', exact: true }).click();
  await expect(panel(page)).toContainText('Existing allowance is sufficient; no approval');
  expect((await run())?.id).toBe(before?.id);
  await expect(transactions).toContainText('Approval: confirmed');
  await expect(transactions.getByRole('link', { name: 'view transaction' })).toHaveAttribute('href', approval!);
  await expect(panel(page).getByRole('button', { name: 'Accept route review', exact: true })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Execute with your wallet', exact: true })).toHaveCount(0);
  await expect(panel(page)).not.toContainText('Deposit confirmed on');
  await expect(panel(page).getByRole('heading', { name: 'Bridge reconciled', exact: true })).toHaveCount(0);
  expect(await counters()).toEqual({ solanaSends: 0, evmSends: 1 });
  await page.screenshot({ path: test.info().outputPath('approval-preserved-fresh-review.png'), fullPage: true });
  networkGuard.assertClean();
});

test('P0 simulation infrastructure failure has a safe specific message and a support correlation ID', async ({ page }) => {
  await installEvmWallet(page, wallets.evm);
  await authorByChat(page, 'bridge 1 USDC from Base to Arbitrum receive WETH');
  await control('MOCK_failSimulation', [{ enabled: true }]);
  await page.getByRole('button', { name: 'Simulate workflow' }).click(); await openSimulationDetails(page);
  await expect(panel(page)).toContainText('The network provider cannot simulate this transaction right now. Nothing was signed.');
  await expect(panel(page)).toContainText(/Support reference: [a-f0-9-]{36}/);
  expect(await counters()).toEqual({ solanaSends: 0, evmSends: 0 });
});

test('P0 Canvas independently selects Base USDC and Arbitrum WETH and applies the same universal bridge', async ({ page }) => {
  await installEvmWallet(page, wallets.evm);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Add bridge', exact: true }).click();
  const card = page.locator('.build-flow-surface .composer-card');
  await card.getByRole('textbox').fill('1');
  await card.getByRole('button', { name: 'Configure source asset', exact: true }).click();
  await page.getByRole('region', { name: 'Source network picker', exact: true }).getByRole('button', { name: 'Base', exact: true }).click();
  await page.getByRole('button', { name: 'Hide bridge picker', exact: true }).click();
  await card.getByRole('button', { name: 'Configure destination asset', exact: true }).click();
  await page.getByRole('region', { name: 'Destination network picker', exact: true }).getByRole('button', { name: 'Arbitrum', exact: true }).click();
  await page.getByRole('region', { name: 'Destination token picker', exact: true }).locator('label').filter({ has: page.getByRole('radio', { name: 'WETH', exact: true }) }).click();
  await page.getByRole('button', { name: 'Hide bridge picker', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Configure source asset', exact: true })).toContainText('USDC');
  await expect(card.getByRole('button', { name: 'Configure destination asset', exact: true })).toContainText('WETH');
  await card.getByRole('textbox').press('Enter');
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
  await page.getByRole('button', { name: 'Simulate workflow' }).click(); await openSimulationDetails(page);
  await expect(panel(page)).toContainText('Bridge 1 USDC from Base to Arbitrum One, receiving WETH.');
});


test('financial truth: an unresolved EVM wallet stays navigable and recoverable, then a definite rejection survives reload without a send', async ({ page, networkGuard }) => {
  await installEvmWallet(page, wallets.evm, 'pause-reject');
  await authorByChat(page, 'bridge 1 USDC from Base to Arbitrum receive WETH');
  await page.getByRole('button', { name: 'Simulate workflow' }).click(); await openSimulationDetails(page);
  await expect(panel(page)).toContainText('Guaranteed minimum');
  await acceptAndExecute(page);
  await expect(page.locator('[data-universal-wallet-pending="true"]')).not.toHaveAttribute('inert', '');
  const stages = page.getByRole('navigation', { name: 'Workflow stages' });
  await stages.getByRole('button', { name: 'Build', exact: true }).click();
  await expect(page.locator('.build-flow-surface')).toBeVisible();
  await stages.getByRole('button', { name: 'Simulate', exact: true }).click(); await openSimulationDetails(page);
  await expect(panel(page).getByRole('button', { name: 'Observe bridge', exact: true })).toBeEnabled();
  await panel(page).getByRole('button', { name: 'Observe bridge', exact: true }).click();
  expect(await counters()).toEqual({ solanaSends: 0, evmSends: 0 });
  await page.evaluate(() => (window as unknown as { rejectEvmRequest: () => void }).rejectEvmRequest());
  await expect(page.locator('[data-universal-wallet-pending="true"]')).toHaveCount(0);
  await expect(panel(page).getByRole('list', { name: 'Source transactions' })).toContainText('Approval: cancelled');
  await page.reload(); await stages.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.locator('.execution-timeline')).toContainText('Wallet request declined');
  await expect(page.locator('.execution-summary')).toContainText('Transaction not submitted');
  expect(await counters()).toEqual({ solanaSends: 0, evmSends: 0 });
  expect(await page.evaluate(() => (window as unknown as { evmSends: unknown[] }).evmSends.length)).toBe(0);
  networkGuard.assertClean();
});
