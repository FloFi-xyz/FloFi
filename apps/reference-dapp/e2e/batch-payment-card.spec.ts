// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02): the Batch Payment card on the normal Editor (passive wallet, every financial gate off; nothing is
 * simulated, signed or sent). The card is added from the existing rail, configured on the card itself (recipients added and removed, the count and the
 * exact total shown), and applied as ONE canonical step; a repeated recipient is named and never merged; the chat's exact batch sentence authors
 * the same ONE card; Portuguese names it "Pagamento em lote".
 *
 * WS02 review fixes: an unapplied Batch Payment draft holds Simulate back like every other unapplied card edit (FE-BATCH-01); a brand-new card states no
 * problem before it is edited (FE-BATCH-10); a network that does not offer the asset clears it, never ETH with the same amounts (FE-BATCH-07); the
 * total ignores a wrong address (FE-BATCH-11); Escape cancels a new card nobody has edited yet but never one whose recipients were typed (its Cancel
 * does; review F3) and the new card stays selected for its Delete (FE-BATCH-05).
 */
import type { Page } from '@playwright/test';
import { test, expect, installPassiveWallet, assertPassiveWallet, readWorkflowIr, sendChatCommand } from './fixtures';
import { replayProviderLogos } from './asset-logo-replay';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { editorSectionAction, openBuilder } from './build-entry-navigation';
import { chooseLanguage } from './app-origin';

const cards = (page: Page) => page.locator('.build-flow-surface .react-flow__node');
const financial = async (page: Page) => (JSON.parse(await readWorkflowIr(page)) as SemanticWorkflow).nodes.filter(node => !node.actionType.startsWith('mock-'));
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
async function open(page: Page) {
  await replayProviderLogos(page); await installPassiveWallet(page, '0x2105'); await openBuilder(page);
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('Hi FloFier!');
}

test('the Batch Payment card: add, edit and remove recipients, see the count and the exact total, apply ONE canonical step', async ({ page, networkGuard }) => {
  await page.setViewportSize({ width: 1536, height: 1080 });
  await open(page);
  await page.getByRole('button', { name: 'Add batch payment', exact: true }).click();
  const card = cards(page).last();
  await expect(card.locator('.composer-action-name')).toHaveText('Batch Payment');
  const form = card.getByRole('form', { name: 'Batch Payment recipients' });
  await expect(form.locator('[data-batch-row]')).toHaveCount(2);
  // FE-BATCH-10: a brand-new card states no problem yet; FE-BATCH-01: while it is a draft, Simulate waits for it.
  await expect(form.getByRole('alert')).toHaveCount(0);
  await expect(editorSectionAction(page, 'Simulate')).toBeDisabled();
  await expect(form.getByRole('combobox', { name: 'Network' })).toHaveValue('Base');
  await expect(form.getByRole('combobox', { name: 'Asset' })).toHaveValue('USDC');
  await form.getByRole('textbox', { name: 'Recipient 1 address' }).fill(A);
  await form.getByRole('textbox', { name: 'Recipient 1 amount (USDC)' }).fill('25');
  await form.getByRole('textbox', { name: 'Recipient 2 address' }).fill(B);
  await form.getByRole('textbox', { name: 'Recipient 2 amount (USDC)' }).fill('50');
  await form.getByRole('button', { name: 'Add recipient', exact: true }).click();
  await form.getByRole('textbox', { name: 'Recipient 3 address' }).fill(C);
  await form.getByRole('textbox', { name: 'Recipient 3 amount (USDC)' }).fill('75');
  await expect(form.locator('.batch-payment-summary')).toHaveText('3 recipients · Total: 150 USDC');
  // A fourth row added and removed again changes nothing.
  await form.getByRole('button', { name: 'Add recipient', exact: true }).click();
  await expect(form.locator('[data-batch-row]')).toHaveCount(4);
  await form.getByRole('button', { name: 'Remove recipient 4', exact: true }).click();
  await expect(form.locator('[data-batch-row]')).toHaveCount(3);
  await form.getByRole('button', { name: 'Apply batch payment', exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
  const nodes = await financial(page);
  expect(nodes.map(node => node.actionType)).toEqual(['asset.transfer.batch']);
  expect(nodes[0]!.chainId).toBe('eip155:8453');
  expect(nodes[0]!.inputs.filter(input => input.kind === 'ACCOUNT').map(input => (input.value as { address: string }).address)).toEqual([A, B, C]);
  expect(nodes[0]!.inputs.filter(input => input.kind === 'QUANTITY').map(input => (input.value as { amount: string }).amount)).toEqual(['25000000', '50000000', '75000000']);
  // The authored card keeps its own fields (an edit is applied as the same card, never as a new step).
  const applied = cards(page).first().getByRole('form', { name: 'Batch Payment recipients' });
  await expect(applied.locator('.batch-payment-summary')).toHaveText('3 recipients · Total: 150 USDC');
  await applied.getByRole('textbox', { name: 'Recipient 2 amount (USDC)' }).fill('60');
  await expect(applied.locator('.batch-payment-summary')).toHaveText('3 recipients · Total: 160 USDC');
  // FE-BATCH-01: an unapplied edit of the saved step is a draft like any other: Simulate waits until it is applied (or cancelled).
  await expect(editorSectionAction(page, 'Simulate')).toBeDisabled();
  await applied.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
  await expect(editorSectionAction(page, 'Simulate')).toBeEnabled();
  expect((await financial(page))[0]!.inputs.filter(input => input.kind === 'QUANTITY').map(input => (input.value as { amount: string }).amount)).toEqual(['25000000', '60000000', '75000000']);
  await assertPassiveWallet(page);
  networkGuard.assertClean();
});

test('a repeated recipient is named and never merged; nothing is applied', async ({ page, networkGuard }) => {
  await page.setViewportSize({ width: 1536, height: 1080 });
  await open(page);
  await page.getByRole('button', { name: 'Add batch payment', exact: true }).click();
  const form = cards(page).last().getByRole('form', { name: 'Batch Payment recipients' });
  await form.getByRole('textbox', { name: 'Recipient 1 address' }).fill(A);
  await form.getByRole('textbox', { name: 'Recipient 1 amount (USDC)' }).fill('1');
  await form.getByRole('textbox', { name: 'Recipient 2 address' }).fill(A);
  await form.getByRole('textbox', { name: 'Recipient 2 amount (USDC)' }).fill('2');
  await expect(form.getByRole('alert')).toHaveText('An address appears more than once. Remove the repeated recipient: payments are never merged.');
  await expect(form.getByRole('button', { name: 'Apply batch payment', exact: true })).toBeDisabled();
  // FE-BATCH-11: every amount is valid, so the exact total is shown although an address repeats.
  await expect(form.locator('.batch-payment-summary')).toHaveText('2 recipients · Total: 3 USDC');
  await expect(form.getByRole('textbox', { name: 'Recipient 2 address' })).toHaveAttribute('aria-invalid', 'true');
  expect(await financial(page)).toEqual([]);
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  networkGuard.assertClean();
});

test('a network without the asset clears it (never ETH); the total ignores a wrong address; Escape keeps an edited new card and cancels an untouched one; the new card\'s Delete removes it', async ({ page, networkGuard }) => {
  await page.setViewportSize({ width: 1536, height: 1080 });
  await open(page);
  await page.getByRole('button', { name: 'Add batch payment', exact: true }).click();
  const form = cards(page).last().getByRole('form', { name: 'Batch Payment recipients' });
  await form.getByRole('textbox', { name: 'Recipient 1 address' }).fill('0x1234');
  await form.getByRole('textbox', { name: 'Recipient 1 amount (USDC)' }).fill('0.5');
  await form.getByRole('textbox', { name: 'Recipient 2 address' }).fill(B);
  await form.getByRole('textbox', { name: 'Recipient 2 amount (USDC)' }).fill(' 1 ');
  // FE-BATCH-09/11: the trimmed amounts are valid, so the exact total is shown; only the wrong address is marked invalid.
  await expect(form.locator('.batch-payment-summary')).toHaveText('2 recipients · Total: 1.5 USDC');
  await expect(form.getByRole('alert')).toHaveText('Enter a valid 0x address for every recipient (a mixed-case address must match its checksum).');
  await expect(form.getByRole('textbox', { name: 'Recipient 1 address' })).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByRole('textbox', { name: 'Recipient 2 address' })).not.toHaveAttribute('aria-invalid', 'true');
  // FE-BATCH-07: Robinhood Chain offers no USDC: the asset is cleared (never switched to ETH with the same amounts) until the person picks one.
  await form.getByRole('combobox', { name: 'Network' }).selectOption('Robinhood Chain');
  await expect(form.getByRole('combobox', { name: 'Asset' })).toHaveValue('');
  await expect(form.getByRole('alert')).toHaveText('Choose an asset available for Batch Payment on this network.');
  await expect(form.locator('.batch-payment-summary')).toHaveText('2 recipients · Total: choose an asset');
  await expect(form.getByRole('button', { name: 'Apply batch payment', exact: true })).toBeDisabled();
  await form.getByRole('combobox', { name: 'Asset' }).selectOption('ETH');
  await expect(form.locator('.batch-payment-summary')).toHaveText('2 recipients · Total: 1.5 ETH');
  // Review F3: Escape never throws away a new card whose recipients were typed (they could not be brought back): it stays, with them, until its Cancel.
  await form.getByRole('textbox', { name: 'Recipient 2 amount (ETH)' }).press('Escape');
  await expect(cards(page)).toHaveCount(1);
  await expect(form.locator('.batch-payment-summary')).toHaveText('2 recipients · Total: 1.5 ETH');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  // FE-BATCH-10: a new card nobody has edited yet goes away on Escape, as on the other card editors (nothing typed is lost).
  await page.getByRole('button', { name: 'Add batch payment', exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
  await form.getByRole('textbox', { name: 'Recipient 1 address' }).press('Escape');
  await expect(cards(page)).toHaveCount(0);
  // FE-BATCH-05: a new card stays selected, so its toolbar Delete removes it.
  await page.getByRole('button', { name: 'Add batch payment', exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  expect(await financial(page)).toEqual([]);
  networkGuard.assertClean();
});

test('the chat\'s batch sentence authors ONE Batch Payment card; Portuguese names it "Pagamento em lote"', async ({ page, networkGuard }) => {
  await page.setViewportSize({ width: 1536, height: 1080 });
  await open(page);
  await sendChatCommand(page, `pay 25 USDC to ${A}, 50 USDC to ${B} and 75 USDC to ${C} on Base`);
  await expect(cards(page)).toHaveCount(1);
  const nodes = await financial(page);
  expect(nodes.map(node => node.actionType)).toEqual(['asset.transfer.batch']);
  await expect(cards(page).first().locator('.batch-payment-summary')).toHaveText('3 recipients · Total: 150 USDC');
  await chooseLanguage(page.context(), 'PT');
  await page.reload();
  await page.getByRole('button', { name: 'Adicionar pagamento em lote', exact: true }).click();
  const card = cards(page).last();
  await expect(card.locator('.composer-action-name')).toHaveText('Pagamento em lote');
  await expect(card.getByRole('form', { name: 'Destinatários do pagamento em lote' }).locator('.batch-payment-summary')).toHaveText('2 destinatários · Total: informe todos os valores');
  networkGuard.assertClean();
});
