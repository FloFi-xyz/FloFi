// SPDX-License-Identifier: AGPL-3.0-only
/** Normal /app Copilot beside Canvas, committed model replay, no substituted server actions and no financial authority. */
import { test, expect, applyPendingProposal, assertPassiveWallet, installPassiveWallet, readWorkflowIr } from './fixtures';
import { replayProviderLogos, expectReviewedImagesOnly } from './asset-logo-replay';
import { ARBITRUM_CERTIFICATION_CASES as cases } from '../src/domain/arbitrum-certification.cases';
import { composeStrategy, semanticWorkflowHash } from '../src/engine/strategy-engine';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';

function expectWorkspaceMeaning(actual: SemanticWorkflow, before: SemanticWorkflow, canonical: SemanticWorkflow) {
  // Workspace UUIDs are hash-bound product identities. Standalone MCP uses workflow-local; do not claim equal raw hashes.
  expect(actual.workflowId).toBe(before.workflowId);
  expect(actual.workflowId).not.toBe(canonical.workflowId);
  const expected = { ...canonical, workflowId: before.workflowId };
  expect(actual).toEqual(expected);
  expect(semanticWorkflowHash(actual)).toBe(semanticWorkflowHash(expected));
  expect(semanticWorkflowHash(actual)).not.toBe(semanticWorkflowHash(canonical));
}

for (const c of cases) test(c.id + ': normal Copilot proposal → Apply → matching Canvas IR/hash', async ({ page, networkGuard }) => {
  await replayProviderLogos(page); await installPassiveWallet(page, '0xa4b1'); await page.goto('/app');
  const conversation = page.getByRole('log', { name: 'Conversation' });
  await expect(conversation).toContainText('Flofi Copilot ready in replay mode');
  await expect(page.getByLabel('Describe your flow')).toBeVisible();
  const before = JSON.parse(await readWorkflowIr(page)) as SemanticWorkflow;
  await page.locator('#mock-prompt').fill('Please ' + c.text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const answer = conversation.locator('.message.ai').last();
  await expect(answer).toContainText('Interpreted as “' + c.sentence + '”');
  await expect(answer.locator('small')).toHaveText('FLOFI COPILOT · AI');
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '0');
  await applyPendingProposal(page);
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
  const composed = composeStrategy(c.strategy); expect(composed.ok).toBe(true); if (!composed.ok) throw Error(composed.code);
  const workflow = JSON.parse(await readWorkflowIr(page)) as SemanticWorkflow;
  expectWorkspaceMeaning(workflow, before, structuredClone(composed.workflow) as SemanticWorkflow);
  const card = page.locator('.build-flow-surface .composer-card').first();
  await expect(card.getByRole('img', { name: /Arbitrum.*network/ }).first()).toBeVisible();
  await expectReviewedImagesOnly(page); await assertPassiveWallet(page); networkGuard.assertClean();
});

for (const c of cases.filter(c => ['Swap', 'Native Transfer', 'Supply'].includes(c.id))) test(c.id + ': Portuguese natural Copilot reaches the same Canvas', async ({ page, networkGuard }) => {
  await replayProviderLogos(page); await installPassiveWallet(page, '0xa4b1'); await page.goto('/app');
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('Flofi Copilot ready in replay mode');
  const before = JSON.parse(await readWorkflowIr(page)) as SemanticWorkflow;
  await page.locator('#mock-prompt').fill('Por favor, ' + c.pt);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const answer = page.getByRole('log', { name: 'Conversation' }).locator('.message.ai').last();
  await expect(answer).toContainText('Interpretado como “' + c.sentence + '”');
  await applyPendingProposal(page);
  const composed = composeStrategy(c.strategy); expect(composed.ok).toBe(true); if (!composed.ok) throw Error(composed.code);
  expectWorkspaceMeaning(JSON.parse(await readWorkflowIr(page)) as SemanticWorkflow, before, structuredClone(composed.workflow) as SemanticWorkflow);
  await assertPassiveWallet(page); networkGuard.assertClean();
});

for (const [text, explanation] of [
  ['Please supply 1 WETH to Aave on Arbitrum', 'USDC'],
  ['Please repay all 10 USDC debt on Arbitrum', 'partial'],
  ['Provide liquidity for USDC and WETH on Arbitrum', 'maximum amounts'],
  ['Please provide 10 USDC and 0.005 WETH liquidity on Arbitrum fee 0.02%', 'registered fee tiers'],
]) test('honest refusal/clarification without a proposal: ' + text, async ({ page, networkGuard }) => {
  await replayProviderLogos(page); await installPassiveWallet(page, '0xa4b1'); await page.goto('/app');
  await page.locator('#mock-prompt').fill(text!); await page.getByRole('button', { name: 'Send', exact: true }).click();
  const answer = page.getByRole('log', { name: 'Conversation' }).locator('.message.ai').last();
  await expect(answer).toContainText(explanation!); await expect(answer).not.toContainText(/COPILOT_|ASSET_|SUPPLY_|UNISWAP_/);
  await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(0);
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '0');
  await assertPassiveWallet(page); networkGuard.assertClean();
});

test('the existing generic network picker offers Arbitrum and chain-bound pinned assets with its existing mark', async ({ page, networkGuard }) => {
  await replayProviderLogos(page); await installPassiveWallet(page, '0xa4b1'); await page.goto('/app');
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  const card = page.locator('.build-flow-surface .composer-card').first();
  await card.getByRole('button', { name: 'Select destination token', exact: true }).click();
  const networks = page.getByRole('region', { name: 'Action network picker', exact: true });
  const arbitrum = networks.getByRole('button', { name: 'Arbitrum One', exact: true });
  await expect(arbitrum).toBeVisible(); await arbitrum.click(); await expect(arbitrum).toHaveAttribute('aria-pressed', 'true');
  const picker = page.getByRole('region', { name: 'Destination token picker', exact: true });
  for (const symbol of ['USDC', 'WETH']) await expect(picker.getByRole('radio', { name: symbol, exact: true })).toHaveCount(1);
  await expect(arbitrum.locator('img')).toHaveAttribute('src', '/brand/crypto/arbitrum.png');
  await expectReviewedImagesOnly(page); await assertPassiveWallet(page); networkGuard.assertClean();
});
