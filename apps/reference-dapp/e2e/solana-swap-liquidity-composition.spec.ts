// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { test, expect, applyPendingProposal, openSimulationDetails } from './fixtures';
import { chooseSolanaWallet, signChains, signRequests } from './jupiter-fixtures';
import { devnetControl, installDevnetWallet, linkSwapToPosition, resetDevnetHarness } from './solana-devnet-fixtures';

// Solana Devnet Swap → Orca liquidity on the MOCKED Devnet loopback only: these runs prove the UX, the single-swap rule and the
// fail-closed paths of the composed flow. They are diagnostic (never DEVNET_EXECUTED) and use the engineering panel's own buttons.
const panel = (page: Page) => page.getByRole('region', { name: 'Solana Devnet swap and liquidity', exact: true });
const phase = (page: Page, value: string) => expect(panel(page).locator(`[data-composition-phase="${value}"]`)).toBeVisible({ timeout: 30_000 });
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) console.error('Composition failure:', await panel(page).locator('pre').textContent().catch(() => 'no panel')); });
async function send(page: Page, text: string) {
  await page.getByLabel('Describe your flow').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await applyPendingProposal(page);
}
async function author(page: Page) {
  await page.goto('/__engineering');
  await send(page, 'swap 0.1 SOL to devUSDC on Solana Devnet slippage 50 bps');
  await send(page, 'add liquidity 0.05 SOL and 1000 devUSDC ticks -39104 to -36992 on Solana Devnet slippage 100 bps');
  await linkSwapToPosition(page);
}
async function swapped(page: Page) {
  await page.getByRole('button', { name: 'Simulate workflow', exact: true }).click();
  await openSimulationDetails(page);
  await chooseSolanaWallet(panel(page));
  await panel(page).getByRole('button', { name: 'Simulate swap and liquidity', exact: true }).click();
  await phase(page, 'SIMULATED');
  expect(await signRequests(page)).toBe(0); expect(await devnetControl({ action: 'sent' })).toBe(0);
  await panel(page).getByRole('button', { name: 'Accept composed review', exact: true }).click();
  await phase(page, 'AUTHORIZED');
  await panel(page).getByRole('button', { name: 'Execute swap', exact: true }).click();
  await phase(page, 'BOUND');
}

test('one reviewed swap, the reconciled output bound to the position, one freshly reviewed position: two signatures and composed MOCKED evidence', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const wallet = await resetDevnetHarness(); await installDevnetWallet(page, wallet);
  await author(page);
  await swapped(page);
  expect(await signRequests(page)).toBe(1); expect(await devnetControl({ action: 'sent' })).toBe(1);
  const bound = await panel(page).locator('[data-composition-binding]').getAttribute('data-composition-binding');
  expect(bound).toMatch(/^[1-9][0-9]*$/);
  await expect(panel(page)).toContainText('received (reconciled); the position may use');
  await panel(page).getByRole('button', { name: 'Prepare position with the received amount', exact: true }).click();
  await phase(page, 'CONSUMING');
  await expect(panel(page).getByLabel('Position review')).toContainText('one-time position-mint key created in this browser');
  await panel(page).getByRole('button', { name: 'Accept position review', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Execute position', exact: true }).click();
  await phase(page, 'COMPLETED');
  expect(await signRequests(page)).toBe(2); expect(await signChains(page)).toEqual(['solana:devnet', 'solana:devnet']);
  expect(await devnetControl({ action: 'sent' })).toBe(2);
  await expect(panel(page)).toContainText('Evidence: MOCKED');
  const href = await panel(page).getByRole('link', { name: 'Download Evidence Bundle' }).getAttribute('href');
  const evidence = JSON.parse(decodeURIComponent(href!.split(',')[1]!)) as { bundle: { environment: string; outcome: string; receipts: unknown[] }; evidenceClass: string;
    composition: { bound: string; received: string } };
  expect(evidence).toMatchObject({ bundle: { environment: 'MOCKED', outcome: 'RECONCILED' }, evidenceClass: 'MOCKED', composition: { bound } });
  expect(evidence.bundle.receipts).toHaveLength(2);
  // Each operation's progress in the existing execution timeline.
  await page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.locator('.execution-timeline .execution-step.execution-state-confirmed')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('a declined position keeps the swap and sends nothing again; after a reload the run is recovered and the owner can end it keeping the tokens', async ({ page }) => {
  const wallet = await resetDevnetHarness(); await installDevnetWallet(page, wallet, { rejectAfter: 1 });
  await author(page);
  await swapped(page);
  expect(await devnetControl({ action: 'sent' })).toBe(1);
  await panel(page).getByRole('button', { name: 'Prepare position with the received amount', exact: true }).click();
  await phase(page, 'CONSUMING');
  await panel(page).getByRole('button', { name: 'Accept position review', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Execute position', exact: true }).click();
  await phase(page, 'BOUND');
  expect(await signRequests(page)).toBe(2); expect(await devnetControl({ action: 'sent' })).toBe(1);
  // The persisted run is recovered from the server journal into the visit's draft: the swap is done and is never offered again.
  await page.reload();
  await page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Simulate', exact: true }).click();
  await openSimulationDetails(page);
  await chooseSolanaWallet(panel(page));
  await phase(page, 'BOUND');
  await expect(panel(page).getByRole('button', { name: 'Execute swap' })).toHaveCount(0);
  await panel(page).getByRole('button', { name: 'End and keep the swapped tokens', exact: true }).click();
  await phase(page, 'PARTIAL');
  await expect(panel(page).getByRole('button', { name: /Execute/ })).toHaveCount(0);
  expect(await signRequests(page)).toBe(0); expect(await devnetControl({ action: 'sent' })).toBe(1);
});

test('a position that cannot be opened blocks before the swap: nothing is signed or sent', async ({ page }) => {
  const wallet = await resetDevnetHarness({}, { lamports: '120000000' }); await installDevnetWallet(page, wallet);
  await author(page);
  await page.getByRole('button', { name: 'Simulate workflow', exact: true }).click();
  await openSimulationDetails(page);
  await chooseSolanaWallet(panel(page));
  await panel(page).getByRole('button', { name: 'Simulate swap and liquidity', exact: true }).click();
  await expect(panel(page).getByRole('status').filter({ hasText: 'not be enough SOL' })).toContainText('Nothing was swapped.');
  await expect(panel(page).getByRole('button', { name: 'Execute swap' })).toHaveCount(0);
  expect(await signRequests(page)).toBe(0); expect(await devnetControl({ action: 'sent' })).toBe(0);
});

// P0 (owner reproduction with Phantom on Solana Devnet): the wallet confirmed, but returned the reviewed swap with Lighthouse guard
// instructions appended. FloFi refuses those bytes and sends nothing; Execute says why and offers a fresh simulation, which then
// runs the swap once and the position.
test('a wallet that changes the reviewed swap is refused before broadcast; Execute explains it and Simulate again completes swap and position', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const wallet = await resetDevnetHarness(); await installDevnetWallet(page, wallet, { guard: 1 });
  await author(page);
  await page.getByRole('button', { name: 'Simulate workflow', exact: true }).click();
  await openSimulationDetails(page);
  await chooseSolanaWallet(panel(page));
  await panel(page).getByRole('button', { name: 'Simulate swap and liquidity', exact: true }).click();
  await phase(page, 'SIMULATED');
  await panel(page).getByRole('button', { name: 'Accept composed review', exact: true }).click();
  await phase(page, 'AUTHORIZED');
  await panel(page).getByRole('button', { name: 'Execute swap', exact: true }).click();
  await phase(page, 'NOT_EXECUTED');
  expect(await signRequests(page)).toBe(1); expect(await devnetControl({ action: 'sent' })).toBe(0);
  await expect(panel(page).getByRole('status')).toContainText('Your wallet added 2 instruction(s) from Lighthouse to the transaction you reviewed');
  // Execute: a concrete outcome and a way forward, never a terminal "Cancelled".
  await page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Execute', exact: true }).click();
  const swapStep = page.locator('.execution-timeline .execution-step').first();
  await expect(swapStep).toHaveClass(/execution-state-not-submitted/);
  await expect(swapStep).toContainText('FloFi sends only the exact transaction you reviewed, so it did not send this one and nothing reached Solana.');
  await expect(page.locator('.execution-timeline .execution-step').nth(1)).toHaveClass(/execution-state-waiting/);
  await expect(page.getByRole('complementary', { name: 'Execution result summary' })).toContainText('Transaction not submitted');
  await expect(page.locator('.execution-timeline')).not.toContainText('Cancelled');
  await page.locator('.execution-lifecycle-actions').getByRole('button', { name: 'Simulate again', exact: true }).click();
  await openSimulationDetails(page);
  await phase(page, 'SIMULATED');
  expect(await devnetControl({ action: 'sent' })).toBe(0);
  await panel(page).getByRole('button', { name: 'Accept composed review', exact: true }).click();
  await phase(page, 'AUTHORIZED');
  await panel(page).getByRole('button', { name: 'Execute swap', exact: true }).click();
  await phase(page, 'BOUND');
  expect(await signRequests(page)).toBe(2); expect(await devnetControl({ action: 'sent' })).toBe(1);
  await panel(page).getByRole('button', { name: 'Prepare position with the received amount', exact: true }).click();
  await phase(page, 'CONSUMING');
  await panel(page).getByRole('button', { name: 'Accept position review', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Execute position', exact: true }).click();
  await phase(page, 'COMPLETED');
  expect(await signRequests(page)).toBe(3); expect(await devnetControl({ action: 'sent' })).toBe(2);
  await page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.locator('.execution-timeline .execution-step.execution-state-confirmed')).toHaveCount(2);
  expect(errors).toEqual([]);
});

// P0: the wallet behaviour captured from Phantom (it inserts a compute-unit price when the transaction sets none). FloFi's reviewed swap and
// position now set their own price, so the wallet signs the exact reviewed bytes and the composition completes.
test('a Phantom-like wallet signs the exact reviewed swap and position: both sent once and reconciled', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const wallet = await resetDevnetHarness(); await installDevnetWallet(page, wallet, { phantom: true });
  await author(page);
  await swapped(page);
  expect(await signRequests(page)).toBe(1); expect(await devnetControl({ action: 'sent' })).toBe(1);
  await panel(page).getByRole('button', { name: 'Prepare position with the received amount', exact: true }).click();
  await phase(page, 'CONSUMING');
  await panel(page).getByRole('button', { name: 'Accept position review', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Execute position', exact: true }).click();
  await phase(page, 'COMPLETED');
  expect(await signRequests(page)).toBe(2); expect(await devnetControl({ action: 'sent' })).toBe(2);
  await page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.locator('.execution-timeline .execution-step.execution-state-confirmed')).toHaveCount(2);
  expect(errors).toEqual([]);
});
