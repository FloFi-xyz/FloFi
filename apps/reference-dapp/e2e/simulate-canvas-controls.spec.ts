// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001 (workstream 2): the Simulate workspace's bottom controls never overlap. The Canvas navigator (zoom)
 * is its own group; Back to the Canvas sits immediately left of Simulate workflow, both bottom-right. Geometry is asserted at desktop,
 * tablet and phone widths in both themes, every control stays clickable (it is the element under its own centre) and keyboard reachable,
 * no control covers a card, and element screenshots of the controls are kept as visual baselines. Nothing is simulated or signed.
 */
import { test, expect } from './fixtures';
import { selectSettingsTheme } from './settings-fixtures';
import { configureCanvasAction } from './composer-authoring-fixtures';
import { expectEditorSection, openBuilder, openEditorSection } from './build-entry-navigation';
import type { Page } from '@playwright/test';

type Box = { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
// Structural (not the accessible name), so the same locator holds after the language switch.
const graph = (page: Page) => page.locator('.simulation-workflow-canvas .simulate-flow-surface');
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test.beforeEach(async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.assign(window, { ethereum: { isMetaMask: true,
      async request({ method }: { method: string }) {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111'];
        if (method === 'eth_chainId') return '0x14a34';
        throw new Error(`Unexpected wallet request: ${method}`);
      }, on() {}, removeListener() {} } });
  });
  await openBuilder(page);
  await expect(page.locator('.build009-wallet-info')).toBeVisible();
  await page.getByRole('button', { name: 'Add supply', exact: true }).click();
  await configureCanvasAction(page, '1');
  // A multi-step workflow: its Simulate action carries the "Step 1 of 2" note (the reported overlap's real-world shape).
  if (testInfo.title.includes('multi-step')) { await page.getByRole('button', { name: 'Add supply', exact: true }).click(); await configureCanvasAction(page, '2'); }
});

const WIDTHS = [1440, 1280, 1100, 1024, 900, 820, 768, 600, 480, 390, 375, 320];
/** The controls' contract at one width (see the module comment); `context` names the width and every box on failure. */
function expectControls(m: Awaited<ReturnType<typeof measure>>, context: string) {
  const { surface, back, simulate, navigator } = m;
  expect(back && simulate && navigator, context).toBeTruthy();
  expect(back!.right, context).toBeLessThanOrEqual(simulate!.left);
  expect(simulate!.left - back!.right, context).toBeLessThanOrEqual(16);
  expect(Math.abs(back!.top - simulate!.top), context).toBeLessThan(2);
  expect(back!.left, context).toBeGreaterThanOrEqual(surface.left);
  expect(surface.right - simulate!.right, context).toBeGreaterThanOrEqual(8);
  expect(surface.right - simulate!.right, context).toBeLessThanOrEqual(32);
  expect(surface.bottom - simulate!.bottom, context).toBeGreaterThanOrEqual(8);
  expect(surface.bottom - simulate!.bottom, context).toBeLessThanOrEqual(32);
  for (const control of [back!, simulate!, ...m.notes]) expect(overlaps(navigator!, control), context).toBe(false);
  expect(navigator!.left, context).toBeGreaterThanOrEqual(surface.left); expect(navigator!.right, context).toBeLessThanOrEqual(surface.right);
  expect(navigator!.top, context).toBeGreaterThanOrEqual(surface.top); expect(navigator!.bottom, context).toBeLessThanOrEqual(surface.bottom);
  for (const card of m.cards) for (const control of [back!, simulate!, navigator!, ...m.notes]) expect(overlaps(card, control), context).toBe(false);
  expect(m.hits, context).toEqual({ back: true, simulate: true, fit: true, percentage: true, slider: true });
}

async function measure(page: Page) {
  // Hit tests need the controls on screen (on a phone the canvas sits below the fold).
  await graph(page).locator('.simulation-workspace-actions button').last().scrollIntoViewIfNeeded();
  return graph(page).evaluate(element => {
    const rect = (el: Element | null): Box | null => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    // Positional, so the same measurement holds in every language: Back is the actions' first button, the primary action its last.
    const actions = [...element.querySelectorAll('.simulation-workspace-actions button')];
    const back = element.querySelector('.simulation-workspace-actions .simulation-back'), simulate = actions.at(-1) ?? null, navigator = element.querySelector('.canvas-navigator');
    const hit = (el: Element | null) => { if (!el) return false; const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top === el || el.contains(top); };
    return { surface: rect(element)!, back: rect(back), simulate: rect(simulate), navigator: rect(navigator),
      cards: [...element.querySelectorAll('.composer-card')].map(card => rect(card)!),
      notes: [...element.querySelectorAll('.simulation-canvas-controls p')].map(note => rect(note)!),
      navigatorButtons: [...(navigator?.querySelectorAll('button, input') ?? [])].map(control => rect(control)!),
      hits: { back: hit(back), simulate: hit(simulate), fit: hit(navigator?.querySelector('.canvas-navigator-fit') ?? null),
        percentage: hit(navigator?.querySelector('.canvas-navigator-percentage') ?? null), slider: hit(navigator?.querySelector('.canvas-navigator-slider') ?? null) } };
  });
}

for (const theme of ['Light', 'Dark'] as const) test(`${theme}: Back sits immediately left of Simulate, bottom-right, and the navigator never overlaps either`, async ({ page }, testInfo) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await selectSettingsTheme(page, theme); await page.keyboard.press('Escape');
  await openEditorSection(page, 'Simulate'); await expectEditorSection(page, 'Simulate');
  const measurements: Record<string, Awaited<ReturnType<typeof measure>>> = {};
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(graph(page)).toHaveAttribute('data-viewport', 'fitted');
    await expect(graph(page).locator('.canvas-navigator')).toHaveAttribute('data-measured', 'true');
    await expect(graph(page).locator('.simulation-workspace-actions button')).toHaveText(['Back to the Canvas', 'Simulate workflow']);
    const m = await measure(page); measurements[width] = m;
    const context = JSON.stringify({ width, theme, m });
    expectControls(m, context);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), context).toBe(true);
  }
  // Keyboard: the navigator's controls, then Back, then Simulate, in visual order; Back still returns to the Canvas.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(graph(page)).toHaveAttribute('data-viewport', 'fitted');
  const percentage = graph(page).locator('.canvas-navigator-percentage');
  await percentage.focus(); await expect(percentage).toBeFocused();
  await page.keyboard.press('Tab'); await expect(graph(page).getByRole('button', { name: 'Back to the Canvas', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(graph(page).getByRole('button', { name: 'Simulate workflow', exact: true })).toBeFocused();
  // The navigator still works: Reset zoom to 100% and Fit workflow.
  await percentage.click(); await expect(percentage).toHaveText('100%');
  await graph(page).getByRole('button', { name: 'Fit workflow', exact: true }).click();
  // Visual baselines of the bottom controls (desktop, tablet, phone).
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(graph(page)).toHaveAttribute('data-viewport', 'fitted');
    await expect(graph(page).locator('.simulation-canvas-controls')).toHaveScreenshot(`simulate-controls-${theme.toLowerCase()}-${width}.png`, { maxDiffPixelRatio: 0.02 });
  }
  await testInfo.attach('simulate-controls-geometry', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  await page.getByRole('button', { name: 'Back to the Canvas', exact: true }).click();
  await expectEditorSection(page, 'Build');
});

test('multi-step: the "Step 1 of 2" note takes its own line, Back stays beside Simulate and nothing overlaps (PT and EN)', async ({ page }) => {
  await openEditorSection(page, 'Simulate'); await expectEditorSection(page, 'Simulate');
  const note = graph(page).locator('.canvas-sequence-note');
  await expect(note).toContainText('Step 1 of 2');
  for (const language of ['EN', 'PT'] as const) {
    if (language === 'PT') {
      // Settings' one Language switch: the longer Portuguese labels and note must keep the same layout.
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('switch', { name: /^(Language|Idioma)$/ }).click(); await page.keyboard.press('Escape');
      await expect(graph(page).locator('.simulation-workspace-actions button').first()).not.toHaveText('Back to the Canvas');
    }
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await expect(graph(page)).toHaveAttribute('data-viewport', 'fitted');
      await expect(graph(page).locator('.canvas-navigator')).toHaveAttribute('data-measured', 'true');
      const m = await measure(page);
      expectControls(m, JSON.stringify({ width, language, m }));
      expect(m.notes.length, String(width)).toBeGreaterThan(0);
      // The note sits above the buttons, right-aligned, never between Back and Simulate.
      for (const box of m.notes) expect(box.bottom, String(width)).toBeLessThanOrEqual(m.back!.top);
    }
  }
});
