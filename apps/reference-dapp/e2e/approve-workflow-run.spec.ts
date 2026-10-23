// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: a multi-step workflow from a conversation, run on `/approve` without the Canvas, in the real application.
 *
 *   consumer OAuth → compose_strategy (two Base Sepolia swaps) → request_user_approval (ONE approval, authority NONE, the authorization counts)
 *   → the FloFi panel's "Authorize" → the owner proves the connected wallet → the run starts (confirm each step: this deployment cannot sign
 *   delegated steps) and loads step 1 into the minimal signing surface → its own Review and wallet confirmations → reconciliation → the run
 *   panel offers "Continue to step 2" (the owner's status poll observes the run; no worker is running here) → step 2 the same way → the run
 *   completes once → get_approval_status reports both steps to the conversation.
 *
 * The synthetic loopback swap RPC and disposable PostgreSQL, with scripted owner wallet confirmations. No public network, provider or
 * broadcast; it proves FloFi's side of the contract, not any vendor's MCP host or wallet extension.
 */
import type { APIRequestContext, Locator } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet.ts';
import { E2E_APP_ORIGIN as APP_ORIGIN } from './app-origin';
import { AUTHORIZE_IN_WALLET, proveConnectedEvmWallet, signingSurface } from './fixtures';
import { guardedContext, installJourneyWallet, walletRequests } from './journey-fixtures';
import { assertMcpHarness, CLIENT_NAME, connectViaBrowser, hostLog, mcpClient, openHost, panelHtmlOf } from './mcp-fixtures';

test.skip(process.env.GRYLOO_MCP_E2E !== 'EMBEDDED_LOOPBACK_ONLY' || process.env.FLOFI_SWAP_EXECUTION_E2E !== 'MOCKED_LOOPBACK_ONLY'
  || process.env.FLOFI_WORKFLOW_RUNS !== 'enabled', 'Requires the MCP harness, the opt-in loopback swap execution harness and workflow runs');
test.setTimeout(240_000);
test.beforeAll(assertMcpHarness);

async function control(request: APIRequestContext, method: string, params: unknown[] = []) {
  const response = await request.post('https://127.0.0.1:8558/control', { ignoreHTTPSErrors: true, data: { jsonrpc: '2.0', id: 1, method, params } });
  expect(response.ok()).toBe(true);
  return (await response.json() as { result: unknown }).result;
}
const SWAP = { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH' };

test('one approval for a two-step workflow: each step signed on /approve after the previous one reconciled, the run reported back to the chat', async ({ browser, request }) => {
  await control(request, 'MOCK_reset');
  const owner = createTestWallet();
  const { context, unexpected } = await guardedContext(browser);
  const consent = await context.newPage();
  const client = mcpClient(context.request, (await connectViaBrowser(consent, context.request)).accessToken);
  const composed = await client.tool('compose_strategy', { strategy: { version: 2, steps: [{ ...SWAP, amount: '1' }, { ...SWAP, amount: '2' }] } });
  expect(composed).toMatchObject({ ok: true, stepCount: 2, executionPlan: { kind: 'SEQUENTIAL', reason: null } });
  const args = { strategy: composed.strategy as Record<string, unknown>, workflowHash: String(composed.workflowHash) };
  const result = await client.toolResult('request_user_approval', args);
  // ONE approval; nothing is authorized by the chat, and the owner is told how many authorizations each mode needs before anything runs.
  expect(result.structuredContent).toMatchObject({ ok: true, status: 'PENDING', authority: 'NONE', executionPlan: 'SEQUENTIAL',
    authorizationPlan: { stepCount: 2, confirmEachStep: { available: true, walletConfirmationsAtLeast: 2 }, delegatedSingleAuthorization: { available: false } } });
  const approvalId = String((result.structuredContent as { approvalId: string }).approvalId);
  const host = await context.newPage();
  const panel = await openHost(host, client, await panelHtmlOf(client, 'ui://flofi/approval-panel.html'), args, result);
  await panel.getByRole('button', { name: 'Authorize', exact: true }).click();
  await expect.poll(async () => (await hostLog(host)).openLinks.length).toBe(1);
  const url = (await hostLog(host)).openLinks[0]!;
  expect(url).toMatch(new RegExp(`^${APP_ORIGIN.replace(/[.]/g, '\\.')}/approve#flofi_hs_[A-Za-z0-9_-]{43}$`));
  await consent.close();

  // Every transaction waits for the owner's scripted confirmation in the wallet.
  const confirmations: (() => void)[] = []; let requested = 0;
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installJourneyWallet(page, [owner], { chain: '0x14a34', transactionControl: async (method, params) => {
    if (method !== 'MOCK_send') throw Error('MOCK_METHOD_DENIED');
    requested++;
    await new Promise<void>(resolve => confirmations.push(resolve));
    return control(request, method, params);
  } });
  const confirm = async () => { await expect.poll(() => confirmations.length).toBe(1); confirmations.shift()!(); };
  const sends = () => control(request, 'MOCK_sends');
  await page.goto(url);
  const region = page.getByRole('region', { name: `Proposal from ${CLIENT_NAME}` });
  await expect(region).toContainText('Nothing is authorized yet.');
  const surface = signingSurface(page);
  await expect(page.getByRole('region', { name: 'Workflow canvas', exact: true })).toHaveCount(0);
  await proveConnectedEvmWallet(page, region, owner.address);

  // The run started at once (confirm each step is this deployment's only mode) and loaded step 1; step 2 waits.
  const run = page.getByRole('region', { name: 'Workflow steps' });
  await expect(run).toHaveAttribute('data-run-state', 'RUNNING');
  await expect(run).toContainText('2-step workflow');
  await expect(run).toContainText('You confirm each step in your wallet');
  const steps = run.getByRole('listitem');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toHaveAttribute('data-step-state', 'AWAITING_OWNER');
  await expect(steps.nth(1)).toHaveAttribute('data-step-state', 'PENDING');
  await expect(run.getByRole('button', { name: /Continue to step/ })).toHaveCount(0);

  /** One step on the signing surface: its own fresh simulation and Review, the token approval, then the swap, each confirmed in the wallet. */
  async function signStep(actions: Locator, before: number) {
    const authorize = actions.getByRole('button', { name: AUTHORIZE_IN_WALLET, exact: true });
    await expect(authorize).toBeEnabled({ timeout: 30_000 });
    await expect(surface).toContainText('Public testnet · Test funds');
    await expect(surface).toContainText(new RegExp(owner.address, 'i'));
    expect(requested).toBe(before); expect(await sends()).toBe(before);
    await authorize.click();
    await expect.poll(() => requested).toBe(before + 1);
    await confirm();
    const next = actions.locator('[data-lifecycle-action="continue"]');
    await expect(next).toHaveText('Continue to swap', { timeout: 30_000 });
    await next.click();
    await expect.poll(() => requested).toBe(before + 2);
    await confirm();
    await expect(surface.locator('.signing-status')).toContainText('Execution completed', { timeout: 45_000 });
  }

  await signStep(surface, 0);
  // Step 1 reconciled: the run panel offers step 2 (nothing of step 2 was requested or sent before the owner continues).
  const continueTo2 = run.getByRole('button', { name: 'Continue to step 2', exact: true });
  await expect(continueTo2).toBeVisible({ timeout: 30_000 });
  await expect(steps.nth(0)).toHaveAttribute('data-step-state', 'RECONCILED');
  await expect(steps.nth(1)).toHaveAttribute('data-step-state', 'PENDING');
  expect(requested).toBe(2); expect(await sends()).toBe(2);
  await continueTo2.click();
  await expect(steps.nth(1)).toHaveAttribute('data-step-state', 'AWAITING_OWNER');
  await expect(continueTo2).toHaveCount(0);

  await signStep(surface, 2);
  await expect(run).toHaveAttribute('data-run-state', 'COMPLETED', { timeout: 30_000 });
  await expect(run).toContainText('Every step reconciled.');
  await expect(steps.nth(1)).toHaveAttribute('data-step-state', 'RECONCILED');

  // The conversation sees the run from durable state: both steps, their transactions (the owner shares status) and never the wallet.
  const status = await client.tool('get_approval_status', { approvalId });
  expect(status).toMatchObject({ ok: true, authority: 'NONE', workflowRun: { state: 'COMPLETED', mode: 'CONFIRM_EACH_STEP', nextAction: 'NONE', stepsVisible: true,
    steps: [{ index: 0, state: 'RECONCILED' }, { index: 1, state: 'RECONCILED' }] } });
  const submitted = (status.workflowRun as { steps: { outcome: { submissions: unknown[] } | null }[] }).steps.map(s => s.outcome?.submissions.length ?? 0);
  expect(submitted.every(n => n > 0)).toBe(true);
  expect(JSON.stringify(status).toLowerCase()).not.toContain(owner.address.toLowerCase());

  // Exactly the four owner-confirmed transactions reached the wallet and the chain double; nothing was sent again.
  expect((await walletRequests(page)).filter(method => method === 'eth_sendTransaction')).toHaveLength(4);
  expect(await sends()).toBe(4); expect(requested).toBe(4);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});
