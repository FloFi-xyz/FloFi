// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page } from '@playwright/test';

/**
 * BUILD0-UX-001: a fresh /app visit opens on Build 0, the intent entry. Suites that exercise the existing builder (Build 1: Canvas and chat) and
 * the stages after it continue exactly as an owner does — "Prefer the editor? Build manually" — never by bypassing the entry. A visit whose
 * workflow or run was restored already moved past the entry by itself; then there is nothing to click.
 */
export const BUILD_MANUALLY = /^(Prefer the editor\? Build manually|Prefere o editor\? Montar manualmente)$/;
export async function continueToBuilder(page: Page): Promise<void> {
  const shell = page.locator('.app-shell').first(), entry = page.locator('main.build-entry-workspace');
  // The shell is inert until hydrated; the owner's click (and so this one) only counts once it is interactive.
  if (await shell.count()) await expect(shell).not.toHaveAttribute('inert', { timeout: 30_000 });
  if (await entry.count()) await page.getByRole('button', { name: BUILD_MANUALLY }).click({ timeout: 10_000 }).catch(async error => {
    // Only a visit that left the entry on its own (a restored workflow or run) may skip the click.
    if (await entry.count()) throw error;
  });
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
 * BUILD-FLOFI-CHAT-EDITOR-UX-001: the navigation is Dashboard | Chat | Editor. Chat is the intent entry (the former Build 0) and the Editor is the
 * former Build 1 (Canvas and side chat). Simulate and Execute are no longer tabs: they are the Editor's simulation/Review and execution sections,
 * reached through the Canvas lifecycle action (as before) or opened from the Editor's footer. Each section is named by its `main` landmark.
 */
export const stagesNavigation = (page: Page) => page.getByRole('navigation', { name: 'Workflow stages' });
export const EDITOR_SECTION_WORKSPACES = { Build: 'Workflow workspace', Simulate: 'Simulation workspace', Execute: 'Execution workspace' } as const;
export type EditorSection = keyof typeof EDITOR_SECTION_WORKSPACES;
const EDITOR_SECTION_ACTIONS = { Simulate: 'View simulation', Execute: 'View execution' } as const;
export const editorTab = (page: Page) => stagesNavigation(page).getByRole('button', { name: 'Editor', exact: true });
export const chatTab = (page: Page) => stagesNavigation(page).getByRole('button', { name: 'Chat', exact: true });
export const editorSectionWorkspace = (page: Page, section: EditorSection) => page.getByRole('main', { name: EDITOR_SECTION_WORKSPACES[section], exact: true });
/** The Editor footer's control for a section (offered on the Canvas, and for execution on the simulation section). */
export const editorSectionAction = (page: Page, section: Exclude<EditorSection, 'Build'>) =>
  page.locator('footer.summary-bar').getByRole('button', { name: EDITOR_SECTION_ACTIONS[section], exact: true });
/**
 * Opens an Editor section the way an owner does where the former Simulate or Execute tab was clicked: the Editor tab opens the Canvas; the
 * footer opens the simulation or execution section. Nothing is simulated, accepted or signed by this navigation.
 */
export async function openEditorSection(page: Page, section: EditorSection): Promise<void> {
  if (section === 'Build') { await editorTab(page).click(); return; }
  if (await editorSectionWorkspace(page, section).count()) return;
  const action = editorSectionAction(page, section);
  if (!(await action.count())) await editorTab(page).click();
  await action.click();
}
/** The Editor is the current navigation item and the named section is the one in view. */
export async function expectEditorSection(page: Page, section: EditorSection, options?: { timeout?: number }): Promise<void> {
  await expect(editorTab(page)).toHaveAttribute('aria-current', 'page', options);
  await expect(editorSectionWorkspace(page, section)).toBeVisible(options);
}
/** Where a spec walked the former Dashboard / Build / Simulate / Execute tabs: Dashboard stays a tab; the others are the Editor's sections. */
export type ProductSection = EditorSection | 'Dashboard';
export async function openProductSection(page: Page, section: ProductSection): Promise<void> {
  if (section === 'Dashboard') await stagesNavigation(page).getByRole('button', { name: 'Dashboard', exact: true }).click();
  else await openEditorSection(page, section);
}
export async function expectProductSection(page: Page, section: ProductSection): Promise<void> {
  if (section === 'Dashboard') await expect(stagesNavigation(page).getByRole('button', { name: 'Dashboard', exact: true })).toHaveAttribute('aria-current', 'page');
  else await expectEditorSection(page, section);
}
