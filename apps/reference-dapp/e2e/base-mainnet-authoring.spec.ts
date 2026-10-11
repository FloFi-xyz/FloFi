// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: Base as a first-class catalog network in the existing Canvas, against FloFi's Base token-list fixture served by the MOCKED
 * loopback harness (127.0.0.1:8562). The existing Swap card offers Base, keeps its USDC/WETH shortcuts and searches the whole validated
 * list (loading, unavailable and retry states included); a non-featured token (cbBTC) lands on the same card with its provider's trusted
 * logo (a broken one falls back to the generated mark), and chat and the natural-language Copilot (committed replay answers) author the same
 * canonical actions. Provider logos are answered by a closed local replay; nothing is quoted, signed or sent and no public network is contacted.
 */
import { test, expect, openProposalReview, readWorkflowIr } from './fixtures';
import type { Page } from '@playwright/test';
import { installSupplyWallet } from './supply-fixtures';
import { expectReviewedImagesOnly, replayProviderLogos } from './asset-logo-replay';

test.skip(process.env.GRYLOO_BASE_MAINNET_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Base authoring requires the isolated loopback token-list harness');
test.describe.configure({ mode: 'serial' });

async function tokenList(mode: 'ok' | 'unavailable' | 'slow') {
  const response = await fetch('http://127.0.0.1:8562/__harness/token-list', { method: 'POST', body: JSON.stringify({ mode }) });
  expect(response.ok).toBe(true);
}
const cards = (page: Page) => page.locator('.build-flow-surface .composer-card');
async function openSwapDestination(page: Page) {
  await installSupplyWallet(page, { chain: '0x2105' });
  await page.goto('/app');
  await expect(page.getByRole('combobox', { name: 'Environment', exact: true })).toHaveText('Mainnet');
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  const card = cards(page).filter({ hasText: 'Swap' }).first();
  const destination = card.getByRole('button', { name: 'Select destination token', exact: true });
  await destination.click();
  return { card, destination, picker: page.getByRole('region', { name: 'Destination token picker', exact: true }),
    networks: page.getByRole('region', { name: 'Action network picker', exact: true }) };
}
const CBBTC_LOGO = 'https://assets.coingecko.com/coins/images/40143/standard/cbbtc.webp';
const AERO_LOGO = 'https://basescan.org/token/images/aerodrome_32.png';
let logos: string[] = [];
test.beforeEach(async ({ page }) => { logos = await replayProviderLogos(page, { broken: [AERO_LOGO] }); });

// The server caches a validated list for minutes, so the unavailable case is this server's first read.
test('an unavailable token list is shown as unavailable, never replaced; retry loads the validated list', async ({ page, networkGuard }) => {
  await tokenList('unavailable');
  const { picker } = await openSwapDestination(page);
  await expect(picker.getByText('Base tokens are unavailable right now.')).toBeVisible();
  await expect(picker.getByRole('list', { name: 'Base token results', exact: true })).toHaveCount(0);
  // Pinned shortcuts stay available; nothing else resolves without the validated list.
  for (const symbol of ['USDC', 'WETH']) await expect(picker.getByRole('radio', { name: symbol, exact: true })).toHaveCount(1);
  await tokenList('slow');
  await picker.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(picker.getByText('Loading Base tokens…')).toBeVisible();
  await expect(picker.getByRole('list', { name: 'Base token results', exact: true })).toBeVisible({ timeout: 15_000 });
  networkGuard.assertClean();
});

test('the Swap card offers Base with its shortcuts and finds a non-featured token (cbBTC) in the validated list', async ({ page, networkGuard }) => {
  await tokenList('ok');
  const { card, destination, picker, networks } = await openSwapDestination(page);
  await expect(networks.getByRole('button', { name: 'Base', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(networks.getByRole('button', { name: 'Robinhood Chain', exact: true })).toHaveCount(1);
  for (const symbol of ['USDC', 'WETH']) await expect(picker.getByRole('radio', { name: symbol, exact: true })).toHaveCount(1);
  const search = picker.getByRole('searchbox', { name: 'Search Base tokens', exact: true });
  await search.fill('coinbase wrapped');
  const results = picker.getByRole('list', { name: 'Base token results', exact: true });
  await expect(results).toBeVisible();
  await results.getByRole('button', { name: /^cbBTC\b/ }).click();
  await expect(destination).toHaveAttribute('title', 'cbBTC on Base');
  // Generic identity: the pinned USDC keeps its reviewed local mark; a listed token shows the logo its provider rule accepted (answered here
  // by the closed replay), and a logo that cannot be loaded falls back to the token's generated monogram.
  const cbbtc = card.locator('.composer-token-avatar[data-token="cbBTC"] img[data-mark="logo"]').first();
  await expect(cbbtc).toHaveAttribute('src', CBBTC_LOGO);
  await expect(cbbtc).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect.poll(() => cbbtc.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(card.locator('.composer-token-avatar[data-token="USDC"] img').first()).toHaveAttribute('src', '/brand/crypto/usdc.png');
  await search.fill('aerodrome');
  const aero = results.getByRole('button', { name: /^AERO\b/ });
  await expect(aero.locator('[data-mark="monogram"]')).toHaveText('AE');
  await expect(aero.locator('img[data-mark="logo"]')).toHaveCount(0);
  await search.fill('toshi');
  await expect(results.getByRole('button', { name: /^TOSHI\b/ }).locator('[data-mark="monogram"]')).toHaveText('TO');
  expect(logos).toEqual(expect.arrayContaining([CBBTC_LOGO, AERO_LOGO]));
  await expectReviewedImagesOnly(page);
  await search.fill('zzzz-no-such-token');
  await expect(picker.getByText('No token matches this search.')).toBeVisible();
  networkGuard.assertClean();
});

test('chat authors the same Base catalog swap; Apply puts cbBTC on the card', async ({ page, networkGuard }) => {
  await tokenList('ok');
  await installSupplyWallet(page, { chain: '0x2105' });
  await page.goto('/app');
  await page.locator('#mock-prompt').fill('swap 1 USDC for cbBTC on Base');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await openProposalReview(page);
  await expect(page.getByRole('dialog', { name: 'Proposed change', exact: true })).toContainText('cbBTC');
  await page.getByRole('button', { name: 'Apply proposal', exact: true }).click();
  const card = cards(page).filter({ hasText: 'Swap' }).first();
  // An authored card names its chain with the id, as every authored network does ("Base (8453)").
  await expect(card.getByRole('button', { name: 'Select destination token', exact: true })).toHaveAttribute('title', /^cbBTC on Base\b(?! Sepolia)/);
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
  expect(await page.evaluate(() => (window as unknown as { supplyWalletRequests: { method: string }[] }).supplyWalletRequests.filter(request => /send|sign/i.test(request.method)))).toEqual([]);
  networkGuard.assertClean();
});

async function ask(page: Page, text: string) {
  await page.locator('#mock-prompt').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const copilotSays = (page: Page) => page.getByRole('log', { name: 'Conversation' }).locator('.message.ai').last();
async function expectProposal(page: Page, interpreted: string, change: string) {
  await expect(copilotSays(page)).toContainText(interpreted);
  await openProposalReview(page);
  await expect(page.getByRole('dialog', { name: 'Proposed change', exact: true })).toContainText(change);
  await page.keyboard.press('Escape');
}

// BUILD-BASE-001 (owner addendum): the product Copilot on committed replay answers (no model is called). FloFi resolves each token the user
// named — by symbol or by its list name — in the validated Base list and renders the same exact-grammar sentence Chat accepts.
test('the Copilot authors Base actions from normal language: a list token by name, a pool, Aave, a transfer and the Arbitrum One → Base route',
  async ({ page, networkGuard }) => {
    test.skip(process.env.FLOFI_COPILOT !== 'replay', 'the natural-language Copilot runs on committed replay answers only');
    await tokenList('ok');
    await installSupplyWallet(page, { chain: '0x2105' });
    await page.goto('/app');
    const recipient = '0x3333333333333333333333333333333333333333';
    await ask(page, 'Please swap 100 USDC for Coinbase Wrapped BTC on Base');
    await expectProposal(page, 'Interpreted as “swap 100 USDC to cbBTC on Base slippage 50 bps”', 'cbBTC');
    await expect(copilotSays(page)).toContainText('“Coinbase Wrapped BTC” is cbBTC (Coinbase Wrapped BTC) in the official Base catalog.');
    await expect(copilotSays(page)).toContainText('Real funds on Base');
    await ask(page, 'Quero colocar 100 USDC e 50 Aerodrome num pool da Uniswap na Base com taxa de 0,3%');
    await expectProposal(page, 'Interpretado como “add liquidity 100 USDC and 50 AERO on Base fee 0.3% slippage 100 bps”', 'AERO');
    await ask(page, `Please lend 25 USDC on Aave on Base for ${recipient}`);
    await expectProposal(page, `Interpreted as “supply 25 USDC to Aave on Base beneficiary ${recipient}”`, 'Supply 25 USDC');
    await ask(page, `Please send 0.01 ETH on Base over to ${recipient}`);
    await expectProposal(page, `Interpreted as “transfer 0.01 ETH on Base to ${recipient}”`, '0.01 ETH');
    await ask(page, 'Move 20 USDC from Arbitrum over to Base');
    await expectProposal(page, 'Interpreted as “bridge 20 USDC from Arbitrum to Base via auto slippage 50 bps”', '20 USDC');
    // Nothing changed until the owner applies one proposal; the swap then lands in the canonical IR with cbBTC's chain + address.
    await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '0');
    await ask(page, 'Please swap 100 USDC for Coinbase Wrapped BTC on Base');
    await openProposalReview(page);
    await page.getByRole('button', { name: 'Apply proposal', exact: true }).click();
    await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
    const ir = await readWorkflowIr(page);
    expect(ir).toContain('0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf');
    expect(ir).toContain('eip155:8453');
    expect(ir).not.toMatch(/logo|coingecko/i);
    expect(await page.evaluate(() => (window as unknown as { supplyWalletRequests: { method: string }[] }).supplyWalletRequests.filter(request => /send|sign/i.test(request.method)))).toEqual([]);
    networkGuard.assertClean();
  });
