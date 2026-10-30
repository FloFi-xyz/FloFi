// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, sendChatCommand, readWorkflowIr, installPassiveWallet, assertPassiveWallet } from './fixtures';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { openBuilder } from './build-entry-navigation';

test.beforeEach(async ({ page }) => { await installPassiveWallet(page); });
test.afterEach(async ({ page }) => { await assertPassiveWallet(page); });

test('chat and canvas round-trip through the same semantic revision', async ({ page }) => {
  await openBuilder(page);
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '0');
  await sendChatCommand(page, 'swap 2 USDC to WETH on Base slippage 50 bps');
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
  const card = page.locator('.build-flow-surface .composer-card');
  await expect(card).toHaveCount(1);
  await card.getByRole('textbox', { name: 'Source amount (USDC)' }).fill('2.5');
  await card.getByRole('textbox', { name: 'Source amount (USDC)' }).press('Enter');
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '2');
  const edited = JSON.parse(await readWorkflowIr(page)) as SemanticWorkflow;
  expect(edited.nodes.find(node => node.nodeId === 'node-002')?.inputs.find(input => input.name === 'amount-in')).toMatchObject({ kind: 'QUANTITY', value: { amount: '2500000' } });
  await sendChatCommand(page, 'set node-002 amount 3');
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '3');
  await expect(card.getByRole('textbox', { name: 'Source amount (USDC)' })).toHaveValue('3');
  const roundTrip = JSON.parse(await readWorkflowIr(page)) as SemanticWorkflow;
  expect(roundTrip.nodes.find(node => node.nodeId === 'node-002')?.inputs.find(input => input.name === 'amount-in')).toMatchObject({ kind: 'QUANTITY', value: { amount: '3000000' } });
  expect(roundTrip.nodes.length).toBe(edited.nodes.length);
});
