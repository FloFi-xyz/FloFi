// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from './fixtures';
import { installSupplyWallet } from './supply-fixtures';
import { openBuilder, openDashboard, openEditorSection, useToolbarRail } from './build-entry-navigation';

test('workflow naming confirms inline, cancels without clearing selection and survives navigation', async ({ page }) => {
  await installSupplyWallet(page);
  await openBuilder(page);
  const canvas = page.getByRole('region', { name: 'Workflow canvas', exact: true });
  const rename = canvas.getByRole('button', { name: /^Rename workflow: / });
  await expect(canvas.getByRole('heading', { name: 'Rename workflow: Your Workflow', exact: true })).toBeVisible();
  await rename.click();
  const input = canvas.getByRole('textbox', { name: 'Workflow name', exact: true });
  await expect(input).toBeFocused();
  await input.fill('  ETH Carry Strategy  ');
  await input.press('Enter');
  await expect(canvas.getByRole('heading', { name: 'Rename workflow: ETH Carry Strategy', exact: true })).toBeVisible();
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '0');
  await page.getByRole('button', { name: 'Add supply', exact: true }).click();
  await expect(canvas.locator('.flow-card.active')).toHaveCount(1);
  await rename.click();
  await input.fill('Cancelled name');
  await input.press('Escape');
  await expect(canvas.getByRole('heading', { name: 'Rename workflow: ETH Carry Strategy', exact: true })).toBeVisible();
  await expect(canvas.locator('.flow-card.active')).toHaveCount(1);
  await expect(page.getByRole('form', { name: 'Edit Supply' })).toBeVisible();
  await rename.click();
  await input.fill('   ');
  await input.press('Enter');
  await expect(canvas.getByRole('heading', { name: 'Rename workflow: ETH Carry Strategy', exact: true })).toBeVisible();
  await rename.click();
  await input.fill('ETH Income Strategy');
  await page.getByRole('heading', { name: 'FloFi Assistant', exact: true }).click();
  await expect(canvas.getByRole('heading', { name: 'Rename workflow: ETH Income Strategy', exact: true })).toBeVisible();
  await openDashboard(page);
  await openEditorSection(page, 'Build');
  await expect(canvas.getByRole('heading', { name: 'Rename workflow: ETH Income Strategy', exact: true })).toBeVisible();
  await expect(canvas.locator('.flow-card.active')).toHaveCount(1);
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
  await page.setViewportSize({ width: 390, height: 844 });
  await rename.click();
  await input.fill('A'.repeat(80));
  await input.press('Enter');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('Privacy is a disabled affordance in both toolbar positions and never authors an action', async ({ page }) => {
  await installSupplyWallet(page);
  await openBuilder(page);
  const toolbar = page.getByRole('toolbar', { name: 'Canvas tools', exact: true });
  for (const floating of [false, true]) {
    if (floating) await useToolbarRail(page);
    // P0 approved UX (board 04): Privacy is not offered until it is available — no disabled placeholder in either toolbar position.
    await expect(toolbar.getByRole('button', { name: 'Add withdraw', exact: true })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Privacy', exact: true })).toHaveCount(0);
    await expect(page.locator('.flow-card')).toHaveCount(0);
    await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '0');
  }
});

test('Copilot keeps existing commands and proposal review while removing internal presentation', async ({ page }) => {
  await installSupplyWallet(page);
  await openBuilder(page);
  const assistant = page.getByRole('complementary', { name: 'FloFi Assistant' });
  const prompt = assistant.getByLabel('Describe your flow', { exact: true });
  const send = assistant.getByRole('button', { name: 'Send message', exact: true });
  await expect(assistant.getByRole('heading', { name: 'FloFi Assistant', exact: true })).toBeVisible();
  await expect(assistant.locator('.assistant-title img[src="/brand/flofi-symbol-light.svg"]')).toHaveCount(1);
  expect(await assistant.innerText()).not.toMatch(/GRYLOO|mock|demo|local command|no model|ticks/i);
  await prompt.fill('explain');
  await send.click();
  await expect(assistant).toContainText('Your flow has no actions yet.');
  await prompt.fill('unsupported request');
  await send.click();
  await expect(assistant).toContainText('This request could not be understood.');
  expect(await assistant.innerText()).not.toMatch(/GRYLOO|mock|local command|no model|ticks/i);
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '0');
  await prompt.fill('swap 2 USDC to WETH on Base slippage 50 bps');
  await send.click();
  await expect(page.getByRole('button', { name: 'Apply proposal', exact: true })).toBeVisible();
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '0');
  await page.getByRole('button', { name: 'Apply proposal', exact: true }).click();
  await expect(page.locator('.flow-card')).toHaveCount(1);
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
  await prompt.fill('explain');
  await send.click();
  await expect(assistant.locator('.message.system').last()).toContainText('2 USDC');
  expect(await assistant.locator('.message.system').last().innerText()).not.toMatch(/mock|sample units/i);
});
