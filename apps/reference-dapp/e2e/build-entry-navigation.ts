// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * P0 approved UX (board 03b): navigation lives only in the ☰ drawer — "New workflow" (the Chat entry, where offered), "Editor", "Dashboard",
 * then Library (Your workflows, Automations) and Access (Credentials, Agents, Passkeys). The drawer is aria-hidden and inert while closed, so
 * these open it first, exactly as an owner does. Nothing is simulated, accepted or signed by this navigation.
 */
export const NAVIGATION_TRIGGER = /^(Open navigation|Abrir navegação)$/;
export const navigationTrigger = (page: Page) => page.getByRole('button', { name: NAVIGATION_TRIGGER });
export const navigationDrawer = (page: Page) => page.getByRole('navigation', { name: /^(FloFi navigation|Navegação (da )?FloFi)$/ });
export const NAVIGATION_ITEMS = {
  Chat: /^(New workflow|Novo fluxo)$/, Editor: /^Editor$/, Dashboard: /^(Dashboard|Painel)$/,
  'Your workflows': /^(Your workflows|Seus fluxos)$/, Automations: /^(Automations|Automações)$/, Credentials: /^(Credentials|Credenciais)$/,
  Agents: /^(Agents|Agentes)$/, Passkeys: /^(Passkeys|Chaves de acesso)$/,
} as const;
export type NavigationItem = keyof typeof NAVIGATION_ITEMS;
/** The drawer's link for an item (its name starts with the item's label; a status tag such as "In testing" may follow it). */
export const navigationLink = (page: Page, item: NavigationItem) =>
  navigationDrawer(page).getByRole('link', { name: new RegExp(NAVIGATION_ITEMS[item].source.replace(/\$$/, '')) }).first();
/** Opens the ☰ drawer (a no-op when it is already open) and returns its navigation. */
export async function openNavigation(page: Page): Promise<Locator> {
  const drawer = navigationDrawer(page);
  if (!(await drawer.isVisible())) await navigationTrigger(page).click();
  await expect(drawer).toBeVisible();
  return drawer;
}
/** Closes the drawer with Escape (as an owner does); a no-op when it is closed. */
export async function closeNavigation(page: Page): Promise<void> {
  if (await navigationDrawer(page).isVisible()) await page.keyboard.press('Escape');
  await expect(navigationDrawer(page)).toHaveCount(0);
}
/**
 * P0 approved UX (board 03b): "Log out" lives once, in the drawer's footer (Settings keeps Disconnect only on the compact /approve surface). It
 * calls the same disconnect as the former Settings → Disconnect.
 */
export const logOutButton = (page: Page) => page.locator('.navigation-drawer').getByRole('button', { name: /^(Log out|Sair)$/ });
export async function logOut(page: Page): Promise<void> {
  await openNavigation(page);
  await logOutButton(page).click();
}
/** Opens the drawer and follows one of its items. */
export async function navigateTo(page: Page, item: NavigationItem): Promise<void> {
  await openNavigation(page);
  await navigationLink(page, item).click();
}
/** Chat (the intent entry) through the drawer's "New workflow". */
export const openChat = (page: Page) => navigateTo(page, 'Chat');
/** The Editor (its Canvas, the Create step) through the drawer. */
export const openEditor = (page: Page) => navigateTo(page, 'Editor');
/** The Dashboard through the drawer. */
export const openDashboard = (page: Page) => navigateTo(page, 'Dashboard');
/** The Chat entry is the place in view (its `main` landmark). */
export const chatWorkspace = (page: Page) => page.locator('main.build-entry-workspace');
export const dashboardWorkspace = (page: Page) => page.getByRole('main', { name: /^(Dashboard|Painel)$/ });
/** Chat (the intent entry) is the place in view: its workspace is shown, the Editor stepper is not, and the drawer marks New workflow current. */
export async function expectChatSection(page: Page): Promise<void> {
  await expect(chatWorkspace(page)).toBeVisible();
  await expect(page.getByRole('navigation', { name: /^(Editor steps|Etapas do editor)$/ })).toHaveCount(0);
  await openNavigation(page);
  await expect(navigationLink(page, 'Chat')).toHaveAttribute('aria-current', 'page');
  await closeNavigation(page);
}

/**
 * BUILD0-UX-001: a fresh /app visit opens on Build 0, the intent entry (Chat). Suites that exercise the existing builder (the Editor: Canvas and
 * chat) and the stages after it continue exactly as an owner does — the drawer's "Editor" (the former "Prefer the editor? Build manually") — never
 * by bypassing the entry. A visit whose workflow or run was restored already moved past the entry by itself; then there is nothing to click.
 */
export async function continueToBuilder(page: Page): Promise<void> {
  const shell = page.locator('.app-shell').first(), entry = chatWorkspace(page);
  // The shell is inert until hydrated; the owner's click (and so this one) only counts once it is interactive.
  if (await shell.count()) await expect(shell).not.toHaveAttribute('inert', { timeout: 30_000 });
  if (await entry.count()) {
    try {
      await openNavigation(page);
      // Only while the entry is still in view: a visit that left it on its own (a restored workflow or run) keeps the section it chose.
      if (await entry.count()) await navigationLink(page, 'Editor').click({ timeout: 10_000 });
    } catch (error) {
      // Only a visit that left the entry on its own may skip the click.
      if (await entry.count()) throw error;
    }
  }
  await expect(entry).toHaveCount(0);
}
export async function openBuilder(page: Page, options?: Parameters<Page['goto']>[1]): Promise<void> {
  await page.goto('/app', options);
  await continueToBuilder(page);
}
/** A reload starts a new visit: on /app it opens on Build 0 again unless a workflow or run was restored. */
export async function reloadBuilder(page: Page): Promise<void> {
  await page.reload();
  await continueToBuilder(page);
}

/**
 * The Editor's sections (the Canvas, the simulation and Review, the execution) are named by their `main` landmark. P0 approved UX (board 03b):
 * the Create → Simulate → Execute stepper ("Editor steps") sits in the top bar while the Editor is open — its presence is what marks the Editor
 * as the current place (the former Dashboard | Chat | Editor tabs are gone). Each step's name is its label; a closed step adds ": <reason>".
 */
export const EDITOR_SECTION_WORKSPACES = { Build: 'Workflow workspace', Simulate: 'Simulation workspace', Execute: 'Execution workspace' } as const;
export type EditorSection = keyof typeof EDITOR_SECTION_WORKSPACES;
const EDITOR_SECTION_STEPS = { Build: /^(Create|Criar)( ?:|$)/, Simulate: /^(Simulate|Simular)( ?:|$)/, Execute: /^(Execute|Executar)( ?:|$)/ } as const;
export const editorSectionWorkspace = (page: Page, section: EditorSection) => page.getByRole('main', { name: EDITOR_SECTION_WORKSPACES[section], exact: true });
export const editorSteps = (page: Page) => page.getByRole('navigation', { name: /^(Editor steps|Etapas do editor)$/ });
/** The Editor stepper's control for a section (Create, Simulate or Execute). */
export const editorStep = (page: Page, section: EditorSection) => editorSteps(page).getByRole('button', { name: EDITOR_SECTION_STEPS[section] });
/** The Editor stepper's control for Simulate or Execute (closed whenever the shell refuses that section). */
export const editorSectionAction = (page: Page, section: Exclude<EditorSection, 'Build'>) => editorStep(page, section);
/**
 * Opens an Editor section the way an owner does where the former Simulate or Execute tab was clicked: outside the Editor the drawer's "Editor"
 * opens the Canvas; inside it the stepper opens the Canvas, the simulation or the execution section. Nothing is simulated, accepted or signed.
 */
export async function openEditorSection(page: Page, section: EditorSection): Promise<void> {
  if (await editorSectionWorkspace(page, section).count()) return;
  if (!(await editorSteps(page).count())) {
    await openEditor(page);
    if (section === 'Build') return;
  }
  await editorStep(page, section).click();
}
/** The Editor is the current place (its stepper is shown, on the named step) and the named section is the one in view. */
export async function expectEditorSection(page: Page, section: EditorSection, options?: { timeout?: number }): Promise<void> {
  await expect(editorStep(page, section)).toHaveAttribute('aria-current', 'step', options);
  await expect(editorSectionWorkspace(page, section)).toBeVisible(options);
}
/** Where a spec walked the former Dashboard / Build / Simulate / Execute tabs: the Dashboard is a drawer item; the others are the Editor's sections. */
export type ProductSection = EditorSection | 'Dashboard';
export async function openProductSection(page: Page, section: ProductSection): Promise<void> {
  if (section === 'Dashboard') await openDashboard(page);
  else await openEditorSection(page, section);
}
export async function expectProductSection(page: Page, section: ProductSection): Promise<void> {
  if (section === 'Dashboard') {
    await expect(dashboardWorkspace(page)).toBeVisible();
    await expect(editorSteps(page)).toHaveCount(0);
  } else await expectEditorSection(page, section);
}

/**
 * P0 approved UX (board 06): in the public chat-first workspace the Simulate section's former "Simulation details" disclosure (the Simulation
 * Summary and the Review) is the Review panel's collapsed "Technical details". P0 hotfix (Simulate layout): the panel (eyebrow REVIEW, "You are
 * authorizing") is an `aside` named "Review" docked INSIDE the Canvas frame at every width (beside the graph on a wide frame, under it otherwise);
 * it is never a column of its own and has no authorize control.
 */
export const simulationReviewPanel = (page: Page) => page.locator('section.simulate-workspace .simulation-workflow-canvas > .simulate-canvas-body > aside.canvas-review-dock');
async function expandDetails(details: Locator): Promise<void> {
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator('summary').first().click();
  await expect(details).toHaveAttribute('open', '');
}
/** Shows the Review panel (docked in the Canvas frame); nothing is simulated, accepted or signed. */
export async function openSimulationReviewPanel(page: Page): Promise<Locator> {
  await expect(page.locator('section.simulate-workspace')).toHaveAttribute('data-review-panel', 'open');
  const panel = simulationReviewPanel(page);
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible();
  return panel;
}
/** The former "Simulation details": the Review panel's Technical details (the Simulation Summary and the Review & Authorization surface). */
export async function openReviewTechnicalDetails(page: Page): Promise<Locator> {
  const panel = await openSimulationReviewPanel(page);
  const technical = panel.locator('details.review-panel-technical').first();
  await expandDetails(technical);
  return technical;
}

/**
 * P0 approved UX (board 04): the Canvas header's ··· (More options) menu holds Save workflow, Automate this workflow (where automations run) and
 * the toolbar layout; each item calls the same handler the former header buttons did. Nothing is saved or scheduled by opening it.
 */
export const workflowMoreOptions = (page: Page) => page.locator('.build-canvas-head .workflow-more-trigger');
export const workflowMenuItem = (page: Page, name: string | RegExp) =>
  page.locator('.build-canvas-head .workflow-more-menu').getByRole('menuitem', typeof name === 'string' ? { name, exact: true } : { name });
export async function openWorkflowMenu(page: Page): Promise<Locator> {
  const menu = page.locator('.build-canvas-head .workflow-more-menu');
  if (!(await menu.isVisible())) await workflowMoreOptions(page).click();
  await expect(menu).toBeVisible();
  return menu;
}
/** Closes the ··· menu with Escape (focus returns to its trigger). */
export async function closeWorkflowMenu(page: Page): Promise<void> {
  const menu = page.locator('.build-canvas-head .workflow-more-menu');
  if (await menu.isVisible()) await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
}
/** Chooses an item of the Canvas header's ··· menu (e.g. "Save workflow"), as an owner does. */
export async function chooseWorkflowMenuItem(page: Page, name: string | RegExp): Promise<void> {
  await openWorkflowMenu(page);
  await workflowMenuItem(page, name).click();
}

/**
 * BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): the vertical tool rail is the Canvas's default; an owner may dock the toolbar instead
 * (a remembered layout preference). P0 approved UX (board 04): the layout choice is the "Dock toolbar" / "Undock toolbar" item of the Canvas
 * header's ··· (More options) menu. These put the Canvas in the named layout whatever was remembered (presentation only).
 */
const buildCanvas = (page: Page) => page.locator('section.canvas').filter({ has: page.locator('.build-canvas-head') });
async function toggleToolbarLayout(page: Page): Promise<void> {
  const head = page.locator('.build-canvas-head');
  await head.locator('.workflow-more-trigger').click();
  await head.locator('.workflow-more-menu .toolbox-mode-toggle').click();
}
export async function useToolbarRail(page: Page): Promise<void> {
  // The remembered layout is read after mount: wait for it, then read it from the Canvas itself, and end on a positive check.
  const canvas = buildCanvas(page);
  await expect(canvas).toHaveAttribute('data-toolbox-ready', 'true');
  if ((await canvas.getAttribute('data-toolbox')) !== 'floating') await toggleToolbarLayout(page);
  await expect(canvas).toHaveAttribute('data-toolbox', 'floating');
  await expect(page.locator('.build-flow-surface .floating-toolbox')).toBeVisible();
}
export async function useDockedToolbar(page: Page): Promise<void> {
  const canvas = buildCanvas(page);
  await expect(canvas).toHaveAttribute('data-toolbox-ready', 'true');
  if ((await canvas.getAttribute('data-toolbox')) !== 'top') await toggleToolbarLayout(page);
  await expect(canvas).toHaveAttribute('data-toolbox', 'top');
  await expect(page.locator('.build-flow-surface .floating-toolbox')).toHaveCount(0);
  await expect(page.locator('.build-canvas-head .canvas-toolbar-row')).toBeVisible();
}
