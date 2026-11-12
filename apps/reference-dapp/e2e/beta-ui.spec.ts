// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from './fixtures';
import { openBuilder } from './build-entry-navigation';

// BUILD-BETA-UI-001: copy and colour only. The header CTA keeps its destination.
const retiredNotice = "FloFi is currently in beta testing. Do not use real funds until the official launch announcement is published in the app and on FloFi's official social media channels.";
const betaNotice = 'FloFi Beta Mainnet — Real funds are enabled. Review every transaction before signing.';
const betaNoticePt = 'FloFi Beta Mainnet — Operações com fundos reais estão habilitadas. Revise cada transação antes de assinar.';

// BUILD-FLOFI-SITE-001: the owner-approved site replaced Landing 07. Its header CTA ("Entrar" / "Open") opens the sign-in entry (PR #143); the
// /app notice below is unchanged.
// A new visitor (no saved language) gets English (BUILD-FLOFI-LAUNCH-001); the visitor's Portuguese choice then follows into sign-in and /app.
test.describe('as a new visitor', () => {
test.use({ savedLanguage: null });
test('the landing header CTA opens sign-in and the builder stays reachable without an account', async ({ page }) => {
  await page.goto('/');
  const header = page.locator('header');
  const cta = header.getByRole('link', { name: 'Open', exact: true });
  await expect(cta).toHaveAttribute('href', '/login');
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByRole('radio', { name: 'Português', exact: true }).check();
  await expect(header.getByRole('link', { name: 'Entrar', exact: true })).toHaveAttribute('href', '/login');
  await header.getByRole('link', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL('/login');
  await page.getByRole('link', { name: 'Explorar o construtor sem conta', exact: true }).click();
  await expect(page).toHaveURL('/app');
});
});

// BUILD-FLOFI-PRODUCT-UX-001: the Beta Mainnet notice under the header (real funds enabled, review before signing). P0 approved UX (board 16 §5):
// it uses the Design System attention pair of the theme — light #8A5A00 on #FFF4E0 (was the older yellow #fde68a / #14233a).
for (const width of [320, 1440]) {
  test(`/app shows the Beta Mainnet notice between the header and the workflow canvas at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openBuilder(page);
    await expect(page.getByText(retiredNotice)).toHaveCount(0);
    const notice = page.locator('.beta-notice');
    await expect(notice).toHaveCount(1);
    await expect(notice).toHaveText(betaNotice);
    await expect(notice).toHaveAttribute('role', 'note');
    expect(await notice.evaluate(element => [
      getComputedStyle(element).backgroundColor,
      getComputedStyle(element).color,
    ])).toEqual(['rgb(255, 244, 224)', 'rgb(138, 90, 0)']);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const top = (await page.locator('.top-bar').boundingBox())!;
    const banner = (await notice.boundingBox())!;
    const canvas = (await page.getByRole('region', { name: 'Workflow canvas', exact: true }).boundingBox())!;
    expect(banner.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
    expect(canvas.y).toBeGreaterThanOrEqual(banner.y + banner.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('toolbar', { name: 'Canvas tools' }).getByRole('button', { name: 'Add swap', exact: true })).toBeEnabled();
  });
}

test('/app Beta Mainnet notice follows the language preference', async ({ page }) => {
  await openBuilder(page);
  await expect(page.locator('.beta-notice')).toHaveText(betaNotice);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // Settings exposes one Language switch (PT/EN are visual labels). The accessible name translates with the locale.
  await page.getByRole('switch', { name: /^(Language|Idioma)$/ }).click();
  await expect(page.locator('.beta-notice')).toHaveText(betaNoticePt);
  await page.getByRole('switch', { name: /^(Language|Idioma)$/ }).click();
  await expect(page.locator('.beta-notice')).toHaveText(betaNotice);
});
