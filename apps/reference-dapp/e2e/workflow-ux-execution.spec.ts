// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ARB-001 Phase 7 — UX-003 (locked processing CTA) and UX-004 (Create new workflow) on the real public-swap UI/API/durable runtime,
 * with the synthetic loopback RPC and explicit scripted owner confirmations of the execution-continuity harness. MOCKED; no public broadcast.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, AUTHORIZE_IN_WALLET, readWorkflowIr, openFirstActionSettings } from './fixtures';
import { installJourneyWallet, walletRequests } from './journey-fixtures';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';

test.skip(process.env.FLOFI_SWAP_EXECUTION_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Requires the opt-in loopback swap execution harness');
test.setTimeout(90_000);
const stage = (page: Page, name: 'Build' | 'Simulate' | 'Execute') => page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name, exact: true });
const summary = (page: Page) => page.locator('.execution-summary');
const cta = (page: Page) => page.locator('.canvas-primary-action');
const processing = (page: Page) => cta(page).locator('[data-lifecycle-action="processing"]');
/** BUILD-SOLANA-TRANSFER-UX-001: the one owner action after a simulation (Review acceptance, then the wallet request). */
const authorize = (page: Page) => cta(page).getByRole('button', { name: AUTHORIZE_IN_WALLET, exact: true });
/** One explicit click accepts the fresh Review and makes exactly the next wallet request; nothing is requested before it. */
async function authorizeInWallet(page: Page, owner: Awaited<ReturnType<typeof setup>>, count: number) {
  await expect(authorize(page)).toBeEnabled({ timeout: 30_000 });
  await expect(authorize(page)).toHaveAttribute('data-lifecycle-action', 'approve');
  expect(owner.requested()).toBe(count - 1);
  await authorize(page).click();
  await expectWaitingForWallet(page, owner, count);
}
async function control(request: APIRequestContext, method: string, params: unknown[] = []) {
  const response = await request.post('https://127.0.0.1:8558/control', { ignoreHTTPSErrors: true, data: { jsonrpc: '2.0', id: 1, method, params } });
  expect(response.ok()).toBe(true);
  return (await response.json() as { result: unknown }).result;
}
/** Every wallet send waits for the test; `decline` turns that request into the wallet's EIP-1193 user rejection (code 4001). */
async function setup(page: Page, request: APIRequestContext, options: { decline?: number; lose?: number } = {}) {
  await control(request, 'MOCK_reset');
  const confirmations: (() => void)[] = []; let requested = 0;
  await installJourneyWallet(page, [createTestWallet()], { transactionControl: async (method, params) => {
    if (method !== 'MOCK_send') throw Error('MOCK_METHOD_DENIED');
    const number = ++requested;
    await new Promise<void>(resolve => confirmations.push(resolve));
    if (number === options.decline) throw Error('MOCK_USER_REJECTED');
    const hash = await control(request, method, params);
    if (number === options.lose) throw Error('MOCK_WALLET_RESPONSE_LOST');
    return hash;
  } });
  await page.addInitScript(() => {
    const w = window as unknown as { ethereum: { request(input: unknown): Promise<unknown> } }, original = w.ethereum.request;
    w.ethereum.request = async input => {
      try { return await original(input); } catch (error) {
        if (String((error as Error)?.message ?? error).includes('MOCK_USER_REJECTED')) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        throw error;
      }
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { provider: w.ethereum, info: { rdns: 'io.metamask', name: 'MetaMask', uuid: 'workflow-ux-metamask' } } })));
  });
  // UX-003: hold the server actions of one Simulate so its in-progress state can be observed.
  let gate: Promise<void> | null = null, release: () => void = () => undefined, held = 0;
  await page.route(url => url.pathname.startsWith('/app'), async route => {
    if (gate && route.request().method() === 'POST' && route.request().headers()['next-action']) { held++; await gate; }
    await route.fallback();
  });
  await page.goto('/app');
  const wallet = page.getByRole('group', { name: 'Wallet connection' });
  await expect(wallet.locator('.header-wallet-provider')).toHaveAttribute('title', 'MetaMask');
  await expect(wallet.locator('.wallet-connection')).toHaveAttribute('title', /Base Sepolia/);
  await buildSwap(page);
  await stage(page, 'Simulate').click();
  return {
    wallet, requested: () => requested, sends: () => control(request, 'MOCK_sends'),
    confirm: async () => { await expect.poll(() => confirmations.length).toBe(1); confirmations.shift()!(); },
    hold: () => { held = 0; gate = new Promise<void>(resolve => { release = () => { gate = null; resolve(); }; }); }, release: () => release(), held: () => held,
  };
}
/** The Base Sepolia USDC → WETH swap: the amount applies on Enter (BUILD-FIX-UX-001), with no Review/Apply step. */
async function buildSwap(page: Page) {
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  const card = page.locator('.build-flow-surface .composer-card').first();
  await card.getByRole('button', { name: 'Select source token', exact: true }).click();
  await page.getByRole('region', { name: 'Action network picker', exact: true }).getByRole('button', { name: 'Base Sepolia', exact: true }).click();
  await page.getByRole('button', { name: 'Hide token picker', exact: true }).click();
  await card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).fill('1');
  await card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).press('Enter');
  await expect(page.locator('.build-canvas-head .revision')).toHaveText('1 action');
  await expect(card.getByRole('button', { name: /^(Review|Apply) amount$/ })).toHaveCount(0);
}
const pointer = (page: Page) => page.evaluate(() => localStorage.getItem('gryloo:public-testnet-execution-id'));
/** The durable record of one run (loopback database only): it is never deleted or rewritten by a later workflow. */
async function durableAttempts(id: string) {
  const url = process.env.FLOFI_E2E_DATABASE_URL!;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw Error('LOOPBACK_DATABASE_REQUIRED');
  const db = createDatabase({ connectionString: url, maxConnections: 1 });
  try { return (await db.query<{ step: string; state: string }>('SELECT step, state FROM execution_attempts WHERE run_id = $1 ORDER BY step', [id])).rows; }
  finally { await db.close(); }
}
/** A fresh simulation, then the one explicit Authorize (Review acceptance + wallet request): the next wallet request is a new, separate one. */
async function simulateReviewExecute(page: Page, owner: Awaited<ReturnType<typeof setup>>, count: number) {
  const simulate = cta(page).getByRole('button', { name: /^Simulate (workflow|again)$/ });
  await expect(simulate).toBeEnabled({ timeout: 30_000 }); await simulate.click();
  await authorizeInWallet(page, owner, count);
  await expect(summary(page)).not.toContainText(/Transaction not submitted|Execution already started/);
}
async function confirmApprovalAndSwap(page: Page, owner: Awaited<ReturnType<typeof setup>>, count: number) {
  await owner.confirm();
  const next = cta(page).getByRole('button', { name: 'Continue to swap', exact: true });
  await expect(next).toBeEnabled(); await next.click(); await expectWaitingForWallet(page, owner, count + 1);
  await owner.confirm();
  await expect(summary(page)).toContainText('Execution completed');
}
/** Legacy test-network swaps cannot discover a hashless send. Their financial CTA stays locked while navigation remains available. */
async function expectWaitingForWallet(page: Page, owner: Awaited<ReturnType<typeof setup>>, count: number) {
  await expect.poll(owner.requested).toBe(count);
  await expect(summary(page)).toContainText('Waiting for wallet…');
  await expect(processing(page)).toHaveText('Waiting for wallet…'); await expect(processing(page)).toBeDisabled();
  await expect(processing(page)).toHaveAttribute('aria-busy', 'true');
  await processing(page).click({ force: true }); await processing(page).evaluate(button => (button as HTMLButtonElement).click());
  await stage(page, 'Build').click(); await stage(page, 'Execute').click();
  await expect(cta(page).locator('[data-lifecycle-action="approve"], [data-lifecycle-action="execute"], [data-lifecycle-action="continue"]')).toHaveCount(0);
  await page.waitForTimeout(300); expect(owner.requested()).toBe(count);
}
async function simulateAndExecute(page: Page, owner: Awaited<ReturnType<typeof setup>>) {
  // UX-003 Simulate: the same CTA becomes a locked, active "Simulating workflow…" button; no loose sentence, no second simulation.
  // Hold only after the page's own availability reads have enabled Simulate (a cold server answers them late).
  const simulate = cta(page).getByRole('button', { name: 'Simulate workflow', exact: true });
  await expect(simulate).toBeEnabled({ timeout: 30_000 });
  owner.hold(); await simulate.click();
  await expect(processing(page)).toHaveText('Simulating workflow…'); await expect(processing(page)).toBeDisabled();
  await expect(processing(page)).toHaveAttribute('aria-busy', 'true');
  await expect(cta(page).locator('[data-lifecycle-action="status"]')).toHaveCount(0);
  await expect.poll(owner.held).toBeGreaterThan(0); const held = owner.held();
  await processing(page).click({ force: true }); await page.waitForTimeout(300);
  expect(owner.held()).toBe(held);
  owner.release();
  await expect(processing(page)).toHaveCount(0);
  await authorizeInWallet(page, owner, 1);
}
async function expectCleanNewWorkflow(page: Page, owner: Awaited<ReturnType<typeof setup>>, before: { workflowId: string; requested: number; sends: unknown }) {
  await expect(stage(page, 'Build')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.build-flow-surface .canvas-empty')).toContainText('Start your workflow');
  await expect(page.locator('.build-canvas-head .revision')).toHaveText('0 actions');
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(0);
  await expect(page.locator('.build-canvas-head h2')).toHaveText('Your Workflow');
  await expect(page.getByRole('log', { name: 'Conversation' }).locator('.message')).toHaveCount(1);
  const fresh = JSON.parse(await readWorkflowIr(page)) as { workflowId: string; revision: number; nodes: { actionType: string }[] };
  expect(fresh.revision).toBe(0); expect(fresh.workflowId).not.toBe(before.workflowId); expect(fresh.workflowId).toMatch(/^workflow-[0-9a-f-]{36}$/);
  expect(fresh.nodes.every(node => node.actionType.startsWith('mock-'))).toBe(true);
  // The wallet connection and session stay; no wallet request or send happens.
  await expect(owner.wallet.locator('.header-wallet-provider')).toHaveAttribute('title', 'MetaMask');
  await expect(owner.wallet.locator('.wallet-connection')).toHaveAttribute('title', /Base Sepolia/);
  expect(owner.requested()).toBe(before.requested); expect(await owner.sends()).toEqual(before.sends);
  // No stale simulation, Review or execution result belongs to the new workflow.
  await stage(page, 'Simulate').click();
  await expect(page.getByRole('button', { name: /Approve|Execute workflow|Authorize in wallet/ })).toHaveCount(0);
  await stage(page, 'Execute').click();
  await expect(summary(page)).not.toContainText(/Execution completed|Transaction not submitted|Result Summary/);
  await expect(page.getByRole('button', { name: 'Create new workflow', exact: true })).toHaveCount(0);
  await stage(page, 'Build').click();
}

test('UX-003/UX-004: completed run — locked CTAs, Return to Build keeps the workflow, Create new workflow starts clean', async ({ page, request, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const owner = await setup(page, request);
  await simulateAndExecute(page, owner);
  await owner.confirm();
  const next = cta(page).getByRole('button', { name: 'Continue to swap', exact: true });
  await expect(next).toBeEnabled(); await expect(processing(page)).toHaveCount(0);
  await next.click(); await expectWaitingForWallet(page, owner, 2);
  await owner.confirm();
  await expect(summary(page)).toContainText('Execution completed'); await expect(processing(page)).toHaveCount(0);
  const create = summary(page).getByRole('button', { name: 'Create new workflow', exact: true });
  await expect(create).toBeVisible(); await expect(summary(page).getByRole('button', { name: 'Return to Build', exact: true })).toBeVisible();
  // Return to Build keeps editing the same workflow; the result stays available.
  const authored = await readWorkflowIr(page);
  await summary(page).getByRole('button', { name: 'Return to Build', exact: true }).click();
  await expect(stage(page, 'Build')).toHaveAttribute('aria-current', 'page');
  expect(await readWorkflowIr(page)).toBe(authored); await expect(page.locator('.build-canvas-head .revision')).toHaveText('1 action');
  // A pending (uncommitted) Copilot proposal on the old workflow must not survive a new workflow.
  await page.locator('#mock-prompt').fill('swap 2 USDC to WETH on Base Sepolia slippage 50 bps'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toBeVisible();
  await stage(page, 'Execute').click(); await expect(summary(page)).toContainText('Execution completed');
  const before = { workflowId: (JSON.parse(authored) as { workflowId: string }).workflowId, requested: owner.requested(), sends: await owner.sends() };
  await summary(page).getByRole('button', { name: 'Create new workflow', exact: true }).click();
  await expectCleanNewWorkflow(page, owner, before);
  expect((await walletRequests(page)).filter(method => method === 'eth_sendTransaction')).toHaveLength(2);
  expect(errors).toEqual([]); networkGuard.assertClean();
});

test('UX-003/UX-004: a declined wallet request resolves the locked CTA and offers Create new workflow', async ({ page, request, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const owner = await setup(page, request, { decline: 1 });
  await simulateAndExecute(page, owner);
  await owner.confirm();
  await expect(summary(page)).toContainText('Transaction not submitted'); await expect(processing(page)).toHaveCount(0);
  expect(await owner.sends()).toBe(0);
  const before = { workflowId: (JSON.parse(await readWorkflowIr(page)) as { workflowId: string }).workflowId, requested: owner.requested(), sends: await owner.sends() };
  await summary(page).getByRole('button', { name: 'Create new workflow', exact: true }).click();
  await expectCleanNewWorkflow(page, owner, before);
  expect(errors).toEqual([]); networkGuard.assertClean();
});

test('UX-004: an unresolved wallet response is never offered Create new workflow', async ({ page, request, networkGuard }) => {
  const owner = await setup(page, request, { lose: 1 });
  await simulateAndExecute(page, owner);
  await owner.confirm();
  await expect(summary(page)).toContainText(/unresolved|uncertain/i); await expect(processing(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create new workflow', exact: true })).toHaveCount(0);
  networkGuard.assertClean();
});

/**
 * BUILD-FIX-UX-001 (reported): after a declined wallet request, Create new workflow and the same swap with the same wallet were stuck on
 * the previous run ("Execution needs attention", "Cannot proceed"). The new workflow now gets its own simulation, Review and wallet request.
 */
test('BUILD-FIX-UX-001: declined request → Create new workflow → same swap → fresh Review and a new wallet request; the declined run stays recorded', async ({ page, request, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const owner = await setup(page, request, { decline: 1 });
  await simulateAndExecute(page, owner);
  await owner.confirm();
  await expect(summary(page)).toContainText('Transaction not submitted'); expect(await owner.sends()).toBe(0);
  const declined = await pointer(page), first = JSON.parse(await readWorkflowIr(page)) as { workflowId: string };
  expect(declined).toMatch(/^pub-[0-9a-f]{24}$/);
  // A definitively declined request is a concluded attempt, never a recovery: no "Recover execution", and starting over is offered.
  await expect(cta(page)).not.toContainText(/Recover execution|Execution needs attention/);
  await expect(cta(page).getByRole('button', { name: 'Simulate again', exact: true })).toBeEnabled();
  await summary(page).getByRole('button', { name: 'Create new workflow', exact: true }).click();
  await expectCleanNewWorkflow(page, owner, { workflowId: first.workflowId, requested: 1, sends: 0 });
  await buildSwap(page);
  const fresh = JSON.parse(await readWorkflowIr(page)) as { workflowId: string; revision: number };
  expect(fresh.workflowId).not.toBe(first.workflowId); expect(fresh.revision).toBe(1);
  // No stale execution state belongs to the new workflow, on any stage.
  await expect(cta(page).getByRole('button', { name: /^Simulate (workflow|again)$/ })).toBeEnabled({ timeout: 30_000 });
  await stage(page, 'Execute').click();
  await expect(summary(page)).not.toContainText(/Transaction not submitted|Execution already started|Result Summary|wallet request was cancelled/);
  await stage(page, 'Simulate').click();
  // Nothing was sent while starting over; the next request is a new, explicitly confirmed one with the same connected wallet.
  expect(owner.requested()).toBe(1); expect(await owner.sends()).toBe(0);
  await simulateReviewExecute(page, owner, 2);
  const second = await pointer(page);
  expect(second).not.toBe(declined);
  await confirmApprovalAndSwap(page, owner, 2);
  expect(await owner.sends()).toBe(2); expect(owner.requested()).toBe(3);
  await expect(owner.wallet.locator('.header-wallet-provider')).toHaveAttribute('title', 'MetaMask');
  await expect(owner.wallet.locator('.wallet-connection')).toHaveAttribute('title', /Base Sepolia/);
  // The declined attempt remains recorded exactly as it was; the new run is separate.
  expect(await durableAttempts(declined!)).toEqual([{ step: 'APPROVAL', state: 'REJECTED' }]);
  expect((await durableAttempts(second!)).map(a => a.state)).toEqual(['CONFIRMED', 'CONFIRMED']);
  expect(errors).toEqual([]); networkGuard.assertClean();
});

test('BUILD-FIX-UX-001: a declined request restored after reload offers Simulate again (not recovery); the same swap executes with a new wallet request', async ({ page, request, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const owner = await setup(page, request, { decline: 1 });
  await simulateAndExecute(page, owner);
  await owner.confirm();
  await expect(summary(page)).toContainText('Transaction not submitted');
  const declined = await pointer(page), authored = JSON.parse(await readWorkflowIr(page)) as { workflowId: string };
  await page.reload();
  await expect(owner.wallet.locator('.header-wallet-provider')).toHaveAttribute('title', 'MetaMask');
  await expect(owner.wallet.locator('.wallet-connection')).toHaveAttribute('title', /Base Sepolia/);
  // The recorded run is restored into the untouched draft as a result, with no recovery and no request.
  await expect(cta(page).getByRole('button', { name: 'Simulate again', exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(cta(page)).not.toContainText('Recover execution');
  expect((JSON.parse(await readWorkflowIr(page)) as { workflowId: string }).workflowId).toBe(authored.workflowId);
  await stage(page, 'Execute').click();
  await expect(summary(page)).toContainText('Transaction not submitted');
  await expect(summary(page).getByRole('button', { name: 'Create new workflow', exact: true })).toBeVisible();
  expect(owner.requested()).toBe(1); expect(await owner.sends()).toBe(0);
  // Navigating away and back does not resurrect recovery either.
  await stage(page, 'Build').click(); await stage(page, 'Simulate').click();
  await simulateReviewExecute(page, owner, 2);
  expect(await pointer(page)).not.toBe(declined);
  await confirmApprovalAndSwap(page, owner, 2);
  expect(await owner.sends()).toBe(2);
  expect(await durableAttempts(declined!)).toEqual([{ step: 'APPROVAL', state: 'REJECTED' }]);
  expect(errors).toEqual([]); networkGuard.assertClean();
});

type SwapIr = { revision: number; nodes: { actionType: string; inputs: { name: string; value: { amount?: string } }[]; userConstraints: { kind: string; maximumBps?: number }[] }[] };
const swapIr = async (page: Page) => (JSON.parse(await readWorkflowIr(page)) as SwapIr).nodes.find(node => node.actionType === 'asset.swap.exact-input')!;
const slippageOf = async (page: Page) => (await swapIr(page)).userConstraints.find(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS')!.maximumBps;
/** The applied limit everywhere the owner reads it: Advanced Settings, the simulation, and the Review that authorizes it. */
async function simulateAndReadLimits(page: Page) {
  await stage(page, 'Simulate').click();
  const simulate = cta(page).getByRole('button', { name: /^Simulate (workflow|again)$/ });
  await expect(simulate).toBeEnabled({ timeout: 30_000 }); await simulate.click();
  await expect(authorize(page)).toBeEnabled({ timeout: 30_000 });
  const text = await page.locator('main').innerText();
  // The Review & Authorization disclosure lists the Strategy Manifest's execution limits.
  const review = page.locator('details#simulation-review');
  if (!await review.evaluate(element => (element as HTMLDetailsElement).open)) await review.locator(':scope > summary').click();
  const limits = await review.innerText();
  return { slippage: /Slippage\s+([0-9.]+%)/.exec(text)?.[1], maximum: /Max slippage\s*([0-9.]+%)/.exec(limits)?.[1] ?? null, text };
}

test('BUILD-FIX-UX-001: a new swap starts at 100 bps; slippage and amount apply directly and each fresh simulation and Review uses them', async ({ page, request, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const owner = await setup(page, request);
  await stage(page, 'Build').click();
  expect(await slippageOf(page)).toBe(100);
  await openFirstActionSettings(page);
  const inspector = page.getByRole('region', { name: 'Action inspector' }), field = inspector.getByLabel('Slippage (bps)', { exact: true });
  await expect(field).toHaveValue('100'); await expect(inspector).toContainText('Applied limit: 100 bps (1.00%)');
  // Invalid values are refused with a reason and never silently reverted or applied.
  for (const bad of ['0', '301', 'abc', '1.5']) {
    await field.fill(bad); await field.press('Enter');
    await expect(inspector.getByRole('alert')).toContainText(/Enter (a slippage from 1 to 300 bps|the slippage as a whole number)/);
    await expect(field).toHaveValue(bad); await expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(await slippageOf(page)).toBe(100);
  }
  const first = await simulateAndReadLimits(page);
  expect(first.slippage).toBe('1.00%');
  // A slippage edit is one ordinary edit: it applies to the workflow and retires the earlier simulation and Review.
  await stage(page, 'Build').click(); await openFirstActionSettings(page);
  await field.fill('75'); await inspector.getByRole('button', { name: 'Apply slippage', exact: true }).click();
  await expect(inspector).toContainText('Applied limit: 75 bps (0.75%)');
  expect(await slippageOf(page)).toBe(75);
  await expect(authorize(page)).toHaveCount(0);
  const seventyFive = await simulateAndReadLimits(page);
  expect(seventyFive.slippage).toBe('0.75%');
  // The Review (Strategy Manifest) authorizes exactly the applied limit.
  expect(first.maximum).toBe('1.00%'); expect(seventyFive.maximum).toBe('0.75%');
  await stage(page, 'Build').click(); await openFirstActionSettings(page);
  await field.fill('100'); await field.press('Enter');
  expect(await slippageOf(page)).toBe(100);
  // An amount edit applies on Enter; the earlier Review can no longer authorize anything, and the fresh simulation uses the new amount.
  const card = page.locator('.build-flow-surface .composer-card').first(), amount = card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  await amount.fill('2'); await amount.press('Enter');
  expect((await swapIr(page)).inputs.find(input => input.name === 'amount-in')!.value.amount).toBe('2000000');
  await expect(authorize(page)).toHaveCount(0);
  const two = await simulateAndReadLimits(page);
  expect(two.slippage).toBe('1.00%'); expect(two.maximum).toBe('1.00%'); expect(two.text).toContain('2 USDC');
  await authorizeInWallet(page, owner, 1);
  await owner.confirm();
  expect(errors).toEqual([]); networkGuard.assertClean();
});
