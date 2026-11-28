// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (E11, P2-04, A10): at about 785 px (and on a phone) the Editor no longer stacks a tall Canvas above
 * the chat. The phone navigation is a Plan / Conversation switch: one pane at a time, both mounted (the conversation and the card selection
 * survive switching), the selected tab says which pane is shown, the footer's primary action stays in view, and the composer is in view once
 * focused (also when the visible height shrinks, as an on-screen keyboard does). Wider screens are unchanged. Loopback app only; no wallet.
 */
import { test, expect, sendChatCommand } from './fixtures';
import { openBuilder } from './build-entry-navigation';

for (const { width, height } of [{ width: 785, height: 900 }, { width: 390, height: 844 }]) {
  test(`Plan / Conversation switch at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openBuilder(page);
    const switcher = page.getByRole('navigation', { name: 'Editor navigation' });
    const plan = switcher.getByRole('tab', { name: 'Plan', exact: true }), conversation = switcher.getByRole('tab', { name: /^Conversation/ });
    const canvas = page.getByRole('region', { name: 'Workflow canvas', exact: true }), assistant = page.getByRole('complementary', { name: 'FloFi Assistant' });
    const composer = page.getByLabel('Describe your flow');
    // The Plan is shown first; the chat stays mounted (hidden), so nothing of the conversation is lost.
    await expect(plan).toHaveAttribute('aria-selected', 'true'); await expect(conversation).toHaveAttribute('aria-selected', 'false');
    await expect(canvas).toBeVisible(); await expect(assistant).toBeHidden(); await expect(page.locator('.copilot')).toHaveCount(1);
    await conversation.click();
    await expect(conversation).toHaveAttribute('aria-selected', 'true'); await expect(plan).toHaveAttribute('aria-selected', 'false');
    await expect(assistant).toBeVisible(); await expect(canvas).toBeHidden(); await expect(page.locator('.workflow-workspace .canvas')).toHaveCount(1);
    // The reply is right below the switch, not after a tall Canvas.
    await sendChatCommand(page, 'Swap 2 USDC to WETH on Base Sepolia slippage 50 bps');
    const reply = page.getByRole('log', { name: 'Conversation' }).locator('.message').last();
    await expect(reply).toBeInViewport();
    // The composer is in view once focused, above the footer, and stays in view when the visible height shrinks (an on-screen keyboard).
    await composer.focus();
    await expect(composer).toBeInViewport();
    const footerTop = async () => (await page.locator('.summary-bar').boundingBox())?.y ?? Number.POSITIVE_INFINITY;
    expect((await composer.boundingBox())!.y + (await composer.boundingBox())!.height).toBeLessThanOrEqual(await footerTop());
    await page.setViewportSize({ width, height: Math.round(height * 0.55) });
    await composer.focus();
    await expect(composer).toBeInViewport();
    await page.setViewportSize({ width, height });
    // The card added from the chat is on the Plan and selected, still selected after switching back and forth; the footer's action stays reachable.
    await plan.click();
    await expect(canvas).toBeVisible(); await expect(assistant).toBeHidden();
    const card = page.locator('.build-flow-surface .composer-card');
    await expect(card).toHaveCount(1); await expect(card).toHaveClass(/active/);
    await conversation.click(); await plan.click();
    await expect(card).toHaveClass(/active/);
    await expect(page.locator('.summary-bar')).toBeInViewport();
    await conversation.click();
    await expect(page.getByRole('log', { name: 'Conversation' }).locator('.message', { hasText: 'Swap added to your workflow' })).toHaveCount(1);
    // Tabs keyboard pattern: Left / Right select the other pane and keep focus on the tab.
    await conversation.focus(); await page.keyboard.press('ArrowLeft');
    await expect(plan).toBeFocused(); await expect(plan).toHaveAttribute('aria-selected', 'true'); await expect(canvas).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('wider screens keep the Canvas and the chat side by side, with no switch', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page);
  await expect(page.getByRole('navigation', { name: 'Editor navigation' })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Workflow canvas', exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'FloFi Assistant' })).toBeVisible();
});
