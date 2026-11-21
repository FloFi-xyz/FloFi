// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: ONE financial card on the Editor's whole-workflow path, proven at the wallet boundary — the
 * EIP-1193 requests the real Editor actually makes are counted by the wallet double (e2e/batch-wallet-fixtures.ts), never a button label.
 *
 *   one Uniswap V3 card (swap 0.0006 WETH → USDC on Base) → "Simulate workflow" (the read-only whole-workflow Review: `wallet_getCapabilities`,
 *   no prompt) → "Review operation" → "Authorize workflow" (one click; a wallet sign-in session already exists) → exactly ONE `wallet_sendCalls`
 *   (atomic; the exact ERC-20 approval folded in only when the allowance is short, then the swap) → the page reads the batch's status and the
 *   run reconciles by itself to COMPLETED (no "Continue", no manual check) → reload: followed, never sent again.
 *   A declined batch executes nothing and is never retried automatically; a wallet without atomic batching on Base keeps the card's own flow.
 *
 * Profile `editor-single-card` (FLOFI_E2E_SINGLE_CARD on the user-funded harness): the database is at schema 32 exactly as an operator release
 * leaves it (the certified fixtures 0029–0032 applied by e2e/cloud-runtime-setup.ts), so the deployment reports one-step runs (`singleStep`), and
 * the server has no local-fork runtime, as a deployment. On Base only: the MOCKED loopback Base authoring harness (127.0.0.1:8562), the
 * user-funded chain double (https://127.0.0.1:8567) and disposable PostgreSQL. (The Arbitrum One acceptance scenario is proven at the run-engine
 * level by src/editor/single-card-run.pg.test.ts.) Nothing reaches a public network, nothing is signed with a real key, and none of this is
 * evidence of a mainnet execution.
 */
import type { Page } from '@playwright/test';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import { createTestWallet, type TestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { BASE_MAINNET_SWAP } from '../src/domain/public-testnet-swap';
import { BASE, chainControl as control, disposeChainControl, installBatchWallet, signedIn, walletSignedIn, type BatchWalletOptions, type SentBatch,
  type WalletRecorder } from './batch-wallet-fixtures';
import { openBuilder, openEditorSection } from './build-entry-navigation';
import { expect, test } from './fixtures';
import { installJourneyWallet } from './journey-fixtures';

/**
 * Selected (FLOFI_E2E_SINGLE_CARD), this proof runs or FAILS: a missing prerequisite is never a skip that the guarded runner would count as a
 * PASS. Not selected, it is skipped. Only the names of what is missing are reported, never a value.
 */
const SELECTED = process.env.FLOFI_E2E_SINGLE_CARD === 'MOCKED_LOOPBACK_ONLY';
const PREREQUISITES: Readonly<Record<string, string | null>> = { FLOFI_USER_FUNDED_E2E: 'MOCKED_LOOPBACK_ONLY', GRYLOO_BASE_MAINNET_E2E: 'MOCKED_LOOPBACK_ONLY',
  FLOFI_WORKFLOW_RUNS: 'enabled', FLOFI_E2E_SESSION_SECRET: null, FLOFI_E2E_DATABASE_URL: null };
const MISSING = Object.entries(PREREQUISITES).filter(([name, value]) => value === null ? !process.env[name]?.trim() : process.env[name] !== value).map(([name]) => name);
if (SELECTED && MISSING.length) throw new Error(`SINGLE_CARD_E2E_PREREQUISITE_MISSING: ${MISSING.join(', ')}`);
test.skip(!SELECTED, 'Runs only in the MOCKED single-card profile (FLOFI_E2E_SINGLE_CARD=MOCKED_LOOPBACK_ONLY)');
test.setTimeout(240_000);

const BASE_HARNESS = 'http://127.0.0.1:8562';
const WETH = BASE_MAINNET_SWAP.weth.toLowerCase(), ROUTER = BASE_MAINNET_SWAP.router.toLowerCase();
/** The card's input: 0.0006 WETH, in wei. */
const AMOUNT_IN = 600_000_000_000_000n;
const APPROVE = '0x095ea7b3', MULTICALL = '0x5ae401dc', EXACT_INPUT_SINGLE = '0x04e45aaf';
/** Words of the card's own flows that must never appear on the one-confirmation path (a second step or a manual status check). */
const MANUAL = /^(Continue to swap|Continue\b.*|Check confirmation|Check status)$/;

test.afterAll(disposeChainControl);
async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  try { return (await db.query(sql, params)).rows as T[]; } finally { await db.close(); }
}
/** One command of the Canvas's own grammar; it adds exactly one card (`label`) to the workflow. */
async function say(page: Page, text: string, label: string) {
  const cards = page.locator('.build-flow-surface .composer-card'), before = await cards.count();
  await page.locator('#mock-prompt').fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(cards).toHaveCount(before + 1, { timeout: 20_000 });
  await expect(cards.nth(before)).toContainText(label);
}
const panel = (page: Page) => page.getByRole('region', { name: 'Whole workflow', exact: true });
const footerAction = (page: Page) => page.locator('.summary-bar .summary-primary-action');
/**
 * Every visible text of a button or link the page ever rendered that matches `MANUAL` (a second step or a manual status check), recorded in the
 * test process as it appears — so a control shown for a moment, or before a reload, is still seen.
 */
async function watchManualControls(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.exposeFunction('flofiManualControl', (text: string) => { if (!seen.includes(text)) seen.push(text); });
  await page.addInitScript(source => {
    const manual = new RegExp(source);
    const report = (window as unknown as { flofiManualControl: (text: string) => void }).flofiManualControl;
    const scan = () => document.querySelectorAll('button, a, [role="button"]').forEach(element => {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (manual.test(text) && (element as HTMLElement).offsetParent !== null) report(text);
    });
    new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  }, MANUAL.source);
  return seen;
}
/** `0x095ea7b3` approve(spender, amount): the spender and the amount the wallet is asked to approve. */
function approval(data: string): { spender: string; amount: bigint } {
  expect(data.slice(0, 10)).toBe(APPROVE);
  expect(data).toHaveLength(10 + 128);
  return { spender: '0x' + data.slice(10 + 24, 10 + 64), amount: BigInt('0x' + data.slice(10 + 64, 10 + 128)) };
}
/**
 * `0x5ae401dc` SwapRouter02 multicall(uint256 deadline, bytes[] data) of ONE `0x04e45aaf` exactInputSingle((tokenIn, tokenOut, fee, recipient,
 * amountIn, amountOutMinimum, sqrtPriceLimitX96)): the swap the wallet is asked to execute.
 */
function swapOf(data: string): { tokenIn: string; tokenOut: string; recipient: string; amountIn: bigint; minimum: bigint } {
  expect(data.slice(0, 10)).toBe(MULTICALL);
  const body = data.slice(10), word = (index: number) => BigInt('0x' + body.slice(index * 64, index * 64 + 64));
  const array = Number(word(1)) / 32;
  expect(word(array)).toBe(1n);
  const start = array + 1 + Number(word(array + 1)) / 32, inner = body.slice((start + 1) * 64, (start + 1) * 64 + Number(word(start)) * 2);
  expect('0x' + inner.slice(0, 8)).toBe(EXACT_INPUT_SINGLE);
  const field = (index: number) => inner.slice(8 + index * 64, 8 + index * 64 + 64), address = (index: number) => '0x' + field(index).slice(24);
  return { tokenIn: address(0), tokenOut: address(1), recipient: address(3), amountIn: BigInt('0x' + field(4)), minimum: BigInt('0x' + field(5)) };
}

type Owner = { readonly wallet: TestWallet; readonly owner: string; readonly log: WalletRecorder; readonly manual: string[] };
/**
 * A fresh owner (in-memory test key) with 0.01 WETH, 10 USDC and 0.1 ETH on the MOCKED Base chain (and, when given, an existing allowance of the
 * router), a FloFi account holding the wallet, a valid wallet sign-in session in this browser, the recorded wallet, and the one card on the Canvas.
 */
async function begin(page: Page, options: BatchWalletOptions & { readonly allowance?: bigint } = {}): Promise<Owner> {
  const wallet = createTestWallet(), owner = wallet.address.toLowerCase();
  const response = await fetch(`${BASE_HARNESS}/__harness/chain`, { method: 'POST', body: JSON.stringify({ action: 'reset' }) });
  expect(response.ok).toBe(true);
  await control('MOCK_reset', [owner, '10000000', '100000000000000000']);
  await control('MOCK_fundToken', [WETH, owner, '10000000000000000']);
  if (options.allowance !== undefined) await control('MOCK_setAllowance', [WETH, owner, ROUTER, options.allowance.toString()]);
  await installJourneyWallet(page, [wallet], { chain: BASE, transactionControl: async () => { throw Error('FINANCIAL_REQUEST_FORBIDDEN'); } });
  const log = await installBatchWallet(page, owner, options);
  const manual = await watchManualControls(page);
  await signedIn(page, owner, 'single-card');
  await walletSignedIn(page, wallet);
  await openBuilder(page);
  // The Canvas's own command grammar (deterministic, no Copilot): one Uniswap V3 card.
  await say(page, 'swap 0.0006 WETH to USDC on Base slippage 50 bps', 'Swap');
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(1);
  return { wallet, owner, log, manual };
}
/** Simulate → Review operation: the read-only whole-workflow Review of the one card, ready to authorize in Execute. Nothing prompts. */
async function simulateAndReview(page: Page, log: WalletRecorder) {
  await openEditorSection(page, 'Simulate');
  await page.locator('.simulation-panel-action').getByRole('button', { name: 'Simulate workflow', exact: true }).click();
  await expect(page.locator('.simulation-context-panel')).toHaveAttribute('data-review-state', 'ready', { timeout: 60_000 });
  await footerAction(page).getByRole('button', { name: 'Review operation', exact: true }).click();
  await expect(panel(page).getByRole('heading', { name: 'Review before authorizing', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(panel(page).getByRole('list', { name: 'Steps', exact: true }).first()).toContainText('Swap 0.0006 WETH → USDC · Base', { timeout: 60_000 });
  await expect(panel(page).locator('.review-block-rows')).toContainText('Wallet requests1');
  await expect(page.locator('main, .summary-bar').getByRole('button', { name: 'Authorize workflow', exact: true })).toHaveCount(1);
  expect(log.methods).toContain('wallet_getCapabilities');
  expect(log.asking()).toEqual([]);
  expect(log.sent).toEqual([]);
}
/** The run of this owner: its handoff, the run and its one group, as FloFi stored them. */
async function stored(owner: string) {
  const runs = await query<{ run_id: string; step_count: number; mode: string; state: string; kind: string; steps: number; requester_kind: string }>(
    `SELECT r.run_id, r.step_count, r.mode, r.state, h.plan->>'kind' AS kind, jsonb_array_length(h.plan->'steps') AS steps, h.requester_kind
       FROM workflow_runs r JOIN mcp_handoffs h ON h.tenant_id = r.tenant_id AND h.handoff_id = r.handoff_id WHERE r.owner_account = $1`, [owner]);
  const groups = await query<{ state: string; request: SentBatch }>(
    `SELECT g.state, g.prepared->'request' AS request FROM workflow_run_groups g JOIN workflow_runs r ON r.tenant_id = g.tenant_id AND r.run_id = g.run_id
      WHERE r.owner_account = $1 ORDER BY g.group_index`, [owner]);
  return { runs, groups };
}

test('insufficient allowance: one Authorize asks the wallet for ONE wallet_sendCalls [exact approval, swap], reconciles by itself, never sends again', async ({ page, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { owner, log, manual } = await begin(page);
  expect(await control<string>('MOCK_allowance', [WETH, owner, ROUTER])).toBe('0');
  await simulateAndReview(page, log);
  await panel(page).getByText('Technical details', { exact: true }).click();
  await expect(panel(page)).toContainText('2 calls in the batch (1 token approvals)');
  await expect(panel(page)).toContainText('one wallet confirmation · 1 on-chain transaction · 2 calls batched');

  // The Authorize window: ONE click, then nothing but the wallet's batch and its status reads until the run completed.
  const authorizeFrom = log.mark();
  await footerAction(page).getByRole('button', { name: 'Authorize workflow', exact: true }).click();
  await expect(panel(page)).toHaveAttribute('data-run-state', 'COMPLETED', { timeout: 90_000 });
  await expect(panel(page)).toContainText('Every step reconciled.');
  const inWindow = log.counts(authorizeFrom);
  console.log(`[single-card] insufficient allowance: wallet requests in the Authorize window ${JSON.stringify(inWindow)}; whole test ${JSON.stringify(log.counts())}`);
  expect(log.asking(authorizeFrom)).toEqual(['wallet_sendCalls']);
  expect(log.count('wallet_sendCalls', authorizeFrom)).toBe(1);
  for (const method of ['personal_sign', 'eth_sendTransaction', 'eth_sendRawTransaction', 'eth_signTypedData_v4', 'wallet_switchEthereumChain']) expect(log.count(method, authorizeFrom)).toBe(0);
  expect(log.methods.slice(authorizeFrom).filter(m => /^eth_signTypedData/.test(m))).toEqual([]);
  // The batch: exactly what FloFi prepared and stored for the run's one group — atomic, from the owner, on Base, with FloFi's own id, no capability.
  expect(log.sent).toHaveLength(1);
  const batch = log.sent[0]!;
  expect(batch).toMatchObject({ version: '2.0.0', chainId: BASE, from: owner, atomicRequired: true });
  expect(batch.id).toMatch(/^0x[0-9a-f]{64}$/);
  expect(batch).not.toHaveProperty('capabilities');
  expect(batch.calls.map(c => [c.to.toLowerCase(), c.data.slice(0, 10), c.value])).toEqual([[WETH, APPROVE, '0x0'], [ROUTER, MULTICALL, '0x0']]);
  // The approval is EXACT: the router, for exactly the swap's own input (never unlimited); the swap pays the owner at least its signed minimum.
  const swap = swapOf(batch.calls[1]!.data);
  expect(swap).toMatchObject({ tokenIn: WETH, tokenOut: BASE_MAINNET_SWAP.usdc.toLowerCase(), recipient: owner, amountIn: AMOUNT_IN });
  expect(swap.minimum).toBeGreaterThan(0n);
  expect(approval(batch.calls[0]!.data)).toEqual({ spender: ROUTER, amount: swap.amountIn });
  const { runs, groups } = await stored(owner);
  expect(runs).toEqual([expect.objectContaining({ step_count: 1, mode: 'USER_FUNDED', state: 'COMPLETED', kind: 'SEQUENTIAL', steps: 1, requester_kind: 'EDITOR_SESSION' })]);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.state).toBe('RECONCILED');
  expect(groups[0]!.request).toEqual(batch);
  // ONE atomic transaction on the chain, from the owner's own account; the exact approval was consumed by the swap.
  expect(await control<number>('MOCK_batches')).toBe(1);
  expect(await control<string>('MOCK_allowance', [WETH, owner, ROUTER])).toBe('0');
  expect(BigInt(await control<string>('MOCK_tokenBalance', [WETH, owner]))).toBe(10_000_000_000_000_000n - AMOUNT_IN);
  expect(BigInt(await control<string>('MOCK_tokenBalance', [BASE_MAINNET_SWAP.usdc, owner]))).toBeGreaterThan(10_000_000n);
  // The completed result is the existing one (the card marked Completed, the run's reconciled step); no second step, no manual status check
  // was ever offered.
  await expect(page.locator('.composer-card').filter({ hasText: 'Swap' }).first()).toContainText('Completed');
  await expect(panel(page)).toContainText('Received (reconciled)');
  await expect(panel(page).getByRole('button', { name: 'Authorize workflow', exact: true })).toHaveCount(0);
  expect(manual).toEqual([]);

  // Reload: the Canvas keeps its workflow id, so the run is THIS workflow's own; it is followed from FloFi (loaded by the owner's click where the
  // panel offers it) and shows its result before anything below is asserted. For 5 more seconds the wallet is never asked to send again.
  const reloaded = log.mark();
  await page.reload();
  await openEditorSection(page, 'Execute');
  const load = panel(page).getByRole('button', { name: 'Load workflow progress', exact: true });
  await expect(panel(page).locator('[role=status]', { hasText: 'Every step reconciled.' }).or(load)).toBeVisible({ timeout: 30_000 });
  if (await load.isVisible()) await load.click();
  await expect(panel(page)).toHaveAttribute('data-run-state', 'COMPLETED', { timeout: 60_000 });
  await expect(panel(page)).toContainText('Every step reconciled.');
  await expect(panel(page).getByRole('button', { name: 'Authorize workflow', exact: true })).toHaveCount(0);
  const settledFrom = Date.now();
  await expect.poll(() => log.sent.length !== 1 ? `SENT ${log.sent.length}` : log.asking(reloaded).length ? `ASKED ${log.asking(reloaded).join(',')}`
    : Date.now() - settledFrom < 5_000 ? 'SETTLING' : 'SETTLED', { timeout: 15_000, intervals: [250] }).toBe('SETTLED');
  console.log(`[single-card] after reload: wallet requests ${JSON.stringify(log.counts(reloaded))}`);
  expect(log.count('wallet_sendCalls')).toBe(1);
  expect(log.asking(reloaded)).toEqual([]);
  expect(await control<number>('MOCK_batches')).toBe(1);
  expect(manual).toEqual([]);
  expect(errors).toEqual([]);
  networkGuard.assertClean();
});

test('existing sufficient allowance: ONE wallet_sendCalls with the swap only (no approval call)', async ({ page, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { owner, log, manual } = await begin(page, { allowance: AMOUNT_IN });
  await simulateAndReview(page, log);
  const authorizeFrom = log.mark();
  await footerAction(page).getByRole('button', { name: 'Authorize workflow', exact: true }).click();
  await expect(panel(page)).toHaveAttribute('data-run-state', 'COMPLETED', { timeout: 90_000 });
  await expect(panel(page)).toContainText('Every step reconciled.');
  console.log(`[single-card] sufficient allowance: wallet requests in the Authorize window ${JSON.stringify(log.counts(authorizeFrom))}; whole test ${JSON.stringify(log.counts())}`);
  expect(log.asking(authorizeFrom)).toEqual(['wallet_sendCalls']);
  expect(log.sent).toHaveLength(1);
  const batch = log.sent[0]!;
  expect(batch).toMatchObject({ version: '2.0.0', chainId: BASE, from: owner, atomicRequired: true });
  expect(batch.calls.map(c => [c.to.toLowerCase(), c.data.slice(0, 10), c.value])).toEqual([[ROUTER, MULTICALL, '0x0']]);
  expect(swapOf(batch.calls[0]!.data)).toMatchObject({ tokenIn: WETH, recipient: owner, amountIn: AMOUNT_IN });
  const { runs, groups } = await stored(owner);
  expect(runs).toEqual([expect.objectContaining({ step_count: 1, mode: 'USER_FUNDED', state: 'COMPLETED', kind: 'SEQUENTIAL', steps: 1, requester_kind: 'EDITOR_SESSION' })]);
  expect(groups.map(g => g.state)).toEqual(['RECONCILED']);
  expect(groups[0]!.request).toEqual(batch);
  expect(await control<number>('MOCK_batches')).toBe(1);
  expect(await control<string>('MOCK_allowance', [WETH, owner, ROUTER])).toBe('0');
  expect(manual).toEqual([]);
  expect(errors).toEqual([]);
  networkGuard.assertClean();
});

test('declined in the wallet (EIP-1193 4001): nothing executes, the one request is never retried automatically, the inline error says so', async ({ page, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { owner, log, manual } = await begin(page, { sendCalls: 'reject' });
  await simulateAndReview(page, log);
  const authorizeFrom = log.mark();
  await footerAction(page).getByRole('button', { name: 'Authorize workflow', exact: true }).click();
  // The existing inline error of a declined wallet request.
  await expect(panel(page).getByRole('alert')).toContainText('You declined the request in your wallet. Nothing was sent.', { timeout: 90_000 });
  // No automatic retry: for 5 more seconds the wallet is asked nothing else that prompts.
  const settledFrom = Date.now();
  await expect.poll(() => log.asking(authorizeFrom).length !== 1 ? `ASKED ${log.asking(authorizeFrom).join(',')}` : Date.now() - settledFrom < 5_000 ? 'SETTLING' : 'SETTLED',
    { timeout: 15_000, intervals: [250] }).toBe('SETTLED');
  console.log(`[single-card] declined: wallet requests in the Authorize window ${JSON.stringify(log.counts(authorizeFrom))}; whole test ${JSON.stringify(log.counts())}`);
  expect(log.asking(authorizeFrom)).toEqual(['wallet_sendCalls']);
  expect(log.sent).toHaveLength(1);
  expect(log.sent[0]!.calls.map(c => c.data.slice(0, 10))).toEqual([APPROVE, MULTICALL]);
  expect(await control<number>('MOCK_batches')).toBe(0);
  expect(await control<string>('MOCK_allowance', [WETH, owner, ROUTER])).toBe('0');
  expect(BigInt(await control<string>('MOCK_tokenBalance', [WETH, owner]))).toBe(10_000_000_000_000_000n);
  const { runs, groups } = await stored(owner);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ step_count: 1, mode: 'USER_FUNDED' });
  expect(runs[0]!.state).not.toBe('COMPLETED');
  expect(groups.map(g => g.state)).toEqual(['PREPARED']);
  expect(manual).toEqual([]);
  expect(errors).toEqual([]);
  networkGuard.assertClean();
});

test('a wallet without atomic batching on Base: no wallet_sendCalls; the card keeps its own flow and nothing prompts by itself', async ({ page, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { owner, log } = await begin(page, { capabilities: { [BASE]: { atomic: { status: 'unsupported' } } } });
  await openEditorSection(page, 'Simulate');
  await page.locator('.simulation-panel-action').getByRole('button', { name: 'Simulate workflow', exact: true }).click();
  // The whole-workflow Review plans the card step by step (the wallet reports no atomic batching on Base): the Editor goes back to the card's own
  // flow, whose own read-only simulation runs; the grouped one-confirmation path is not offered.
  await expect.poll(() => log.count('wallet_getCapabilities'), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.locator('.simulation-panel-action').getByRole('button', { name: 'Simulate workflow', exact: true })).toHaveCount(0, { timeout: 60_000 });
  // The card's own simulation panel (its own words), not the whole-workflow Review: nothing to authorize as one confirmation, nothing sent.
  // (Its own read-only simulation does not complete on this harness — the Base authoring harness's quote is refused — so the per-flow path is
  // not executed here; only that nothing prompts by itself and that the grouped path is not used.)
  const simulation = page.getByRole('main', { name: 'Simulation workspace', exact: true });
  await expect(simulation.getByRole('heading', { name: 'Workflow simulation', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('footer.summary-bar')).toContainText('Nothing was sent');
  await page.waitForTimeout(5_000);
  console.log(`[single-card] no atomic batching: wallet requests ${JSON.stringify(log.counts())}`);
  await expect(page.getByText('Review before authorizing', { exact: true })).toHaveCount(0);
  await expect(page.locator('main, .summary-bar').getByRole('button', { name: 'Authorize workflow', exact: true })).toHaveCount(0);
  // Execute after the fallback shows only the card's own flow: never the whole-workflow Review, its mechanism sentence or a second primary action
  // ("Review whole workflow" / "Review again") beside the card's own (final frontend-ux review).
  await openEditorSection(page, 'Execute');
  await expect(page.getByText('Review before authorizing', { exact: true })).toHaveCount(0);
  await expect(page.locator('.editor-run-mechanism')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Review whole workflow|Review again|Refresh review)$/ })).toHaveCount(0);
  expect(log.count('wallet_sendCalls')).toBe(0);
  expect(log.asking()).toEqual([]);
  expect((await stored(owner)).runs).toEqual([]);
  expect(await control<number>('MOCK_batches')).toBe(0);
  expect(errors).toEqual([]);
  networkGuard.assertClean();
});
