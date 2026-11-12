// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001 (workstream 3): an ordinary Supply, Borrow, Repay or Withdraw amount edit on an Arbitrum One Canvas
 * card applies directly — Enter (keyboard) or leaving the card (pointer) — as one new workflow revision, with no Review/Apply proposal. An
 * invalid amount is refused and changes nothing, and nothing is simulated, signed or sent (passive wallet; replay model; no financial gate).
 */
import { test, expect, assertPassiveWallet, installPassiveWallet, readWorkflowIr } from './fixtures';
import { replayProviderLogos } from './asset-logo-replay';
import { openBuilder } from './build-entry-navigation';
import type { Page } from '@playwright/test';

type Ir = { readonly revision: number; readonly nodes: readonly { readonly nodeId: string; readonly actionType: string; readonly dependencies: readonly string[];
  readonly userConstraints: readonly { readonly kind: string; readonly quantity?: { readonly amount: string } }[] }[] };
const revision = (page: Page) => page.locator('.summary-bar');
async function author(page: Page, prompt: string, added: RegExp) {
  await replayProviderLogos(page); await installPassiveWallet(page, '0xa4b1'); await openBuilder(page);
  await page.locator('#mock-prompt').fill(prompt); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log', { name: 'Conversation' }).locator('.message.ai').last()).toContainText(added);
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '1');
  return page.locator('.build-flow-surface .composer-card').first();
}
async function noProposal(page: Page) {
  await expect(page.getByRole('button', { name: /^Review (Supply|Borrow|Repay|Withdraw) change$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply proposal', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Workflow edit review', exact: true })).toHaveCount(0);
}
const amountOf = (ir: Ir) => ir.nodes[0]!.userConstraints.find(c => c.quantity)?.quantity?.amount;

for (const [action, prompt, from, to, units] of [
  ['Supply', 'Please supply 100 USDC on Arbitrum', '100', '75', '75000000'],
  ['Borrow', 'Please borrow 20 USDC on Arbitrum', '20', '0.5', '500000'],
  ['Repay', 'Please repay 10 USDC on Arbitrum', '10', '4', '4000000'],
  ['Withdraw', 'Please withdraw 50 USDC from Aave on Arbitrum', '50', '25', '25000000'],
] as const) test(`${action} ${from} → ${to} USDC + Enter applies at once, as one new revision, with no proposal`, async ({ page, networkGuard }) => {
  const card = await author(page, prompt, new RegExp(`${action} added to your workflow`));
  const amount = card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  await expect(amount).toHaveValue(from);
  const before = JSON.parse(await readWorkflowIr(page)) as Ir;
  await noProposal(page);
  await amount.fill(to);
  // A draft is not the workflow until it is applied.
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '1');
  await expect(card.locator('.composer-amount-hint')).toHaveText('Press Enter to apply');
  await amount.press('Enter');
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '2');
  await expect(amount).toHaveValue(to);
  await noProposal(page);
  const after = JSON.parse(await readWorkflowIr(page)) as Ir;
  expect(amountOf(after)).toBe(units);
  // The same step (same id, action and links), only its amount changed; nothing was simulated, signed or sent.
  expect(after.nodes.map(n => [n.nodeId, n.actionType, n.dependencies])).toEqual(before.nodes.map(n => [n.nodeId, n.actionType, n.dependencies]));
  await expect(page.getByRole('button', { name: 'Simulate workflow', exact: true })).toBeEnabled();
  await assertPassiveWallet(page); networkGuard.assertClean();
});

test('Supply 1 → 0.0010 WETH + Enter shows 0.001 WETH at once (the same amount, normalized), keeping WETH', async ({ page, networkGuard }) => {
  const card = await author(page, 'Please supply 1 WETH to Aave on Arbitrum', /Supply added to your workflow: 1 WETH/);
  const amount = card.getByRole('textbox', { name: 'Source amount (WETH)', exact: true });
  await amount.fill('0.0010'); await amount.press('Enter');
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '2');
  await expect(amount).toHaveValue('0.001');
  await expect(card.locator('.composer-amount-token').first()).toHaveText('WETH');
  expect(amountOf(JSON.parse(await readWorkflowIr(page)) as Ir)).toBe('1000000000000000');
  await noProposal(page); await assertPassiveWallet(page); networkGuard.assertClean();
});

test('pointer: leaving the card applies a valid Borrow amount; an invalid amount is refused and changes nothing', async ({ page, networkGuard }) => {
  const card = await author(page, 'Please borrow 20 USDC on Arbitrum', /Borrow added to your workflow/);
  const amount = card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  for (const invalid of ['0', '-1']) {
    await amount.fill(invalid); await amount.press('Enter');
    await expect(card.getByRole('alert')).toBeVisible();
    await expect(revision(page)).toHaveAttribute('data-workflow-revision', '1');
    await noProposal(page);
  }
  await amount.fill('0.5');
  // Pointer: click empty Canvas well away from the card and the floating tools (the card loses focus without Enter).
  const pane = page.locator('.build-flow-surface .react-flow__pane'), box = (await pane.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.75);
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '2');
  await expect(amount).toHaveValue('0.5');
  await noProposal(page);
  // Enter never submits the page or starts an execution: no wallet request, no Review, still on the Canvas.
  await expect(page.getByRole('button', { name: 'Simulate workflow', exact: true })).toBeVisible();
  await assertPassiveWallet(page); networkGuard.assertClean();
});

// P0 workflow execution (Scenario A, the owner's production report): in a CONNECTED three-step workflow — Swap USDC → WETH, Supply WETH (funded by
// the swap), Borrow USDC on Arbitrum One — every amount edit applies directly: Enter (keyboard), leaving the card (pointer) or a pause after
// typing. No "Review <Action> change" and no "Apply proposal" ever appear; each edit is one new revision of the same steps and links; nothing is
// simulated, signed or sent.
test('Scenario A: Swap → Supply WETH → Borrow, edited by Enter, by leaving the card and by a typing pause, never needs Review/Apply', async ({ page, networkGuard }) => {
  await replayProviderLogos(page); await installPassiveWallet(page, '0xa4b1'); await openBuilder(page);
  const send = async (prompt: string, added: RegExp) => {
    await page.locator('#mock-prompt').fill(prompt); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('log', { name: 'Conversation' }).locator('.message.ai').last()).toContainText(added);
  };
  await send('Please Swap 10 USDC for WETH on Arbitrum', /Swap added to your workflow|Interpreted as/);
  await send('Please supply 1 WETH to Aave on Arbitrum', /Supply added to your workflow/);
  await send('Please borrow 20 USDC on Arbitrum', /Borrow added to your workflow/);
  const ir = async () => JSON.parse(await readWorkflowIr(page)) as Ir;
  const before = await ir();
  expect(before.nodes.map(n => n.actionType)).toEqual(['asset.swap.exact-input', 'supply', 'borrow']);
  const start = Number(await revision(page).getAttribute('data-workflow-revision'));
  const cards = page.locator('.build-flow-surface .composer-card');
  const swap = cards.nth(0), supply = cards.nth(1), borrow = cards.nth(2);
  // The Supply spends the WETH the swap delivers (the sequence funds it), exactly as the owner built it.
  await expect(supply).toContainText(/Funded by step 1/);
  await noProposal(page);

  // Supply WETH 1 → 0.0013 + Enter: applied at once.
  const supplyAmount = supply.getByRole('textbox', { name: 'Source amount (WETH)', exact: true });
  await supplyAmount.fill('0.0013'); await supplyAmount.press('Enter');
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', String(start + 1));
  await expect(supplyAmount).toHaveValue('0.0013');
  await noProposal(page);
  // Borrow 20 → 0.8 by leaving the card (pointer, no Enter).
  const borrowAmount = borrow.getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  await borrowAmount.fill('0.8');
  const pane = page.locator('.build-flow-surface .react-flow__pane'), box = (await pane.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.8);
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', String(start + 2));
  await noProposal(page);
  // Swap 10 → 3: typed and left alone (no Enter, focus stays in the field) applies after a short pause, keeping exactly the typed text.
  const swapAmount = swap.getByRole('textbox', { name: /Source amount/ }).first();
  await swapAmount.fill('3');
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', String(start + 3), { timeout: 5_000 });
  await expect(swapAmount).toHaveValue('3');
  await expect(swapAmount).toBeFocused();
  await noProposal(page);

  // The same three steps and links; only their amounts changed (WETH 18 decimals, USDC 6).
  const after = await ir();
  expect(after.nodes.map(n => [n.nodeId, n.actionType, n.dependencies])).toEqual(before.nodes.map(n => [n.nodeId, n.actionType, n.dependencies]));
  expect(after.nodes.map(n => n.userConstraints.find(c => c.quantity)?.quantity?.amount)).toEqual(['3000000', '1300000000000000', '800000']);
  await assertPassiveWallet(page); networkGuard.assertClean();
});
