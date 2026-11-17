// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (EXEC-01) — the production incident (a Uniswap v3 position: the first approval confirmed and
 * reconciled, the Review then expired, the second approval was prepared under the expired Review and refused at the wallet hand-off) replayed
 * against the real browser UI, server actions and durable run on the MOCKED loopback Base Sepolia chain (harness clock; no public network, no
 * broadcast, FloFi signs nothing).
 *
 * The product never authorizes or executes a MOCKED result (release-financial-provenance.spec.ts), so the owner's Review authorizations and
 * wallet requests are made by the test through the very service the browser's server actions run (`createUniswapLiquidityService`, same
 * journal, same chain, same harness clock, the scripted owner wallet). The browser owns everything the product does with such a run: writing
 * the workflow in the chat, the simulation, recovering the started run after reloads, and "Simulate again" refreshing the SAME run's Review
 * instead of starting another one. The store's automatic in-place refresh after a pre-wallet refusal is covered by
 * `src/state/uniswap-liquidity-store.test.tsx`; the run's wording by `src/server/base-liquidity.test.ts`.
 */
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { test, expect, openSimulationDetails } from './fixtures';
import { advanceUniswapHarness, installUniswapWallet, resetUniswapHarness, uniswapHarnessRpc, walletSends, UNI_E2E_OWNER as owner } from './uniswap-liquidity-fixtures';
import { openBuilder, openEditorSection, reloadBuilder } from './build-entry-navigation';
import { createUniswapLiquidityService, type UniswapLiquidityService } from '../src/server/uniswap-liquidity-service';
import { createBaseSepoliaReadRpc, UNISWAP_LIQUIDITY_RPC_METHODS } from '../src/server/public-testnet-rpc';
import { UNI_MOCK_CODE_PINS, UNI_MOCK_RPC_URL } from '../src/server/uniswap-liquidity-mock';

test.skip(process.env.GRYLOO_UNISWAP_LIQUIDITY_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Requires the MOCKED loopback Uniswap liquidity harness');
test.setTimeout(180_000);
const KEY = 'flofi:uniswap-liquidity:run';
const chat = (page: Page) => page.locator('.chat-messages[role="log"]');
const flofi = (page: Page) => chat(page).locator('.message:not(.you):not(.conversation-execution-message)').last();
const region = (page: Page) => page.getByRole('region', { name: 'Base Sepolia liquidity' });
const runId = (page: Page) => page.evaluate(key => (JSON.parse(window.localStorage.getItem(key) ?? 'null') as { id?: string } | null)?.id ?? null, KEY);
const pageSends = (page: Page) => page.evaluate(() => (window as unknown as { uniswapWalletRequests: { method: string }[] }).uniswapWalletRequests
  .filter(r => r.method === 'eth_sendTransaction').length);

/** The service the app's server actions run (MOCKED harness mode): same journal, same loopback chain, same harness clock. */
function ownerService(): UniswapLiquidityService {
  const journal = process.env.GRYLOO_UNISWAP_LIQUIDITY_JOURNAL!;
  // The same bounded offset the app's harness clock accepts (0–24 h).
  const offset = () => { try { const value = Number(readFileSync(`${journal}.clock`, 'utf8')); return Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000 ? value : 0; } catch { return 0; } };
  const now = () => new Date(Date.now() + offset());
  return createUniswapLiquidityService({ storage: createFileExecutionStorage(journal, 'UNISWAP_LIQUIDITY_BUSY'),
    // The owner-side requests also re-estimate gas (begin); the Base Sepolia read list alone does not include it.
    rpc: createBaseSepoliaReadRpc(UNI_MOCK_RPC_URL, [...UNISWAP_LIQUIDITY_RPC_METHODS, 'eth_estimateGas']), provenance: 'MOCKED', mockedCodePins: UNI_MOCK_CODE_PINS, now });
}
/** Exactly one wallet request under the owner's current authorization (the scripted owner wallet sends it), then observed and reconciled. */
async function ownerRequest(service: UniswapLiquidityService, id: string, workflow: SemanticWorkflow) {
  const begun = await service.begin(id, owner, workflow);
  await service.handoff(id);
  await service.report(id, { kind: 'HASH', hash: await uniswapHarnessRpc('MOCK_send', [begun.transaction]) as string });
  return { step: begun.attempt.step, record: await service.observe(id) };
}

test.beforeEach(async () => { await resetUniswapHarness(); });

test('a Review that expires between the two approvals: the browser recovers the run with its confirmed approval and "Simulate again" refreshes the same run', async ({ page }) => {
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
  const id = await runId(page);
  expect(id).toMatch(/^unilp-[a-f0-9]{32}$/);
  expect(await walletSends()).toBe(0);

  // The owner authorizes the Review and confirms the USDC approval (confirmed and reconciled on the loopback chain).
  const service = ownerService();
  const simulated = await service.load(id!);
  await service.review(id!, simulated.review.commitment, simulated.workflow);
  const first = await ownerRequest(service, id!, simulated.workflow);
  expect(first.step).toBe('APPROVE_TOKEN0');
  expect(first.record.attempts[0]).toMatchObject({ step: 'APPROVE_TOKEN0', state: 'CONFIRMED', reconciled: true });

  // The owner takes longer than the Review allows (120 s on this profile): the next request is refused before anything is prepared.
  await advanceUniswapHarness(130);
  await expect(service.begin(id!, owner, simulated.workflow)).rejects.toThrow('UNISWAP_REVIEW_EXPIRED');
  const stopped = await service.load(id!);
  expect(stopped.attempts.map(a => [a.step, a.state])).toEqual([['APPROVE_TOKEN0', 'CONFIRMED']]);
  expect(stopped.error).toBe('UNISWAP_REVIEW_EXPIRED');
  expect(await walletSends()).toBe(1);

  // A reload: the browser recovers the same started run, and "Simulate again" refreshes THAT run (no new run id): the USDC approval is kept
  // and only the WETH approval and the mint remain in the updated Review, which waits for the owner's new authorization.
  await reloadBuilder(page);
  expect(await runId(page)).toBe(id);
  const again = page.locator('.canvas-primary-action [data-lifecycle-action="simulate"]');
  await expect(again).toBeEnabled({ timeout: 30_000 });
  await again.click();
  await expect.poll(async () => (await service.load(id!)).review.calls.map(c => c.step), { timeout: 60_000 }).toEqual(['APPROVE_TOKEN1', 'MINT']);
  expect(await runId(page)).toBe(id);
  const refreshed = await service.load(id!);
  expect(refreshed.authorization).toBeNull();
  expect(refreshed.review.commitment).not.toBe(simulated.review.commitment);
  expect(refreshed.review.approvals.map(a => [a.symbol, a.required])).toEqual([['USDC', false], ['WETH', true]]);
  await openSimulationDetails(page);
  await expect(region(page)).toContainText('Approve WETH (exact amount) → Mint the position NFT', { timeout: 30_000 });
  expect(await walletSends()).toBe(1);

  // Explicit authorization of the updated Review, then only the remaining requests: the WETH approval and the mint.
  await service.review(id!, refreshed.review.commitment, refreshed.workflow);
  expect((await ownerRequest(service, id!, refreshed.workflow)).step).toBe('APPROVE_TOKEN1');
  const minted = await ownerRequest(service, id!, refreshed.workflow);
  expect(minted.step).toBe('MINT');
  expect(minted.record.verdict).toBe('RECONCILED');
  expect(minted.record.attempts.filter(a => a.step === 'APPROVE_TOKEN0')).toHaveLength(1);
  expect(minted.record.evidence!.transactions.map(t => [t.step, t.reviewCommitment === simulated.review.commitment ? 'original' : 'refreshed']))
    .toEqual([['APPROVE_TOKEN0', 'original'], ['APPROVE_TOKEN1', 'refreshed'], ['MINT', 'refreshed']]);
  expect(await walletSends()).toBe(3);

  // After a reload the browser shows the one run, every request confirmed, the USDC approval once; the page itself never asked the wallet to send.
  await reloadBuilder(page);
  await openEditorSection(page, 'Execute');
  const main = page.locator('#workspace');
  await expect(main).toContainText('Approve USDC', { timeout: 30_000 });
  await expect(main).toContainText('Approve WETH');
  expect(await runId(page)).toBe(id);
  expect(await pageSends(page)).toBe(0);
  expect(errors).toEqual([]);
});
