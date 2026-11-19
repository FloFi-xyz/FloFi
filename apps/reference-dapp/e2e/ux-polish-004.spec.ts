// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD UX POLISH 004 — navigation, direct access to the Editor and Canvas usability. UX only: nothing here simulates, quotes, signs or sends,
 * no wallet is asked for anything, and the network guard refuses every request outside the loopback app.
 * - UX-01: above 800 px navigation is a persistent rail, collapsed (icons) by default; the chevron beside the logo shows the names and groups and
 *   hides them again; collapsed items name themselves in a tooltip; Log out, Terms and Privacy stay reachable; the workspace takes the freed width;
 *   the Canvas and its workflow are untouched. At 800 px and below the ☰ drawer is unchanged.
 * - UX-02: the FloFi logo opens the Dashboard (a client navigation; the session, wallet and Canvas stay).
 * - UX-03: "Prefer the editor? Build it manually" under the suggestions opens the Editor in one click, creating nothing; requests still work.
 * - UXA-02: a mouse wheel over the Canvas zooms around the cursor (the same viewport transform as + / −), a trackpad still pans, drags pan without
 *   moving cards, card drags move only the card, and neither the page nor the chat scrolls because of the Canvas (nor the Canvas because of them).
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseLanguage } from './app-origin';
import { closeNavigation, editorStep, expectChatSection, expectEditorSection, expectProductSection, navigationDrawer, navigationLink, navigationTrigger, openBuilder, openNavigation, openProductSection, railToggle } from './build-entry-navigation';

test.beforeEach(async ({ page }) => {
  // Cards may ask for a display estimate; none is needed here (and none may reach a provider).
  await page.route('**/api/build-estimate', route => route.fulfill({ json: { ok: false, code: 'ESTIMATE_UNAVAILABLE' } }));
});

const open = async (page: Page) => { await page.goto('/app'); await expect(page.locator('.app-shell').first()).not.toHaveAttribute('inert', { timeout: 30_000 }); };
const rail = (page: Page) => page.locator('.navigation-layer');
const main = (page: Page) => page.locator('main#workspace');
const box = async (locator: Locator) => (await locator.boundingBox())!;
const graph = (page: Page) => page.locator('.build-flow-surface');
const viewport = (page: Page) => graph(page).locator('.react-flow__viewport').evaluate(element => {
  const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
  return { x: matrix.e, y: matrix.f, zoom: matrix.a };
});
/** Every card's stored position (React Flow's node transform comes from the workflow's layout, never from the viewport). */
const cardPositions = (page: Page) => graph(page).locator('.react-flow__node').evaluateAll(nodes => nodes.map(node => `${node.getAttribute('data-id')} ${(node as HTMLElement).style.transform}`));
const revision = (page: Page) => page.locator('.summary-bar').getAttribute('data-workflow-revision');
async function addSwapCard(page: Page) {
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  await expect(graph(page).locator('.react-flow__node')).toHaveCount(1);
}
/** The fields of a wheel event that tell its device apart (Chromium accepts the legacy `wheelDeltaY` in the event's init). */
type WheelInit = { deltaMode?: number; deltaX?: number; deltaY?: number; wheelDeltaY?: number };
/** A wheel event exactly as a browser reports it, at a point of the page (a trackpad's `wheelDeltaY` is −3 × deltaY on macOS). */
async function wheelAt(page: Page, point: { x: number; y: number }, init: WheelInit) {
  return page.evaluate(({ point, init }) => {
    const target = document.elementFromPoint(point.x, point.y)!;
    const event = new WheelEvent('wheel', { ...init, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true, composed: true } as WheelEventInit);
    target.dispatchEvent(event);
    return { prevented: event.defaultPrevented, target: target.className };
  }, { point, init });
}
const pause = (page: Page) => page.waitForTimeout(260); // longer than one wheel gesture (WHEEL_GESTURE_GAP_MS)

test.describe('UX-01 collapsible navigation rail', () => {
  test('desktop starts collapsed; the chevron expands and collapses it smoothly; icons navigate in both states', async ({ page, networkGuard }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    const toggle = railToggle(page), drawer = navigationDrawer(page);
    // Collapsed by default: the rail is in view (nothing to open), 64 px wide below the header, the ☰ drawer trigger is not offered.
    await expect(toggle).toHaveAccessibleName('Expand navigation');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-controls', (await page.locator('.navigation-drawer').getAttribute('id'))!);
    await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(rail(page)).toHaveAttribute('data-expanded', 'false');
    const header = await box(page.getByRole('banner')), collapsed = await box(page.locator('.navigation-drawer'));
    expect(collapsed.x).toBe(0); expect(collapsed.width).toBe(64); expect(collapsed.y).toBeCloseTo(header.y + header.height, 0);
    expect(header.x).toBe(0); expect(header.width).toBe(1440);
    // Only icons are shown; every item keeps its name for assistive technology (and the current one is marked).
    for (const label of ['New workflow', 'Editor', 'Dashboard', 'Your workflows', 'Automations', 'Credentials', 'Agents', 'Passkeys']) {
      const item = drawer.getByRole('link', { name: new RegExp(`^${label}`) });
      await expect(item).toBeVisible();
      expect((await box(item)).width).toBeLessThanOrEqual(44);
      await expect(item.locator('.navigation-row-label')).toHaveCSS('clip-path', 'inset(50%)');
    }
    await expect(navigationLink(page, 'Chat')).toHaveAttribute('aria-current', 'page');
    await expect(drawer.locator('.navigation-section-label').first()).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
    // Log out, Terms and Privacy stay reachable in the compact rail.
    const aside = page.getByRole('complementary', { name: 'FloFi navigation' });
    for (const control of [aside.getByRole('button', { name: 'Log out', exact: true }), aside.getByRole('link', { name: 'Terms', exact: true }), aside.getByRole('link', { name: 'Privacy', exact: true })]) {
      await expect(control).toBeInViewport();
      expect((await box(control)).x + (await box(control)).width).toBeLessThanOrEqual(64);
    }
    await expect(aside.getByRole('link', { name: 'Terms', exact: true })).toHaveAttribute('href', '/terms');
    await expect(aside.getByRole('link', { name: 'Privacy', exact: true })).toHaveAttribute('href', '/privacy');
    const mainCollapsed = await box(main(page));
    expect(mainCollapsed.x).toBeGreaterThanOrEqual(64);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // Expanded: the drawer's own look (260 px, names, status tags and group titles); the workspace moves aside by the difference, the header stays.
    await toggle.click();
    await expect(railToggle(page)).toHaveAccessibleName('Collapse navigation');
    await expect(railToggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(rail(page)).toHaveAttribute('data-expanded', 'true');
    await expect.poll(async () => (await box(page.locator('.navigation-drawer'))).width).toBe(260);
    await expect.poll(async () => (await box(main(page))).x - mainCollapsed.x).toBeCloseTo(196, 0);
    expect((await box(page.getByRole('banner'))).width).toBe(1440);
    await expect(drawer.getByRole('link', { name: /^Agents/ }).locator('.navigation-status')).toHaveText('In testing');
    await expect(drawer.locator('.navigation-section-label').first()).toHaveText('Library');
    await expect(drawer.locator('.navigation-section-label').first()).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
    await expect(aside.locator('.navigation-legal')).toHaveText('Terms · Privacy');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // A navigation item keeps the owner's choice (the rail stays expanded on the next section).
    await navigationLink(page, 'Dashboard').click();
    await expect(page).toHaveURL('/app/dashboard');
    await expect(navigationLink(page, 'Dashboard')).toHaveAttribute('aria-current', 'page');
    await expect(rail(page)).toHaveAttribute('data-expanded', 'true');
    await navigationLink(page, 'Your workflows').click();
    await expect(page).toHaveURL('/app/workflows');
    await expect(page.getByRole('heading', { name: 'Your workflows', level: 1 })).toBeVisible();
    // Collapsing again restores the collapsed geometry; icons still navigate.
    await railToggle(page).click();
    await expect(rail(page)).toHaveAttribute('data-expanded', 'false');
    await expect.poll(async () => (await box(page.locator('.navigation-drawer'))).width).toBe(64);
    await navigationLink(page, 'Credentials').click();
    await expect(page).toHaveURL('/app/credentials');
    await expect(navigationLink(page, 'Credentials')).toHaveAttribute('aria-current', 'page');
    await navigationLink(page, 'Editor').click();
    await expectEditorSection(page, 'Build');
    await expect(navigationLink(page, 'Editor')).toHaveAttribute('aria-current', 'page');
    // A new page load starts collapsed again (nothing is stored).
    await railToggle(page).click(); await expect(rail(page)).toHaveAttribute('data-expanded', 'true');
    await page.reload(); await expect(page.locator('.app-shell').first()).not.toHaveAttribute('inert', { timeout: 30_000 });
    await expect(rail(page)).toHaveAttribute('data-expanded', 'false');
    await expect(railToggle(page)).toHaveAttribute('aria-expanded', 'false');
    networkGuard.assertClean();
    expect(errors).toEqual([]);
  });

  // Every section at 1024–1440 px in both themes and both rail states: no horizontal overflow, the header at full width, the rail under it with
  // every item and Log out in view and the current one marked. From 1360 px the expanded rail moves the workspace aside; below, it floats over
  // it (the workspace keeps the width it was designed for, giving up only the collapsed 64 px).
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} desktop rail keeps Build, Simulate, Execute and the Dashboard usable at 1024, 1280 and 1440 px`, async ({ page, networkGuard }) => {
      test.setTimeout(240_000);
      await page.addInitScript(value => localStorage.setItem('flofi.theme', value), theme);
      // An empty workflow: every section opens (an unconfigured card would rightly keep Simulate and Execute closed).
      await openBuilder(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const width of [1024, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const expanded of [false, true]) {
          if ((await rail(page).getAttribute('data-expanded')) !== String(expanded)) await railToggle(page).click();
          await expect(rail(page)).toHaveAttribute('data-expanded', String(expanded));
          // Every section with the default (collapsed) rail; the Editor's Canvas and the Dashboard with the names shown.
          for (const section of expanded ? ['Build', 'Dashboard'] as const : ['Build', 'Simulate', 'Execute', 'Dashboard'] as const) {
            const label = `${theme} ${width}px ${expanded ? 'expanded' : 'collapsed'} ${section}`;
            await openProductSection(page, section);
            await expectProductSection(page, section);
            // Below 1360 px a press outside the floating rail (the stepper is one) collapses it: show the names again for this section.
            if ((await rail(page).getAttribute('data-expanded')) !== String(expanded)) await railToggle(page).click();
            await expect(rail(page)).toHaveAttribute('data-expanded', String(expanded));
            await page.evaluate(() => window.scrollTo(0, 0));
            const railWidth = expanded ? 260 : 64;
            await expect.poll(async () => (await box(page.locator('.navigation-drawer'))).width, { message: label }).toBe(railWidth);
            const header = await box(page.getByRole('banner')), drawer = await box(page.locator('.navigation-drawer')), workspace = await box(main(page));
            expect(header.x, label).toBe(0); expect(header.width, label).toBe(width);
            expect(drawer.x, label).toBe(0); expect(drawer.y, label).toBeCloseTo(header.y + header.height, 0);
            expect(workspace.x, label).toBeGreaterThanOrEqual(expanded && width >= 1360 ? 260 : 64);
            if (expanded && width < 1360) expect(workspace.x, label).toBeLessThan(260);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label).toBe(true);
            for (const item of ['Chat', 'Editor', 'Dashboard', 'Your workflows', 'Automations', 'Credentials', 'Agents', 'Passkeys'] as const)
              await expect(navigationLink(page, item), label).toBeInViewport();
            await expect(page.locator('.navigation-drawer').getByRole('button', { name: 'Log out', exact: true }), label).toBeInViewport();
            await expect(navigationDrawer(page).locator('[aria-current=page]'), label).toHaveCount(1);
            await expect(navigationLink(page, section === 'Dashboard' ? 'Dashboard' : 'Editor'), label).toHaveAttribute('aria-current', 'page');
            if (section === 'Build') {
              // The Canvas, its action rail and navigator stay inside the workspace; the chat sits beside or below it.
              const canvas = await box(page.locator('main .canvas').first()), chat = await box(page.locator('main .copilot').first());
              expect(canvas.x, label).toBeGreaterThanOrEqual(workspace.x - 1);
              for (const control of await graph(page).locator('.floating-toolbox button:visible, .canvas-navigator button').all()) {
                const button = await box(control);
                expect(button.x, label).toBeGreaterThanOrEqual(canvas.x - 1); expect(button.x + button.width, label).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
              }
              expect(chat.x >= canvas.x + canvas.width - 1 || chat.y >= canvas.y + canvas.height - 1, label).toBe(true);
            }
          }
        }
        if (width === 1440) await page.screenshot({ path: test.info().outputPath(`rail-${theme}-${width}.png`) });
      }
      networkGuard.assertClean();
    });
  }

  test('below 1360 px the expanded rail floats over the Canvas and gets out of the way; from 1360 px it sits beside the workspace', async ({ page, networkGuard }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openBuilder(page);
    const tool = await box(graph(page).locator('.floating-toolbox button').first());
    const toolCenter = { x: tool.x + tool.width / 2, y: tool.y + tool.height / 2 };
    const covered = () => page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.navigation-layer')), toolCenter);
    expect(await covered()).toBe(false);
    const workspace = await box(main(page));
    await railToggle(page).click();
    await expect(rail(page)).toHaveAttribute('data-expanded', 'true');
    // It floats: the workspace keeps its width and position, the rail covers its left edge with the drawer's shadow.
    expect(await box(main(page))).toEqual(workspace);
    expect(await covered()).toBe(true);
    await expect(page.locator('.navigation-drawer')).not.toHaveCSS('box-shadow', 'none');
    // A press outside navigation collapses it, and the Canvas tool under it is reachable again.
    await page.mouse.click(toolCenter.x + 420, toolCenter.y + 120);
    await expect(rail(page)).toHaveAttribute('data-expanded', 'false');
    await expect.poll(covered).toBe(false);
    // Escape from inside it collapses it and returns focus to the chevron; Escape elsewhere leaves it as it is.
    await railToggle(page).click();
    await navigationDrawer(page).getByRole('link', { name: 'Dashboard', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(rail(page)).toHaveAttribute('data-expanded', 'false');
    await expect(railToggle(page)).toBeFocused();
    await railToggle(page).click();
    await page.locator('#mock-prompt').focus();
    await page.keyboard.press('Escape');
    await expect(rail(page)).toHaveAttribute('data-expanded', 'true');
    // From 1360 px the expanded rail moves the workspace aside and stays as the owner left it.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await box(main(page))).x).toBeGreaterThanOrEqual(260);
    await page.mouse.click(1000, 600);
    await page.waitForTimeout(200);
    await expect(rail(page)).toHaveAttribute('data-expanded', 'true');
    await expect(page.locator('.navigation-drawer')).toHaveCSS('box-shadow', 'none');
    networkGuard.assertClean();
  });

  test('the docked Canvas toolbar keeps every action inside the Canvas at 1101–1280 px beside the collapsed rail', async ({ page, networkGuard }) => {
    await page.addInitScript(() => localStorage.setItem('gryloo:toolbox-mode', 'top'));
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBuilder(page);
    await expect(page.locator('.build-canvas-head .canvas-toolbar-row')).toBeVisible();
    for (const width of [1101, 1180, 1280, 1360]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(rail(page)).toHaveAttribute('data-expanded', 'false');
      const canvas = await box(page.locator('main .canvas').first());
      for (const control of await page.locator('.build-canvas-head .canvas-toolbar-row .canvas-toolbox button').all()) {
        const button = await box(control);
        expect(button.x, `${width}px`).toBeGreaterThanOrEqual(canvas.x - 1);
        expect(button.x + button.width, `${width}px`).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px`).toBe(true);
    }
    networkGuard.assertClean();
  });

  test('the transition is a short ease-out slide and reduced motion removes it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page);
    const shell = page.locator('.app-shell').first();
    await expect(shell).toHaveCSS('transition-duration', '0.2s');
    await expect(shell).toHaveCSS('transition-property', 'padding-left');
    await expect(rail(page)).toHaveCSS('transition-property', 'width');
    const widths = await page.evaluate(async () => {
      const layer = document.querySelector<HTMLElement>('.navigation-layer')!;
      document.querySelector<HTMLButtonElement>('.navigation-trigger')!.click();
      const samples: number[] = [];
      for (let frame = 0; frame < 24; frame++) { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); samples.push(layer.getBoundingClientRect().width); }
      return samples;
    });
    expect(widths.some(width => width > 64 && width < 260)).toBe(true);
    for (let index = 1; index < widths.length; index++) expect(widths[index]!).toBeGreaterThanOrEqual(widths[index - 1]!);
    expect(widths.at(-1)).toBe(260);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(shell).toHaveCSS('transition-duration', '0s');
    await railToggle(page).click();
    await expect.poll(async () => (await box(page.locator('.navigation-drawer'))).width).toBe(64);
  });

  test('collapsed items name themselves on hover and keyboard focus; the rail is keyboard reachable without a trap', async ({ page, networkGuard }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await chooseLanguage(page.context(), 'PT');
    await open(page);
    const tooltip = page.locator('.navigation-rail-tooltip');
    // Hover (after a short delay), beside the item and outside the rail.
    const panel = navigationDrawer(page).getByRole('link', { name: 'Painel', exact: true });
    await panel.hover();
    await expect(tooltip).toHaveText('Painel');
    const tip = await box(tooltip), item = await box(panel);
    expect(tip.x).toBeGreaterThan(item.x + item.width);
    expect(Math.abs(tip.y + tip.height / 2 - (item.y + item.height / 2))).toBeLessThanOrEqual(2);
    await expect(tooltip).toHaveAttribute('aria-hidden', 'true');
    await page.mouse.move(900, 600);
    await expect(tooltip).toHaveCount(0);
    // Choosing an item hides its name, even with the pointer still on it (nothing covers the page it opens).
    await panel.hover();
    await expect(tooltip).toHaveText('Painel');
    await panel.click();
    await expect(page).toHaveURL('/app/dashboard');
    await page.waitForTimeout(500);
    await expect(tooltip).toHaveCount(0);
    await page.goto('/app'); await expect(page.locator('.app-shell').first()).not.toHaveAttribute('inert', { timeout: 30_000 });
    // Also when the section it opens rebuilds the header under a pointer that has not moved (Chat → Editor); moving shows names again.
    const editor = navigationDrawer(page).getByRole('link', { name: 'Editor', exact: true });
    await editor.hover(); await expect(tooltip).toHaveText('Editor');
    await editor.click();
    await expect(editorStep(page, 'Build')).toHaveAttribute('aria-current', 'step');
    await page.waitForTimeout(600);
    await expect(tooltip).toHaveCount(0);
    const editorBox = await box(navigationDrawer(page).getByRole('link', { name: 'Editor', exact: true }));
    await page.mouse.move(editorBox.x + editorBox.width / 2 + 6, editorBox.y + editorBox.height / 2 + 4);
    await expect(tooltip).toHaveText('Editor');
    await page.mouse.move(900, 600); await expect(tooltip).toHaveCount(0);
    await navigationDrawer(page).getByRole('link', { name: 'Novo fluxo', exact: true }).click();
    // Status tags are part of the name.
    await navigationDrawer(page).getByRole('link', { name: /^Agentes/ }).hover();
    await expect(tooltip).toHaveText('Agentes · Em teste');
    await page.mouse.move(900, 600);
    // Keyboard: the chevron, then the rail it controls in order (each item named at once, with a visible focus), then the logo and the rest of
    // the header; "Skip to workspace" still jumps past all of it. Reached with the keyboard (Shift+Tab), so the browser shows its keyboard focus.
    await navigationDrawer(page).getByRole('link', { name: 'Novo fluxo', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(railToggle(page)).toBeFocused();
    await expect(railToggle(page)).toHaveAccessibleName('Expandir navegação');
    expect(await railToggle(page).evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
    for (const label of ['Novo fluxo', 'Editor', 'Painel', 'Seus fluxos']) {
      await page.keyboard.press('Tab');
      const focused = navigationDrawer(page).getByRole('link', { name: new RegExp(`^${label}`) });
      await expect(focused).toBeFocused();
      await expect(tooltip).toHaveText(new RegExp(`^${label}`));
      expect(await focused.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
    }
    await page.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
    // Tab leaves the rail (no trap): after Privacy comes the logo, then the workspace's own controls.
    for (let step = 0; step < 12 && await page.evaluate(() => Boolean(document.activeElement?.closest('.navigation-layer'))); step++) await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'FloFi — ir para o Painel', exact: true })).toBeFocused();
    await expect(tooltip).toHaveCount(0);
    // Enter on the chevron expands (names visible, no tooltip).
    await railToggle(page).focus(); await page.keyboard.press('Enter');
    await expect(rail(page)).toHaveAttribute('data-expanded', 'true');
    await navigationDrawer(page).getByRole('link', { name: 'Painel', exact: true }).hover();
    await page.waitForTimeout(400);
    await expect(tooltip).toHaveCount(0);
    networkGuard.assertClean();
  });

  test('expanding and collapsing never touches the Canvas, its workflow, viewport or chat', async ({ page, networkGuard }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBuilder(page);
    await addSwapCard(page);
    const chat = page.locator('#mock-prompt');
    await chat.fill('draft kept in the chat');
    const before = { revision: await revision(page), cards: await cardPositions(page), view: await viewport(page) };
    for (const state of ['true', 'false', 'true', 'false']) {
      await railToggle(page).click();
      await expect(rail(page)).toHaveAttribute('data-expanded', state);
      await expect.poll(async () => (await box(page.locator('.navigation-drawer'))).width).toBe(state === 'true' ? 260 : 64);
      await expectEditorSection(page, 'Build');
      expect(await revision(page)).toBe(before.revision);
      expect(await cardPositions(page)).toEqual(before.cards);
      expect(await viewport(page)).toEqual(before.view);
      await expect(chat).toHaveValue('draft kept in the chat');
      await expect(graph(page).locator('.composer-card')).toHaveCount(1);
    }
    networkGuard.assertClean();
  });

  test('phones keep the ☰ drawer: no rail, no chevron, the workspace keeps its full width', async ({ page, networkGuard }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await expect(railToggle(page)).toHaveCount(0);
    await expect(navigationTrigger(page)).toHaveAccessibleName('Open navigation');
    await expect(navigationDrawer(page)).toHaveCount(0);
    await expect(rail(page)).toHaveAttribute('inert', '');
    expect((await box(main(page))).x).toBe(0);
    await openNavigation(page);
    await expect(navigationLink(page, 'Chat')).toBeFocused();
    expect((await box(page.locator('.navigation-drawer'))).width).toBeCloseTo(Math.min(390 * .88, 320), 0);
    await expect(page.locator('.navigation-backdrop')).toBeVisible();
    await expect(page.locator('.navigation-drawer').getByRole('link', { name: 'Terms', exact: true })).toBeVisible();
    await closeNavigation(page);
    await expect(navigationTrigger(page)).toBeFocused();
    await expectChatSection(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    networkGuard.assertClean();
  });
});

// BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio, A2/B2/C2, intentional change): the logo opens Operate (/app) — the workspace with the open workflow —
// and the global navigation beside it names the product areas (Operate | Dashboard | My Workflows). Both are client navigations inside the same
// persistent workspace: the session, the wallet and the Canvas stay.
test.describe('UX-02 the logo opens Operate', () => {
  test('from the Dashboard and a secondary page, by mouse and keyboard, back to the same open workflow', async ({ page, networkGuard }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBuilder(page);
    await addSwapCard(page);
    const before = { revision: await revision(page), cards: await cardPositions(page) };
    const logo = page.getByRole('link', { name: 'FloFi — go to Operate', exact: true });
    const areas = page.getByRole('navigation', { name: 'Product areas', exact: true });
    await expect(logo).toHaveAttribute('href', '/app');
    await expect(logo.locator('.flofi-logo')).toBeVisible();
    // The logo keeps its look (same artwork and size as before).
    expect((await box(logo.locator('.flofi-logo-light .flofi-logo-symbol'))).height).toBe(29);
    await expect(areas.getByRole('link')).toHaveText(['Operate', 'Dashboard', 'My Workflows']);
    await expect(areas.getByRole('link', { name: 'Operate', exact: true })).toHaveAttribute('aria-current', 'page');
    const marker = await page.evaluate(() => { (window as unknown as { shellMarker: string }).shellMarker = 'same-document'; return 'same-document'; });
    await areas.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(page).toHaveURL('/app/dashboard');
    await expect(page.getByRole('main', { name: 'Dashboard', exact: true })).toBeVisible();
    await expect(areas.getByRole('link', { name: 'Dashboard', exact: true })).toHaveAttribute('aria-current', 'page');
    await logo.click();
    await expect(page).toHaveURL('/app');
    // A client navigation inside the same workspace: no reload, no public landing, no sign-out; the Editor shows the same workflow.
    expect(await page.evaluate(() => (window as unknown as { shellMarker?: string }).shellMarker)).toBe(marker);
    await expect(page.getByRole('button', { name: 'Connect Wallet', exact: true })).toBeVisible();
    await expectEditorSection(page, 'Build');
    expect(await revision(page)).toBe(before.revision);
    expect(await cardPositions(page)).toEqual(before.cards);
    // My Workflows is the existing library page; with the rail expanded too, and with the keyboard from a secondary page.
    await areas.getByRole('link', { name: 'My Workflows', exact: true }).click();
    await expect(page).toHaveURL('/app/workflows');
    await expect(areas.getByRole('link', { name: 'My Workflows', exact: true })).toHaveAttribute('aria-current', 'page');
    await railToggle(page).click();
    await navigationLink(page, 'Credentials').click();
    await expect(page).toHaveURL('/app/credentials');
    await expect(areas.locator('[aria-current="page"]')).toHaveCount(0);
    await logo.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await expect(logo).toBeFocused();
    expect(await logo.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/app');
    await expectEditorSection(page, 'Build');
    expect(await revision(page)).toBe(before.revision);
    expect(await page.evaluate(() => (window as unknown as { shellMarker?: string }).shellMarker)).toBe(marker);
    networkGuard.assertClean();
  });

  test('on a phone too, and the compact /approve signing header keeps an inert logo', async ({ page, networkGuard }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chooseLanguage(page.context(), 'PT');
    await open(page);
    const areas = page.getByRole('navigation', { name: 'Áreas do produto', exact: true });
    await expect(areas.getByRole('link')).toHaveText(['Operar', 'Painel', 'Meus Workflows']);
    await areas.getByRole('link', { name: 'Painel', exact: true }).click();
    await expect(page).toHaveURL('/app/dashboard');
    await expect(page.getByRole('main', { name: 'Painel', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'FloFi — ir para Operar', exact: true }).click();
    await expect(page).toHaveURL('/app');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto('/approve');
    await expect(page.locator('.flofi-logo-link')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Áreas do produto', exact: true })).toHaveCount(0);
    networkGuard.assertClean();
  });
});

test.describe('UX-03 direct access to the manual Editor', () => {
  const entry = (page: Page) => page.locator('main.build-entry-workspace');
  test('"Prefere o editor? Construa manualmente" opens the empty Editor in one click and creates nothing', async ({ page, networkGuard }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await chooseLanguage(page.context(), 'PT');
    await open(page);
    await expectChatSection(page);
    const line = entry(page).locator('p').filter({ hasText: 'Prefere o editor?' });
    await expect(line).toHaveText('Prefere o editor? Construa manualmente');
    // Only the action is the link; the question is plain neutral text and the link is the FloFi accent.
    const link = line.getByRole('link');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText('Construa manualmente');
    const [question, accent] = await line.evaluate(element => [getComputedStyle(element).color, getComputedStyle(element.querySelector('a')!).color]);
    expect(question).not.toBe(accent);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).not.toBe('');
    // Centred, small, right under the suggestions, with the page's hierarchy unchanged (one heading, one field, six buttons).
    const chips = await box(entry(page).getByRole('group', { name: 'Exemplos de pedidos' })), lineBox = await box(line), linkBox = await box(link);
    expect(lineBox.y).toBeGreaterThan(chips.y + chips.height);
    expect(lineBox.y - (chips.y + chips.height)).toBeLessThan(32);
    expect(Math.abs((lineBox.x + lineBox.width / 2) - (chips.x + chips.width / 2))).toBeLessThanOrEqual(2);
    expect(await line.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeLessThanOrEqual(14);
    await expect(entry(page).getByRole('button')).toHaveCount(6);
    await expect(entry(page).getByRole('heading')).toHaveCount(1);
    // Hover and focus are perceptible.
    await link.hover(); await expect(link).toHaveCSS('text-decoration-line', 'underline');
    await page.mouse.move(10, 600);
    await link.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    expect(await link.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
    expect(linkBox.height).toBeGreaterThan(0);
    // One click: the Editor with the empty Canvas of the new workflow; no prompt was typed, nothing was created, no wallet was asked.
    await link.click();
    await expect(editorStep(page, 'Build')).toHaveAttribute('aria-current', 'step');
    await expect(page.locator('main.workflow-workspace')).toBeVisible();
    await expect(page.locator('.build-flow-surface .canvas-empty')).toContainText('Comece seu fluxo');
    await expect(graph(page).locator('.react-flow__node')).toHaveCount(0);
    await expect(page.locator('.summary-bar')).toContainText('0 passos');
    await expect(page.locator('.wallet-connection')).toHaveText('Carteira não conectada');
    // The manual tools work from there.
    await addSwapCardPt(page);
    networkGuard.assertClean();
  });

  test('the natural-language request still creates the workflow and the keyboard reaches the link after the suggestions', async ({ page, networkGuard }) => {
    await page.setViewportSize({ width: 1240, height: 871 });
    await open(page);
    const request = entry(page).getByRole('textbox', { name: 'Describe what you want to do' });
    await request.click();
    await page.keyboard.type('Swap 1 USDC to WETH on Base slippage 50 bps');
    // Create workflow, the five suggestions, then the new link: it adds one stop at the end and changes no earlier one.
    const order = [entry(page).getByRole('button', { name: 'Create workflow', exact: true }),
      ...['Swap tokens', 'Earn yield', 'Provide liquidity', 'Use as collateral', 'Multi-step workflow'].map(name => entry(page).getByRole('button', { name, exact: true })),
      entry(page).getByRole('link', { name: 'Build it manually', exact: true })];
    for (const control of order) { await page.keyboard.press('Tab'); await expect(control).toBeFocused(); }
    await request.focus();
    await request.press('Enter');
    await expectEditorSection(page, 'Build');
    await expect(page.locator('.chat-messages[role="log"]')).toContainText('Swap added to your workflow: 1 USDC');
    await expect(graph(page).locator('.react-flow__node')).toHaveCount(1);
    networkGuard.assertClean();
  });
});
async function addSwapCardPt(page: Page) {
  await page.getByRole('button', { name: /^(Add swap|Adicionar troca)$/ }).click();
  await expect(graph(page).locator('.react-flow__node')).toHaveCount(1);
}

test.describe('UXA-02 Canvas zoom, pan and independent scrolling', () => {
  test('a mouse wheel zooms around the cursor; + and − use the same transform; Ctrl + wheel still zooms; cards never move', async ({ page, networkGuard }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBuilder(page);
    await addSwapCard(page);
    const cards = await cardPositions(page), rev = await revision(page);
    const renderer = await box(graph(page).locator('.react-flow__renderer'));
    const card = await box(graph(page).locator('.react-flow__node').first());
    // Whole pixels: the browser reports the pointer in whole CSS pixels.
    const cursor = { x: Math.round(card.x + card.width * .7), y: Math.round(card.y + 24) };
    const flowAt = (view: { x: number; y: number; zoom: number }) => ({ x: (cursor.x - renderer.x - view.x) / view.zoom, y: (cursor.y - renderer.y - view.y) / view.zoom });
    const start = await viewport(page);
    await page.mouse.move(cursor.x, cursor.y);
    await page.mouse.wheel(0, -100);
    await expect.poll(async () => (await viewport(page)).zoom).toBeGreaterThan(start.zoom);
    const zoomedIn = await viewport(page);
    // The point under the cursor stays under it (sub-pixel), so the card does not jump away.
    expect(flowAt(zoomedIn).x).toBeCloseTo(flowAt(start).x, 1); expect(flowAt(zoomedIn).y).toBeCloseTo(flowAt(start).y, 1);
    expect(zoomedIn.zoom).toBeCloseTo(start.zoom * 2 ** 0.2, 3);
    await expect(graph(page).locator('.react-flow__node').first()).toBeInViewport();
    await pause(page);
    await page.mouse.wheel(0, 100); await pause(page); await page.mouse.wheel(0, 100);
    await expect.poll(async () => (await viewport(page)).zoom).toBeLessThan(start.zoom);
    const zoomedOut = await viewport(page);
    expect(flowAt(zoomedOut).x).toBeCloseTo(flowAt(start).x, 1); expect(flowAt(zoomedOut).y).toBeCloseTo(flowAt(start).y, 1);
    // Limits: the canvas's own minimum and maximum.
    for (let step = 0; step < 20; step++) { await page.mouse.wheel(0, 300); await pause(page); }
    expect((await viewport(page)).zoom).toBeCloseTo(.35, 3);
    await expect(graph(page).getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled();
    // + and − step the same transform the wheel changed (and Fit is kept).
    const navigator = graph(page).getByRole('group', { name: 'Canvas navigator' });
    const beforeIn = (await viewport(page)).zoom;
    await navigator.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect.poll(async () => (await viewport(page)).zoom).toBeGreaterThan(beforeIn);
    await navigator.getByRole('button', { name: 'Zoom in', exact: true }).focus();
    await page.keyboard.press('Enter');
    const afterKeys = (await viewport(page)).zoom;
    await navigator.getByRole('button', { name: 'Zoom out', exact: true }).press('Enter');
    await expect.poll(async () => (await viewport(page)).zoom).toBeLessThan(afterKeys);
    await navigator.getByRole('button', { name: 'Fit workflow', exact: true }).click();
    await expect(graph(page).locator('.react-flow__node').first()).toBeInViewport();
    // Ctrl + wheel (and a trackpad pinch, which browsers report the same way) keeps React Flow's own zoom at the cursor.
    const beforeCtrl = await viewport(page);
    await page.mouse.move(cursor.x, cursor.y);
    await page.keyboard.down('Control'); await page.mouse.wheel(0, 60); await page.keyboard.up('Control');
    await expect.poll(async () => (await viewport(page)).zoom).toBeLessThan(beforeCtrl.zoom);
    // Nothing of the workflow changed: positions are the stored layout, the revision is the same.
    expect(await cardPositions(page)).toEqual(cards);
    expect(await revision(page)).toBe(rev);
    networkGuard.assertClean();
  });

  test('a trackpad still pans; right-drag and Space + drag pan without moving cards; dragging a card moves only that card', async ({ page, networkGuard }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBuilder(page);
    await addSwapCard(page);
    const cards = await cardPositions(page);
    const pane = await box(graph(page).locator('.react-flow__pane'));
    const point = { x: pane.x + pane.width - 160, y: pane.y + 80 };
    // macOS trackpad (deltaY with wheelDeltaY = −3 × deltaY) and a two-axis swipe: the shared 1:1 pan, never a zoom.
    let before = await viewport(page);
    await wheelAt(page, point, { deltaY: 30, wheelDeltaY: -90 });
    await expect.poll(async () => (await viewport(page)).y).toBeCloseTo(before.y - 30, 0);
    expect((await viewport(page)).zoom).toBe(before.zoom);
    await pause(page);
    before = await viewport(page);
    await wheelAt(page, point, { deltaX: 12, deltaY: 8, wheelDeltaY: -24 });
    await expect.poll(async () => (await viewport(page)).x).toBeCloseTo(before.x - 12, 0);
    expect((await viewport(page)).zoom).toBe(before.zoom);
    // One gesture keeps its device: a stray whole notch inside a trackpad swipe does not zoom. Both events are dispatched in the same task, so
    // they are always closer than one gesture gap, however slow the machine.
    before = await viewport(page);
    await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)!;
      for (const init of [{ deltaY: 6, wheelDeltaY: -18 }, { deltaY: 100, wheelDeltaY: -120 }])
        target.dispatchEvent(new WheelEvent('wheel', { ...init, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true } as WheelEventInit));
    }, point);
    expect((await viewport(page)).zoom).toBe(before.zoom);
    await pause(page);
    // A notched mouse wheel in Firefox (lines) zooms.
    before = await viewport(page);
    await wheelAt(page, point, { deltaY: -3, deltaMode: 1 });
    expect((await viewport(page)).zoom).toBeGreaterThan(before.zoom);
    await pause(page);
    // Right-button drag and Space + left drag pan; no marquee, no card moves.
    before = await viewport(page);
    await page.mouse.move(point.x, point.y); await page.mouse.down({ button: 'right' });
    await page.mouse.move(point.x + 50, point.y + 40, { steps: 5 }); await page.mouse.up({ button: 'right' });
    await expect.poll(async () => (await viewport(page)).x).toBeCloseTo(before.x + 50, 0);
    before = await viewport(page);
    await page.mouse.move(point.x, point.y); await page.keyboard.down('Space'); await page.mouse.down();
    await page.mouse.move(point.x + 30, point.y + 20, { steps: 5 });
    await expect(graph(page).locator('.canvas-marquee')).toHaveCount(0);
    await page.mouse.up(); await page.keyboard.up('Space');
    await expect.poll(async () => (await viewport(page)).x).toBeCloseTo(before.x + 30, 0);
    expect(await cardPositions(page)).toEqual(cards);
    // Dragging a card by its header moves that card (a committed Canvas edit) and never the viewport. The card is fitted first so the drag stays
    // clear of the pane's edges, where React Flow's existing auto-pan (unchanged) follows a card dragged out of view.
    await graph(page).getByRole('button', { name: 'Fit workflow', exact: true }).click();
    await page.waitForTimeout(400);
    before = await viewport(page);
    const card = await box(graph(page).locator('.react-flow__node .composer-card').first());
    await page.mouse.move(card.x + card.width / 2, card.y + 12); await page.mouse.down();
    await page.mouse.move(card.x + card.width / 2 + 60, card.y + 52, { steps: 6 }); await page.mouse.up();
    await expect.poll(() => cardPositions(page)).not.toEqual(cards);
    expect(await viewport(page)).toEqual(before);
    networkGuard.assertClean();
  });

  test('the page and the chat keep their own scrolling: the Canvas never scrolls the page, and outside it the wheel is untouched', async ({ page, networkGuard }) => {
    // A short laptop window: the document is taller than the viewport.
    await page.setViewportSize({ width: 1280, height: 640 });
    await openBuilder(page);
    await addSwapCard(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
    const node = await box(graph(page).locator('.react-flow__node').first());
    // Over a card and over the empty Canvas: no page scroll (zoom instead).
    for (const point of [{ x: node.x + node.width / 2, y: node.y + 30 }, { x: node.x + node.width + 120, y: node.y + 30 }]) {
      const before = await viewport(page);
      await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, 200); await pause(page);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      expect((await viewport(page)).zoom).not.toBe(before.zoom);
    }
    // Over the Canvas's floating controls and its rail (scrolled to its end): the page stays, nothing zooms.
    await page.evaluate(() => window.scrollTo(0, 400));
    const scrolled = await page.evaluate(() => scrollY);
    const controls = await box(graph(page).locator('.canvas-navigator'));
    const view = await viewport(page);
    const result = await wheelAt(page, { x: controls.x + 4, y: controls.y + controls.height / 2 }, { deltaY: 120, wheelDeltaY: -120 });
    expect(result.prevented).toBe(true);
    await page.mouse.move(controls.x + 4, controls.y + controls.height / 2); await page.mouse.wheel(0, 200); await pause(page);
    expect(await page.evaluate(() => scrollY)).toBe(scrolled);
    expect(await viewport(page)).toEqual(view);
    // The Canvas's floating action rail (the default toolbox layout at this width) scrolls itself, then holds the wheel at its end.
    const toolbox = graph(page).locator('.floating-toolbox');
    await expect(toolbox).toHaveCount(1);
    const railBox = await box(toolbox);
    await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + 40);
    for (let step = 0; step < 4; step++) { await page.mouse.wheel(0, 400); await pause(page); }
    await expect.poll(() => toolbox.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true);
    expect(await page.evaluate(() => scrollY)).toBe(scrolled);
    expect(await viewport(page)).toEqual(view);
    // Outside the Canvas the page scrolls normally (the footer).
    const footer = await box(page.locator('.summary-bar'));
    await page.mouse.move(footer.x + footer.width / 2, footer.y + footer.height / 2); await page.mouse.wheel(0, -200); await pause(page);
    expect(await page.evaluate(() => scrollY)).toBeLessThan(scrolled);
    // The chat scrolls itself; at its end it does not move the page or the Canvas.
    await page.evaluate(() => window.scrollTo(0, 0));
    const messages = page.locator('.copilot .chat-messages');
    await messages.evaluate(element => { element.style.maxHeight = '90px'; });
    await expect.poll(() => messages.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect(messages).toHaveCSS('overscroll-behavior-y', 'contain');
    const chatBox = await box(messages), canvasView = await viewport(page);
    await page.mouse.move(chatBox.x + chatBox.width / 2, chatBox.y + chatBox.height / 2);
    await page.mouse.wheel(0, 60); await pause(page);
    await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    for (let step = 0; step < 4; step++) { await page.mouse.wheel(0, 400); await pause(page); }
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(await viewport(page)).toEqual(canvasView);
    networkGuard.assertClean();
  });
});
