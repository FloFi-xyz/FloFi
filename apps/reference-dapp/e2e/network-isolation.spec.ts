// SPDX-License-Identifier: AGPL-3.0-only
import { negativeGuardTest, test, expect, SYNTHETIC_GUARD_URL } from './fixtures';
import { openBuilder } from './build-entry-navigation';

test('ordinary application page makes no external request or WebSocket attempt', async ({ page, networkGuard }) => {
  await openBuilder(page);
  // P0 approved UX (board 04): the Canvas header's name is its rename control, so the heading reads "Rename workflow: <name>".
  await expect(page.getByRole('heading', { name: 'Rename workflow: Your Workflow', exact: true })).toBeVisible();
  networkGuard.assertClean();
});

negativeGuardTest('guard negative self-test records and aborts one synthetic external attempt before egress', async ({ page, networkGuard }) => {
  await openBuilder(page);
  await page.evaluate(async (url) => { try { await fetch(url); } catch { /* Expected interception. */ } }, SYNTHETIC_GUARD_URL);
  expect(networkGuard.unexpected).toEqual([SYNTHETIC_GUARD_URL]);
  expect(() => networkGuard.assertClean()).toThrow(`Unexpected network attempts: ${SYNTHETIC_GUARD_URL}`);
});
