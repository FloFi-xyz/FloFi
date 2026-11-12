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
import { expectEditorSection, openBuilder, openEditorSection, openReviewTechnicalDetails, reloadBuilder } from './build-entry-navigation';

test.skip(process.env.FLOFI_SWAP_EXECUTION_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Requires the opt-in loopback swap execution harness');
test.setTimeout(90_000);
const summary = (page: Page) => page.locator('.execution-summary');
/** BUILD0-UX-001: the chat-first Execute status panel (always visible) offers Create new workflow beside Return to Build. */
const createNew = (page: Page) => page.locator('.execution-status-panel').getByRole('button', { name: 'Create new workflow', exact: true });
/** P0 approved UX (board 06): the former "Simulation details" is the Review panel's collapsed Technical details (beside the canvas from 1200 px). */
async function openDetails(page: Page) {
  await openReviewTechnicalDetails(page);
}
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
  await openBuilder(page);
  const wallet = page.getByRole('group', { name: 'Wallet connection' });
  await expect(wallet.locator('.header-wallet-provider')).toHaveAttribute('title', 'MetaMask');
  await expect(wallet.locator('.wallet-connection')).toHaveAttribute('title', /Base Sepolia/);
  await buildSwap(page);
  await openEditorSection(page, 'Simulate');
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
  await expect(page.locator('.build-canvas-head .revision')).toHaveText('1 step');
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
  await openEditorSection(page, 'Build'); await openEditorSection(page, 'Execute');
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
  await expectEditorSection(page, 'Build');
  await expect(page.locator('.build-flow-surface .canvas-empty')).toContainText('Start your workflow');
  await expect(page.locator('.build-canvas-head .revision')).toHaveText('0 steps');
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
  await openEditorSection(page, 'Simulate');
  await expect(page.getByRole('button', { name: /Approve|Execute workflow|Authorize in wallet/ })).toHaveCount(0);
  await openEditorSection(page, 'Execute');
  await expect(summary(page)).not.toContainText(/Execution completed|Transaction not submitted|Result Summary/);
  await expect(page.getByRole('button', { name: 'Create new workflow', exact: true })).toHaveCount(0);
  await openEditorSection(page, 'Build');
}

test('UX-003/UX-004: completed run — locked CTAs, Return to the Canvas keeps the workflow, Create new workflow starts clean', async ({ page, request, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const owner = await setup(page, request);
  await simulateAndExecute(page, owner);
  await owner.confirm();
  const next = cta(page).getByRole('button', { name: 'Continue to swap', exact: true });
  await expect(next).toBeEnabled(); await expect(processing(page)).toHaveCount(0);
  await next.click(); await expectWaitingForWallet(page, owner, 2);
  await owner.confirm();
  await expect(summary(page)).toContainText('Execution completed'); await expect(processing(page)).toHaveCount(0);
  const create = createNew(page);
  await expect(create).toBeVisible(); await expect(summary(page).getByRole('button', { name: 'Return to the Canvas', exact: true })).toBeVisible();
  // Return to Build keeps editing the same workflow; the result stays available.
  const authored = await readWorkflowIr(page);
  await summary(page).getByRole('button', { name: 'Return to the Canvas', exact: true }).click();
  await expectEditorSection(page, 'Build');
  expect(await readWorkflowIr(page)).toBe(authored); await expect(page.locator('.build-canvas-head .revision')).toHaveText('1 step');
  // The old workflow's conversation must not survive a new workflow (BUILD-FLOFI-CONVERSATIONAL-001: the chat reports the recorded result and
  // offers Create new workflow; it never simulates over a completed run).
  await page.locator('#mock-prompt').fill('Review workflow'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log', { name: 'Conversation' }).locator('.message').last()).toContainText('Execution completed');
  await expect(page.getByRole('log', { name: 'Conversation' }).getByRole('button', { name: 'Create new workflow', exact: true })).toBeVisible();
  expect(owner.requested()).toBe(2);
  await openEditorSection(page, 'Execute'); await expect(summary(page)).toContainText('Execution completed');
  const before = { workflowId: (JSON.parse(authored) as { workflowId: string }).workflowId, requested: owner.requested(), sends: await owner.sends() };
  await createNew(page).click();
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
  await createNew(page).click();
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
  await createNew(page).click();
  await expectCleanNewWorkflow(page, owner, { workflowId: first.workflowId, requested: 1, sends: 0 });
  await buildSwap(page);
  const fresh = JSON.parse(await readWorkflowIr(page)) as { workflowId: string; revision: number };
  expect(fresh.workflowId).not.toBe(first.workflowId); expect(fresh.revision).toBe(1);
  // No stale execution state belongs to the new workflow, on any stage.
  await expect(cta(page).getByRole('button', { name: /^Simulate (workflow|again)$/ })).toBeEnabled({ timeout: 30_000 });
  await openEditorSection(page, 'Execute');
  await expect(summary(page)).not.toContainText(/Transaction not submitted|Execution already started|Result Summary|wallet request was cancelled/);
  await openEditorSection(page, 'Simulate');
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
  await reloadBuilder(page);
  await expect(owner.wallet.locator('.header-wallet-provider')).toHaveAttribute('title', 'MetaMask');
  await expect(owner.wallet.locator('.wallet-connection')).toHaveAttribute('title', /Base Sepolia/);
  // The recorded run is restored into the untouched draft as a result, with no recovery and no request.
  await expect(cta(page).getByRole('button', { name: 'Simulate again', exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(cta(page)).not.toContainText('Recover execution');
  expect((JSON.parse(await readWorkflowIr(page)) as { workflowId: string }).workflowId).toBe(authored.workflowId);
  await openEditorSection(page, 'Execute');
  await expect(summary(page)).toContainText('Transaction not submitted');
  await expect(createNew(page)).toBeVisible();
  expect(owner.requested()).toBe(1); expect(await owner.sends()).toBe(0);
  // Navigating away and back does not resurrect recovery either.
  await openEditorSection(page, 'Build'); await openEditorSection(page, 'Simulate');
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
/** The applied limit everywhere the owner reads it: the card's action settings, the simulation, and the Review that authorizes it. */
async function simulateAndReadLimits(page: Page) {
  await openEditorSection(page, 'Simulate');
  const simulate = cta(page).getByRole('button', { name: /^Simulate (workflow|again)$/ });
  await expect(simulate).toBeEnabled({ timeout: 30_000 }); await simulate.click();
  await expect(authorize(page)).toBeEnabled({ timeout: 30_000 });
  await openDetails(page);
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
  await openEditorSection(page, 'Build');
  expect(await slippageOf(page)).toBe(100);
  await openFirstActionSettings(page);
  const inspector = page.getByRole('dialog', { name: 'Action settings', exact: true }), field = inspector.getByLabel('Max price difference (%)', { exact: true });
  await expect(field).toHaveValue('1'); await expect(inspector).toContainText('Applied limit: 1%');
  // Invalid values are refused with a reason and never silently reverted or applied.
  // Board 16: the limit is typed in percent; 0.125% has no whole basis-point value and is refused, never rounded.
  for (const bad of ['0', '3.01', 'abc', '0.125']) {
    await field.fill(bad); await field.press('Enter');
    await expect(inspector.getByRole('alert')).toContainText(/Enter (a max price difference from 0\.01% to 3%|the max price difference as a percentage)/);
    await expect(field).toHaveValue(bad); await expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(await slippageOf(page)).toBe(100);
  }
  const first = await simulateAndReadLimits(page);
  expect(first.slippage).toBe('1.00%');
  // A slippage edit is one ordinary edit: it applies to the workflow and retires the earlier simulation and Review.
  await openEditorSection(page, 'Build'); await openFirstActionSettings(page);
  await field.fill('0.75'); await inspector.getByRole('button', { name: 'Apply max price difference', exact: true }).click();
  await expect(inspector).toContainText('Applied limit: 0.75%');
  expect(await slippageOf(page)).toBe(75);
  await expect(authorize(page)).toHaveCount(0);
  const seventyFive = await simulateAndReadLimits(page);
  expect(seventyFive.slippage).toBe('0.75%');
  // The Review (Strategy Manifest) authorizes exactly the applied limit.
  expect(first.maximum).toBe('1.00%'); expect(seventyFive.maximum).toBe('0.75%');
  await openEditorSection(page, 'Build'); await openFirstActionSettings(page);
  await field.fill('1'); await field.press('Enter');
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
