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
