// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { test, expect, chooseWallet, openSimulationDetails, readWorkflowIr } from './fixtures';
import { assertSimulationReviewBlocked } from './release-safety-fixtures';
import { signRequests } from './jupiter-fixtures';
import { devnetControl, installDevnetWallet, resetDevnetHarness } from './solana-devnet-fixtures';

/**
 * BUILD-SOLANA-MAINNET-001 on MOCKED loopback harnesses only (the Devnet harness also serves a MOCKED copy of the mainnet-beta Orca pool):
 * the header Mainnet/Testnet control drives a Solana session's cluster, a step moves only to its own family's counterpart, and Orca liquidity
 * on Solana Mainnet keeps real-funds wording and an explicit acknowledgement before the one owner signature. Nothing reaches a public network:
 * live Build estimates are answered "unavailable" in the browser, so the server never calls a provider.
 */
async function closedEstimates(page: Page) {
  await page.route('**/api/build-estimate', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'ESTIMATE_UNAVAILABLE' }) }));
}
const mainnetControl = async (body: Record<string, unknown>) => (await (await fetch('http://127.0.0.1:8552/mainnet-control', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as { result: unknown }).result;
const environment = (page: Page) => page.getByRole('combobox', { name: 'Environment', exact: true });
async function chooseEnvironment(page: Page, value: 'Mainnet' | 'Testnet') {
  await environment(page).click(); await page.getByRole('option', { name: value, exact: true }).click();
  await expect(environment(page)).toHaveText(value);
}
async function connectSolana(page: Page) {
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
  await chooseWallet(page, 'Gryloo MOCKED Solana wallet', 'Solana');
  await expect(environment(page)).toHaveText('Testnet'); await expect(environment(page)).toBeEnabled();
}
async function chooseNetwork(page: Page, card: ReturnType<Page['locator']>, network: string) {
  await card.getByRole('button', { name: 'Select source token', exact: true }).click();
  await page.getByRole('region', { name: 'Action network picker', exact: true }).getByRole('button', { name: network, exact: true }).click();
  await page.getByRole('region', { name: 'Source asset picker', exact: true }).getByRole('button', { name: 'Hide token picker', exact: true }).click();
}
const revision = (page: Page) => page.locator('.summary-bar');

test('a Solana session switches Testnet ↔ Mainnet from the header, and a Swap step follows its own family (Solana Devnet ↔ Solana) as a draft', async ({ page }) => {
  await closedEstimates(page);
  const wallet = await resetDevnetHarness(); await installDevnetWallet(page, wallet);
  await page.goto('/app');
  await connectSolana(page);
  await expect(page.getByRole('group', { name: 'Wallet connection' })).toContainText('Solana Devnet');
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  const card = page.locator('.build-flow-surface .composer-card');
  await chooseNetwork(page, card, 'Solana Devnet');
  await expect(card.locator('.composer-metadata')).toContainText('Solana Devnet');
  await card.getByRole('textbox').fill('0.5'); await card.getByRole('textbox').press('Enter');
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '1');
  await expect(card.getByRole('button', { name: 'Select destination token', exact: true })).toContainText('devUSDC');

  await chooseEnvironment(page, 'Mainnet');
  await expect(page.getByRole('group', { name: 'Wallet connection' })).toContainText('Solana mainnet-beta');
  // The step moves to Solana (mainnet-beta) with mainnet USDC — never to another chain — and stays a draft until Enter.
  await expect(card.locator('.composer-metadata')).toContainText('Solana');
  await expect(card.locator('.composer-metadata')).not.toContainText('Devnet');
  await expect(card.getByRole('button', { name: 'Select destination token', exact: true })).toContainText('USDC');
  await expect(card.getByRole('button', { name: 'Select destination token', exact: true })).not.toContainText('devUSDC');
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '1');
  await card.getByRole('textbox').press('Enter');
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '2');
  await expect(card.locator('.composer-metadata')).toContainText('Jupiter');

  await chooseEnvironment(page, 'Testnet');
  await expect(card.getByRole('button', { name: 'Select destination token', exact: true })).toContainText('devUSDC');
  await card.getByRole('textbox').press('Enter');
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '3');
  await expect(card.locator('.composer-metadata')).toContainText('Solana Devnet');
  // Switching clusters is a connection only: no signature was ever requested.
  expect(await signRequests(page)).toBe(0);
});

test('Orca liquidity on Solana Mainnet: authored on the Canvas against the verified mainnet pool and mints, with real-funds wording; MOCKED cannot authorize', async ({ page }) => {
  await closedEstimates(page);
  const wallet = await resetDevnetHarness();
  await mainnetControl({ action: 'reset', owner: wallet.owner });
  await installDevnetWallet(page, wallet);
  await page.goto('/__engineering');
  await connectSolana(page);
  await chooseEnvironment(page, 'Mainnet');
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
