// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (UX-01): the owner's chat bubbles keep short messages on one line ("Continuar", "Deu certo?", numbers)
 * and still wrap long sentences and unbroken wallet addresses inside the panel — at desktop and mobile widths, in light and dark themes, and at
 * the browser zoom levels where the bug showed ("Continua / r"). Measured on the rendered line boxes, never on text content.
 *
 * Root cause pinned here: the owner's row is shrink-to-fit, and the bubble's `max-width: calc(100% - 36px)` resolved against that row back to
 * exactly the bubble's own text width; any sub-pixel rounding then wrapped the last character (`overflow-wrap: anywhere`). Browser zoom is
 * emulated with the root `zoom` property, which reproduces the same fractional layout.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { openBuilder } from './build-entry-navigation';
import { selectSettingsTheme } from './settings-fixtures';

const SHORT = ['Continuar', 'Deu certo?', '123456789', '0.990877', '100 USDC'];
const LONG = ['Quero transferir 100 USDC da rede Base para a Arbitrum e depois trocar metade por ETH com slippage de meio por cento, por favor.',
  'I would like to bridge 100 USDC from Base to Arbitrum and then swap half of it for ETH with half a percent slippage, please.'];
const ADDRESSES = ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'];
const log = (page: Page) => page.locator('.chat-messages[role="log"]');

async function say(page: Page, text: string) {
  const sent = log(page).locator('.chat-row-you');
  const before = await sent.count();
  await expect(page.locator('#mock-prompt')).toBeEnabled();
  await page.locator('#mock-prompt').fill(text);
  await page.locator('.chat-form button[type=submit]').click();
  await expect(sent).toHaveCount(before + 1);
  await expect(page.locator('.chat-form button[type=submit]')).not.toHaveAttribute('aria-busy', 'true');
}
type Measured = { text: string; lines: number; overflow: boolean; bubbleRight: number; logRight: number };
/** Each owner bubble's rendered line count (distinct line boxes of its text) and whether anything leaves the bubble or the chat log. */
const measure = (page: Page) => log(page).evaluate((element): Measured[] => [...element.querySelectorAll<HTMLElement>('.chat-row-you')].map(row => {
  const bubble = row.querySelector<HTMLElement>('.message.you')!, text = bubble.querySelector('p')!, range = document.createRange();
  range.selectNodeContents(text);
  const tops = new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top)));
  const box = bubble.getBoundingClientRect(), area = element.getBoundingClientRect();
  return { text: text.textContent ?? '', lines: tops.size, overflow: text.scrollWidth > text.clientWidth + 1 || box.right > area.right + 0.5 || box.left < area.left - 0.5,
    bubbleRight: box.right, logRight: area.right };
}));
async function expectLayout(page: Page, context: string) {
  const rows = await measure(page);
  for (const text of [...SHORT, ...LONG, ...ADDRESSES]) expect(rows.some(row => row.text === text), `${context}: “${text}” is shown`).toBe(true);
  for (const row of rows) {
    expect(row.overflow, `${context}: “${row.text}” stays inside its bubble and the chat`).toBe(false);
    if (SHORT.includes(row.text)) expect(row.lines, `${context}: “${row.text}” is one line`).toBe(1);
    if (LONG.includes(row.text)) expect(row.lines, `${context}: a long sentence wraps`).toBeGreaterThan(1);
  }
}

test('short owner messages never wrap a character; long sentences and addresses wrap inside the panel', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openBuilder(page);
  for (const text of [...SHORT, ...LONG, ...ADDRESSES]) await say(page, text);
  for (const theme of ['Light', 'Dark'] as const) {
    // The real Settings control (desktop header), as the owner switches it.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await selectSettingsTheme(page, theme);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    for (const [width, height] of [[1440, 1000], [1280, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      for (const zoom of ['1', '0.9', '0.8', '1.1', '1.25']) {
        await page.evaluate(value => { document.documentElement.style.zoom = value; }, zoom);
        await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe(zoom);
        await expectLayout(page, `${width}px ${theme} zoom ${zoom}`);
      }
      await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    }
  }
  // The row and avatar layout is unchanged: the owner's avatar sits beside (right of) its own bubble, and nothing scrolls the page sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  const row = log(page).locator('.chat-row-you').first();
  const [bubble, avatar] = [await row.locator('.message.you').boundingBox(), await row.locator('.user-avatar').boundingBox()];
  expect(avatar!.x).toBeGreaterThanOrEqual(bubble!.x + bubble!.width - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
