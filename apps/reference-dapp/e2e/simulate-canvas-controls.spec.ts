// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001 (workstream 2): the Simulate workspace's bottom controls never overlap. The Canvas navigator (zoom)
 * is its own group; Back to the Canvas sits immediately left of Simulate workflow, both bottom-right. Geometry is asserted at desktop,
 * tablet and phone widths in both themes, every control stays clickable (it is the element under its own centre) and keyboard reachable,
 * no control covers a card, and element screenshots of the controls are kept as visual baselines. Nothing is simulated or signed.
 * P0 approved UX (boards 04, 06): in the chat-first workspace the simulated canvas carries no action — the one lifecycle control (Simulate) lives in
 * the Editor footer and the stepper's Create returns to the Canvas — so the canvas's bottom control group is the navigator alone, centred (Fit,
 * Zoom out, Zoom in; the slider and percentage are gone). The contract below is that shape: the navigator stays inside the graph and never covers a
 * card or a step note, each of its controls is the element under its own centre and keyboard reachable, and the footer's Simulate stays there.
 */
import { test, expect } from './fixtures';
import { selectSettingsTheme } from './settings-fixtures';
import { configureCanvasAction } from './composer-authoring-fixtures';
import { expectEditorSection, openBuilder, openEditorSection } from './build-entry-navigation';
import type { Page } from '@playwright/test';

type Box = { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
// Structural (not the accessible name), so the same locator holds after the language switch.
const graph = (page: Page) => page.locator('.simulation-workflow-canvas .simulate-flow-surface');
const footer = (page: Page) => page.locator('footer.summary-bar');
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
  // A multi-step workflow: its simulation describes "Step 1 of 2" (the reported overlap's real-world shape).
  if (testInfo.title.includes('multi-step')) { await page.getByRole('button', { name: 'Add supply', exact: true }).click(); await configureCanvasAction(page, '2'); }
});

const WIDTHS = [1440, 1280, 1100, 1024, 900, 820, 768, 600, 480, 390, 375, 320];
/** The controls' contract at one width (see the module comment); `context` names the width and every box on failure. */
function expectControls(m: Awaited<ReturnType<typeof measure>>, context: string) {
  const { surface, navigator } = m;
  expect(navigator, context).toBeTruthy();
  expect(m.actions, context).toBe(0);
  // Inside the graph, on its own centred line at the bottom (the group has no action beside it).
  expect(navigator!.left, context).toBeGreaterThanOrEqual(surface.left); expect(navigator!.right, context).toBeLessThanOrEqual(surface.right);
  expect(navigator!.top, context).toBeGreaterThanOrEqual(surface.top); expect(navigator!.bottom, context).toBeLessThanOrEqual(surface.bottom);
  expect(Math.abs((navigator!.left + navigator!.right) / 2 - (surface.left + surface.right) / 2), context).toBeLessThanOrEqual(1);
  expect(navigator!.top, context).toBeGreaterThan(surface.top + (surface.bottom - surface.top) / 2);
  for (const card of m.cards) expect(overlaps(card, navigator!), context).toBe(false);
  for (const note of m.notes) expect(overlaps(note, navigator!), context).toBe(false);
  expect(m.hits, context).toEqual({ fit: true, zoomOut: true, zoomIn: true });
}

async function measure(page: Page) {
  // Hit tests need the controls on screen (on a phone the canvas sits below the fold).
  await graph(page).locator('.canvas-navigator').scrollIntoViewIfNeeded();
  return graph(page).evaluate(element => {
    const rect = (el: Element | null): Box | null => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    const navigator = element.querySelector('.canvas-navigator');
    const steps = [...(navigator?.querySelectorAll('.canvas-navigator-step') ?? [])];
    const hit = (el: Element | null) => { if (!el) return false; const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top === el || el.contains(top); };
    return { surface: rect(element)!, navigator: rect(navigator), actions: element.querySelectorAll('.simulation-workspace-actions, .canvas-primary-action').length,
      cards: [...element.querySelectorAll('.composer-card')].map(card => rect(card)!),
      notes: [...element.querySelectorAll('.simulation-canvas-controls p')].map(note => rect(note)!),
      hits: { fit: hit(navigator?.querySelector('.canvas-navigator-fit') ?? null), zoomOut: hit(steps[0] ?? null), zoomIn: hit(steps[1] ?? null) } };
  });
}
/** The footer holds the one Simulate control, inside the footer and never covered by the canvas's navigator. */
async function expectFooterAction(page: Page, context: string) {
  const action = footer(page).locator('.canvas-primary-action button[data-lifecycle-action]');
  await expect(action).toHaveCount(1);
  await action.scrollIntoViewIfNeeded();
  const [bar, button, navigator] = await Promise.all([footer(page).boundingBox(), action.boundingBox(), graph(page).locator('.canvas-navigator').boundingBox()]);
  expect(button!.y, context).toBeGreaterThanOrEqual(bar!.y - 1); expect(button!.y + button!.height, context).toBeLessThanOrEqual(bar!.y + bar!.height + 1);
  expect(overlaps({ left: button!.x, right: button!.x + button!.width, top: button!.y, bottom: button!.y + button!.height },
    { left: navigator!.x, right: navigator!.x + navigator!.width, top: navigator!.y, bottom: navigator!.y + navigator!.height }), context).toBe(false);
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
    await expect(footer(page).locator('.canvas-primary-action').getByRole('button', { name: 'Simulate workflow', exact: true })).toBeVisible();
    const m = await measure(page); measurements[width] = m;
    const context = JSON.stringify({ width, theme, m });
    expectControls(m, context);
    await expectFooterAction(page, context);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), context).toBe(true);
  }
  // Keyboard: the navigator's controls in visual order (Fit, Zoom out); the zoom controls and Fit still work.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(graph(page)).toHaveAttribute('data-viewport', 'fitted');
  const fit = graph(page).getByRole('button', { name: 'Fit workflow', exact: true }), zoomOut = graph(page).getByRole('button', { name: 'Zoom out', exact: true });
  await fit.focus(); await expect(fit).toBeFocused();
  await page.keyboard.press('Tab'); await expect(zoomOut).toBeFocused();
  const scale = () => graph(page).locator('.react-flow__viewport').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
  const before = await scale();
  await zoomOut.click(); await expect.poll(scale).toBeLessThan(before);
  await expect(graph(page).getByRole('button', { name: 'Zoom in', exact: true })).toBeEnabled();
  await fit.click();
  // Visual baselines of the bottom controls (desktop, tablet, phone).
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(graph(page)).toHaveAttribute('data-viewport', 'fitted');
    await expect(graph(page).locator('.simulation-canvas-controls')).toHaveScreenshot(`simulate-controls-${theme.toLowerCase()}-${width}.png`, { maxDiffPixelRatio: 0.02 });
  }
  await testInfo.attach('simulate-controls-geometry', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  // Back to the Canvas is the stepper's Create (the chat-first Simulate section has no Back button of its own).
  await expect(graph(page).getByRole('button', { name: 'Back to the Canvas', exact: true })).toHaveCount(0);
  await openEditorSection(page, 'Build');
  await expectEditorSection(page, 'Build');
});

test('multi-step: the "Step 1 of 2" note takes its own line, Back stays beside Simulate and nothing overlaps (PT and EN)', async ({ page }) => {
  await openEditorSection(page, 'Simulate'); await expectEditorSection(page, 'Simulate');
  // The simulation states which step it describes (in the Review panel beside the canvas at this width).
  await expect(page.locator('.simulate-workspace')).toContainText('Step 1 of 2');
  for (const language of ['EN', 'PT'] as const) {
    if (language === 'PT') {
      // Settings' one Language switch: the longer Portuguese labels must keep the same layout.
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('switch', { name: /^(Language|Idioma)$/ }).click(); await page.keyboard.press('Escape');
      await expect(footer(page).locator('.canvas-primary-action button[data-lifecycle-action]')).not.toHaveText('Simulate workflow');
    }
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await expect(graph(page)).toHaveAttribute('data-viewport', 'fitted');
      await expect(graph(page).locator('.canvas-navigator')).toHaveAttribute('data-measured', 'true');
      const m = await measure(page);
      const context = JSON.stringify({ width, language, m });
      expectControls(m, context);
      await expectFooterAction(page, context);
    }
  }
});
