// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: Base as a first-class catalog network in the existing Canvas, against FloFi's Base token-list fixture served by the MOCKED
 * loopback harness (127.0.0.1:8562). The existing Swap card offers Base, keeps its USDC/WETH shortcuts and searches the whole validated
 * list (loading, unavailable and retry states included); a non-featured token (cbBTC) lands on the same card with a locally generated mark,
 * and chat authors the same swap. Nothing is quoted, signed or sent, no remote image is loaded and no public network is contacted.
 */
import { test, expect, openProposalReview } from './fixtures';
import type { Page } from '@playwright/test';
import { installSupplyWallet } from './supply-fixtures';

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
const localImagesOnly = async (page: Page) => {
  const sources = await page.locator('img').evaluateAll(images => images.map(image => image.getAttribute('src') ?? ''));
  expect(sources.filter(src => src && !src.startsWith('/') && !src.startsWith('data:'))).toEqual([]);
};

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
  // Generic identity: the pinned USDC keeps its local mark; a listed token gets a generated monogram (never a third-party logo).
  await expect(card.locator('.composer-token-avatar[data-token="cbBTC"] [data-mark="monogram"]').first()).toHaveText('CB');
  await expect(card.locator('.composer-token-avatar[data-token="USDC"] img').first()).toHaveAttribute('src', '/brand/crypto/usdc.png');
  await localImagesOnly(page);
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
