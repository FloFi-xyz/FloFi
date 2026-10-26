// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { test, expect, applyPendingProposal, openSimulationDetails } from './fixtures';
import { seedCopilotPosition } from './copilot-solana-fixtures';
import { assertSimulationReviewBlocked } from './release-safety-fixtures';
import { chooseSolanaWallet, signRequests } from './jupiter-fixtures';
import { devnetControl, installDevnetWallet, resetDevnetHarness } from './solana-devnet-fixtures';

// PR B: context-aware Solana Devnet authoring in the Copilot, on committed replay answers (e2e/copilot/replay-v2.json) and the MOCKED Devnet
// loopback. The pool price and the wallet's FloFi positions are read by FloFi itself; every proposal needs Apply, and every financial step its own
// simulation, Review and wallet signature. Never DEVNET_EXECUTED.
if (process.env.FLOFI_COPILOT !== 'replay') throw new Error('copilot-solana.spec.ts requires FLOFI_COPILOT=replay');

const conversation = (page: Page) => page.getByRole('log', { name: 'Conversation' });
const copilotSays = (page: Page) => conversation(page).locator('.message.ai').last();
const proposal = (page: Page) => page.getByRole('button', { name: /^Review proposed change:/ });
const revision = (page: Page, value: number) => expect(page.locator(`.summary-bar[data-workflow-revision="${value}"]`)).toHaveCount(1);
const stage = (page: Page, name: string) => page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name, exact: true }).click();
const liquidityPanel = (page: Page) => page.getByRole('region', { name: 'Solana Devnet liquidity' });
async function ask(page: Page, text: string) {
  await page.locator('#mock-prompt').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('one sentence authors the swap and the position it funds; "yes" never applies; Apply gives the linked Canvas pair', async ({ page }) => {
  const wallet = await resetDevnetHarness(); await installDevnetWallet(page, wallet);
  await page.goto('/app');
  await ask(page, 'Swap 0.1 SOL to devUSDC on Solana Devnet and add liquidity with these tokens and at most 0.05 SOL in a 10% range');
  await expect(copilotSays(page)).toContainText('Interpreted as “swap 0.1 SOL to devUSDC on Solana Devnet slippage 100 bps then add liquidity all swapped devUSDC and 0.05 SOL from');
  await expect(copilotSays(page)).toContainText('Range ±10% around the current verified pool price');
  await expect(copilotSays(page)).toContainText('The swap and the position are two transactions, each simulated, reviewed and signed in your wallet.');
  await expect(proposal(page)).toHaveCount(1);
  await ask(page, 'yes');
  await expect(copilotSays(page)).toContainText('To use the proposal, choose Apply below it.');
  await revision(page, 0);
  await applyPendingProposal(page);
  await revision(page, 3);
  await expect(page.locator('.react-flow__node[data-id="node-002"]')).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="node-003"]')).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  expect(await signRequests(page)).toBe(0); expect(await devnetControl({ action: 'sent' })).toBe(0);
});

test('"these tokens" links a position to the applied swap; Flofi asks for the other maximum and takes a bare amount without the model', async ({ page }) => {
  const wallet = await resetDevnetHarness(); await installDevnetWallet(page, wallet);
  await page.goto('/app');
  await ask(page, 'swap 0.1 SOL to devUSDC on Solana Devnet slippage 50 bps');
  await applyPendingProposal(page);
  await revision(page, 1);
  await ask(page, 'add liquidity with these tokens in a 10% range');
  await expect(copilotSays(page)).toContainText('How much SOL at most should the position use together with the swapped devUSDC?');
  await ask(page, '0.05');
  await expect(copilotSays(page)).toContainText('Interpreted as “add liquidity all devUSDC from node-002 and 0.05 SOL from');
  await applyPendingProposal(page);
  await revision(page, 3);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await ask(page, 'no');
  await expect(copilotSays(page)).toContainText('OK, Flofi dropped that request. Nothing changed.');
  await revision(page, 3);
});

test('chat selects the second registered position for partial removal and exit; MOCKED Review stays blocked', async ({ page }) => {
  const wallet = await resetDevnetHarness();
  await seedCopilotPosition(wallet);
  const selected = await seedCopilotPosition(wallet);
  await installDevnetWallet(page, wallet);
  await page.goto('/app');
  await ask(page, 'Add liquidity 0.01 SOL and 0.30 devUSDC ticks -39104 to -36992 on Solana Devnet');
  await applyPendingProposal(page);
  await page.getByRole('button', { name: 'Simulate workflow' }).click();
  await openSimulationDetails(page);
  await chooseSolanaWallet(liquidityPanel(page));
  await expect(liquidityPanel(page).getByRole('region', { name: 'Your Flofi positions' })).toContainText(selected);
  await stage(page, 'Build');
  await ask(page, 'Remove 25% of my liquidity');
  await expect(copilotSays(page)).toContainText('Which position do you mean?');
  await ask(page, `Position ${selected.slice(0, 4)}…${selected.slice(-4)} · ticks -39104 to -36992`);
  await expect(copilotSays(page)).toContainText('Remove 25% of the liquidity of your Flofi position');
  await applyPendingProposal(page);
  await stage(page, 'Simulate');
  await openSimulationDetails(page);
  await expect(liquidityPanel(page).locator('#orca-operation')).toHaveValue('DECREASE_PARTIAL');
  await expect(liquidityPanel(page).getByLabel('Portion to remove (bps)')).toHaveValue('2500');
  await liquidityPanel(page).getByRole('button', { name: 'Simulate removal' }).click();
  await expect(liquidityPanel(page).getByRole('term').filter({ hasText: /^Expected principal returned$/ })).toBeVisible();
  await expect(liquidityPanel(page).getByRole('definition').filter({ hasText: selected })).toBeVisible();
  await expect(page.locator('.canvas-primary-action').getByRole('button', { name: 'Authorize in wallet', exact: true })).toBeDisabled();
  await stage(page, 'Build');
  await ask(page, 'Close my position');
  await expect(copilotSays(page)).toContainText('Which position do you mean?');
  await ask(page, `Position ${selected.slice(0, 4)}…${selected.slice(-4)} · ticks -39104 to -36992`);
  await applyPendingProposal(page);
  await stage(page, 'Simulate');
  await openSimulationDetails(page);
  await expect(liquidityPanel(page).locator('#orca-operation')).toHaveValue('EXIT');
  await liquidityPanel(page).getByRole('button', { name: 'Simulate removal' }).click();
  await expect(liquidityPanel(page).getByRole('definition').filter({ hasText: selected })).toBeVisible();
  await assertSimulationReviewBlocked(page, () => signRequests(page));
  expect(await signRequests(page)).toBe(0);
  // Only the two explicitly seeded fixture transactions exist; chat never signs or sends.
  expect(await devnetControl({ action: 'sent' })).toBe(2);
});
