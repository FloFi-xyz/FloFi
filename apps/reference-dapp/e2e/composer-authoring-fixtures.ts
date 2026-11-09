// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page } from '@playwright/test';

/** Explicitly configure fixtures that exercise already-authored workflows. Toolbar creation itself stays unconfigured. */
export async function configureCanvasAction(page: Page, amount: string) {
  const card = page.locator('.build-flow-surface .composer-card').last();
  const input = card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  await input.fill(amount);
  // P0 workflow execution: every action's amount, the lending cards' included, applies on Enter (no Review/Apply proposal).
  await input.press('Enter');
  await expect(card.getByRole('button', { name: 'Apply proposal', exact: true })).toHaveCount(0);
}

/** Opening settings is an explicit user action, independent of node selection. */
export async function openCanvasSettings(page: Page) {
  await page.locator('.build-flow-surface .composer-card.active').getByRole('button', { name: 'Action settings', exact: true }).click();
}

/** Configure a neutral Pool through the existing card Review/Apply controls. */
export async function configureCanvasPool(page: Page, usdc = '1', weth = '0.0001') {
  const card = page.locator('.build-flow-surface .composer-card').last();
  await card.getByRole('textbox', { name: 'First liquidity amount (USDC)', exact: true }).fill(usdc);
  await card.getByRole('textbox', { name: 'Second liquidity amount (WETH)', exact: true }).fill(weth);
  await card.getByRole('button', { name: 'Review', exact: true }).click();
  await card.getByRole('button', { name: 'Apply', exact: true }).click();
}
