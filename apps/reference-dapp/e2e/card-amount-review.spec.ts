// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FIX-UX-001: an ordinary card amount applies to the editable workflow on Enter (or when the owner leaves the step) — no "Review
 * amount" / "Apply amount" ceremony. Validation is unchanged: an invalid amount is refused inline and never changes the workflow. Applying a
 * draft is not authorization: Simulate, Review/Strategy Manifest acceptance and the wallet signature remain separate, later steps.
 */
import { test, expect } from './fixtures';
import { installSupplyWallet } from './supply-fixtures';
import { configureCanvasAction, openCanvasSettings } from './composer-authoring-fixtures';
import { openBuilder } from './build-entry-navigation';

for (const action of ['swap', 'bridge'] as const) test(`${action} applies a valid amount on Enter, refuses an invalid one inline and keeps one canonical value`, async ({ page }) => {
  await installSupplyWallet(page); await openBuilder(page);
  await page.getByRole('button', { name: `Add ${action}`, exact: true }).click();
  const card = page.locator('.build-flow-surface .composer-card');
  const source = card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  const revision = page.locator('.summary-bar');
  const settings = page.getByRole('dialog', { name: 'Action settings', exact: true }).getByRole('button', { name: 'Action settings', exact: true });
  const stages = page.getByRole('navigation', { name: 'Workflow stages' });
  const hint = card.locator('.composer-amount-hint');
  await expect(hint).toHaveText('Press Enter to apply');
  await expect(page.getByRole('button', { name: /^(Review|Apply) amount$/ })).toHaveCount(0);
  await source.press('Enter');
  await expect(card.getByRole('alert')).toContainText('greater than 0');
  await expect(card.getByRole('alert')).toBeVisible();
  await expect(source).toHaveAttribute('aria-invalid', 'true');
  await expect(revision).toHaveAttribute('data-workflow-revision', '0');
  await source.fill('2.5');
  await expect(card.getByRole('alert')).toHaveCount(0);
  // A draft is not the workflow: nothing is simulated or executable from it.
  await expect(revision).toHaveAttribute('data-workflow-revision', '0');
  await expect(stages.getByRole('button', { name: 'Simulate', exact: true })).toBeDisabled();
  await expect(stages.getByRole('button', { name: 'Execute', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Workflow edit review', exact: true })).toHaveCount(0);
  await openCanvasSettings(page);
  await expect(page.getByRole('button', { name: /^(Review|Apply) amount$/ })).toHaveCount(0);
  await settings.click();
  await source.fill('3');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const hintBox = (await hint.boundingBox())!, cardBox = (await card.boundingBox())!;
    expect(hintBox.x).toBeGreaterThanOrEqual(cardBox.x); expect(hintBox.x + hintBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // Enter twice: applied exactly once.
  await source.press('Enter'); await source.press('Enter');
  await expect(revision).toHaveAttribute('data-workflow-revision', '1');
  await expect(source).toHaveValue('3'); await expect(hint).toHaveCount(0);
  await expect(settings).toHaveAttribute('aria-expanded', 'false');
  // Escape (and Cancel) return an unapplied edit to the applied value.
  await source.fill('7'); await expect(hint).toBeVisible();
  await source.press('Escape');
  await expect(source).toHaveValue('3'); await expect(revision).toHaveAttribute('data-workflow-revision', '1');
  await source.fill('8'); await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(source).toHaveValue('3'); await expect(revision).toHaveAttribute('data-workflow-revision', '1');
  // Stage inspection does not grant simulation capability in this supply-only fixture.
  await expect(page.getByRole('button', { name: 'Simulate workflow', exact: true })).toBeDisabled();
  await expect(stages.getByRole('button', { name: 'Simulate', exact: true })).toBeEnabled();
  await openCanvasSettings(page);
  await expect(page.getByRole('dialog', { name: 'Action settings', exact: true }).getByLabel(action === 'swap' ? 'Input amount (USDC)' : 'Cross-chain amount (USDC)', { exact: true })).toHaveValue('3');
  await settings.click();
  await stages.getByRole('button', { name: 'Simulate', exact: true }).click();
  await expect(page.locator('.simulate-flow-surface .composer-amount')).toHaveText('3 USDC');
  expect(await page.evaluate(() => (window as unknown as { supplyWalletRequests: { method: string }[] }).supplyWalletRequests.filter(request => /sign|send/i.test(request.method)))).toEqual([]);
});

test('an applied amount is scoped to its own card; leaving a step applies only that step, and an invalid draft changes nothing', async ({ page }) => {
  await installSupplyWallet(page); await openBuilder(page);
  const cards = page.locator('.build-flow-surface .composer-card');
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  await configureCanvasAction(page, '2');
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  await configureCanvasAction(page, '3'); await expect(cards).toHaveCount(2);
  const first = cards.nth(0), second = cards.nth(1), revision = page.locator('.summary-bar');
  const amount = (card: typeof first) => card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  await expect(revision).toHaveAttribute('data-workflow-revision', '2');
  await amount(first).fill('4');
  await expect(revision).toHaveAttribute('data-workflow-revision', '2');
  // Moving to the other step applies this step's valid draft (pointer and touch users need no Enter key) — and only this one.
  await amount(second).click();
  await expect(revision).toHaveAttribute('data-workflow-revision', '3');
  await expect(amount(first)).toHaveValue('4'); await expect(amount(second)).toHaveValue('3');
  await amount(second).fill('5'); await amount(second).press('Enter');
  await expect(revision).toHaveAttribute('data-workflow-revision', '4');
  await expect(amount(first)).toHaveValue('4'); await expect(amount(second)).toHaveValue('5');
  // An invalid draft is refused when the owner leaves the step: shown inline, the workflow keeps the applied amounts.
  await amount(first).fill('0'); await amount(second).click();
  await expect(first.getByRole('alert')).toContainText('greater than 0');
  await expect(revision).toHaveAttribute('data-workflow-revision', '4');
  await expect(page.getByRole('button', { name: 'Simulate workflow', exact: true })).toBeDisabled();
  await amount(first).click(); await amount(first).press('Escape');
  await expect(amount(first)).toHaveValue('4'); await expect(revision).toHaveAttribute('data-workflow-revision', '4');
  // Stage inspection does not grant simulation capability in this supply-only fixture.
  await expect(page.getByRole('button', { name: 'Simulate workflow', exact: true })).toBeDisabled();
  await expect(page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Simulate', exact: true })).toBeEnabled();
});
