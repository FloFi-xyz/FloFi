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
import type { Page, Route } from '@playwright/test';
import { createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { test, expect, chooseWallet, openSimulationDetails, AUTHORIZE_IN_WALLET, readWorkflowIr, sendChatCommand } from './fixtures';
import { installSolanaWallet, MOCKED_SOLANA_WALLET, signRequests } from './jupiter-fixtures';
import { createTestWallet, personalSignText, type TestWallet } from '../../../packages/reference-reconciler/test/test-wallet.ts';
import type { BuildEstimateResult } from '../src/domain/build-estimate';
import { replayProviderLogos } from './asset-logo-replay';
import { openBuilder, openEditorSection, reloadBuilder } from './build-entry-navigation';

const copilotSays = (page: Page) => page.getByRole('log', { name: 'Conversation' }).locator('.message.ai').last();
async function ask(page: Page, text: string) {
  await page.locator('#mock-prompt').fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}
const panel = (page: Page) => page.getByRole('region', { name: 'Universal cross-chain bridge' });
test('Copilot keeps a destination question without buttons and resolves one token reply without repeating the request', async ({ page }) => {
  await openBuilder(page);
  const before = await counters();
  await ask(page, 'quero bridge de 1 USDT da Solana para Robinhood Chain');
  // A Portuguese request is understood; P0 approved UX: FloFi answers in the interface language (English here).
  await expect(copilotSays(page)).toContainText('Which asset do you want to receive on Robinhood Chain?');
  await ask(page, 'USDG');
  await expect(copilotSays(page)).toContainText('receive USDG');
  await expect(copilotSays(page)).toContainText('bridge 1 USDT from Solana to Robinhood Chain receive USDG via best slippage 100 bps');
  // BUILD-FLOFI-CONVERSATIONAL-001: once every required field is valid the step is committed at once; nothing is quoted, signed or sent by the chat.
  // The request was in Portuguese; FloFi confirms in the interface language (English).
  await expect(copilotSays(page)).toContainText('Bridge added to your workflow: 1 USDT');
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
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
/**
 * `nonce-ahead-once` (BUILD-P0-MAINNET-EXECUTION-RELIABILITY, Incident A): the wallet's first `pending` count is one above the chain's (a pending
 * transaction FloFi's RPC does not see), then it agrees — as when the owner clears that transaction in the wallet and comes back.
 */
async function installEvmWallet(page: Page, wallet: TestWallet, mode: 'normal' | 'pause-reject' | 'nonce-ahead-once' = 'normal') {
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
      if (input.method === 'eth_getTransactionCount') {
        const count = await w.flofiUniversalControl('MOCK_nonce', [...input.params ?? [], state.chain]) as string;
        if (mode !== 'nonce-ahead-once' || (w as unknown as { nonceAheadServed?: boolean }).nonceAheadServed) return count;
        (w as unknown as { nonceAheadServed?: boolean }).nonceAheadServed = true;
        return '0x' + (BigInt(count) + 1n).toString(16);
      }
      if (input.method === 'eth_sendTransaction') { w.evmSends.push(input.params?.[0]);
        if (mode === 'pause-reject') await new Promise((_resolve, reject) => { w.rejectEvmRequest = () => reject(Object.assign(new Error('Owner rejected'), { code: 4001 })); });
        return w.flofiUniversalControl('MOCK_evm_send', [{ ...input.params?.[0] as object, chainId: state.chain }]); }
      throw new Error('MOCK_WALLET_METHOD_DENIED');
    } };
  }, { owner: wallet.address, mode });
}
async function authorByChat(page: Page, sentence: string) {
  await openBuilder(page);
  // Post-#254 hotfix (post-merge CI shard 8, also seen on PR #253's merge): the quote endpoint streams NDJSON, and Chromium can report that request
  // as cancelled (net::ERR_ABORTED) at the moment its last bytes reach the page — after the page has read and shown the estimate — so DevTools
  // keeps no body for a later `response.json()`. The test therefore reads the endpoint's own answer as it passes to the page, unchanged (the same
  // status, headers and bytes; only the first quote, and only from the loopback app).
  let answer!: (value: { readonly body: string; readonly headers: Record<string, string> }) => void;
  const quote = new Promise<{ readonly body: string; readonly headers: Record<string, string> }>(resolve => { answer = resolve; });
  let captured = false;
  const passThrough = async (route: Route) => {
    if (captured || route.request().method() !== 'POST') return route.fallback();
    captured = true;
    const response = await route.fetch(), body = await response.text();
    answer({ body, headers: response.headers() });
    await route.fulfill({ response, body });
  };
  await page.route('**/api/build-estimate', passThrough);
  await sendChatCommand(page, sentence);
  const { body, headers } = await quote;
  await page.unroute('**/api/build-estimate', passThrough);
  // The first NDJSON line is the estimate (an optional USD line may follow it).
  const result = JSON.parse(body.slice(0, body.indexOf('\n') < 0 ? undefined : body.indexOf('\n'))) as BuildEstimateResult;
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.code);
  const card = page.locator('.build-flow-surface .composer-card');
  // P0 approved UX (board 04): the quoted output is shown with at most six significant digits; its exact value stays in the title.
  const shown = card.locator('.composer-destination-box .composer-amount-value');
  await expect(shown).toHaveAttribute('title', result.estimate.expected);
  const expected = Number(result.estimate.expected);
  expect(Math.abs(Number(await shown.innerText()) - expected)).toBeLessThanOrEqual(expected * 5e-6);
  expect(result.estimate.correlationId).toBe(headers['x-quote-correlation-id']);
  // BUILD-FLOFI-UX-FIX-003: an executable (builder-verified) estimate is shown as the amount alone; provider and quality labels stay off the card,
  // and only a route FloFi cannot execute is said so in plain words.
  await expect(card).not.toContainText(/simulation and Review still required|Live quote only|Provider estimates/);
  if (result.estimate.bridge?.execution === 'QUOTE_ONLY') await expect(card).toContainText('Estimate only: FloFi cannot execute this route yet.');
  else await expect(card).not.toContainText('Estimate only');
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
  await openBuilder(page);
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
  // BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001 (incident regression): the EVM source wallet is connected and no Solana wallet is known. The card's
  // Destination wallet is amber and says which wallet is missing; Simulate is blocked before any sign-in; the chat names the receiving wallet,
  // never "Connect the wallet that will sign".
  const destination = page.locator('.build-flow-surface .composer-card .composer-destination');
  await expect(destination).toHaveAttribute('data-destination-state', 'attention');
  await expect(destination).toContainText('Required: a wallet that can receive on Solana (Solana address). Connect one or enter its public address.');
  await expect(destination.getByRole('button', { name: 'Connect a Solana wallet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Simulate workflow' })).toBeDisabled();
  await page.getByLabel('Describe your flow').fill('Review workflow');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const answer = page.getByRole('log', { name: 'Conversation' }).locator('.message:not(.you):not(.conversation-execution-message)').last();
  await expect(answer).toContainText('To receive the tokens on Solana, connect a Solana wallet here.');
  await expect(answer.getByRole('button', { name: 'Connect a Solana wallet', exact: true })).toBeVisible();
  await expect(answer).not.toContainText('will sign');
  expect(await page.evaluate(() => (window as unknown as { evmSends: unknown[] }).evmSends.length)).toBe(0);
  // A typed public address resolves it at once: the warning clears and Simulate opens (the recipient is the address as written).
  await destination.getByRole('textbox', { name: 'Destination wallet' }).fill(wallets.solana.owner);
  await destination.getByRole('textbox', { name: 'Destination wallet' }).press('Enter');
  await expect(destination).toHaveAttribute('data-destination-state', 'normal');
  await expect(destination).not.toContainText('Required');
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
  await openBuilder(page);
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

test('PR #254 follow-up: a universal bridge applies a max price difference preset at once; Enter applies a typed value; Escape discards it', async ({ page }) => {
  await installEvmWallet(page, wallets.evm);
  await openBuilder(page);
  await page.getByRole('button', { name: 'Add bridge', exact: true }).click();
  const card = page.locator('.build-flow-surface .composer-card'), revision = page.locator('.summary-bar');
  await card.getByRole('textbox').fill('1');
  await card.getByRole('button', { name: 'Configure source asset', exact: true }).click();
  await page.getByRole('region', { name: 'Source network picker', exact: true }).getByRole('button', { name: 'Base', exact: true }).click();
  await page.getByRole('button', { name: 'Hide bridge picker', exact: true }).click();
  await card.getByRole('button', { name: 'Configure destination asset', exact: true }).click();
  await page.getByRole('region', { name: 'Destination network picker', exact: true }).getByRole('button', { name: 'Arbitrum', exact: true }).click();
  await page.getByRole('region', { name: 'Destination token picker', exact: true }).locator('label').filter({ has: page.getByRole('radio', { name: 'WETH', exact: true }) }).click();
  await page.getByRole('button', { name: 'Hide bridge picker', exact: true }).click();
  await card.getByRole('textbox').press('Enter');
  await expect(revision).toHaveAttribute('data-workflow-revision', '1');
  // The applied limit, as the canonical workflow records it (the bridge's MAXIMUM_SLIPPAGE_BPS constraint).
  const slippageBps = async () => (JSON.parse(await readWorkflowIr(page)) as { nodes: { userConstraints: { kind: string; maximumBps?: number }[] }[] }).nodes
    .flatMap(node => node.userConstraints).find(constraint => constraint.kind === 'MAXIMUM_SLIPPAGE_BPS')?.maximumBps;
  const before = await counters();
  expect(await slippageBps()).toBe(100);
  await card.getByRole('button', { name: 'Action settings', exact: true }).click();
  const form = page.getByRole('form', { name: 'Edit universal bridge', exact: true });
  const field = form.getByLabel('Universal bridge max price difference (%)', { exact: true });
  await expect(field).toHaveValue('1');
  await expect(form.getByRole('button', { name: '1%', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // One click on a preset applies it to the workflow (a new revision); there is no proposal to review and no "Review bridge change" click.
  await form.getByRole('button', { name: '2.5%', exact: true }).click();
  await expect(revision).toHaveAttribute('data-workflow-revision', '2');
  expect(await slippageBps()).toBe(250);
  await expect(page.locator('.proposal-artifact')).toHaveCount(0);
  await expect(field).toHaveValue('2.5');
  await expect(form.getByRole('button', { name: '2.5%', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // A typed value applies on Enter (never per keystroke); an invalid one is refused with its reason and never applied.
  await field.fill('3');
  await expect(revision).toHaveAttribute('data-workflow-revision', '2');
  await field.press('Enter');
  await expect(revision).toHaveAttribute('data-workflow-revision', '3');
  expect(await slippageBps()).toBe(300);
  await field.fill('0.125'); await field.press('Enter');
  await expect(form.getByRole('alert')).toContainText('Enter a max price difference from 0.01% to');
  await expect(revision).toHaveAttribute('data-workflow-revision', '3');
  // Escape discards a typed value that was not applied (the settings close; nothing changes).
  await field.fill('4'); await field.press('Escape');
  await expect(revision).toHaveAttribute('data-workflow-revision', '3');
  expect(await slippageBps()).toBe(300);
  // Choosing a limit never quotes, signs or sends anything.
  expect(await counters()).toEqual(before);
});


test('financial truth: an unresolved EVM wallet stays navigable and recoverable, then a definite rejection survives reload without a send', async ({ page, networkGuard }) => {
  await installEvmWallet(page, wallets.evm, 'pause-reject');
  await authorByChat(page, 'bridge 1 USDC from Base to Arbitrum receive WETH');
  await page.getByRole('button', { name: 'Simulate workflow' }).click(); await openSimulationDetails(page);
  await expect(panel(page)).toContainText('Guaranteed minimum');
  await acceptAndExecute(page);
  await expect(page.locator('[data-universal-wallet-pending="true"]')).not.toHaveAttribute('inert', '');
  await openEditorSection(page, 'Build');
  await expect(page.locator('.build-flow-surface')).toBeVisible();
  await openEditorSection(page, 'Simulate'); await openSimulationDetails(page);
  await expect(panel(page).getByRole('button', { name: 'Observe bridge', exact: true })).toBeEnabled();
  await panel(page).getByRole('button', { name: 'Observe bridge', exact: true }).click();
  expect(await counters()).toEqual({ solanaSends: 0, evmSends: 0 });
  await page.evaluate(() => (window as unknown as { rejectEvmRequest: () => void }).rejectEvmRequest());
  await expect(page.locator('[data-universal-wallet-pending="true"]')).toHaveCount(0);
  await expect(panel(page).getByRole('list', { name: 'Source transactions' })).toContainText('Approval: cancelled');
  await reloadBuilder(page); await openEditorSection(page, 'Execute');
  await expect(page.locator('.execution-timeline')).toContainText('Wallet request declined');
  await expect(page.locator('.execution-summary')).toContainText('Transaction not submitted');
  expect(await counters()).toEqual({ solanaSends: 0, evmSends: 0 });
  expect(await page.evaluate(() => (window as unknown as { evmSends: unknown[] }).evmSends.length)).toBe(0);
  networkGuard.assertClean();
});

test('Incident A/D: a wallet reporting another transaction number sends nothing, reads "not submitted", and the same workflow continues with Refresh & review', async ({ page, networkGuard }) => {
  await installEvmWallet(page, wallets.evm, 'nonce-ahead-once');
  await authorByChat(page, 'bridge 1 USDC from Base to Arbitrum receive WETH');
  const workflowBefore = JSON.parse(await readWorkflowIr(page)) as { workflowId: string; revision: number };
  await page.getByRole('button', { name: 'Simulate workflow' }).click(); await openSimulationDetails(page);
  await expect(panel(page)).toContainText('Guaranteed minimum');
  await acceptAndExecute(page);
  // Refused before the wallet's send method: the attempt is cancelled, the owner is told what disagreed, nothing reached the wallet or chain.
  await expect(panel(page).getByRole('list', { name: 'Source transactions' })).toContainText('Approval: cancelled');
  await expect(panel(page)).toContainText('Your wallet shows a pending transaction that FloFi does not see on the network yet');
  expect(await counters()).toEqual({ solanaSends: 0, evmSends: 0 });
  expect(await page.evaluate(() => (window as unknown as { evmSends: unknown[] }).evmSends.length)).toBe(0);
  // The consumer outcome is "not submitted" — never "needs attention" — and the run offers Refresh & review on the same workflow.
  await openEditorSection(page, 'Execute');
  const summary = page.locator('.execution-summary').first();
  await expect(summary).toContainText('Transaction not submitted');
  await expect(summary).not.toContainText('needs attention');
  await page.getByRole('button', { name: 'Refresh & review', exact: true }).first().click();
  await openSimulationDetails(page);
  await expect(panel(page)).toContainText('Guaranteed minimum');
  const workflowAfter = JSON.parse(await readWorkflowIr(page)) as { workflowId: string; revision: number };
  expect([workflowAfter.workflowId, workflowAfter.revision]).toEqual([workflowBefore.workflowId, workflowBefore.revision]);
  // The fresh preparation reads the wallet's count again; it now agrees and the approval is sent once, at the still-next nonce.
  await acceptAndExecute(page);
  await control('MOCK_mine', [{ blocks: 3 }]);
  await expect(panel(page).getByRole('list', { name: 'Source transactions' })).toContainText('Approval: confirmed', { timeout: 30_000 });
  expect(await counters()).toEqual({ solanaSends: 0, evmSends: 1 });
  networkGuard.assertClean();
});
