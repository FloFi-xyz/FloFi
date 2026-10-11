// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: Robinhood Chain authoring in the existing Canvas against the full official Stock Token catalog — the committed read-only
 * registry capture served by the MOCKED loopback harness (127.0.0.1:8561). The Stocks card keeps its featured shortcuts and searches all
 * 194 official Stock Tokens (a non-featured one included) with loading, empty and unavailable states; the existing Bridge card offers the
 * Robinhood Chain routes on mainnet. BUILD-BASE-001: each Stock Token shows its validated official logo (answered by a closed local replay), and
 * the natural-language Copilot (committed replay answers) resolves a company name to its Stock Token. Nothing is quoted, signed or sent and no
 * public network is contacted.
 */
import { readFileSync } from 'node:fs';
import { test, expect, openProposalReview, readWorkflowIr } from './fixtures';
import type { Page } from '@playwright/test';
import { installSupplyWallet } from './supply-fixtures';
import { expectReviewedImagesOnly, replayProviderLogos } from './asset-logo-replay';

test.skip(process.env.GRYLOO_ROBINHOOD_MAINNET_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Robinhood Chain authoring requires the isolated loopback registry harness');
test.describe.configure({ mode: 'serial' });

async function registry(mode: 'ok' | 'unavailable' | 'slow') {
  const response = await fetch('http://127.0.0.1:8561/__harness/registry', { method: 'POST', body: JSON.stringify({ mode }) });
  expect(response.ok).toBe(true);
}
const cards = (page: Page) => page.locator('.build-flow-surface .composer-card');
const CDN = 'https://cdn.robinhood.com/ncw_assets/logos/';
let logos: string[] = [];
test.beforeEach(async ({ page }) => { logos = await replayProviderLogos(page); });
async function openStocks(page: Page) {
  await page.getByRole('button', { name: 'Stocks', exact: true }).click();
  const card = cards(page).filter({ hasText: 'Robinhood' });
  await card.getByRole('button', { name: 'Select stock', exact: true }).click();
  return { card, panel: page.getByRole('region', { name: 'Stocks configuration', exact: true }) };
}

test('the Stocks card shows the registry unavailable, then loading, then the full official catalog behind its featured shortcuts', async ({ page, networkGuard }) => {
  // The first read of this server fails: nothing stale or recorded stands in for the official registry.
  await registry('unavailable');
  await page.goto('/app');
  const { panel } = await openStocks(page);
  await expect(panel.getByText('Robinhood Stock Tokens are unavailable right now.')).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Stock Token results', exact: true })).toHaveCount(0);
  // The featured five stay shortcuts; they are never the catalog.
  for (const symbol of ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN']) await expect(panel.getByRole('radio', { name: symbol, exact: true })).toHaveCount(1);
  await registry('slow');
  await panel.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(panel.getByText('Loading Robinhood Stock Tokens…')).toBeVisible();
  const results = panel.getByRole('list', { name: 'Stock Token results', exact: true });
  await expect(results).toBeVisible({ timeout: 15_000 });
  // A bounded window over the full catalog — never hundreds of buttons.
  await expect(results.getByRole('button')).toHaveCount(12);
  await expect(panel.getByText('194 Stock Tokens · type to search')).toBeVisible();
  networkGuard.assertClean();
});

test('search reaches a non-featured Stock Token (PLTR), selects it on the same card, and an unmatched search is empty', async ({ page, networkGuard }) => {
  await registry('ok');
  await page.goto('/app');
  const { card, panel } = await openStocks(page);
  const search = panel.getByRole('searchbox', { name: 'Search Stock Tokens', exact: true });
  await search.fill('palantir');
  const results = panel.getByRole('list', { name: 'Stock Token results', exact: true });
  const pltr = results.getByRole('button', { name: /^PLTR\b/ });
  await expect(pltr).toBeVisible();
  await pltr.click();
  await expect(pltr).toHaveAttribute('aria-pressed', 'true');
  for (const symbol of ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN']) await expect(panel.getByRole('radio', { name: symbol, exact: true })).not.toBeChecked();
  // The card pays USDG and receives the chosen Stock Token.
  await expect(card.getByRole('button', { name: 'Select stock', exact: true })).toHaveText('PLTR');
  await expect(card.locator('.composer-token-chip .composer-amount-token').first()).toHaveText('USDG');
  // BUILD-BASE-001: the Stock Token shows its validated official logo — the issuer's CDN image of its own address — through the shared icon.
  const logo = pltr.locator('img[data-mark="logo"]');
  await expect(logo).toHaveAttribute('src', new RegExp(`^${CDN.replaceAll('.', '\\.')}0x[0-9a-f]{40}\\.png$`));
  await expect.poll(() => logo.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(logos.every(url => url.startsWith(CDN))).toBe(true);
  await expectReviewedImagesOnly(page);
  await search.fill('zzzz-no-such-stock');
  await expect(panel.getByText('No Stock Token matches this search.')).toBeVisible();
  await expect(results).toHaveCount(0);
  networkGuard.assertClean();
});

test('on mainnet the existing Bridge card offers the Robinhood Chain routes and names the delivered asset (USDC → USDG)', async ({ page, networkGuard }) => {
  await installSupplyWallet(page, { chain: '0x2105' });
  await page.goto('/app');
  await expect(page.getByRole('combobox', { name: 'Environment', exact: true })).toHaveText('Mainnet');
  await page.getByRole('button', { name: 'Add bridge', exact: true }).click();
  const card = cards(page).filter({ hasText: 'Router' });
  const source = card.getByRole('button', { name: 'Configure source asset', exact: true });
  const destination = card.getByRole('button', { name: 'Configure destination asset', exact: true });
  await expect(source).toHaveAttribute('title', 'USDC on Base');
  await destination.click();
  const destinations = page.getByRole('region', { name: 'Destination network picker', exact: true });
  // Base → Arbitrum One, and now Base → Robinhood Chain: the supported destinations of the chosen source.
  await expect(destinations.getByRole('button', { name: 'Robinhood Chain', exact: true })).toHaveCount(1);
  await destinations.getByRole('button', { name: 'Robinhood Chain', exact: true }).click();
  await expect(destination).toHaveAttribute('title', 'USDG on Robinhood Chain');
  await expect(source).toHaveAttribute('title', 'USDC on Base');
  await page.getByRole('button', { name: 'Hide bridge picker', exact: true }).click();
  await source.click();
  const sources = page.getByRole('region', { name: 'Source network picker', exact: true });
  for (const network of ['Base', 'Arbitrum', 'Robinhood Chain']) await expect(sources.getByRole('button', { name: network, exact: true })).toHaveCount(1);
  await sources.getByRole('button', { name: 'Robinhood Chain', exact: true }).click();
  // Out of Robinhood Chain the source is USDG and the destination follows a supported pair (USDG → USDC on Base).
  await expect(source).toHaveAttribute('title', 'USDG on Robinhood Chain');
  await expect(destination).toHaveAttribute('title', 'USDC on Base');
  networkGuard.assertClean();
});

async function ask(page: Page, text: string) {
  await page.locator('#mock-prompt').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const conversation = (page: Page) => page.getByRole('log', { name: 'Conversation' });
async function proposedChange(page: Page): Promise<string> {
  await openProposalReview(page);
  const dialog = page.getByRole('dialog', { name: 'Proposed change', exact: true });
  const text = (await dialog.innerText()).trim();
  await page.keyboard.press('Escape');
  return text;
}

// BUILD-BASE-001 (owner addendum): the product Copilot on committed replay answers (no model is called). A company name, in English or
// Portuguese, resolves in the official catalog to the same canonical USDG → TSLA swap as the symbol and Chat's exact grammar.
test('the Copilot resolves a company name to its Stock Token: Tesla (EN and PT) and a non-featured Salesforce, the same proposal as TSLA',
  async ({ page, networkGuard }) => {
    test.skip(process.env.FLOFI_COPILOT !== 'replay', 'the natural-language Copilot runs on committed replay answers only');
    await registry('ok');
    await page.goto('/app');
    await ask(page, 'Buy Tesla with 50 USDG on Robinhood Chain');
    const said = conversation(page).locator('.message.ai').last();
    await expect(said).toContainText('Interpreted as “swap 50 USDG to TSLA on Robinhood Chain slippage 50 bps”');
    await expect(said).toContainText('“Tesla” is TSLA (Tesla) in the official Robinhood Chain catalog.');
    const english = await proposedChange(page);
    await ask(page, 'Compre ações da Tesla com 50 USDG na Robinhood');
    await expect(conversation(page).locator('.message.ai').last()).toContainText('Interpretado como “swap 50 USDG to TSLA on Robinhood Chain slippage 50 bps”');
    await expect(conversation(page).locator('.message.ai').last()).toContainText('“Tesla” é TSLA (Tesla) no catálogo oficial da Robinhood Chain.');
    const portuguese = await proposedChange(page);
    // Chat's exact grammar (no model) proposes the very same change.
    await ask(page, 'Swap 50 USDG for TSLA on Robinhood Chain');
    await expect(conversation(page).locator('.message.system').last()).toContainText('Proposal:');
    const exact = await proposedChange(page);
    expect(portuguese).toBe(english);
    expect(exact).toBe(english);
    expect(english).toContain('TSLA');
    await ask(page, 'Buy Salesforce with 20 USDG on Robinhood Chain');
    await expect(conversation(page).locator('.message.ai').last()).toContainText('Interpreted as “swap 20 USDG to CRM on Robinhood Chain slippage 50 bps”');
    // Nothing changed until the owner applies; then the canonical IR holds TSLA's own chain + address.
    await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '0');
    await ask(page, 'Buy Tesla with 50 USDG on Robinhood Chain');
    await openProposalReview(page);
    await page.getByRole('button', { name: 'Apply proposal', exact: true }).click();
    await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
    const ir = await readWorkflowIr(page);
    expect(ir).toContain('eip155:4663');
    const capture = JSON.parse(readFileSync(new URL('../../../packages/action-registry/test/fixtures/robinhood-rhj-assets-2026-10-11.json', import.meta.url), 'utf8')) as
      { assets: { tokenSymbol: string; deployments: { contractAddress: string; chainId: number }[] }[] };
    const tsla = capture.assets.find(asset => asset.tokenSymbol === 'TSLA')!.deployments.find(deployment => deployment.chainId === 4663)!.contractAddress.toLowerCase();
    expect(ir).toContain(tsla);
    expect(ir).not.toMatch(/logo|cdn\.robinhood/i);
    networkGuard.assertClean();
  });
