// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, assertNoFinancialCanvasAction } from './fixtures';
import { readyForVisualCapture } from './mode-a-fixtures';
import { openBuilder } from './build-entry-navigation';

test('Build shell visual baseline', async ({ page }) => {
  await openBuilder(page);
  await expect(page.getByRole('heading', { name: 'Your Workflow' })).toBeVisible();
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(0);
  await readyForVisualCapture(page);
  await expect(page).toHaveScreenshot('build.png', { fullPage: true });
});

test('Simulate mocked-chain empty visual baseline', async ({ page }) => {
  await openBuilder(page);
  await page.getByRole('button', { name: 'Simulate', exact: true }).click();
  // BUILD-FLOFI-CHAT-E2E-FIX-002: the chat-first workspace keeps the summary (and its embedded Review) in an optional, collapsed details surface.
  await expect(page.locator('.simulation-details > summary')).toBeVisible();
  await expect(page.locator('.review-authorization-details')).toBeHidden();
  await expect(page.locator('.review-workspace')).toHaveCount(0);
  await readyForVisualCapture(page);
  await expect(page).toHaveScreenshot('simulate.png', { fullPage: true });
});

test('Execute unavailable visual baseline', async ({ page }) => {
  await openBuilder(page);
  await page.getByRole('button', { name: 'Execute', exact: true }).click();
  // BUILD0-UX-001: the status panel replaces the collapsed execution details; no technical disclosure on Execute.
  await expect(page.getByRole('region', { name: 'Execution status', exact: true })).toBeVisible();
  await expect(page.locator('.execution-details, .execute-technical')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Execution Summary' })).toBeHidden();
  await assertNoFinancialCanvasAction(page);
  await readyForVisualCapture(page);
  await expect(page).toHaveScreenshot('execute.png', { fullPage: true });
});
