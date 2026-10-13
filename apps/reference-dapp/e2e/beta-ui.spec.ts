// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from './fixtures';

// BUILD-BETA-UI-001: copy and colour only. The header CTA keeps its destination, and the /app notice informs without gating anything.
const notice = "FloFi is currently in beta testing. Do not use real funds until the official launch announcement is published in the app and on FloFi's official social media channels.";

test('the landing header CTA reads Launch Beta FloFi on yellow and still opens the product', async ({ page }) => {
  await page.goto('/');
  const header = page.locator('header');
  const cta = header.getByRole('link', { name: 'Launch Beta FloFi', exact: true });
  await expect(cta).toHaveAttribute('href', '/app');
  expect(await cta.evaluate(element => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color])).toEqual(['rgb(250, 204, 21)', 'rgb(4, 27, 61)']);
  // The hero and closing Launch buttons are separate and unchanged.
  await expect(page.locator('main').getByRole('link', { name: 'Launch FloFi', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'PT', exact: true }).click();
  await expect(header.getByRole('link', { name: 'Abrir FloFi Beta', exact: true })).toHaveAttribute('href', '/app');
  await expect(page.locator('main').getByRole('link', { name: 'Abrir FloFi', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await cta.click();
  await expect(page).toHaveURL('/app');
});

for (const width of [320, 1440]) {
  test(`the /app beta notice sits between the header and the workflow canvas at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/app');
    const banner = page.getByRole('note').filter({ hasText: 'FloFi is currently in beta testing.' });
    await expect(banner).toHaveText(notice);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const top = (await page.locator('.top-bar').boundingBox())!;
    const box = (await banner.boundingBox())!;
    const canvas = (await page.getByRole('region', { name: 'Workflow canvas', exact: true }).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
    expect(canvas.y).toBeGreaterThanOrEqual(box.y + box.height);
    expect(box.width).toBeGreaterThanOrEqual(width - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Informational only: authoring stays available.
    await expect(page.getByRole('toolbar', { name: 'Canvas tools' }).getByRole('button', { name: 'Add swap', exact: true })).toBeEnabled();
  });
}
