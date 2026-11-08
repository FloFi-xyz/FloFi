// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD AAVE-V3-CARD-CATALOG-FIX-001: the Aave V3 reserve catalog inside the lending card's own token picker on Base mainnet, against the MOCKED
 * Base Aave market of the loopback harness (127.0.0.1:8562; `e2e/base-mainnet-aave.ts`): wallet 250 USDC + 0.4 WETH, 100 USDC supplied,
 * 0.01 WETH debt, USDbC frozen, cbBTC borrowing disabled. The card picks a reserve, the card updates at once, Review/Apply authors its exact
 * registry identity (chain + address + decimals) as a new revision. Test fixture data only: nothing is simulated, signed or sent, no public
 * network is contacted, and none of this is evidence of live mainnet execution.
 */
import { test, expect, readWorkflowIr } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { installSupplyWallet } from './supply-fixtures';
import { openBuilder, openEditorSection, reloadBuilder } from './build-entry-navigation';
import { expectReviewedImagesOnly, replayProviderLogos } from './asset-logo-replay';

test.skip(process.env.GRYLOO_BASE_MAINNET_E2E !== 'MOCKED_LOOPBACK_ONLY', 'The Aave card catalog requires the isolated Base loopback harness');
test.describe.configure({ mode: 'serial' });

const HARNESS = 'http://127.0.0.1:8562';
const BASE_WETH = '0x4200000000000000000000000000000000000006', BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_RESERVES = 15;
async function harness(path: string, body: unknown) {
  const response = await fetch(`${HARNESS}${path}`, { method: 'POST', body: JSON.stringify(body) });
  expect(response.ok, `${path} ${response.status}`).toBe(true);
}
// The app shares a market read per owner for a few seconds; each test reads with its own owner so a patched market is read fresh.
let owner = Date.now() % 1_000_000;
const nextOwner = () => `0x${(0x2000 + ++owner).toString(16).padStart(40, '0')}`;
// Provider logos of the token list (reserves without a reviewed local mark) are answered by the closed local replay, never fetched.
test.beforeEach(async ({ page }) => { await harness('/__harness/chain', { action: 'reset' }); await replayProviderLogos(page); });
test.afterEach(async ({ page }) => { await expectReviewedImagesOnly(page); });

const cards = (page: Page) => page.locator('.build-flow-surface .composer-card');
async function addCard(page: Page, action: 'supply' | 'borrow' | 'repay' | 'withdraw' | 'swap') {
  await page.getByRole('button', { name: `Add ${action}`, exact: true }).click();
  return cards(page).last();
}
async function openReserves(page: Page, card: Locator) {
  await card.getByRole('button', { name: 'Select source token', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Source token picker', exact: true });
  await expect(picker.locator('.lending-card-picker')).toHaveAttribute('data-live', 'LIVE');
  return picker;
}
const option = (picker: Locator, symbol: string) => picker.locator('label.lending-card-option').filter({ has: picker.page().getByRole('radio', { name: symbol, exact: true }) });
const shownSymbols = (picker: Locator) => picker.getByRole('radio').evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value));
async function closePicker(page: Page) {
  await page.getByRole('region', { name: 'Source asset picker', exact: true }).getByRole('button', { name: 'Hide token picker', exact: true }).click();
}
/** Every image in the picker loaded (no broken icon), and every generated mark has text. */
async function expectIconsRendered(picker: Locator) {
  const images = await picker.locator('.composer-token-avatar img').evaluateAll(elements => elements.map(element => {
    const image = element as HTMLImageElement; return { src: image.getAttribute('src'), ok: image.complete && image.naturalWidth > 0 }; }));
  expect(images.filter(image => !image.ok), JSON.stringify(images)).toEqual([]);
  const monograms = await picker.locator('.composer-token-avatar [data-mark="monogram"]').allInnerTexts();
  expect(monograms.every(text => text.trim().length > 0)).toBe(true);
}
async function nodeAsset(page: Page, actionType: string) {
  const workflow = JSON.parse(await readWorkflowIr(page)) as { revision: number; nodes: { nodeId: string; actionType: string; chainId: string; dependencies: string[]; inputs: { name: string; value: { asset: unknown; amount: string } }[] }[] };
  const node = workflow.nodes.find(item => item.actionType === actionType)!;
  return { revision: workflow.revision, node, amount: node.inputs.find(input => input.name === 'amount')!.value };
}

test('Supply on Base: the card picker lists the live Base catalog, held assets first, and WETH replaces USDC with its exact identity', async ({ page }) => {
  await installSupplyWallet(page, { chain: '0x2105', account: nextOwner() }); await openBuilder(page);
  const card = await addCard(page, 'supply');
  await expect(card.locator('.composer-operation')).toHaveText('USDC → Aave V3');
  const picker = await openReserves(page, card);
  await expect(picker.locator('.lending-card-picker')).toHaveAttribute('data-provenance', 'MOCKED');
  await expect(picker).toContainText('Test fixture data (MOCKED): not a live market read.');
  // The wallet's assets first (250 USDC, 0.4 WETH); the current reserve is focused.
  expect((await shownSymbols(picker)).sort()).toEqual(['USDC', 'WETH']);
  await expect(picker.getByRole('radio', { name: 'USDC', exact: true })).toBeChecked();
  await expect(picker.getByRole('radio', { name: 'USDC', exact: true })).toBeFocused();
  await expect(option(picker, 'WETH')).toContainText('Wallet 0.4 WETH');
  await expect(option(picker, 'USDC')).toContainText('Wallet 250 USDC');
  await expectIconsRendered(picker);
  await expect(option(picker, 'WETH').locator('img')).toHaveAttribute('src', '/brand/crypto/tokens/eth.svg');
  await expect(option(picker, 'USDC').locator('img')).toHaveAttribute('src', '/brand/crypto/usdc.png');
  // Zero balance is never "unsupported": the toggle reveals every other registered reserve, selectable; the frozen one says why.
  const toggle = picker.getByRole('checkbox', { name: /Show assets with 0 balance/ });
  await expect(toggle).toBeVisible();
  await toggle.check();
  await expect(picker.getByRole('radio')).toHaveCount(BASE_RESERVES);
  await expect(picker.getByRole('radio', { name: 'GHO', exact: true })).toBeEnabled();
  await expect(option(picker, 'GHO')).toContainText('Wallet 0 GHO');
  await expect(picker.getByRole('radio', { name: 'USDbC', exact: true })).toBeDisabled();
  await expect(option(picker, 'USDbC')).toContainText('Frozen');
  // An icon that used to be a broken placeholder renders from a reviewed local mark.
  await expect(option(picker, 'AAVE').locator('img')).toHaveAttribute('src', '/brand/crypto/tokens/aave.svg');
  await expectIconsRendered(picker);
  await toggle.uncheck();
  // The search covers the whole market catalog.
  const search = picker.getByRole('searchbox', { name: 'Search Base Aave reserves', exact: true });
  await search.fill('cbbtc');
  expect(await shownSymbols(picker)).toEqual(['cbBTC']);
  await search.fill('');
  // Choose WETH: the card changes at once, and the amount is entered again in WETH (never re-read from USDC).
  const revision = page.locator('.summary-bar');
  await expect(revision).toHaveAttribute('data-workflow-revision', '0');
  await option(picker, 'WETH').click();
  await expect(card.getByRole('button', { name: 'Select source token', exact: true })).toContainText('WETH');
  await expect(card.locator('.composer-operation')).toHaveText('WETH → Aave V3');
  await expect(card.getByRole('button', { name: 'Select source token', exact: true }).locator('img').first()).toHaveAttribute('src', '/brand/crypto/tokens/eth.svg');
  await closePicker(page);
  await expect(revision).toHaveAttribute('data-workflow-revision', '0');
  const amount = card.getByRole('textbox', { name: 'Source amount (WETH)', exact: true });
  // P0 workflow execution: the new card applies directly on Enter (no Review/Apply proposal).
  await amount.fill('0.1'); await amount.press('Enter');
  await expect(card.getByRole('button', { name: 'Review Supply change', exact: true })).toHaveCount(0);
  await expect(revision).toHaveAttribute('data-workflow-revision', '1');
  const applied = await nodeAsset(page, 'supply');
  expect(applied.node.chainId).toBe('eip155:8453');
  expect(applied.amount).toEqual({ asset: { chainId: 'eip155:8453', address: BASE_WETH, decimals: 18 }, amount: '100000000000000000' });
  await expect(card.locator('.composer-operation')).toHaveText('WETH → Aave V3');
  // The authored card keeps WETH when it is selected again, and its own picker still shows it as the current reserve.
  const authored = await openReserves(page, card);
  await expect(authored.getByRole('radio', { name: 'WETH', exact: true })).toBeChecked();
  await closePicker(page);
  // Leaving Build and coming back keeps the exact reserve (this session's workflow; saving requires a signed-in account).
  await page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Dashboard', exact: true }).click();
  await openEditorSection(page, 'Build');
  expect((await nodeAsset(page, 'supply')).amount).toEqual(applied.amount);
  expect(await page.evaluate(() => (window as unknown as { supplyWalletRequests: { method: string }[] }).supplyWalletRequests.filter(request => /sign|send|switch/i.test(request.method)))).toEqual([]);
});

// P0 workflow execution: a reserve picked on an authored card is the owner's own edit — it applies directly once the amount is entered in the new
// asset (Enter or leaving the card), as one new revision; it never re-denominates the old amount and never needs a Review/Apply proposal.
test('an authored Supply changes reserve directly once its amount is entered in the new asset, as a new revision', async ({ page }) => {
  await installSupplyWallet(page, { chain: '0x2105', account: nextOwner() }); await openBuilder(page);
  const card = await addCard(page, 'supply');
  const usdc = card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  await usdc.fill('10'); await usdc.press('Enter');
  const revision = page.locator('.summary-bar');
  await expect(revision).toHaveAttribute('data-workflow-revision', '1');
  expect((await nodeAsset(page, 'supply')).amount).toEqual({ asset: { chainId: 'eip155:8453', address: BASE_USDC, decimals: 6 }, amount: '10000000' });
  const picker = await openReserves(page, card);
  await option(picker, 'WETH').click();
  await closePicker(page);
  // A draft only: the saved step is unchanged and the amount waits for a WETH value.
  await expect(revision).toHaveAttribute('data-workflow-revision', '1');
  const amount = card.getByRole('textbox', { name: 'Source amount (WETH)', exact: true });
  await expect(amount).toHaveValue('');
  // An empty amount in the new asset applies nothing (the step keeps its saved reserve and amount).
  await amount.press('Enter');
  await expect(revision).toHaveAttribute('data-workflow-revision', '1');
  await amount.fill('0.05'); await amount.press('Enter');
  await expect(revision).toHaveAttribute('data-workflow-revision', '2');
  await expect(card.getByRole('button', { name: 'Review Supply change', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Apply proposal', exact: true })).toHaveCount(0);
  expect((await nodeAsset(page, 'supply')).amount).toEqual({ asset: { chainId: 'eip155:8453', address: BASE_WETH, decimals: 18 }, amount: '50000000000000000' });
});

test('Borrow lists reserves by borrow configuration, not supply: disabled borrowing and frozen reserves cannot be chosen', async ({ page }) => {
  await installSupplyWallet(page, { chain: '0x2105', account: nextOwner() }); await openBuilder(page);
  const supply = await openReserves(page, await addCard(page, 'supply'));
  await supply.getByRole('checkbox', { name: /Show assets with 0 balance/ }).check();
  await expect(supply.getByRole('radio', { name: 'cbBTC', exact: true })).toBeEnabled();
  await closePicker(page);
  await reloadBuilder(page);
  const card = await addCard(page, 'borrow');
  const picker = await openReserves(page, card);
  const borrowable = await shownSymbols(picker);
  expect(borrowable).toHaveLength(BASE_RESERVES - 2);
  expect(borrowable).not.toContain('cbBTC'); expect(borrowable).not.toContain('USDbC');
  await expect(option(picker, 'WETH')).toContainText('APY');
  await expect(option(picker, 'WETH')).toContainText('Debt 0.01 WETH');
  // Kept discoverable behind the toggle, closed with their reason.
  await picker.getByRole('checkbox', { name: /Show reserves you can't borrow now/ }).check();
  await expect(picker.getByRole('radio', { name: 'cbBTC', exact: true })).toBeDisabled();
  await expect(option(picker, 'cbBTC')).toContainText('Borrowing disabled');
  await expect(picker.getByRole('radio', { name: 'USDbC', exact: true })).toBeDisabled();
  await option(picker, 'cbBTC').click({ force: true });
  await expect(picker.getByRole('radio', { name: 'USDC', exact: true })).toBeChecked();
  // Switch between eligible reserves.
  await option(picker, 'WETH').click();
  await expect(card.getByRole('button', { name: 'Select source token', exact: true })).toContainText('WETH');
  await expect(card.locator('.composer-operation')).toHaveText('Aave V3 → WETH');
  await option(picker, 'GHO').click();
  await expect(card.locator('.composer-operation')).toHaveText('Aave V3 → GHO');
  await expectIconsRendered(picker);
});

test('Repay offers only real debts and Withdraw only real supplied positions', async ({ page }) => {
  await installSupplyWallet(page, { chain: '0x2105', account: nextOwner() }); await openBuilder(page);
  const repay = await openReserves(page, await addCard(page, 'repay'));
  expect(await shownSymbols(repay)).toEqual(['WETH', 'USDC']);
  await expect(option(repay, 'WETH')).toContainText('Debt 0.01 WETH');
  // The current (default) reserve stays visible, closed: there is no USDC debt to repay.
  await expect(repay.getByRole('radio', { name: 'USDC', exact: true })).toBeChecked();
  await expect(option(repay, 'USDC')).toContainText('No debt to repay');
  await repay.getByRole('checkbox', { name: /Show reserves without debt/ }).check();
  await expect(repay.getByRole('radio', { name: 'GHO', exact: true })).toBeDisabled();
  await closePicker(page);
  await reloadBuilder(page);
  const withdraw = await openReserves(page, await addCard(page, 'withdraw'));
  expect(await shownSymbols(withdraw)).toEqual(['USDC']);
  await expect(option(withdraw, 'USDC')).toContainText('Supplied 100 USDC');
  await withdraw.getByRole('checkbox', { name: /Show reserves without a supplied position/ }).check();
  await expect(withdraw.getByRole('radio', { name: 'WETH', exact: true })).toBeDisabled();
  await expect(option(withdraw, 'WETH')).toContainText('Nothing supplied');
});

test('wallet-balance filtering never removes a supported reserve from discovery: an empty wallet still reaches and picks any reserve', async ({ page }) => {
  await harness('/__harness/aave', { reserves: { USDC: { walletBalance: '0' }, WETH: { walletBalance: '0' } } });
  await installSupplyWallet(page, { chain: '0x2105', account: nextOwner() }); await openBuilder(page);
  const card = await addCard(page, 'supply');
  const supply = await openReserves(page, card);
  await expect(supply).toContainText('Your wallet holds none of these assets on Base.');
  expect(await shownSymbols(supply)).toEqual(['USDC']);
  await supply.getByRole('searchbox').fill('GHO');
  expect(await shownSymbols(supply)).toEqual(['GHO']);
  await supply.getByRole('searchbox').fill('');
  await supply.getByRole('checkbox', { name: /Show assets with 0 balance/ }).check();
  await expect(supply.getByRole('radio')).toHaveCount(BASE_RESERVES);
  await option(supply, 'GHO').click();
  await expect(card.locator('.composer-operation')).toHaveText('GHO → Aave V3');
});

test('Swap USDC → WETH → Supply WETH: auto-connected, funded by the swap, and an asset change is flagged and applied directly as a new revision', async ({ page }) => {
  await installSupplyWallet(page, { chain: '0x2105', account: nextOwner() }); await openBuilder(page);
  const swap = await addCard(page, 'swap');
  await expect(swap.locator('.composer-operation')).toHaveText('USDC → WETH');
  await swap.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).fill('100');
  await swap.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).press('Enter');
  const revision = page.locator('.summary-bar');
  await expect(revision).toHaveAttribute('data-workflow-revision', '1');
  const supply = await addCard(page, 'supply');
  const picker = await openReserves(page, supply);
  await option(picker, 'WETH').click();
  await closePicker(page);
  await supply.getByRole('textbox', { name: 'Source amount (WETH)', exact: true }).fill('0.05');
  await supply.getByRole('textbox', { name: 'Source amount (WETH)', exact: true }).press('Enter');
  await expect(revision).toHaveAttribute('data-workflow-revision', '2');
  // Auto-connected in order (an ordering link, drawn on the Canvas), and the Supply spends the WETH the swap delivers.
  const ir = JSON.parse(await readWorkflowIr(page)) as { nodes: { nodeId: string; actionType: string; dependencies: string[] }[]; resourceEdges: unknown[] };
  const swapNode = ir.nodes.find(node => node.actionType === 'asset.swap.exact-input')!, supplyNode = ir.nodes.find(node => node.actionType === 'supply')!;
  expect(supplyNode.dependencies).toEqual([swapNode.nodeId]);
  expect(ir.resourceEdges).toEqual([]);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(supply.locator('.composer-funding-note')).toHaveText('Funded by step 1: spends the WETH it delivers.');
  // Choosing another asset is flagged before anything changes; applying it is a new revision that keeps the order but ends the funding.
  const again = await openReserves(page, supply);
  await expect(again.locator('.lending-card-picker-funding')).toHaveText('This step spends the WETH delivered by step 1.');
  // The same label on another network is another asset: Arbitrum One WETH is not what the Base swap delivers.
  const networks = page.getByRole('region', { name: 'Action network picker', exact: true });
  await networks.getByRole('button', { name: 'Arbitrum One', exact: true }).click();
  const moved = page.getByRole('region', { name: 'Source token picker', exact: true });
  await expect(moved.locator('.lending-card-picker-funding')).toContainText('Step 1 delivers WETH on Base: with WETH on Arbitrum One this step is no longer funded by it');
  await expect(supply.locator('.composer-funding-note')).toContainText('Step 1 delivers WETH on Base: this step will no longer be funded by it.');
  await networks.getByRole('button', { name: 'Base', exact: true }).click();
  const back = page.getByRole('region', { name: 'Source token picker', exact: true });
  await expect(back.locator('.lending-card-picker-funding')).toHaveText('This step spends the WETH delivered by step 1.');
  await expect(supply.locator('.composer-funding-note')).toHaveText('Funded by step 1: spends the WETH it delivers.');
  await option(back, 'USDC').click();
  await expect(back.locator('.lending-card-picker-funding')).toContainText('Step 1 delivers WETH on Base: with USDC on Base this step is no longer funded by it');
  await closePicker(page);
  await expect(supply.locator('.composer-funding-note')).toContainText('Step 1 delivers WETH on Base: this step will no longer be funded by it.');
  await expect(revision).toHaveAttribute('data-workflow-revision', '2');
  await supply.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).fill('25');
  await supply.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).press('Enter');
  await expect(revision).toHaveAttribute('data-workflow-revision', '3');
  const edited = await nodeAsset(page, 'supply');
  expect(edited.node.dependencies).toEqual([swapNode.nodeId]);
  expect(edited.amount).toEqual({ asset: { chainId: 'eip155:8453', address: BASE_USDC, decimals: 6 }, amount: '25000000' });
  await expect(supply.locator('.composer-funding-note')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});

test('the card catalog follows its network: Arbitrum One lists its own reserves by its own addresses, never Base\'s by symbol', async ({ page }) => {
  await installSupplyWallet(page, { chain: '0x2105', account: nextOwner() }); await openBuilder(page);
  const card = await addCard(page, 'supply');
  const picker = await openReserves(page, card);
  await option(picker, 'WETH').click();
  await page.getByRole('region', { name: 'Action network picker', exact: true }).getByRole('button', { name: 'Arbitrum One', exact: true }).click();
  const arbitrum = page.getByRole('region', { name: 'Source token picker', exact: true });
  // No Arbitrum harness here: the live read is unavailable, so every registered Arbitrum reserve is listed, selectable, nothing claimed.
  await expect(arbitrum.locator('.lending-card-picker')).toHaveAttribute('data-live', 'UNAVAILABLE');
  await expect(arbitrum.getByRole('radio')).toHaveCount(20);
  await expect(arbitrum.getByRole('radio', { name: 'USDC.e', exact: true })).toBeEnabled();
  await expect(arbitrum.getByRole('radio', { name: 'WETH', exact: true })).toBeChecked();
  const arbitrumWeth = await option(arbitrum, 'WETH').getAttribute('data-reserve');
  expect(arbitrumWeth).toBe('0x82af49447d8a07e3bd95bd0d56f35241523fbab1');
  await expect(card.locator('.composer-chain')).toHaveText('Arbitrum One');
  await closePicker(page);
  await card.getByRole('textbox', { name: 'Source amount (WETH)', exact: true }).fill('0.2');
  await card.getByRole('textbox', { name: 'Source amount (WETH)', exact: true }).press('Enter');
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '1');
  expect((await nodeAsset(page, 'supply')).amount).toEqual({ asset: { chainId: 'eip155:42161', address: arbitrumWeth, decimals: 18 }, amount: '200000000000000000' });
});
