// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from './fixtures';
import { installSupplyWallet } from './supply-fixtures';
import { configureCanvasAction } from './composer-authoring-fixtures';
import type { Page } from '@playwright/test';
import { expectProductSection, navigationLink, openBuilder, openProductSection, type NavigationItem } from './build-entry-navigation';

/**
 * P0 approved UX (board 03b): the drawer's items, in order — New workflow (the Chat entry), Editor, Dashboard; Library (Your workflows,
 * Automations); Access (Credentials, Agents, Passkeys). An item that is not available yet carries a status tag ("In testing", "Coming soon") after
 * its label, so items are read by their label.
 */
const DRAWER_ITEMS = ['New workflow', 'Editor', 'Dashboard', 'Your workflows', 'Automations', 'Credentials', 'Agents', 'Passkeys'];
const itemLabels = (page: Page) => page.locator('.navigation-drawer nav').getByRole('link').evaluateAll(links => links.map(link => link.querySelector('span')?.textContent ?? ''));
const item = (page: Page, label: string) => navigationLink(page, (label === 'New workflow' ? 'Chat' : label) as NavigationItem);

async function geometry(page: Page) {
  return page.evaluate(() => {
    const selectors = ['.top-bar', 'main', '.canvas', '.canvas-head', '.flow-surface', '.canvas-foot', '.canvas-primary-action', '.canvas-navigator', '.copilot', '.simulation-summary', '.execution-plan', '.summary-bar', '.dashboard-workspace'];
    return Object.fromEntries(selectors.map(selector => {
      const element = document.querySelector(`main ${selector}`) ?? document.querySelector(selector);
      if (!element) return [selector, null];
      const { x, y, width, height } = element.getBoundingClientRect();
      return [selector, { x, y, width, height }];
    }));
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} navigation routes share the drawer and preserve dismissal controls`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(value => localStorage.setItem('flofi.theme', value), theme);
    await installSupplyWallet(page); await openBuilder(page);
    await expect(page.locator('.build009-wallet-info')).toBeVisible();
    const trigger = page.locator('.navigation-trigger'), drawer = page.locator('.navigation-drawer'), layer = page.locator('.navigation-layer');
    await expect(trigger).toHaveAccessibleName('Open navigation');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(drawer).toBeHidden(); await expect(layer).toHaveAttribute('inert', '');
    expect(await trigger.getAttribute('aria-controls')).toBe(await drawer.getAttribute('id'));
    for (const label of ['Credentials', 'Agents', 'Passkeys']) {
      await trigger.click(); await expect(drawer).toBeVisible();
      expect(await itemLabels(page)).toEqual(DRAWER_ITEMS);
      await item(page, label).click();
      await expect(page).toHaveURL(`/app/${label.toLowerCase()}`);
      await expect(page.getByRole('heading', { name: label, level: 1 })).toBeVisible();
      await expect(drawer).toBeHidden();
      await trigger.click();
      const row = item(page, label);
      await expect(row).toHaveAttribute('aria-current', 'page');
      await expect(drawer.locator('[aria-current=page]')).toHaveCount(1);
      await expect(row).toHaveCSS('font-weight', '600');
      await expect(row).toHaveCSS('background-color', theme === 'dark' ? 'rgb(26, 35, 80)' : 'rgb(234, 242, 255)');
      await row.press('Escape'); await expect(drawer).toBeHidden(); await expect(trigger).toBeFocused();
      await expect(trigger).toHaveCSS('outline-style', 'solid');
    }
    await trigger.press('Enter');
    // Board 03b: focus starts on the first item and Tab follows the drawer's order.
    await expect(item(page, 'New workflow')).toBeFocused();
    for (const label of DRAWER_ITEMS.slice(1, 7)) { await page.keyboard.press('Tab'); await expect(item(page, label)).toBeFocused(); }
    await page.keyboard.press('Enter'); await expect(page).toHaveURL('/app/agents'); await expect(drawer).toBeHidden();
    await trigger.click(); await trigger.click(); await expect(drawer).toBeHidden();
    await trigger.click(); await page.mouse.click(1400, 500); await expect(drawer).toBeHidden(); await expect(trigger).toBeFocused();
    await trigger.click(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('switch', { name: 'Language', exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Theme', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).press('Escape');
    expect(errors).toEqual([]);
  });

  test(`${theme} responsive drawer preserves Build, Simulate, Execute and Dashboard geometry`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(value => localStorage.setItem('flofi.theme', value), theme);
    await installSupplyWallet(page); await openBuilder(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.build009-wallet-info')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: 'Add supply', exact: true }).click();
    await configureCanvasAction(page, '1');
    const trigger = page.locator('.navigation-trigger');
    const drawer = page.locator('.navigation-drawer');
    const measurements: Record<string, Awaited<ReturnType<typeof geometry>>> = {};
    for (const width of [320, 375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const stage of ['Build', 'Simulate', 'Execute', 'Dashboard'] as const) {
        await openProductSection(page, stage);
        await expectProductSection(page, stage);
        if (stage === 'Dashboard') await expect(page.locator('.dashboard-loading')).toHaveCount(0);
        await page.evaluate(() => window.scrollTo(0, 0));
        const before = await geometry(page);
        measurements[`${theme}-${width}-${stage}`] = before;
        await trigger.click(); await expect(drawer).toBeVisible();
        expect(await geometry(page)).toEqual(before);
        const headerBox = (await page.getByRole('banner').boundingBox())!;
        const drawerBox = (await drawer.boundingBox())!;
        expect(drawerBox.x).toBe(0);
        expect(drawerBox.y).toBe(headerBox.y + headerBox.height);
        expect(drawerBox.y + drawerBox.height).toBe(900);
        expect(drawerBox.width).toBeCloseTo(width <= 480 ? Math.min(width * .88, 320) : 260, 1);
        expect(900 - drawerBox.y).toBeGreaterThan(400);
        expect(width - drawerBox.width).toBeGreaterThan(30);
        expect(await drawer.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
        for (const label of DRAWER_ITEMS) await expect(item(page, label)).toBeInViewport();
        await expect(drawer.getByRole('button', { name: 'Log out', exact: true })).toBeInViewport();
        // Board 03b: the Editor is the current item on each of its sections (Create, Simulate, Execute); the Dashboard on its own page.
        await expect(drawer.locator('[aria-current=page]')).toHaveCount(1);
        await expect(item(page, stage === 'Dashboard' ? 'Dashboard' : 'Editor')).toHaveAttribute('aria-current', 'page');
        await expect(trigger).toBeInViewport();
        // BUILD-FLOFI-MAINNET-PRODUCT-001: Mainnet-only, so the header has no network selector.
        await expect(page.getByRole('combobox', { name: 'Environment', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
        await expect(page.getByRole('group', { name: 'Wallet connection' })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (stage === 'Build' && (width === 320 || width === 1440)) await page.screenshot({ path: `.tmp/flofi-navigation-${theme}-${width}.png` });
        await item(page, 'Credentials').press('Escape');
        await expect(drawer).toBeHidden();
        expect(await geometry(page)).toEqual(before);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
    await testInfo.attach('navigation-workspace-geometry', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
    expect(errors).toEqual([]);
  });
}

test('drawer opens and closes with a restrained reversible slide and respects reduced motion', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await openBuilder(page);
  const trigger = page.locator('.navigation-trigger');
  const drawer = page.locator('.navigation-drawer');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await trigger.click();
  await expect(drawer).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  for (const open of [false, true]) {
    const motion = await page.evaluate(async open => {
      const layer = document.querySelector('.navigation-layer')!;
      const drawer = document.querySelector('.navigation-drawer')!;
      const trigger = document.querySelector<HTMLButtonElement>('.navigation-trigger')!;
      const changed = new Promise<void>(resolve => {
        const observer = new MutationObserver(() => {
          if (layer.getAttribute('data-open') === String(open)) { observer.disconnect(); resolve(); }
        });
        observer.observe(layer, { attributes: true, attributeFilter: ['data-open'] });
      });
      void getComputedStyle(drawer).transform;
      trigger.click(); await changed;
      const style = getComputedStyle(drawer);
      const samples: { x: number; visibility: string }[] = [];
      for (let frame = 0; frame < 20; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        samples.push({ x: new DOMMatrix(getComputedStyle(drawer).transform).m41, visibility: getComputedStyle(layer).visibility });
      }
      return { duration: style.transitionDuration, easing: style.transitionTimingFunction, samples };
    }, open);
    expect(motion.duration).toBe('0.22s'); expect(motion.easing).toBe('ease-out');
    expect(motion.samples.some(sample => sample.x > -260 && sample.x < 0 && sample.visibility === 'visible')).toBe(true);
    expect(motion.samples.every(sample => sample.x >= -260 && sample.x <= 0)).toBe(true);
    for (let index = 1; index < motion.samples.length; index++) {
      const delta = motion.samples[index]!.x - motion.samples[index - 1]!.x;
      expect(open ? delta >= 0 : delta <= 0).toBe(true);
    }
    expect(motion.samples.at(-1)!.x).toBe(open ? 0 : -260);
  }
  await trigger.click(); await expect(drawer).toBeHidden();
  // A quick reversal settles open, with no extra layer or stuck backdrop.
  await trigger.click(); await trigger.click(); await trigger.click();
  await expect(drawer).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await expect(page.locator('.navigation-layer')).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(drawer).toHaveCSS('transition-duration', '0s');
  await trigger.click(); await expect(drawer).toBeHidden();
  await trigger.press('Space'); await expect(drawer).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await page.keyboard.press('Escape'); await expect(drawer).toBeHidden();
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.click(); await page.getByRole('switch', { name: 'Theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await settings.press('Escape'); await trigger.click();
  await expect(drawer).toHaveCSS('transition-duration', '0s');
  await expect(drawer).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await page.keyboard.press('Escape'); await expect(drawer).toBeHidden();
  expect(errors).toEqual([]);
});
