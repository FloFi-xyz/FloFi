// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, readWorkflowIr } from './fixtures';
import { installSupplyWallet } from './supply-fixtures';
import { configureCanvasAction, openCanvasSettings } from './composer-authoring-fixtures';
import type { Page } from '@playwright/test';

const card = (page: Page) => page.locator('.build-flow-surface .composer-card');
async function readWorkflow(page: Page) {
  const workflow = JSON.parse(await readWorkflowIr(page)) as { revision: number; nodes: { actionType: string; nodeId: string; inputs: { kind: string; value: { amount?: string } }[] }[] };
  return workflow.nodes.some(node => !node.actionType.startsWith('mock-')) ? workflow : null;
}
async function expectBlocked(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Workflow stages' });
  await expect(nav.getByRole('button', { name: 'Simulate', exact: true })).toBeDisabled();
  await expect(nav.getByRole('button', { name: 'Execute', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Simulate workflow', exact: true })).toBeDisabled();
  await nav.getByRole('button', { name: 'Simulate', exact: true }).dispatchEvent('click');
  await nav.getByRole('button', { name: 'Execute', exact: true }).dispatchEvent('click');
  await expect(nav.getByRole('button', { name: 'Build', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('main', { name: 'Simulation workspace', exact: true })).toHaveCount(0);
  await expect(page.getByRole('main', { name: 'Execution workspace', exact: true })).toHaveCount(0);
}

for (const action of ['swap', 'bridge'] as const) test(`${action} starts unconfigured at zero, blocks later stages and accepts only a validated positive amount`, async ({ page }) => {
  await installSupplyWallet(page); await page.goto('/app');
  await page.getByRole('button', { name: `Add ${action}`, exact: true }).click();
  const source = card(page).getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  await expect(source).toHaveValue('0');
  await expect(card(page).locator('.composer-destination-box .composer-amount-value')).toHaveText('—');
  await expect(card(page).locator('.composer-fiat-value')).toHaveText(['Test token · no USD value', 'Test token · no USD value']);
  await expect(card(page).locator('.composer-network-badge')).toHaveCount(2);
  expect(await card(page).innerText()).not.toMatch(/pending|unapplied|canonical|committed|draft/i);
  await expectBlocked(page);
  const initial = await readWorkflow(page);
  expect(initial).toBeNull();
  await expect(page.getByRole('form', { name: 'Edit cross-chain bridge', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Input amount (USDC)', exact: true })).toHaveCount(0);
  await openCanvasSettings(page);
  const amountForm = page.getByRole('form', { name: `Configure ${action === 'swap' ? 'Swap' : 'Bridge'}`, exact: true });
  await expect(amountForm.getByLabel('Source amount (USDC)', { exact: true })).toHaveValue('0');
  // BUILD-FIX-UX-001: test tokens have no USD value, so no USD-first mode is offered; display never edits the amount or invents a quote.
  await expect(card(page).getByRole('button', { name: 'Show USD value first', exact: true })).toHaveCount(0);
  await expect(card(page).locator('.composer-primary-fiat')).toHaveCount(0);
  await expect(source).toHaveValue('0');
  const destination = card(page).locator('.composer-destination-box');
  await expect(destination.locator('.composer-amount-value')).toHaveText('—');
  await expect(card(page).locator('.composer-network-badge').first()).toHaveAttribute('aria-label', 'Base Sepolia network');
  await expect(card(page).locator('.composer-network-badge').last()).toHaveAttribute('aria-label', action === 'swap' ? 'Base Sepolia network' : 'Arbitrum Sepolia network');
  await source.press('Enter');
  await expect(card(page).getByRole('alert')).toContainText('greater than 0');
  expect(await readWorkflow(page)).toEqual(initial);
  await source.fill(''); await expectBlocked(page);
  await source.fill('2.5');
  await expect(amountForm.getByLabel('Source amount (USDC)', { exact: true })).toHaveValue('2.5');
  // A typed amount is a draft: the workflow is unchanged and later stages stay blocked until Enter applies it.
  await expectBlocked(page);
  expect(await readWorkflow(page)).toEqual(initial);
  await source.press('Enter');
  if (action === 'swap') {
    const configured = await readWorkflow(page), node = configured!.nodes.find(item => !item.actionType.startsWith('mock-'))!;
    expect(node.actionType).toBe('asset.swap.exact-input');
    expect(node.inputs.find(field => field.kind === 'QUANTITY')?.value.amount).toBe('2500000');
  } else {
    // Router workflows use their existing dedicated diagnostics. Its editor and Simulate are both canonical readers.
    await expect(page.getByRole('form', { name: 'Edit cross-chain bridge', exact: true }).getByLabel('Cross-chain amount (USDC)', { exact: true })).toHaveValue('2.5');
  }
  await expect(source).toHaveValue('2.5');
  // Authoring enables stage inspection; this supply-only harness cannot simulate Swap/Router.
  await expect(page.getByRole('button', { name: 'Simulate workflow', exact: true })).toBeDisabled();
  await expect(page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Simulate', exact: true })).toBeEnabled();
  await expect(card(page)).toHaveClass(/active/);
  await page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Simulate', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Simulation workspace', exact: true })).toBeVisible();
  await expect(page.locator('.simulate-flow-surface .composer-amount')).toHaveText('2.5 USDC');
});

test('clearing an existing amount blocks both later stages without sending zero to the IR, and Cancel restores its value', async ({ page }) => {
  await installSupplyWallet(page); await page.goto('/app');
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  await configureCanvasAction(page, '2');
  const original = await readWorkflow(page);
  await openCanvasSettings(page);
  const source = card(page).getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  await source.fill('0'); await expectBlocked(page);
  await expect(page.getByRole('dialog', { name: 'Action settings', exact: true }).locator('.composer-editor-context')).toContainText('0 USDC');
  await expect(page.getByRole('dialog', { name: 'Action settings', exact: true }).getByLabel('Input amount (USDC)', { exact: true })).toHaveValue('0');
  expect(await readWorkflow(page)).toEqual(original);
  await source.press('Enter');
  await expect(card(page).getByRole('alert')).toContainText('greater than 0');
  expect(await readWorkflow(page)).toEqual(original);
  await card(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(source).toHaveValue('2');
  // Authoring enables stage inspection; this supply-only harness cannot simulate Swap/Router.
  await expect(page.getByRole('button', { name: 'Simulate workflow', exact: true })).toBeDisabled();
  await expect(page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Simulate', exact: true })).toBeEnabled();
  expect(await readWorkflow(page)).toEqual(original);
});

test('an unapplied amount can be corrected freely, and delete/history restores an incomplete card safely', async ({ page }) => {
  await installSupplyWallet(page); await page.goto('/app');
  await page.getByRole('button', { name: 'Add bridge', exact: true }).click();
  const source = card(page).getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  await source.fill('2'); await source.fill('0');
  await source.press('Enter');
  await expect(card(page).getByRole('alert')).toContainText('greater than 0');
  expect(await readWorkflow(page)).toBeNull();
  // Focus moving to the toolbar never applies an invalid draft; Undo then removes the incomplete card.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  expect(await readWorkflow(page)).toBeNull();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(source).toHaveValue('0');
  await expect(card(page).locator('.composer-amount-hint')).toHaveText('Press Enter to apply');
  await expectBlocked(page);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(source).toHaveValue('0'); await expectBlocked(page);
  expect(await readWorkflow(page)).toBeNull();
});


test('a new isolated Bridge cannot replace an already-configured workflow through amount acceptance', async ({ page }) => {
  await installSupplyWallet(page); await page.goto('/app');
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  await configureCanvasAction(page, '2');
  const original = await readWorkflow(page);
  await page.getByRole('button', { name: 'Add bridge', exact: true }).click();
  await expect(card(page)).toHaveCount(2);
  const bridge = card(page).last();
  await bridge.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).fill('3');
  await bridge.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).press('Enter');
  await expect(bridge.getByRole('alert')).toContainText('use a separate workflow');
  await expectBlocked(page);
  expect(await readWorkflow(page)).toEqual(original);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(card(page)).toHaveCount(1);
  await expect(card(page).getByRole('textbox', { name: 'Source amount (USDC)', exact: true })).toHaveValue('2');
  // Authoring enables stage inspection; this supply-only harness cannot simulate Swap/Router.
  await expect(page.getByRole('button', { name: 'Simulate workflow', exact: true })).toBeDisabled();
  await expect(page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Simulate', exact: true })).toBeEnabled();
  expect(await readWorkflow(page)).toEqual(original);
});
