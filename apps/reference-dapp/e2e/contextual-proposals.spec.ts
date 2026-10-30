// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { test, expect, openProposalReview, applyPendingProposal, sendChatCommand, installPassiveWallet, assertPassiveWallet, assertNoFinancialCanvasAction } from './fixtures';
import { openBuilder } from './build-entry-navigation';

test.beforeEach(async ({ page }) => { await installPassiveWallet(page, '0x14a34'); await openBuilder(page); });
test.afterEach(async ({ page }) => { await assertPassiveWallet(page); });

const LENDING = 'compose supply 0.1 USDC to Aave then borrow 0.01 USDC then swap borrowed USDC to WETH on Base Sepolia slippage 50 bps owner 0x1111111111111111111111111111111111111111';
/**
 * BUILD-FLOFI-CONVERSATIONAL-001: a valid chat request is committed at once, so the contextual proposal remains only for a chat change that would
 * also drop a step the owner did not name (here, a composition that replaces the workflow's existing Swap). FloFi says so in the chat.
 */
async function replacingProposal(page: Page) {
  await sendChatCommand(page, 'swap 2 USDC to WETH on Base Sepolia slippage 50 bps');
  await page.getByLabel('Describe your flow').fill(LENDING);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('This change would also remove 1. Swap. Review it on the Canvas before applying; nothing changed yet.');
  await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(1);
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
}

test('outside click and Escape close the proposal without applying or dismissing it', async ({ page }) => {
  await replacingProposal(page);
  for (const close of ['outside', 'Escape']) {
    await openProposalReview(page);
    if (close === 'outside') await page.getByRole('heading', { name: 'FloFi Assistant', exact: true }).click();
    else await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Proposed change' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(1);
    await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
    await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(1);
  }
  await applyPendingProposal(page);
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '2');
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(3);
});

test('the explicit Dismiss control discards the proposal without changing the workflow', async ({ page }) => {
  await replacingProposal(page);
  await openProposalReview(page);
  await page.getByRole('button', { name: 'Dismiss proposal', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Proposed change' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(0);
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(1);
});

test('a three-step chat composition commits atomically and grants no financial authorization', async ({ page }) => {
  await sendChatCommand(page, LENDING);
  await expect(page.getByRole('log', { name: 'Conversation' }).locator('.message').last()).toContainText('Supply added to your workflow');
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(3);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Execute', exact: true }).click();
  await assertNoFinancialCanvasAction(page);
  await expect(page.getByRole('button', { name: 'Authorize in wallet', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Download Evidence Bundle' })).toHaveCount(0);
});
