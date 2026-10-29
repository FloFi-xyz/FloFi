// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, sendChatCommand, openProposalReview, readWorkflowIr, openFirstActionSettings, installPassiveWallet, assertPassiveWallet } from './fixtures';
import type { Page } from '@playwright/test';
import { hashArtifactBytes, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { readyForVisualCapture } from './mode-a-fixtures';

test.beforeEach(async ({ page }) => { await installPassiveWallet(page); });
test.afterEach(async ({ page }) => { await assertPassiveWallet(page); });

const prompt = (page: Page) => page.getByLabel('Describe your flow');
const send = async (page: Page, text: string) => {
  await prompt(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
};
/** BUILD-FLOFI-CONVERSATIONAL-001: a valid chat request is committed at once (no proposal to apply). */
const commit = sendChatCommand;
const selectSwap = openFirstActionSettings;
const settings = (page: Page) => page.getByRole('dialog', { name: 'Action settings', exact: true });
/** A composition that would replace the workflow (dropping its Swap): the chat keeps that change a Canvas proposal. */
const REPLACING = 'compose supply 0.1 USDC to Aave then borrow 0.01 USDC then swap borrowed USDC to WETH on Base Sepolia slippage 50 bps owner 0x1111111111111111111111111111111111111111';
const workflow = async (page: Page) => JSON.parse(await readWorkflowIr(page)) as SemanticWorkflow;
const hash = (value: unknown) => hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(value)));
const createCanvas = async (page: Page, direction: 'USDC_TO_WETH' | 'WETH_TO_USDC', amount: string, slippage: string) => {
  await expect(page.getByText('Advanced action setup', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  const card = page.locator('.build-flow-surface .composer-card');
  if (direction === 'WETH_TO_USDC') {
    await card.getByRole('button', { name: 'Select source token', exact: true }).click();
    const picker = page.getByRole('region', { name: 'Source token picker', exact: true });
    await picker.locator('label', { has: page.getByRole('radio', { name: 'WETH', exact: true }) }).click();
    await page.getByRole('button', { name: 'Hide token picker', exact: true }).click();
  }
  // BUILD-FIX-UX-001: the amount applies on Enter; a new Canvas swap starts at 100 bps, and another limit is one direct settings edit.
  const input = card.getByRole('textbox', { name: `Source amount (${direction === 'USDC_TO_WETH' ? 'USDC' : 'WETH'})`, exact: true });
  await input.fill(amount); await input.press('Enter');
  if (slippage !== '100') {
    await selectSwap(page);
    await settings(page).getByLabel('Slippage (bps)', { exact: true }).fill(slippage);
    await page.getByRole('button', { name: 'Apply slippage', exact: true }).click();
  }
};

for (const [direction, from, to, amount] of [
  ['USDC_TO_WETH', 'USDC', 'WETH', '2.25'],
  ['WETH_TO_USDC', 'WETH', 'USDC', '0.125'],
] as const) {
  test(`${from} to ${to}: actual chat and canvas inputs yield equal semantic hashes`, async ({ page }) => {
    await page.goto('/app');
    await commit(page, `swap ${amount} ${from} to ${to} on Base slippage 100 bps`);
    await expect(page.getByRole('log', { name: 'Conversation' }).locator('.message').last()).toContainText(`${from} → ${to}`);
    const chat = await workflow(page);
    expect(chat.revision).toBe(1);
    await expect(page.getByRole('region', { name: 'Deterministic review findings' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Authorize in wallet', exact: true })).toHaveCount(0);
    await page.reload();
    await createCanvas(page, direction, amount, '100');
    const canvas = await workflow(page);
    expect(canvas.revision).toBe(1);
    expect(canvas.workflowId).not.toBe(chat.workflowId);
    const reconstructed = { ...canvas, workflowId: chat.workflowId };
    expect(reconstructed).toEqual(chat);
    expect(hash(reconstructed)).toBe(hash(chat));
  });
}

test('mixed surface edits, dismissal, locks and stale proposals preserve revisions', async ({ page }) => {
  await page.goto('/app');
  await commit(page, 'swap 2 USDC to WETH on Base slippage 50 bps');
  await expect(page.locator('.summary-bar[data-workflow-revision="1"]')).toBeVisible();
  await selectSwap(page);
  const card = page.locator('.build-flow-surface .composer-card').first();
  await card.getByRole('textbox', { name: 'Source amount (USDC)' }).fill('3');
  await card.getByRole('textbox', { name: 'Source amount (USDC)' }).press('Enter');
  await commit(page, 'set node-002 slippage 75 bps');
  const chatCanvasChat = await workflow(page);
  expect(chatCanvasChat.revision).toBe(3);

  await page.reload();
  await createCanvas(page, 'USDC_TO_WETH', '2', '100');
  await commit(page, 'set node-002 amount 3');
  await selectSwap(page);
  // BUILD-FIX-UX-001: a slippage edit applies directly (no proposal and no unrelated "Apply amount"), and the card's settings show it.
  await settings(page).getByLabel('Slippage (bps)', { exact: true }).fill('75');
  await page.getByRole('button', { name: 'Apply slippage', exact: true }).click();
  await expect(settings(page)).toContainText('Applied limit: 75 bps (0.75%)');
  await expect(card.getByRole('button', { name: /^(Review|Apply) amount$/ })).toHaveCount(0);
  const canvasChatCanvas = await workflow(page);
  expect(canvasChatCanvas.workflowId).not.toBe(chatCanvasChat.workflowId);
  const reconstructed = { ...canvasChatCanvas, workflowId: chatCanvasChat.workflowId };
  expect(reconstructed).toEqual(chatCanvasChat);
  expect(hash(reconstructed)).toBe(hash(chatCanvasChat));

  // BUILD-FLOFI-CONVERSATIONAL-001: a chat change that would drop the Swap stays a proposal; made at revision 3, it is stale after the lock.
  await send(page, REPLACING);
  await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(1);
  await selectSwap(page);
  await settings(page).getByRole('button', { name: 'Lock amount' }).click();
  await expect(page.locator('.summary-bar[data-workflow-revision="4"]')).toBeVisible();
  await openProposalReview(page);
  await expect(page.getByRole('button', { name: 'Apply proposal' })).toBeDisabled();
  await expect(page.locator('.summary-bar[data-workflow-revision="4"]')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss proposal' }).click();
  // A chat edit of the locked amount is refused and changes nothing.
  await send(page, 'set node-002 amount 4');
  await expect(page.getByRole('log', { name: 'Conversation' }).locator('.message').last()).toContainText('amount is locked');
  await expect(page.locator('.summary-bar[data-workflow-revision="4"]')).toBeVisible();
  await selectSwap(page);
  await settings(page).getByRole('button', { name: 'Unlock amount' }).click();
  await expect(page.locator('.summary-bar[data-workflow-revision="5"]')).toBeVisible();
});

test('chat-committed and blocked review snapshots show unquoted unavailable state', async ({ page }) => {
  await page.goto('/app');
  // BUILD-FLOFI-CONVERSATIONAL-001: the chat commits the request at once and says what it added; nothing is quoted, approved or signed.
  await commit(page, 'swap 0.125 WETH to USDC on Base slippage 301 bps');
  await expect(page.getByRole('log', { name: 'Conversation' }).locator('.message').last()).toContainText('Swap added to your workflow: 0.125 WETH');
  await expect(page.getByRole('log', { name: 'Conversation' }).locator('.message').last()).toContainText('WETH → USDC');
  await readyForVisualCapture(page);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('chat-committed.png', { fullPage: true, maxDiffPixels: 0, mask: [page.locator('[data-workflow-ir]')] });
  await selectSwap(page);
  // The displayed IR carries this visit's own draft identity, so it is checked as text and masked in the screenshot below.
  expect((JSON.parse(await readWorkflowIr(page)) as SemanticWorkflow).workflowId).toMatch(/^workflow-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  await expect(page.getByRole('region', { name: 'Deterministic review findings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Authorize in wallet', exact: true })).toHaveCount(0);
  await page.locator('.build-flow-surface .composer-card').first().scrollIntoViewIfNeeded();
  // IntersectionObserver rounds a fully visible transformed card to 0.99999994.
  // Check its actual CSS bounds instead of comparing that floating-point ratio to 1.
  const bounds = await page.locator('.build-flow-surface .composer-card').first().boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await expect(page.getByRole('button', { name: 'Simulate workflow' })).toBeEnabled();
  // This profile has no cloud runtime: wait for the specific configuration diagnosis after the debounced read.
  const quoteNote = page.locator('.build-flow-surface .composer-quote-note');
  await expect(quoteNote).toHaveText('Quote service is not configured. Contact support.');
  await expect(quoteNote).toHaveAttribute('title', /^CLOUD_RUNTIME_NOT_CONFIGURED · [a-f0-9-]{36}$/);
  await readyForVisualCapture(page);
  // BUILD-FIX-UX-001: Canvas handles now react to hover; capture without the pointer resting on the card so the image is pointer-independent.
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('review-blocked.png', { fullPage: true, maxDiffPixels: 0, mask: [page.locator('[data-workflow-ir]')] });
});

test('Base authoring and review fit mobile, tablet and desktop widths', async ({ page }) => {
  await page.goto('/app');
  await createCanvas(page, 'USDC_TO_WETH', '2', '50');
  await selectSwap(page);
  await readWorkflowIr(page);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('region', { name: 'Deterministic review findings' })).toHaveCount(0);
    await expect(page.locator('.build-flow-surface .composer-card')).toBeVisible();
    await expect(page.locator('.canvas-primary-action').getByRole('button', { name: 'Simulate workflow', exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, `horizontal overflow at ${width}px`).toBe(false);
  }
});
