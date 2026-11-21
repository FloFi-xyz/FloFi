// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, assertNoFinancialCanvasAction } from './fixtures';
import { readyForVisualCapture } from './mode-a-fixtures';
import { editorStep, editorSteps, expectEditorSection, openBuilder } from './build-entry-navigation';

test('Build shell visual baseline', async ({ page }) => {
  await openBuilder(page);
  await expect(page.getByRole('heading', { name: 'Your Workflow' })).toBeVisible();
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(0);
  await readyForVisualCapture(page);
  await expect(page).toHaveScreenshot('build.png', { fullPage: true });
});

// BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio, section 03): on an empty workflow Simulate and Execute are not yet eligible. Their steps stay in the
// Editor header, closed (aria-disabled, so the press is forced past Playwright's enabled check, as a touch or keyboard owner can still press it);
// pressing one says why and opens nothing (no simulation, Review or execution surface is shown, nothing is requested).
test('Simulate closed on an empty workflow visual baseline', async ({ page }) => {
  await openBuilder(page);
  await expect(editorStep(page, 'Simulate')).toHaveAttribute('aria-disabled', 'true');
  await editorStep(page, 'Simulate').click({ force: true });
  await expect(editorSteps(page).getByRole('status')).toHaveText('Add an action to your workflow first');
  await expectEditorSection(page, 'Build');
  await expect(page.locator('section.simulate-workspace, .review-workspace')).toHaveCount(0);
  await expect(page.getByText(/^(You are authorizing|Review before authorizing|Check your operation)$/)).toHaveCount(0);
  await readyForVisualCapture(page);
  await expect(page).toHaveScreenshot('simulate.png', { fullPage: true });
});

test('Execute closed on an empty workflow visual baseline', async ({ page }) => {
  await openBuilder(page);
  await expect(editorStep(page, 'Execute')).toHaveAttribute('aria-disabled', 'true');
  await editorStep(page, 'Execute').click({ force: true });
  await expect(editorSteps(page).getByRole('status')).toHaveText('Simulate the workflow first');
  await expectEditorSection(page, 'Build');
  await expect(page.getByRole('region', { name: 'Execution status', exact: true })).toHaveCount(0);
  await expect(page.locator('.execution-details, .execute-technical')).toHaveCount(0);
  await assertNoFinancialCanvasAction(page);
  await readyForVisualCapture(page);
  await expect(page).toHaveScreenshot('execute.png', { fullPage: true });
});
