// SPDX-License-Identifier: AGPL-3.0-only
import type { Page, Route } from '@playwright/test';
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import { SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { test, expect, applyPendingProposal, chooseWallet, readWorkflowIr } from './fixtures';
import { createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { installDevnetWallet } from './solana-devnet-fixtures';
import { installSupplyWallet } from './supply-fixtures';

/**
 * BUILD-SOLANA-MAINNET-001 PR B (requirements C, D, E) on the product Canvas. Nothing here quotes a public provider, signs or sends: Build
 * estimates are answered in the browser by a MOCKED double keyed to the exact snapshot the card asks about.
 */
const cards = (page: Page) => page.locator('.build-flow-surface .composer-card');
const pageErrors: string[] = [];
test.beforeEach(({ page }) => { pageErrors.length = 0; page.on('pageerror', error => pageErrors.push(error.message + '\n' + (error.stack ?? '').slice(0, 800))); });
test.afterEach(() => { expect(pageErrors).toEqual([]); });
const revision = (page: Page) => page.locator('.summary-bar');
const empty = (page: Page) => page.locator('.build-flow-surface .canvas-empty');
async function chat(page: Page, text: string) {
  await page.getByLabel('Describe your flow').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await applyPendingProposal(page);
}
async function selectAndDelete(page: Page, card: ReturnType<Page['locator']>) {
  await card.locator('.composer-action-title').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
}
/** MOCKED Build estimates: SOL → USDC answers USDC, USDC → SOL answers SOL, for exactly the snapshot (workflow hash) the card sent. */
async function mockedSolanaEstimates(page: Page, seen: string[]) {
  await page.route('**/api/build-estimate', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { workflow: { nodes: { nodeId: string; chainId: string; userConstraints: { kind: string; maximumBps?: number }[]; inputs: { name: string; value: { asset: { address: string } } }[] }[] }; nodeId: string };
    const node = body.workflow.nodes.find(item => item.nodeId === body.nodeId)!;
    const input = node.inputs.find(item => item.name === 'amount-in')!.value.asset.address;
    const toUsdc = input === SOLANA_MAINNET_TOKENS.SOL.mint;
    seen.push(toUsdc ? 'SOL→USDC' : 'USDC→SOL');
    const workflowHash = hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(body.workflow)));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, estimate: { workflowHash, nodeId: body.nodeId, chain: node.chainId,
      provider: 'Jupiter', expected: toUsdc ? '150.25' : '0.006655', minimum: toUsdc ? '149.5' : '0.00662', symbol: toUsdc ? 'USDC' : 'SOL',
      slippageBps: node.userConstraints.find(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS')?.maximumBps,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), usd: null } }) });
  });
}

test('Launch App starts with an empty Canvas and nothing adds an action afterwards: not time, a wallet connection or a network change', async ({ page }) => {
  test.setTimeout(90_000);
  await installSupplyWallet(page, { connected: false });
  await page.goto('/app');
  await expect(empty(page)).toContainText('Start your workflow');
  await expect(cards(page)).toHaveCount(0);
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '0');
  // Wait after the initial render: no delayed background process may create a card.
  await page.waitForTimeout(3_000);
  await expect(cards(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
  await chooseWallet(page, 'Browser wallet');
  // BUILD-FLOFI-PRODUCT-UX-001: header shows the short address; the connected network stays in the wallet title (details menu).
  await expect(page.locator('.build009-wallet-info')).toHaveAttribute('title', /Base Sepolia/);
  await page.waitForTimeout(1_000);
  await expect(cards(page)).toHaveCount(0); await expect(empty(page)).toBeVisible();
  // A reload starts empty too (execution-continuity.spec.ts covers a new visit with a finished run's pointer still in storage).
  await page.reload();
  await expect(empty(page)).toContainText('Start your workflow'); await expect(cards(page)).toHaveCount(0);
  await page.waitForTimeout(2_000);
  await expect(cards(page)).toHaveCount(0);
});

test('Add Swap → configure → delete leaves an empty Canvas with nothing in its place; the Canvas stays editable', async ({ page }) => {
  await page.route('**/api/build-estimate', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'ESTIMATE_UNAVAILABLE' }) }));
  await page.goto('/app');
  await chat(page, 'swap 2 USDC to WETH on Base slippage 50 bps');
  await expect(cards(page)).toHaveCount(1);
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '1');
  await selectAndDelete(page, cards(page).first());
  await expect(cards(page)).toHaveCount(0);
  await expect(empty(page)).toContainText('Start your workflow');
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '2');
  await page.waitForTimeout(1_000);
  await expect(cards(page)).toHaveCount(0);
  // Undo brings the step back; deleting it again (redo) empties the Canvas again.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  await chat(page, 'swap 3 USDC to WETH on Base slippage 50 bps');
  await expect(cards(page)).toHaveCount(1);
});

test('Add Bridge → configure → delete keeps an editable Canvas', async ({ page }) => {
  await installSupplyWallet(page); await page.goto('/app');
  // BUILD-FLOFI-PRODUCT-UX-001: header shows the short address; the connected network stays in the wallet title (details menu).
  await expect(page.locator('.build009-wallet-info')).toHaveAttribute('title', /Base Sepolia/);
  await page.getByRole('button', { name: 'Add bridge', exact: true }).click();
  const card = cards(page);
  await card.getByRole('textbox').fill('2.5'); await card.getByRole('textbox').press('Enter');
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '1');
  await selectAndDelete(page, card.first());
  await expect(cards(page)).toHaveCount(0);
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '2');
  await page.getByRole('button', { name: 'Add bridge', exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
});

test('deleting the middle of connected actions keeps a consistent graph, names what else it removed, and undo restores it', async ({ page }) => {
  await page.goto('/app');
  await chat(page, 'compose supply 0.1 USDC to Aave then borrow 0.01 USDC then swap borrowed USDC to WETH on Base Sepolia slippage 50 bps owner 0x1111111111111111111111111111111111111111');
  await expect(cards(page)).toHaveCount(3);
  const before = JSON.parse(await readWorkflowIr(page)) as { nodes: { nodeId: string }[] };
  // The lending Canvas fits its vertical layout first; select the Borrow card once the viewport has settled.
  await page.waitForTimeout(1_500);
  await cards(page).nth(1).locator('.composer-action-title').click({ force: true });
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  // Borrow is deleted; the Swap spends its output and cannot run without it, so it goes too and the owner is told. Supply stays.
  await expect(page.locator('.canvas-feedback')).toContainText('Also removed 1 linked step that cannot run without the deleted one. Undo restores it.');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('Supply');
  const after = JSON.parse(await readWorkflowIr(page)) as { nodes: { nodeId: string; dependencies: string[]; inputs: { kind: string }[] }[]; resourceEdges: unknown[] };
  expect(after.resourceEdges).toEqual([]);
  expect(after.nodes.every(node => node.dependencies.every(id => after.nodes.some(other => other.nodeId === id)) && !node.inputs.some(input => input.kind === 'OUTPUT_REFERENCE'))).toBe(true);
  await expect(page.locator('.build-flow-surface .react-flow__edge')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(cards(page)).toHaveCount(3);
  expect((JSON.parse(await readWorkflowIr(page)) as { nodes: { nodeId: string }[] }).nodes.map(node => node.nodeId)).toEqual(before.nodes.map(node => node.nodeId));
});

test('the Swap arrow inverts SOL/USDC to USDC/SOL on the same network, drops the old quote and re-quotes the new direction', async ({ page }) => {
  const seen: string[] = []; await mockedSolanaEstimates(page, seen);
  await installDevnetWallet(page, createMockedSolanaWallet());
  await page.goto('/app');
  await chat(page, 'Swap 1 SOL to USDC on Solana');
  // The owner's Solana wallet connects on the workflow's own cluster (mainnet-beta); it signs nothing here.
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
  await chooseWallet(page, 'Gryloo MOCKED Solana wallet', 'Solana');
  await expect(page.getByRole('group', { name: 'Wallet connection', exact: true })).toContainText(/[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}/);
  const card = cards(page).first();
  const source = card.getByRole('button', { name: 'Select source token', exact: true }), destination = card.getByRole('button', { name: 'Select destination token', exact: true });
  await expect(source).toContainText('SOL'); await expect(destination).toContainText('USDC');
  await expect(card.locator('.composer-destination-box')).toContainText('150.25');
  const arrow = card.getByRole('button', { name: 'Switch From and To tokens', exact: true });
  // The existing arrow, unchanged in place and look.
  await expect(arrow).toHaveClass(/composer-value-arrow/);
  const box = (await arrow.boundingBox())!; expect(Math.round(box.width)).toBe(Math.round(box.height));
  await arrow.click();
  await expect(source).toContainText('USDC'); await expect(destination).toContainText('SOL');
  await expect(card.locator('.composer-metadata')).toContainText('Solana');
  // The previous USDC estimate is gone; the new direction is quoted for exactly the inverted snapshot.
  await expect(card.locator('.composer-destination-box')).not.toContainText('150.25');
  await expect(card.locator('.composer-destination-box')).toContainText('0.006655');
  expect(seen).toContain('USDC→SOL');
  // The typed amount is now spent in USDC; nothing was applied yet (a draft), and Enter applies it.
  await expect(card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true })).toHaveValue('1');
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '1');
  await card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).press('Enter');
  await expect(revision(page)).toHaveAttribute('data-workflow-revision', '2');
  const swap = (JSON.parse(await readWorkflowIr(page)) as { nodes: { actionType: string; chainId: string; inputs: { name: string; value: { amount: string; asset: { address: string } } }[] }[] })
    .nodes.find(node => node.actionType === 'asset.swap.exact-input')!;
  expect(swap.chainId).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  expect(swap.inputs.find(input => input.name === 'amount-in')!.value).toMatchObject({ amount: '1000000', asset: { address: SOLANA_MAINNET_TOKENS.USDC.mint } });
});
