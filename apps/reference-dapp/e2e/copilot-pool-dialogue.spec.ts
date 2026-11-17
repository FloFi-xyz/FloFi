// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { test, expect, CHAT_COMMITTED } from './fixtures';
import { openBuilder } from './build-entry-navigation';
import { installDevnetWallet, resetDevnetHarness } from './solana-devnet-fixtures';
import { signRequests } from './jupiter-fixtures';

/**
 * BUILD-P1 pool conversational reliability, in the browser and in the public Mainnet-only product as deployed: an Orca SOL/USDC position on Solana
 * requested by conversation and its range answered in separate messages, exactly as in the production incident ("1usdc" → "lower"). The first
 * message is interpreted from a committed replay answer (e2e/copilot/replay-v2.json; no model is called); every later answer is FloFi's own reading.
 * The current pool price is read by FloFi through its read-only Orca mainnet service from the MOCKED loopback copy of the mainnet pool. Nothing is
 * signed or sent, and MOCKED data is never evidence of a mainnet position.
 */
if (process.env.FLOFI_COPILOT !== 'replay') throw new Error('copilot-pool-dialogue.spec.ts requires FLOFI_COPILOT=replay');
if (process.env.FLOFI_E2E_NETWORK_SCOPE !== 'PUBLIC_MAINNET') throw new Error('copilot-pool-dialogue.spec.ts certifies the public Mainnet-only product');

const conversation = (page: Page) => page.getByRole('log', { name: 'Conversation' });
const copilotSays = (page: Page) => conversation(page).locator('.message.ai').last();
const commits = (page: Page, count: number) => expect(conversation(page).locator('.message', { hasText: CHAT_COMMITTED })).toHaveCount(count);
async function ask(page: Page, text: string) {
  await page.locator('#mock-prompt').fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}
const mainnetSent = async () => (await (await fetch('http://127.0.0.1:8552/mainnet-control', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'sent' }) })).json() as { result: number }).result;
/** Live Build estimates are never requested from a provider in this suite. */
async function closedEstimates(page: Page) {
  await page.route('**/api/build-estimate', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'ESTIMATE_UNAVAILABLE' }) }));
}
/** No test network or test token is ever shown, and no generic failure replaces an answer to FloFi's own question. */
async function publicAndUnderstood(page: Page) {
  await expect(conversation(page)).not.toContainText(/devUSDC|Devnet|Sepolia/);
  await expect(conversation(page)).not.toContainText(/could not validate|still cannot prepare this request/);
}

test.beforeEach(async ({ page }) => {
  await closedEstimates(page);
  const wallet = await resetDevnetHarness(); await installDevnetWallet(page, wallet);
  await openBuilder(page);
});

test('the captured sequence: "1usdc" → Lower → "180" keeps every value and authors the Orca position on Solana', async ({ page }) => {
  await ask(page, 'Add liquidity on Orca on Solana with 0.1 SOL and 10 USDC');
  await expect(copilotSays(page)).toContainText('Which price range should the position use? Give the lower and upper prices in USDC per SOL');
  await ask(page, '1usdc');
  await expect(copilotSays(page)).toContainText('Is 1 USDC per SOL the lower or the upper price of the range?');
  await copilotSays(page).getByRole('button', { name: 'Lower', exact: true }).click();
  await expect(copilotSays(page)).toContainText('The lower price is 1 USDC per SOL. What upper price in USDC per SOL should the range use?');
  await ask(page, '180');
  await expect(copilotSays(page)).toContainText('Interpreted as “add liquidity 0.1 SOL and 10 USDC from 1 to 180 USDC per SOL on Solana slippage 100 bps”');
  await expect(copilotSays(page)).toContainText('Effective range after aligning to the pool\'s ticks');
  await expect(copilotSays(page)).toContainText('Pool price read on chain at slot');
  await commits(page, 1);
  await publicAndUnderstood(page);
  expect(await signRequests(page)).toBe(0); expect(await mainnetSent()).toBe(0);
});

test('a percentage answer ("faixa de 10%") is computed from the verified mainnet pool price and the effective range is shown', async ({ page }) => {
  await ask(page, 'Quero adicionar liquidez na Orca na Solana com 0,1 SOL e 10 USDC');
  await expect(copilotSays(page)).toContainText('Which price range should the position use?');
  await ask(page, 'faixa de 10%');
  await expect(copilotSays(page)).toContainText('Interpreted as “add liquidity 0.1 SOL and 10 USDC from');
  await expect(copilotSays(page)).toContainText(/Range: ±10% around the current verified pool price \([0-9.]+ USDC per SOL\)\./);
  await expect(copilotSays(page)).toContainText('Effective range after aligning to the pool\'s ticks');
  await commits(page, 1);
  await publicAndUnderstood(page);
  expect(await signRequests(page)).toBe(0); expect(await mainnetSent()).toBe(0);
});

test('the full range is not substituted for Orca, and an explicit change of a bound replaces only that bound', async ({ page }) => {
  await ask(page, 'Add liquidity on Orca on Solana with 0.1 SOL and 10 USDC');
  await expect(copilotSays(page)).toContainText('Which price range should the position use?');
  await ask(page, 'full range');
  await expect(copilotSays(page)).toContainText('The full range is not available for this pool in Flofi.');
  await ask(page, 'upper 180');
  await expect(copilotSays(page)).toContainText('The upper price is 180 USDC per SOL. What lower price in USDC per SOL should the range use?');
  await ask(page, 'actually make the upper 200');
  await expect(copilotSays(page)).toContainText('The upper price is 200 USDC per SOL.');
  await ask(page, '120');
  await expect(copilotSays(page)).toContainText('Interpreted as “add liquidity 0.1 SOL and 10 USDC from 120 to 200 USDC per SOL on Solana slippage 100 bps”');
  await commits(page, 1);
  await publicAndUnderstood(page);
  expect(await signRequests(page)).toBe(0); expect(await mainnetSent()).toBe(0);
});
