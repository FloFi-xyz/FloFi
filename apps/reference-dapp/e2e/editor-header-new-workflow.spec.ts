// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: the Editor header shows the default name whole ("Meu fluxo" / "Your Workflow", never "Meu fl…") at desktop and
 * phone widths, light and dark, and offers a New workflow icon button beside the rename control. The button (mouse or keyboard) empties the
 * Canvas, clears the pending proposal and the workflow's conversation, restores the default name and stays in Create; the wallet connection,
 * preferences and language stay. Nothing is simulated, signed or sent.
 */
import type { Page } from '@playwright/test';
import { test, expect, sendChatCommand } from './fixtures';
import { openBuilder } from './build-entry-navigation';

const nameText = (page: Page) => page.locator('.build-canvas-head .workflow-name-text');
/** The rendered name is not cut: its text fits its own box (an ellipsis means scrollWidth > clientWidth). */
const nameFits = (page: Page) => nameText(page).evaluate(element => element.scrollWidth <= element.clientWidth);
async function chooseFromSettings(page: Page, control: RegExp) {
  await page.getByRole('button', { name: /^(Settings|Configurações)$/ }).first().click();
  await page.locator('.header-settings-menu').getByRole('switch', { name: control }).click();
  await page.keyboard.press('Escape');
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const) {
  test(`the default name is whole in English and Portuguese, light and dark, at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openBuilder(page);
    await expect(nameText(page)).toHaveText('Your Workflow');
    expect(await nameFits(page)).toBe(true);
    await chooseFromSettings(page, /^(Language|Idioma)$/);
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toMatch(/^pt/);
    await expect(nameText(page)).toHaveText('Meu fluxo');
    expect(await nameFits(page)).toBe(true);
    for (const theme of ['dark', 'light'] as const) {
      if (await page.evaluate(() => document.documentElement.dataset.theme ?? 'light') !== theme) await chooseFromSettings(page, /^(Theme|Tema)$/);
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      expect(await nameFits(page)).toBe(true);
      await expect(page.locator('.build-canvas-head .canvas-name').getByRole('button', { name: 'Novo fluxo', exact: true })).toBeVisible();
    }
    // The rename pencil stays; the header never overflows the page.
    await expect(page.getByRole('button', { name: /^Renomear fluxo: Meu fluxo$/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}

test('New workflow (keyboard and mouse) empties the Canvas, the proposal and the conversation and keeps Create, language and theme', async ({ page }) => {
  await openBuilder(page);
  const toolbar = page.getByRole('toolbar', { name: 'Canvas tools' });
  await toolbar.getByRole('button', { name: 'Add swap', exact: true }).click();
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(1);
  await page.getByRole('button', { name: /^Rename workflow:/ }).click();
  await page.getByRole('textbox', { name: 'Workflow name' }).fill('Weekly rebalance');
  await page.keyboard.press('Enter');
  await expect(nameText(page)).toHaveText('Weekly rebalance');
  await sendChatCommand(page, 'swap 1 USDC to WETH on Base');
  await expect(page.getByRole('log', { name: 'Conversation' }).locator('.message')).not.toHaveCount(1);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light');

  // Keyboard: Tab from the rename control reaches New workflow; Enter activates it.
  await page.getByRole('button', { name: /^Rename workflow:/ }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'New workflow', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(0);
  await expect(page.locator('.build-canvas-head .revision')).toHaveText('0 steps');
  await expect(nameText(page)).toHaveText('Your Workflow');
  await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(0);
  await expect(page.getByRole('log', { name: 'Conversation' }).locator('.message')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.dataset.theme ?? 'light')).toBe(theme);
  await expect(page.getByRole('button', { name: 'New workflow', exact: true })).toBeVisible();

  // Mouse, on an already empty workflow: still an empty draft, nothing else moves.
  await toolbar.getByRole('button', { name: 'Add swap', exact: true }).click();
  await page.getByRole('button', { name: 'New workflow', exact: true }).click();
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(0);
});
