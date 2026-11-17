// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (EXEC-01) — the production incident (a Uniswap v3 position: the first approval confirmed, the Review
 * then expired, the second approval was prepared under the expired Review and refused at the wallet hand-off) replayed in the browser with the
 * real store, server actions and durable run: Simulate → Review → authorize → approve USDC → confirmed and reconciled → time passes beyond the
 * Review's expiry → FloFi refuses to prepare the next request and refreshes the SAME run's Review (the confirmed approval is kept, never asked
 * again) → reload → explicit authorization → approve WETH → mint → reconciled.
 *
 * MOCKED loopback Base Sepolia chain, its scripted owner wallet and the harness clock (no public network, no broadcast, FloFi signs nothing).
 * The product's shared Review must refuse to authorize a MOCKED result (release-financial-provenance.spec.ts), so the wallet requests are made
 * from the loopback-only engineering liquidity panel; the workflow itself is written in the FloFi chat.
 */
import type { Page } from '@playwright/test';
import { test, expect, openSimulationDetails } from './fixtures';
import { advanceUniswapHarness, installUniswapWallet, resetUniswapHarness, sendRequests, walletSends, UNI_E2E_OWNER as owner } from './uniswap-liquidity-fixtures';
import { openBuilder, openEditorSection, reloadBuilder } from './build-entry-navigation';

test.skip(process.env.GRYLOO_UNISWAP_LIQUIDITY_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Requires the MOCKED loopback Uniswap liquidity harness');
test.setTimeout(180_000);
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e', WETH = '0x4200000000000000000000000000000000000006', NPM = '0x27f971cb582bf9e50f397e4d29a5c7a34f11faa2';
const APPROVE = '0x095ea7b3', MINT = '0x88316456';
const chat = (page: Page) => page.locator('.chat-messages[role="log"]');
const flofi = (page: Page) => chat(page).locator('.message:not(.you):not(.conversation-execution-message)').last();
const region = (page: Page) => page.getByRole('region', { name: 'Base Sepolia liquidity' });
const transactions = (page: Page) => region(page).getByRole('list', { name: 'Liquidity transactions' });
const execute = (page: Page, label: string) => region(page).getByRole('button', { name: `Execute: ${label}` }).click();
const accept = (page: Page) => region(page).getByRole('button', { name: 'Accept liquidity review' }).click();
const sent = async (page: Page) => (await sendRequests(page)).map(t => [t.to, t.data?.slice(0, 10)]);

test.beforeEach(async () => { await resetUniswapHarness(); });

test('an expired Review between the two approvals is refreshed on the same run, authorized again, and the position is minted and reconciled', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installUniswapWallet(page);
  await openBuilder(page);
  // The workflow is written in the chat. The pool's MOCKED price is about 159 USDC per WETH: the range is around it.
  await page.locator('#mock-prompt').fill('add liquidity 10 USDC and 0.005 WETH from 140 to 180 USDC per WETH on Base Sepolia slippage 100 bps');
  await page.locator('.chat-form button[type=submit]').click();
  await expect(flofi(page)).toContainText('Would you like to add another action or review your workflow?', { timeout: 30_000 });
  const simulate = page.locator('.canvas-primary-action [data-lifecycle-action="simulate"]');
  await expect(simulate).toBeEnabled({ timeout: 30_000 });
  await simulate.click();
  await openSimulationDetails(page);
  await expect(region(page)).toContainText('Approve USDC (exact amount) → Approve WETH (exact amount) → Mint the position NFT', { timeout: 60_000 });
  expect(await walletSends()).toBe(0);

  // Review → authorize → the exact USDC approval, confirmed and reconciled.
  await accept(page);
  await execute(page, 'Approve USDC (exact amount)');
  await expect(transactions(page)).toContainText('Approve USDC (exact amount): confirmed', { timeout: 60_000 });
  expect(await walletSends()).toBe(1);

  // The owner takes longer than the Review allows (120 s on this profile) before continuing.
  await advanceUniswapHarness(130);
  await execute(page, 'Approve WETH (exact amount)');
  // FloFi refuses to prepare the WETH request under the expired Review, says why, and refreshes the SAME run's Review: only the WETH approval
  // and the mint remain. Nothing was sent, nothing is prepared, and nothing happens without a new authorization.
  await expect(region(page)).toContainText('Your Review expired before FloFi asked your wallet for the next request, so nothing was sent.', { timeout: 60_000 });
  await expect(region(page)).toContainText('Approve WETH (exact amount) → Mint the position NFT');
  await expect(region(page)).not.toContainText('Approve USDC (exact amount) → Approve WETH');
  await expect(transactions(page)).toContainText('Approve USDC (exact amount): confirmed');
  await expect(region(page).getByRole('button', { name: /^Execute:/ })).toHaveCount(0);
  await expect(region(page).getByRole('button', { name: 'Accept liquidity review' })).toBeVisible();
  expect(await walletSends()).toBe(1);

  // A reload in between: the run is recovered with its confirmed approval and its refreshed Review still waiting for the owner.
  await reloadBuilder(page);
  await openEditorSection(page, 'Execute');
  await openSimulationDetails(page);
  await expect(region(page)).toContainText('Recovered run', { timeout: 30_000 });
  await expect(transactions(page)).toContainText('Approve USDC (exact amount): confirmed');
  await expect(region(page).getByRole('button', { name: /^Execute:/ })).toHaveCount(0);
  expect(await walletSends()).toBe(1);

  // Explicit authorization of the refreshed Review, then only the remaining requests.
  await accept(page);
  await execute(page, 'Approve WETH (exact amount)');
  await expect(transactions(page)).toContainText('Approve WETH (exact amount): confirmed', { timeout: 60_000 });
  await execute(page, 'Mint the position NFT');
  await expect(region(page).getByRole('region', { name: 'Liquidity result' })).toContainText(`is owned by your wallet ${owner}`, { timeout: 60_000 });
  await expect(region(page)).toContainText('Evidence: MOCKED');
  // Three wallet requests in all: the USDC approval once, the WETH approval, the mint; each from the owner on Base Sepolia, never by FloFi.
  expect(await walletSends()).toBe(3);
  expect(await sent(page)).toEqual([[WETH, APPROVE], [NPM, MINT]]);
  const href = await page.getByRole('link', { name: 'Download Evidence Bundle' }).getAttribute('href');
  const evidence = JSON.parse(decodeURIComponent(href!.split(',')[1]!)) as { bundle: { outcome: string }; transactions: { step: string; reviewCommitment: string }[] };
  expect(evidence.bundle.outcome).toBe('RECONCILED');
  expect(evidence.transactions.map(t => t.step)).toEqual(['APPROVE_TOKEN0', 'APPROVE_TOKEN1', 'MINT']);
  // The USDC approval was authorized under the original Review; the WETH approval and the mint under the refreshed one.
  expect(evidence.transactions[0]!.reviewCommitment).not.toBe(evidence.transactions[1]!.reviewCommitment);
  expect(evidence.transactions[1]!.reviewCommitment).toBe(evidence.transactions[2]!.reviewCommitment);
  for (const tx of await sendRequests(page)) expect([tx.from, tx.chainId, tx.value]).toEqual([owner, '0x14a34', '0x0']);
  void USDC;
  expect(errors).toEqual([]);
});
