// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { test, expect, chooseWallet, openSimulationDetails, readWorkflowIr } from './fixtures';
import { assertSimulationReviewBlocked } from './release-safety-fixtures';
import { signRequests } from './jupiter-fixtures';
import { devnetControl, installDevnetWallet, resetDevnetHarness } from './solana-devnet-fixtures';

/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001 on MOCKED loopback harnesses only, with the app exactly as deployed (no engineering opt-in): FloFi is Mainnet-only.
 * There is no Mainnet/Testnet selector; a Solana wallet connects on mainnet-beta; the Canvas offers mainnets only, and a test network typed in
 * chat is refused rather than moved to a mainnet. Orca liquidity on Solana Mainnet keeps real-funds wording, and MOCKED evidence cannot authorize.
 * (The Devnet harness also serves a MOCKED copy of the mainnet-beta Orca pool.) Nothing reaches a public network: live Build estimates are
 * answered "unavailable" in the browser, so the server never calls a provider.
 */
async function closedEstimates(page: Page) {
  await page.route('**/api/build-estimate', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'ESTIMATE_UNAVAILABLE' }) }));
}
const mainnetControl = async (body: Record<string, unknown>) => (await (await fetch('http://127.0.0.1:8552/mainnet-control', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as { result: unknown }).result;
async function connectSolana(page: Page) {
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
  await chooseWallet(page, 'Gryloo MOCKED Solana wallet', 'Solana');
  await expect(page.getByRole('group', { name: 'Wallet connection', exact: true })).toContainText(/[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}/);
}
async function chooseNetwork(page: Page, card: ReturnType<Page['locator']>, network: string) {
  await card.getByRole('button', { name: 'Select source token', exact: true }).click();
  await page.getByRole('region', { name: 'Action network picker', exact: true }).getByRole('button', { name: network, exact: true }).click();
  await page.getByRole('region', { name: 'Source asset picker', exact: true }).getByRole('button', { name: 'Hide token picker', exact: true }).click();
}
const revision = (page: Page) => page.locator('.summary-bar');
const TEST_NETWORKS = ['Solana Devnet', 'Base Sepolia', 'Ethereum Sepolia', 'Arbitrum Sepolia', 'Robinhood Chain Testnet'];

test('FloFi is Mainnet-only: no environment selector, a Solana wallet connects on mainnet-beta, and the Canvas offers mainnets only', async ({ page }) => {
  await closedEstimates(page);
  const wallet = await resetDevnetHarness(); await installDevnetWallet(page, wallet);
  await page.goto('/app');
  await expect(page.getByRole('combobox', { name: 'Environment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Supply → Borrow → Swap' })).toHaveCount(0);
  await connectSolana(page);
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  const card = page.locator('.build-flow-surface .composer-card');
  await card.getByRole('button', { name: 'Select source token', exact: true }).click();
  const networks = page.getByRole('region', { name: 'Action network picker', exact: true });
  for (const name of ['Base', 'Solana', 'Robinhood Chain']) await expect(networks.getByRole('button', { name, exact: true })).toBeVisible();
  for (const name of TEST_NETWORKS) await expect(networks.getByRole('button', { name, exact: true })).toHaveCount(0);
  await networks.getByRole('button', { name: 'Solana', exact: true }).click();
  await page.getByRole('region', { name: 'Source asset picker', exact: true }).getByRole('button', { name: 'Hide token picker', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Select destination token', exact: true })).not.toContainText('devUSDC');
  await card.getByRole('textbox').fill('0.5'); await card.getByRole('textbox').press('Enter');
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '1');
  await expect(card.locator('.composer-metadata')).toContainText('Jupiter');
  const ir = JSON.parse(await readWorkflowIr(page)) as { nodes: { actionType: string; chainId: string }[] };
  expect(ir.nodes.filter(node => !node.actionType.startsWith('mock-')).map(node => node.chainId)).toEqual(['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']);
  // Connecting is a connection only: no signature was ever requested.
  expect(await signRequests(page)).toBe(0);
});

test('Orca liquidity on Solana Mainnet: authored on the Canvas against the verified mainnet pool and mints, with real-funds wording; MOCKED cannot authorize', async ({ page }) => {
  await closedEstimates(page);
  const wallet = await resetDevnetHarness();
  await mainnetControl({ action: 'reset', owner: wallet.owner });
  await installDevnetWallet(page, wallet);
  await page.goto('/__engineering');
  await connectSolana(page);
  await page.getByRole('button', { name: 'Add pool', exact: true }).click();
  const card = page.locator('.build-flow-surface .composer-card');
  await chooseNetwork(page, card, 'Solana');
  await expect(card.getByRole('group', { name: 'Liquidity provider', exact: true }).getByRole('button', { name: 'Solana', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByRole('button', { name: 'Select destination token', exact: true })).toHaveText('USDC');
  await card.getByRole('textbox', { name: 'First liquidity amount (SOL)', exact: true }).fill('0.01');
  await card.getByRole('textbox', { name: 'Second liquidity amount (USDC)', exact: true }).fill('0.3');
  await card.getByRole('button', { name: 'Advanced Settings', exact: true }).click();
  const form = page.getByRole('form', { name: 'Edit Solana liquidity position', exact: true });
  await form.getByLabel('Lower bound', { exact: true }).fill('-39104'); await form.getByLabel('Upper bound', { exact: true }).fill('-36992');
  await form.getByLabel('Liquidity slippage (bps)', { exact: true }).fill('100');
  await card.getByRole('button', { name: 'Review', exact: true }).click();
  await card.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '1');
  const ir = JSON.parse(await readWorkflowIr(page)) as { nodes: { actionType: string; chainId: string }[] };
  expect(ir.nodes.filter(node => !node.actionType.startsWith('mock-')).map(node => [node.actionType, node.chainId]))
    .toEqual([['asset.liquidity.concentrated', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']]);

  await page.getByRole('button', { name: 'Simulate workflow', exact: true }).click();
  await openSimulationDetails(page);
  const panel = page.getByRole('region', { name: 'Solana liquidity', exact: true });
  await expect(panel).toContainText('This position uses real funds on Solana Mainnet.');
  await expect(panel).toContainText('Wallet connected · Solana Mainnet');
  await panel.getByRole('button', { name: 'Simulate position', exact: true }).click();
  await expect(panel.getByRole('term').filter({ hasText: /^Expected contribution$/ })).toBeVisible();
  await expect(panel).toContainText('Solana Mainnet (genesis 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d)');
  await expect(panel).toContainText('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ');
  await expect(panel).toContainText('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  await expect(panel).toContainText('aligned ticks -39104 to -36992');
  await expect(panel).not.toContainText('devUSDC');
  // MOCKED loopback evidence can never authorize a real-funds signature.
  await assertSimulationReviewBlocked(page, () => signRequests(page));
  expect(await mainnetControl({ action: 'sent' })).toBe(0); expect(await devnetControl({ action: 'sent' })).toBe(0);
});

test('a test network named in chat is refused with an explanation and never moved to a mainnet', async ({ page }) => {
  await closedEstimates(page);
  await page.goto('/app');
  await page.getByLabel('Describe your flow').fill('swap 1 USDC to WETH on Base Sepolia slippage 50 bps');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('log', { name: 'Conversation', exact: true }))
    .toContainText('Base Sepolia is a test network. FloFi runs on mainnets only, with real funds: rebuild this on Base.');
  await expect(page.getByRole('button', { name: 'Apply proposal', exact: true })).toHaveCount(0);
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '0');
  const ir = JSON.parse(await readWorkflowIr(page)) as { nodes: { actionType: string; chainId: string }[] };
  expect(ir.nodes.filter(node => !node.actionType.startsWith('mock-'))).toEqual([]);
});
