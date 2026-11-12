// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from './fixtures';
import { installSupplyWallet, SUPPLY_OWNER } from './supply-fixtures';
import { configureCanvasAction } from './composer-authoring-fixtures';
import { expectEditorSection, openBuilder, openEditorSection, useDockedToolbar } from './build-entry-navigation';

// BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): the Canvas takes the space, the FloFi panel is compact, and the Canvas lifecycle control
// (Simulate) moved from the Canvas corner to the Editor footer, rendered once with its own handler; Simulate and Execute open from the stepper.
test('the Build CTA lives once in the Editor footer, beside the real notices, and the Canvas takes the space', async ({ page }) => {
  await installSupplyWallet(page);
  await openBuilder(page);
  // Supply binds the connected owner as beneficiary: wait for the wallet's passive reconnect before adding it.
  await expect(page.locator('.build009-wallet-info')).toHaveAttribute('title', new RegExp(SUPPLY_OWNER, 'i'));
  await page.getByRole('button', { name: 'Add supply', exact: true }).click();
  const canvas = page.getByRole('region', { name: 'Workflow canvas', exact: true });
  const graph = page.getByRole('region', { name: 'Workflow graph', exact: true });
  const footer = page.locator('footer.summary-bar');
  const cta = footer.locator('.canvas-primary-action').getByRole('button', { name: 'Simulate workflow', exact: true });
  await expect(page.getByRole('button', { name: 'Continue to Simulate', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Simulate workflow', exact: true })).toHaveCount(1);
  await expect(graph.locator('.canvas-primary-action')).toHaveCount(0);
  await expect(footer.locator('button[data-lifecycle-action]')).toHaveCount(1);
  await expect(footer.getByRole('button', { name: /^View (simulation|execution)$/ })).toHaveCount(0);
  // P0 approved UX (board 03b / 16): the stepper is in the top bar; a closed step adds its reason for assistive technology, so the visible number
  // and label are read on their own.
  const steps = page.getByRole('navigation', { name: 'Editor steps', exact: true });
  await expect(steps.getByRole('button')).toHaveCount(3);
  await expect(steps.locator('.editor-stepper-number')).toHaveText(['1', '2', '3']);
  await expect(steps.locator('.editor-stepper-label')).toHaveText(['Create', 'Simulate', 'Execute']);
  for (const docked of [false, true]) {
    if (docked) await useDockedToolbar(page);
    for (const width of [1920, 1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(cta).toBeVisible();
      const graphBox = (await graph.boundingBox())!, footerBox = (await footer.boundingBox())!, ctaBox = (await cta.boundingBox())!;
      expect(ctaBox.y).toBeGreaterThanOrEqual(footerBox.y); expect(ctaBox.y + ctaBox.height).toBeLessThanOrEqual(footerBox.y + footerBox.height + 1);
      expect(ctaBox.x + ctaBox.width).toBeLessThanOrEqual(width);
      const nodeBox = (await graph.locator('.flow-card').boundingBox())!, controlsBox = (await graph.locator('.canvas-navigator').boundingBox())!;
      expect(controlsBox.y + controlsBox.height).toBeLessThanOrEqual(graphBox.y + graphBox.height + 1);
      if (!docked) {
        const rail = (await graph.locator('.floating-toolbox').boundingBox())!;
        expect(rail.x).toBeGreaterThanOrEqual(graphBox.x); expect(rail.y + rail.height).toBeLessThanOrEqual(graphBox.y + graphBox.height + 1);
        expect(nodeBox.x).toBeGreaterThanOrEqual(rail.x + rail.width);
      }
      if (width > 1100) {
        expect(await page.locator('main').evaluate(element => getComputedStyle(element).paddingLeft)).toBe('20px');
        const assistantBox = (await page.getByRole('complementary', { name: 'FloFi Assistant' }).boundingBox())!, canvasBox = (await canvas.boundingBox())!;
        // P0 approved UX (board 16 §7): the FloFi panel is 380 px wide from 1200 px.
        expect(assistantBox.width).toBe(380);
        expect(assistantBox.x).toBeGreaterThanOrEqual(canvasBox.x + canvasBox.width);
        // The Canvas fills the viewport above the footer (a 900 px window leaves it at least 560 px tall).
        expect(canvasBox.height).toBeGreaterThanOrEqual(560);
        expect(canvasBox.width).toBeGreaterThan(assistantBox.width * 2);
      }
      if (width === 1920) expect((await page.locator('main').boundingBox())!.width).toBe(1720);
      // BUILD-FLOFI-CONVERSATIONAL-001: no settings panel below the canvas (a card's settings open anchored to it, only on request).
      await expect(page.getByRole('dialog', { name: 'Action settings', exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await configureCanvasAction(page, '1');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => cta.evaluate(element => getComputedStyle(element).animationName)).toBe('build-cta-pulse');
  const pulse = await cta.evaluate(element => {
    const style = getComputedStyle(element);
    return { duration: parseFloat(style.animationDuration), timing: style.animationTimingFunction,
      opacity: style.opacity, transform: style.transform };
  });
  expect(pulse.duration).toBeGreaterThanOrEqual(3);
  expect(pulse.timing).toBe('ease-in-out');
  expect(pulse.opacity).toBe('1'); expect(pulse.transform).toBe('none');
  await cta.focus();
  await expect.poll(() => cta.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await cta.evaluate(element => element.blur());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => cta.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
});

test('Canvas simulation runs the shared Supply lifecycle with one guarded Review action', async ({ page }) => {
  await installSupplyWallet(page);
  await openBuilder(page);
  // Supply binds the connected owner as beneficiary: wait for the wallet's passive reconnect before adding it.
  await expect(page.locator('.build009-wallet-info')).toHaveAttribute('title', new RegExp(SUPPLY_OWNER, 'i'));
  await page.getByRole('button', { name: 'Add supply', exact: true }).click();
  await configureCanvasAction(page, '1');
  await page.locator('footer.summary-bar').getByRole('button', { name: 'Simulate workflow', exact: true }).click();
  await expectEditorSection(page, 'Simulate');
  // P0 approved UX (board 06): the one lifecycle control stays in the Editor footer on Simulate too (the simulated canvas carries no action); no
  // section button of its own (the stepper opens Execute).
  await expect(page.getByRole('region', { name: 'Simulation workflow graph', exact: true }).locator('.canvas-primary-action')).toHaveCount(0);
  const primary = page.locator('footer.summary-bar .canvas-primary-action');
  await expect(primary.getByRole('button', { name: 'Authorize in wallet', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Authorize in wallet', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Simulate Supply', exact: true })).toHaveCount(0);
  await expect(page.locator('.summary-bar button[data-lifecycle-action]')).toHaveCount(1);
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
  await expect(page.getByRole('button', { name: 'Simulate workflow', exact: true })).toHaveCount(0);
  await openEditorSection(page, 'Build');
  await expect(page.locator('.canvas-primary-action').getByRole('button', { name: 'Authorize in wallet', exact: true })).toBeDisabled();
  await expect(page.locator('.flow-card.active')).toHaveCount(1);
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
});
