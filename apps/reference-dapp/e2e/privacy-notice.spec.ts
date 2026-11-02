// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the first-access Privacy & Memory notice on /app — a centered dialog over a dimmed page, one "I agree"
 * checkbox, Continue and "Not now", and no wallet proof. The suites otherwise visit as a returning visitor (`answeredPrivacyNotice`); this spec
 * removes that answer first. Loopback only; nothing is signed or sent.
 */
import { test, expect } from './fixtures';
import { PRIVACY_NOTICE_COOKIE, PRIVACY_NOTICE_VERSION } from '../src/domain/privacy-notice';

const notice = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'Privacy & Memory', exact: true });
const answer = async (context: import('@playwright/test').BrowserContext) => (await context.cookies()).find(cookie => cookie.name === PRIVACY_NOTICE_COOKIE)?.value ?? null;
test.beforeEach(async ({ context }) => { await context.clearCookies({ name: PRIVACY_NOTICE_COOKIE }); });

test('first access to /app: a centered notice over a dimmed page; Continue needs "I agree", is remembered, and asks for no wallet proof', async ({ page, context, networkGuard }) => {
  await page.goto('/app');
  const dialog = notice(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This never changes a workflow, an approval, a signature or any movement of funds.');
  await expect(dialog).toContainText('No wallet proof is needed to answer.');
  await expect(dialog.getByRole('button', { name: /prove|verify|connect/i })).toHaveCount(0);
  // A modal dialog: centered, the page behind it dimmed and unreachable.
  const geometry = await dialog.evaluate(element => {
    const box = element.getBoundingClientRect(), backdrop = getComputedStyle(element, '::backdrop').backgroundColor;
    return { modal: element.matches(':modal'), center: Math.abs(box.left + box.width / 2 - innerWidth / 2), middle: Math.abs(box.top + box.height / 2 - innerHeight / 2), backdrop };
  });
  expect(geometry.modal).toBe(true); expect(geometry.center).toBeLessThan(2); expect(geometry.middle).toBeLessThan(2);
  expect(geometry.backdrop).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
  const proceed = dialog.getByRole('button', { name: 'Continue', exact: true });
  await expect(proceed).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'I agree', exact: true }).check();
  await proceed.click();
  await expect(dialog).toHaveCount(0);
  expect(await answer(context)).toBe(`${PRIVACY_NOTICE_VERSION}.AGREED`);
  for (const path of ['/app', '/app/dashboard', '/app/workflows']) {
    await page.goto(path); await expect(page.locator('.top-bar')).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  }
  networkGuard.assertClean();
});

test('"Not now" and Escape close the notice without any agreement, and it does not return on the next visit', async ({ page, context }) => {
  await page.goto('/app/dashboard');
  await notice(page).getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(notice(page)).toHaveCount(0);
  expect(await answer(context)).toBe(`${PRIVACY_NOTICE_VERSION}.NOT_NOW`);
  await page.reload(); await expect(page.locator('.top-bar')).toBeVisible(); await expect(notice(page)).toHaveCount(0);
  await context.clearCookies({ name: PRIVACY_NOTICE_COOKIE });
  await page.goto('/app'); await expect(notice(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(notice(page)).toHaveCount(0);
  expect(await answer(context)).toBe(`${PRIVACY_NOTICE_VERSION}.NOT_NOW`);
});

test('Privacy & memory accepts the agreement later without a wallet proof', async ({ page, context }) => {
  await page.goto('/app/privacy');
  await notice(page).getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Privacy & memory', exact: true })).toBeVisible();
  const agree = page.getByRole('button', { name: 'I agree to Privacy & Memory', exact: true });
  if (await agree.count()) {
    await agree.click();
    await expect(page.getByRole('status').filter({ hasText: 'You agreed to Privacy & Memory in this browser.' })).toBeVisible();
    expect(await answer(context)).toBe(`${PRIVACY_NOTICE_VERSION}.AGREED`);
  } else {
    // A deployment without Copilot learning keeps nothing: the page says so and offers no agreement to give.
    await expect(page.locator('.privacy-controls')).toContainText(/nothing about how you write is kept|within a conversation only/);
  }
});
