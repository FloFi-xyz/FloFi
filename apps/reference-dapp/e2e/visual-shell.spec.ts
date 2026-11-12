// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, assertNoFinancialCanvasAction } from './fixtures';
import { readyForVisualCapture } from './mode-a-fixtures';
import { openBuilder, openEditorSection, openSimulationReviewPanel } from './build-entry-navigation';

test('Build shell visual baseline', async ({ page }) => {
  await openBuilder(page);
  await expect(page.getByRole('heading', { name: 'Your Workflow' })).toBeVisible();
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(0);
  await readyForVisualCapture(page);
  await expect(page).toHaveScreenshot('build.png', { fullPage: true });
});

test('Simulate mocked-chain empty visual baseline', async ({ page }) => {
  await openBuilder(page);
  await openEditorSection(page, 'Simulate');
  // BUILD-FLOFI-CHAT-E2E-FIX-002 / P0 approved UX (board 06): the chat-first workspace shows the Review panel beside the canvas (1440 px) and keeps
  // the summary (and its embedded Review) in the panel's collapsed Technical details.
  await openSimulationReviewPanel(page);
  await expect(page.locator('.review-panel-technical > summary')).toBeVisible();
  await expect(page.locator('.review-authorization-details')).toBeHidden();
  await expect(page.locator('.review-workspace')).toHaveCount(0);
  await readyForVisualCapture(page);
  await expect(page).toHaveScreenshot('simulate.png', { fullPage: true });
});

test('Execute unavailable visual baseline', async ({ page }) => {
  await openBuilder(page);
  await openEditorSection(page, 'Execute');
  // BUILD0-UX-001: the status panel replaces the collapsed execution details; no technical disclosure on Execute.
  await expect(page.getByRole('region', { name: 'Execution status', exact: true })).toBeVisible();
  await expect(page.locator('.execution-details, .execute-technical')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Execution Summary' })).toBeHidden();
  await assertNoFinancialCanvasAction(page);
  await readyForVisualCapture(page);
  await expect(page).toHaveScreenshot('execute.png', { fullPage: true });
});
