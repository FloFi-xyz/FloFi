// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Editor layout): Create, Simulate and Execute keep one coherent layout at 1920, 1440, 768 and 375 px, light and dark, English and
 * Portuguese — the Canvas frame in the centre with the Review DOCKED INSIDE it on Simulate, the FloFi Assistant as its own panel (beside from
 * 1281 px, below otherwise), the footer actions — and never:
 *   - a third column between the Canvas and the Assistant, or a Review outside the Canvas frame;
 *   - a horizontal page scroll, or a Review laid over a card;
 *   - a card shrunk to an unreadable width;
 *   - a card title broken inside a word ("Swa / p", "Bri / dg / e", "Tro / ca").
 * Geometry is asserted (not pixels); full-page screenshots are attached as evidence. Passive wallet on Arbitrum One: nothing is simulated against a
 * network, signed or sent.
 */
import type { Page, TestInfo } from '@playwright/test';
import { test, expect, installPassiveWallet, sendChatCommand } from './fixtures';
import { openBuilder, openEditorSection, type EditorSection } from './build-entry-navigation';

const VIEWPORTS = [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 375, height: 812 }] as const;
/** The smallest rendered card width the read-only graph may show (a Simulate card is 224 px at 1×). */
const READABLE_CARD_PX = 190;

/** Every word (whitespace-separated) of the matched elements whose glyphs sit on more than one line. */
async function wordsBrokenAcrossLines(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll(elements => elements.flatMap(element => {
    const broken: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      for (const match of text.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index ?? 0); range.setEnd(node, (match.index ?? 0) + match[0].length);
        const tops = new Set([...range.getClientRects()].filter(rect => rect.width > 0.5).map(rect => Math.round(rect.top)));
        if (tops.size > 1) broken.push(match[0]);
      }
    }
    return broken;
  }));
}
const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
type Box = { x: number; y: number; width: number; height: number };
const inside = (inner: Box, outer: Box) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 &&
  inner.y + inner.height <= outer.y + outer.height + 1;
const overlaps = (a: Box, b: Box) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;

async function chooseFromSettings(page: Page, control: RegExp) {
  await page.getByRole('button', { name: /^(Settings|Configurações)$/ }).first().click();
  await page.locator('.header-settings-menu').getByRole('switch', { name: control }).click();
  await page.keyboard.press('Escape');
}
async function usePortuguese(page: Page) {
  await chooseFromSettings(page, /^(Language|Idioma)$/);
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toMatch(/^pt/);
  await expect(page.getByRole('heading', { name: /^(Seu fluxo|Your Workflow)/ }).first()).toBeVisible();
}
async function useTheme(page: Page, theme: 'light' | 'dark') {
  if (await page.evaluate(() => document.documentElement.dataset.theme ?? 'light') !== theme) await chooseFromSettings(page, /^(Theme|Tema)$/);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

/** The shared geometry of every section: no horizontal scroll, the Assistant as its own panel, no card title broken inside a word. */
async function assertSection(page: Page, section: EditorSection, width: number, testInfo: TestInfo, label: string) {
  await openEditorSection(page, section);
  const cards = page.locator(section === 'Build' ? '.build-flow-surface .react-flow__node' : '.simulate-flow-surface .react-flow__node');
  await expect(cards).toHaveCount(2);
  await expect.poll(() => horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await wordsBrokenAcrossLines(page, '.composer-card-head .composer-action-title'), `${label}: a card title broke inside a word`).toEqual([]);
  if (section !== 'Build') {
    // One column inside <main> (the stage); the Assistant is the stage's sibling, beside it above 1280 px, below it otherwise.
    const grid = page.locator(section === 'Simulate' ? '.simulate-workspace-grid' : '.execute-workspace-grid');
    expect((await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns)).trim().split(/\s+/)).toHaveLength(1);
    const chat = (await page.locator('.stage-with-chat > .copilot').boundingBox())!, stage = (await page.locator('.stage-with-chat > .main').boundingBox())!;
    expect(chat.width).toBeGreaterThanOrEqual(Math.min(300, width - 32));
    if (width > 1280) expect(chat.x).toBeGreaterThanOrEqual(stage.x + stage.width - 1); else expect(chat.y).toBeGreaterThanOrEqual(stage.y + stage.height - 1);
    // Every card is fully inside the graph at a readable size.
    const surface = (await page.locator('.simulate-flow-surface').boundingBox())!;
    for (const box of await cards.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }))) {
      expect(inside(box, surface), `${label}: a card is cut by the graph's edge`).toBe(true);
      expect(box.width, `${label}: a card is too small to read`).toBeGreaterThanOrEqual(READABLE_CARD_PX);
    }
  }
  if (section === 'Simulate') {
    // The Review is docked INSIDE the Canvas frame (no third column, never a detached disclosure below the page) and never over a card.
    const frame = page.locator('.simulate-workspace .simulation-workflow-canvas');
    const dock = frame.locator('> .simulate-canvas-body > aside.canvas-review-dock');
    await expect(dock).toBeVisible();
    await expect(page.getByRole('complementary', { name: /^(Review|Revisão)$/ })).toHaveCount(1);
    await expect(page.locator('details.simulation-details')).toHaveCount(0);
    const dockBox = (await dock.boundingBox())!, frameBox = (await frame.boundingBox())!;
    expect(inside(dockBox, frameBox), `${label}: the Review is outside the Canvas frame`).toBe(true);
    for (const box of await cards.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })))
      expect(overlaps(box, dockBox), `${label}: the Review covers a card`).toBe(false);
    // Beside the graph only when both fit at a readable size; under it otherwise — never a narrow strip.
    expect(dockBox.width).toBeGreaterThanOrEqual(Math.min(360, frameBox.width - 2));
    // One page scroll: the dock has no scroll area of its own.
    expect(await dock.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: testInfo.outputPath(`${label}.png`), fullPage: true });
}

for (const language of ['EN', 'PT'] as const) for (const viewport of VIEWPORTS) {
  test(`Editor layout ${language} ${viewport.width}px light and dark: Review inside the Canvas frame, Assistant beside or below, readable cards, no broken titles`,
    async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      await page.setViewportSize(viewport);
      await installPassiveWallet(page, '0xa4b1');
      await openBuilder(page);
      await sendChatCommand(page, 'Swap 0.001 WETH for USDC on Arbitrum');
      await sendChatCommand(page, 'Bridge 2 USDC from Arbitrum to Base');
      await expect(page.locator('.build-flow-surface .react-flow__node')).toHaveCount(2);
      if (language === 'PT') await usePortuguese(page);
      for (const theme of ['light', 'dark'] as const) {
        await openEditorSection(page, 'Build');
        await useTheme(page, theme);
        for (const section of ['Build', 'Simulate', 'Execute'] as const)
          await assertSection(page, section, viewport.width, testInfo, `${section.toLowerCase()}-${language.toLowerCase()}-${viewport.width}-${theme}`);
      }
    });
}
