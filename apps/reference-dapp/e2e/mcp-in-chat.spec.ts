// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-002 AC-7: the in-chat execution journey in a real browser, end to end, on the embedded PostgreSQL runtime with the
 * MOCKED loopback router and Solana Devnet harnesses (never a public network, never a real transaction):
 *
 *   consumer OAuth (consent page, invite) → compose_strategy → request_user_approval → the FloFi panel in an MCP Apps host →
 *   "Authorize" (ui/open-link to a fresh FloFi approval session on the minimal signing surface) or "View in FloFi" (the same session
 *   on the Canvas) → wallet proof (EIP-4361 / Sign-In With Solana; an already connected EVM wallet is recognized, no selector) →
 *   the exact proposal loaded for that wallet → FloFi's own fresh simulation → one "Authorize in wallet" action, which current main
 *   keeps disabled for MOCKED evidence → prepared status back in the panel and model context.
 *   The separate PostgreSQL journey retains the positive owner-driven lifecycle and reconciled evidence coverage.
 *
 * The test host is minimal and honest about what it is: it proves FloFi's side of the MCP Apps contract, not any vendor's host.
 */
import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import { createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet.ts';
import { E2E_APP_ORIGIN as APP_ORIGIN } from './app-origin';
import { MOCKED_SOLANA_WALLET, signRequests } from './jupiter-fixtures';
import { AUTHORIZE_IN_WALLET, chooseWallet, openProposalSimulationDetails, proveConnectedEvmWallet, signingSurface } from './fixtures';
import { assertExecutionBlocked } from './release-safety-fixtures';
import { guardedContext, installJourneyWallet, journeySends, walletRequests } from './journey-fixtures';
import { assertMcpHarness, CLIENT_NAME, connectViaBrowser, hostLog, mcpClient, openHost, panelHtmlOf } from './mcp-fixtures';
import { routerControl } from './router-fixtures';
import { installLendingWallet, LENDING_OWNER, lendingRpc, lendingSends } from './lending-fixtures';
import { devnetControl, devnetPanel, installDevnetWallet } from './solana-devnet-fixtures';
import { panelHtml } from '../src/mcp/app/panel';

const PANEL_URI = 'ui://flofi/approval-panel-chat-first-v1.html';
/** The newest durable run of one flow owned by one wallet, read from the disposable loopback database. */
async function latestRun(flow: string, owner: string): Promise<string> {
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  try {
    const row = (await db.query<{ run_id: string }>('SELECT run_id FROM execution_runs WHERE flow = $1 AND owner_account = $2 ORDER BY created_at DESC LIMIT 1',
      [flow, owner])).rows[0];
    if (!row) throw new Error('RUN_NOT_RECORDED');
    return row.run_id;
  } finally { await db.close(); }
}
// BUILD-FLOFI-UX-UI-002: the proposal's compact notice inside the normal workspace (no separate proposal panel or Load step).
const approval = (page: Page) => page.getByRole('region', { name: `Proposal from ${CLIENT_NAME}` });
const bridge = (page: Page) => page.getByRole('region', { name: 'Cross-chain bridge' });
type Presentation = 'signing' | 'canvas';
/** On the signing surface nothing financial is enabled and no result or evidence exists. */
async function assertSigningBlocked(page: Page, requests: () => Promise<number>) {
  await expect(signingSurface(page)).toBeVisible();
  await expect(signingSurface(page).getByRole('button', { name: AUTHORIZE_IN_WALLET, exact: true }).and(page.locator(':enabled'))).toHaveCount(0);
  await expect(signingSurface(page).locator(['approve', 'execute', 'continue'].map(kind => `button[data-lifecycle-action="${kind}"]:enabled`).join(', '))).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Download.*Evidence Bundle|View receipt and evidence/ })).toHaveCount(0);
  expect(await requests()).toBe(0);
}
async function assertHandoffReviewBlocked(page: Page, requests: () => Promise<number>, proposalUrl: string) {
  await expect(page.locator('.canvas-primary-action').getByRole('button', { name: AUTHORIZE_IN_WALLET, exact: true })).toBeDisabled();
  await expect(page.locator('.review-authorization-details')).toContainText('A simulation that can authorize this workflow is required before approval.');
  await expect(page.getByRole('region', { name: 'Authorization technical details', exact: true })).toContainText('Strategy Manifest');
  await expect(page.getByRole('button', { name: 'Review approved', exact: true })).toHaveCount(0);
  expect(await requests()).toBe(0);
  await assertExecutionBlocked(page, requests);
  // The signing-session link stays consumed. Its proven claimant may restore the authoring proposal, with no prior Review authority.
  // Diagnostics explicitly enter engineering; restore the external approval URL
  // for the same full-document owner restoration check.
  // An applied proposal is never restored silently (an interrupted run's recovery must not be replaced): one explicit Restore.
  await page.goto(proposalUrl);
  await expect(approval(page)).toContainText('Nothing is authorized yet.');
  await expect(approval(page)).toContainText('This proposal is already in a FloFi workflow for your wallet.');
  await expect(approval(page).getByRole('button', { name: 'Load proposal' })).toHaveCount(0);
  await approval(page).getByRole('button', { name: 'Restore proposal' }).click();
  await expect(approval(page).getByRole('status')).toContainText('Proposal restored for its proven owner.');
  if (new URL(proposalUrl).searchParams.get('view') === 'canvas') await assertExecutionBlocked(page, requests);
  else await assertSigningBlocked(page, requests);
}

async function chatToSigningWindow(context: BrowserContext, strategy: Record<string, unknown>, presentation: Presentation = 'signing') {
  const consent = await context.newPage();
  const { accessToken } = await connectViaBrowser(consent, context.request);
  const client = mcpClient(context.request, accessToken);
  const composed = await client.tool('compose_strategy', { strategy });
  expect(composed).toMatchObject({ ok: true, stepCount: 1 });
  const args = { strategy: composed.strategy as Record<string, unknown>, workflowHash: String(composed.workflowHash) };
  const result = await client.toolResult('request_user_approval', args);
  expect(result.structuredContent).toMatchObject({ ok: true, status: 'PENDING', authority: 'NONE' });
  // The text result alone already lets a host without MCP Apps send the user to FloFi (fallback E).
  expect(result.content?.[0]?.text).toContain(`${APP_ORIGIN}/approve#apr_`);
  expect(JSON.stringify(result.structuredContent) + result.content?.[0]?.text).not.toContain('flofi_hs_');
  // BUILD-WORKFLOW-VISUAL-PRESENTATION-001: a readable summary with Open in FloFi, and the workflow picture as standard image content.
  expect(result.content?.map(block => block.type)).toEqual(['text', 'text', 'image']);
  expect(result.content?.[1]?.text).toContain(`Open in FloFi: ${APP_ORIGIN}/approve#apr_`);
  expect((result.structuredContent?.visual as { workflowHash?: string } | undefined)?.workflowHash).toBe(String(composed.workflowHash));
  const host = await context.newPage();
  const panel = await openHost(host, client, await panelHtmlOf(client, PANEL_URI), args, result);
  await expect(panel.getByText('Nothing is authorized yet.', { exact: false })).toBeVisible();
  // The proposal as FloFi's workflow visual, labelled with its text alternative; the full workflow hash stays listed.
  await expect(panel.getByRole('img', { name: /^FloFi workflow: / })).toBeVisible();
  await panel.getByText('Proposal details', { exact: true }).click();
  await expect(panel.getByText(`Workflow hash: ${String(composed.workflowHash)}`)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Check this chat environment (diagnostics)' })).toBeVisible();
  // BUILD-SOLANA-TRANSFER-UX-001: "Authorize" opens the minimal signing surface; "View in FloFi" opens the same session on the Canvas.
  await expect(panel.getByRole('button', { name: 'Authorize in chat', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Open FloFi', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Open FloFi', exact: true }).click();
  await expect.poll(async () => (await hostLog(host)).openLinks.length).toBe(1);
  const url = (await hostLog(host)).openLinks[0]!;
  expect(url).toMatch(new RegExp(`^${APP_ORIGIN.replace(/[.]/g, '\\.')}/approve#flofi_hs_[A-Za-z0-9_-]{43}$`));
  await consent.close();
  return { client, host, panel, url: presentation === 'canvas' ? url.replace('/approve#', '/approve?view=canvas#') : url, composed };
}
async function proposalIntoWorkflow(signing: Page, url: string, wallet: 'evm' | 'solana', account?: string, connected?: string) {
  const response = await signing.goto(url);
  expect(response?.headers()['content-security-policy']).toContain("connect-src 'self'");
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await expect(signing.locator('.app-shell')).toHaveCount(1);
  const region = approval(signing);
  await expect(region).toContainText(`From ${CLIENT_NAME}`);
  await expect(region).toContainText('Nothing is authorized yet.');
  await expect(region).toContainText('Test funds');
  await region.getByText('Proposal details', { exact: true }).click();
  await expect(region).toContainText('not financial advice');
  await region.getByText('Proposal details', { exact: true }).click();
  // BUILD-FLOFI-UX-UI-002: no separate panel and no Load step. BUILD-SOLANA-TRANSFER-UX-001: the signing surface (default) lists the exact
  // requested action; "View in FloFi" (`?view=canvas`) shows the proposal's action cards on the normal Canvas. Either way nothing can be
  // simulated or authorized until a proven wallet has loaded the proposal.
  await expect(signing.locator('.approval-page, .approval-handoff')).toHaveCount(0);
  if (new URL(url).searchParams.get('view') === 'canvas') {
    await expect(signing.getByRole('region', { name: 'Workflow canvas', exact: true })).toBeVisible();
    await expect(signing.locator('.build-flow-surface .composer-card').first()).toBeVisible();
    await expect(signing.locator('.canvas-primary-action button')).toBeDisabled();
  } else {
    await expect(signingSurface(signing)).toBeVisible();
    await expect(signing.getByRole('navigation', { name: 'Workflow stages' })).toHaveCount(0);
    await expect(signing.getByRole('region', { name: 'Workflow canvas', exact: true })).toHaveCount(0);
    await expect(signingSurface(signing).locator('button[data-lifecycle-action]')).toHaveCount(0);
  }
  await expect(signing.getByRole('checkbox', { name: /I understand/ })).toHaveCount(0);
  await expect(region.getByRole('button', { name: 'Load proposal' })).toHaveCount(0);
  // The secret left the address bar; the account consented in this browser, so status sharing is on by default.
  expect(signing.url()).not.toContain('flofi_hs_');
  await expect(region.getByRole('checkbox')).toBeChecked();
  // The journey wallet records its requests; the Solana and lending fixtures keep their own logs.
  const signIns = await walletRequests(signing).then(requests => requests.filter(method => method === 'personal_sign').length).catch(() => null);
  if (wallet === 'evm') await proveConnectedEvmWallet(signing, region, connected ?? account!);
  else { await region.getByRole('button', { name: 'Connect Solana wallet and prove ownership' }).click(); await chooseWallet(signing, MOCKED_SOLANA_WALLET, 'Solana'); }
  // The proof itself loads the proposal: one sign-in message, then the exact proposal, with no further approval step.
  await expect(region.getByRole('status')).toContainText('Ready for your review.');
  if (signIns !== null) expect((await walletRequests(signing)).filter(method => method === 'personal_sign')).toHaveLength(signIns + 1);
  if (account) await expect(region.getByRole('checkbox')).toBeChecked();
}

test.describe('BUILD-MCP-002 in-chat execution (mocked MCP Apps host)', () => {
  test.beforeAll(assertMcpHarness);

  for (const namespace of ['evm', 'solana'] as const) test(`embedded wallet proof (${namespace}): fresh review stays in chat; no open-link or Canvas`, async ({ browser }) => {
    const { context, unexpected } = await guardedContext(browser);
    const host = await context.newPage(), consent = await context.newPage();
    const owner = createTestWallet(), solana = createMockedSolanaWallet();
    if (namespace === 'evm') {
      await routerControl('MOCK_reset', [{ network: 'testnet', owner: owner.address, wallets: [] }]);
      await installJourneyWallet(host, [owner]);
    } else {
      await devnetControl({ action: 'reset', owner: solana.owner, options: {}, devUsdc: '0' });
      await installDevnetWallet(host, solana, { signMessage: true });
    }
    const client = mcpClient(context.request, (await connectViaBrowser(consent, context.request)).accessToken);
    const capabilities = await client.tool('get_capabilities', {});
    expect(capabilities).toMatchObject({ ok: true });
    expect(capabilities.conversationExecution).toMatchObject({ surface: 'MCP_APP_EMBEDDED_SIGNING', canvasRequired: false, hostAndWalletVerified: false });
    const strategy = namespace === 'evm'
      ? { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '1' }
      : { action: 'swap', network: 'solana-devnet', inputAsset: 'SOL', outputAsset: 'devUSDC', amount: '0.1' };
    const composed = await client.tool('compose_strategy', { strategy });
    const args = { strategy: composed.strategy, workflowHash: composed.workflowHash };
    await client.tool('review_strategy', args);
    const result = await client.toolResult('request_user_approval', args);
    expect(JSON.stringify(result.structuredContent)).not.toContain('flofi_hs_');
    const panel = await openHost(host, client, await panelHtmlOf(client, PANEL_URI), args, result, { embedded: true });
    await panel.getByRole('button', { name: 'Authorize in chat', exact: true }).click();
    const signing = panel.frameLocator('iframe.signing-frame');
    const region = signing.getByRole('region', { name: `Proposal from ${CLIENT_NAME}` });
    await expect(signing.getByRole('main', { name: 'Authorize with your wallet' })).toBeVisible();
    await expect(signing.getByRole('navigation', { name: 'Workflow stages' })).toHaveCount(0);
    await expect(signing.getByRole('region', { name: 'Workflow canvas', exact: true })).toHaveCount(0);
    await region.getByRole('button', { name: namespace === 'evm' ? 'Connect wallet and prove ownership' : 'Connect Solana wallet and prove ownership' }).click();
    if (namespace === 'solana') await signing.getByRole('button', { name: `${MOCKED_SOLANA_WALLET} on Solana`, exact: true }).click();
    await expect(region.getByRole('status')).toContainText('Ready for your review.');
    await expect(signing.getByRole('button', { name: AUTHORIZE_IN_WALLET, exact: true })).toBeDisabled({ timeout: 30_000 });
    // The iframe persists through the panel's authoritative status refresh, preserving the wallet/runtime instance.
    const frame = host.frames().find(frame => new URL(frame.url()).pathname === '/mcp/approve')!;
    await frame.evaluate(() => { (window as unknown as { frameIdentity: string }).frameIdentity = 'same-signing-runtime'; });
    await panel.getByRole('button', { name: 'Refresh status' }).click();
    await expect.poll(() => frame.evaluate(() => (window as unknown as { frameIdentity: string }).frameIdentity)).toBe('same-signing-runtime');
    const cookies = (await context.cookies()).map(({ name, httpOnly, secure, sameSite, path }) => ({ name, httpOnly, secure, sameSite, path }));
    const proof = cookies.find(cookie => cookie.name === `embedded_flofi_${namespace === 'evm' ? 'wallet' : 'solana'}_session`);
    expect(proof).toMatchObject({ httpOnly: true, secure: true, sameSite: 'None', path: '/mcp/approve' });
    expect(cookies.some(cookie => cookie.name === `flofi_${namespace === 'evm' ? 'wallet' : 'solana'}_session`)).toBe(false);
    expect((await hostLog(host)).openLinks).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(namespace === 'evm' ? await journeySends() : await devnetControl({ action: 'sent' })).toBe(0);
    await context.close();
  });

  test('embedded wallet proof: missing signer is explicit and never forces an external CTA or fabricates approval', async ({ browser }) => {
    const { context, unexpected } = await guardedContext(browser), host = await context.newPage(), consent = await context.newPage();
    const client = mcpClient(context.request, (await connectViaBrowser(consent, context.request)).accessToken);
    const composed = await client.tool('compose_strategy', { strategy: { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '1' } });
    const args = { strategy: composed.strategy, workflowHash: composed.workflowHash };
    const result = await client.toolResult('request_user_approval', args);
    const panel = await openHost(host, client, await panelHtmlOf(client, PANEL_URI), args, result, { embedded: true });
    await consent.close();
    await panel.getByRole('button', { name: 'Authorize in chat', exact: true }).click();
    const signing = panel.frameLocator('iframe.signing-frame');
    await signing.getByRole('button', { name: 'Connect wallet and prove ownership' }).click();
    await expect(signing.getByRole('status').filter({ hasText: 'No compatible wallet is available inside this chat.' })).toBeVisible();
    await expect(signing.locator('[data-wallet-option]')).toHaveCount(0);
    await signing.getByRole('button', { name: 'Close wallet selector', exact: true }).click();
    const status = await client.tool('get_approval_status', { approvalId: result.structuredContent!.approvalId });
    expect(status).toMatchObject({ ok: true, status: 'PENDING', runs: [] });
    expect((await hostLog(host)).openLinks).toEqual([]); expect(context.pages()).toHaveLength(1); expect(unexpected).toEqual([]);
    await context.close();
  });

  test('EVM: chat → panel Authorize → signing surface → wallet proof → FloFi-prepared router simulation; current main blocks MOCKED execution and the panel reports prepared status', async ({ browser }) => {
    const owner = createTestWallet();
    await routerControl('MOCK_reset', [{ network: 'testnet', owner: owner.address, wallets: [] }]);
    const { context, unexpected } = await guardedContext(browser);
    const { host, panel, url } = await chatToSigningWindow(context, { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '1' });
    expect(await journeySends()).toBe(0);

    const signing = await context.newPage();
    const errors: string[] = []; signing.on('pageerror', e => errors.push(e.message));
    await installJourneyWallet(signing, [owner]);
    await proposalIntoWorkflow(signing, url, 'evm', undefined, owner.address);
    // Chat-first, no Canvas: FloFi prepares the fresh simulation for the proven wallet; the signing surface shows the exact action, the
    // signer and the test-funds network, and its one owner action stays disabled because MOCKED evidence cannot authorize.
    const surface = signingSurface(signing);
    await expect(surface.getByRole('list', { name: 'Requested actions' })).toContainText('Base Sepolia');
    await expect(surface).toContainText(new RegExp(owner.address, 'i'));
    await expect(surface).toContainText('Public testnet · Test funds');
    await expect(surface.getByRole('button', { name: AUTHORIZE_IN_WALLET, exact: true })).toBeDisabled({ timeout: 30_000 });
    await assertSigningBlocked(signing, journeySends);
    // The prepared simulation reuses the sign-in the proof just completed: one wallet message in total, no second prompt.
    expect((await walletRequests(signing)).filter(method => method === 'personal_sign')).toHaveLength(1);
    // Use the authoritative product's simulation and Review; a MOCKED route cannot authorize execution.
    await openProposalSimulationDetails(signing);
    await expect(bridge(signing)).toContainText('Strategy Manifest');
    await expect(bridge(signing)).toContainText(`Owner ${owner.address}`);
    expect(await walletRequests(signing)).toContain('personal_sign');
    await assertHandoffReviewBlocked(signing, journeySends, url);
    expect(await walletRequests(signing)).not.toContain('eth_sendTransaction');

    // Status still reaches the chat, without claiming reconciliation or an evidence bundle.
    await expect(panel.getByText(/crosschain-router-testnet · PREPARED/).first()).toBeVisible({ timeout: 45_000 });
    const log = await hostLog(host);
    expect(log.toolCalls).toEqual(expect.arrayContaining(['open_approval_session', 'get_execution_progress']));
    expect(log.toolCalls).not.toContain('request_user_approval');
    const context0 = log.modelContext.at(-1)!;
    expect(context0.content?.[0]?.text).toContain('PREPARED');
    expect(JSON.stringify(context0)).not.toMatch(/RECONCILED|0x[0-9a-f]{64}/);
    expect(JSON.stringify(log)).not.toMatch(/flofi_at_|flofi_rt_|calldata|"signature"/);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  });

  test('Solana: panel View in FloFi → Canvas → Sign-In With Solana → FloFi-prepared Orca simulation; current main blocks MOCKED execution and the panel reports simulated status', async ({ browser }) => {
    const wallet = createMockedSolanaWallet();
    await devnetControl({ action: 'reset', owner: wallet.owner, options: {}, devUsdc: '0' });
    const { context, unexpected } = await guardedContext(browser);
    const { panel, url } = await chatToSigningWindow(context, { action: 'swap', network: 'solana-devnet', inputAsset: 'SOL', outputAsset: 'devUSDC', amount: '0.1' }, 'canvas');
    const signing = await context.newPage();
    await installDevnetWallet(signing, wallet, { signMessage: true });
    await proposalIntoWorkflow(signing, url, 'solana', wallet.owner);
    // Optional Canvas: the proposal's action card is on the Canvas, and the wallet proven for the proposal is the one its simulation uses
    // (no second connection); FloFi prepared that fresh simulation itself.
    await expect(signing.getByRole('region', { name: 'Simulation workflow graph', exact: true }).locator('.composer-card').first()).toContainText('Solana Devnet');
    await openProposalSimulationDetails(signing);
    await expect(devnetPanel(signing).getByRole('button', { name: 'Connect Solana wallet' })).toHaveCount(0);
    await expect(devnetPanel(signing).getByRole('definition').filter({ hasText: '→ expected' })).toContainText('0.1 Devnet SOL → expected');
    await assertHandoffReviewBlocked(signing, () => signRequests(signing), url);
    expect(await devnetControl({ action: 'sent' })).toBe(0);
    await expect(panel.getByText(/solana-devnet-swap · SIMULATED/).first()).toBeVisible({ timeout: 45_000 });
    expect(unexpected).toEqual([]);
    await context.close();
  });

  test('lending composition (v2 supply → borrow → swap): proposal and simulation preserve main’s MOCKED execution guard and report simulated status', async ({ browser }) => {
    test.setTimeout(120_000);
    // The lending harness funds one public disposable fixture account; the test signs its sign-in message with that fixture key.
    const fixtureOwner = createTestWallet(new Uint8Array(32).fill(0x43));
    expect(fixtureOwner.address).toBe(LENDING_OWNER);
    await lendingRpc('MOCK_reset', [{}]);
    const { context, unexpected } = await guardedContext(browser);
    const steps = [{ action: 'supply', network: 'base-sepolia', asset: 'USDC', amount: '0.1', beneficiary: LENDING_OWNER },
      { action: 'borrow', network: 'base-sepolia', asset: 'USDC', amount: '0.01', beneficiary: LENDING_OWNER },
      { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '0.01', slippageBps: 50 }];
    const { panel, url, composed } = await chatToSigningWindow(context, { version: 2, steps });
    expect(composed).toMatchObject({ strategy: { action: 'lending_composition', owner: LENDING_OWNER }, executionPlan: { kind: 'COMPOSITE_FLOW' } });
    const signing = await context.newPage();
    await installLendingWallet(signing, { signer: fixtureOwner });
    await proposalIntoWorkflow(signing, url, 'evm', LENDING_OWNER);
    const lending = signing.getByRole('region', { name: 'Lending composition' });
    await openProposalSimulationDetails(signing);
    await expect(lending).toContainText('Expected output:');
    await assertHandoffReviewBlocked(signing, () => lendingSends(signing), url);
    await expect(panel.getByText(/lending-composition · SIMULATED/).first()).toBeVisible({ timeout: 45_000 });
    expect(unexpected).toEqual([]);
    await context.close();
  });

  test('another browser cannot take a claimed proposal or share by default; /connections links a wallet for run reads, and unlinks it', async ({ browser }) => {
    const owner = createTestWallet(), other = createTestWallet();
    await routerControl('MOCK_reset', [{ network: 'testnet', owner: owner.address, wallets: [other.address] }]);
    const { context, unexpected } = await guardedContext(browser);
    const { client, url } = await chatToSigningWindow(context, { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '1' });
    // Someone else's browser (no FloFi account here) can see the proposal; sharing with the requesting account is off by default.
    const elsewhere = await guardedContext(browser), stranger = await elsewhere.context.newPage();
    await installJourneyWallet(stranger, [other]);
    await stranger.goto(url);
    await expect(approval(stranger).getByRole('checkbox')).not.toBeChecked();
    // The owner claims first, in the browser that holds the account.
    const signing = await context.newPage();
    await installJourneyWallet(signing, [owner]);
    await proposalIntoWorkflow(signing, url, 'evm', owner.address);
    // A second proven wallet holding the same link cannot take it: claimed by another wallet, and once applied the approval-session
    // link no longer resolves at all (it reveals nothing about the proposal).
    await proveConnectedEvmWallet(stranger, approval(stranger), other.address);
    await expect(approval(stranger)).toContainText(/Another wallet already opened this proposal|HANDOFF_NOT_FOUND/);
    await expect(approval(stranger).getByRole('status')).toHaveCount(0);
    await expect(stranger.locator('button[data-lifecycle-action]:enabled')).toHaveCount(0);
    // The owner's simulation creates a durable run owned by their wallet; the account cannot read it until the wallet is linked.
    await openProposalSimulationDetails(signing);
    await expect(bridge(signing)).toContainText(`Owner ${owner.address}`);
    await expect.poll(() => latestRun('crosschain-router-testnet', owner.address).catch(() => null)).not.toBeNull();
    const runId = await latestRun('crosschain-router-testnet', owner.address);
    expect(await client.tool('get_execution_status', { executionId: runId })).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    const connections = await context.newPage();
    await installJourneyWallet(connections, [owner]);
    await connections.goto(`${APP_ORIGIN}/connections`);
    const panel = connections.getByRole('region', { name: 'Connections' });
    await expect(panel).toContainText(/Account mcpacct_[a-z2-7]{26}/);
    await expect(panel).toContainText(`Signed in as ${owner.address}`);
    await panel.getByRole('button', { name: /^Link 0x/ }).click();
    await expect(panel.getByRole('button', { name: 'Remove link' })).toBeVisible();
    expect(await client.tool('get_execution_status', { executionId: runId })).toMatchObject({ ok: true, executionId: runId, owner: owner.address, accessBasis: 'ACCOUNT_LINKED_WALLET' });
    await panel.getByRole('button', { name: 'Remove link' }).click();
    await expect(panel).toContainText('No linked wallet.');
    expect(await client.tool('get_execution_status', { executionId: runId })).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
    expect(await journeySends()).toBe(0);
    expect([...unexpected, ...elsewhere.unexpected]).toEqual([]);
    await elsewhere.context.close(); await context.close();
  });

  test('a mainnet strategy is refused by policy before any panel or link exists; nothing is opened', async ({ browser }) => {
    const { context, unexpected } = await guardedContext(browser);
    const consent = await context.newPage();
    const client = mcpClient(context.request, (await connectViaBrowser(consent, context.request)).accessToken);
    const composed = await client.tool('compose_strategy', { strategy: { action: 'swap', network: 'solana', inputAsset: 'USDC', outputAsset: 'SOL', amount: '1' } });
    const refused = await client.toolResult('request_user_approval', { strategy: composed.strategy as Record<string, unknown>, workflowHash: String(composed.workflowHash) });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ ok: false, gates: { supportedByCode: { execute: true }, enabledByPolicy: { enabled: false, fundsClass: 'REAL_FUNDS' } } });
    expect(['MAINNET_HANDOFF_DISABLED_BY_POLICY', 'FLOW_NOT_ENABLED_IN_DEPLOYMENT']).toContain(refused.structuredContent?.code);
    expect(JSON.stringify(refused)).not.toContain('/approve#');
    expect(unexpected).toEqual([]);
    await context.close();
  });
});

test.describe('BUILD-MCP-LINK-INTEGRITY-P0 panel navigation', () => {
  const origin = 'https://flofi.xyz', approvalId = 'apr_' + 'a'.repeat(26), secret = 'flofi_hs_' + 'x'.repeat(43);
  const publicUrl = `${origin}/approve#${approvalId}`, privateUrl = `${origin}/approve#${secret}`;
  const approved = { ok: true, approvalId, approvalUrl: publicUrl, workflowHash: '0x' + '1'.repeat(64), steps: [], status: 'PENDING', authority: 'NONE' };
  const html = () => panelHtml({ origin, inFrameProbeHosts: [] });
  // A protocol host double supplies deliberately hostile results. This tests FloFi's UI, not the honesty of a real host/LLM.
  const fakeClient = (result: Record<string, unknown> = {}) => ({
    call: async () => result, tool: async () => result, toolResult: async () => ({ structuredContent: result }),
  });

  test('no tool result, failed tools and invented links produce no CTA; a new failure clears the old CTA', async ({ context }) => {
    const hostile = ['https://www.flo.finance/?utm_source=chatgpt.com', 'https://flofi.xyz.evil.test/approve', 'https://fl0fi.xyz/approve',
      'https://flofı.xyz/approve', 'http://flofi.xyz/approve', 'javascript:alert(1)', 'data:text/html,hi', 'https://[bad',
      `https://user@flofi.xyz/approve#${approvalId}`, `https://flofi.xyz/x/../approve#${approvalId}`,
      `${origin}/approve?redirect=https://flo.finance#${approvalId}`, `${origin}/approve#apr_${'b'.repeat(26)}`, `${origin}/approve#fabricated`];
    const invalid = [{}, { structuredContent: { ...approved }, isError: true },
      ...hostile.map(approvalUrl => ({ structuredContent: { ...approved, approvalUrl } })),
      { structuredContent: approved, _meta: { 'flofi/approval': { approvalUrl: 'https://flo.finance/approve' } } }];
    for (const result of invalid) {
      const page = await context.newPage();
      const panel = await openHost(page, fakeClient(), html(), {}, result);
      await expect.poll(async () => (await hostLog(page)).initialized).toBe(true);
      await expect(panel.getByRole('button', { name: 'Authorize in chat', exact: true })).toHaveCount(0);
      await expect(panel.locator('code')).toHaveCount(0);
      expect((await hostLog(page)).openLinks).toEqual([]);
      await page.close();
    }
    const page = await context.newPage();
    const panel = await openHost(page, fakeClient(), html(), {}, { structuredContent: approved });
    await expect(panel.getByRole('button', { name: 'Authorize in chat', exact: true })).toBeVisible();
    await page.evaluate(() => (document.getElementById('app') as HTMLIFrameElement).contentWindow!.postMessage({ jsonrpc: '2.0',
      method: 'ui/notifications/tool-result', params: { isError: true, structuredContent: { ok: false, code: 'TOOL_FAILED' } } }, '*'));
    await expect(panel.getByRole('button', { name: 'Authorize in chat', exact: true })).toHaveCount(0);
    await expect(panel.locator('code')).toHaveCount(0);
  });

  test('valid canonical approval opens only after a successful matching session; unsafe sessions never reach open-link', async ({ context }) => {
    for (const result of [{}, { ok: false, code: 'TOOL_FAILED' }, { ok: true, approvalId, approvalUrl: 'https://flo.finance/approve' },
      { ok: true, approvalId, approvalUrl: `https://user@flofi.xyz/approve#${secret}` },
      { ok: true, approvalId, approvalUrl: `${origin}/approve?next=https://flo.finance#${secret}` },
      { ok: true, approvalId: 'apr_' + 'b'.repeat(26), approvalUrl: privateUrl },
      { ok: true, approvalId, approvalUrl: privateUrl }]) {
      const page = await context.newPage();
      const panel = await openHost(page, fakeClient(result), html(), {}, { structuredContent: approved });
      await panel.getByRole('button', { name: 'Open FloFi', exact: true }).click();
      if (result.ok && result.approvalId === approvalId && result.approvalUrl === privateUrl) {
        await expect.poll(async () => (await hostLog(page)).openLinks).toEqual([privateUrl]);
      } else {
        await expect(panel.getByText(/APPROVAL_LINK_INVALID|TOOL_FAILED/, { exact: true })).toBeVisible();
        expect((await hostLog(page)).openLinks).toEqual([]);
      }
      await page.close();
    }
  });

  test('embedded approval uses only the fixed trusted signing path; hostile sessions create no frame', async ({ context }) => {
    for (const approvalUrl of ['https://flo.finance/approve', `${origin}/approve?redirect=https://flo.finance#${secret}`, privateUrl]) {
      const page = await context.newPage();
      // No live request: the only valid target is intercepted with a blank local response.
      await page.route(`${origin}/**`, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Controlled frame target</title>' }));
      const panel = await openHost(page, fakeClient({ ok: true, approvalId, approvalUrl }), html(), {}, { structuredContent: approved });
      await panel.getByRole('button', { name: 'Authorize in chat', exact: true }).click();
      if (approvalUrl === privateUrl) await expect(panel.locator('iframe.signing-frame')).toHaveAttribute('src', `${origin}/mcp/approve#${secret}`);
      else {
        await expect(panel.getByText('APPROVAL_LINK_INVALID', { exact: true })).toBeVisible();
        await expect(panel.locator('iframe')).toHaveCount(0);
      }
      expect((await hostLog(page)).openLinks).toEqual([]);
      await page.close();
    }
  });

  test('an unexpected signing-frame redirect cannot navigate to an alternate brand', async ({ page }) => {
    let alternateRequests = 0, blocked = false;
    page.on('console', message => { if (message.type() === 'error' && message.text().includes('frame-src')) blocked = true; });
    await page.route(`${origin}/mcp/approve`, route => route.fulfill({ status: 302, headers: { location: 'https://flo.finance/approve' } }));
    await page.route('https://flo.finance/**', async route => { alternateRequests++; await route.abort('blockedbyclient'); });
    const panel = await openHost(page, fakeClient({ ok: true, approvalId, approvalUrl: privateUrl }), html(), {}, { structuredContent: approved });
    await panel.getByRole('button', { name: 'Authorize in chat', exact: true }).click();
    await expect.poll(() => blocked).toBe(true);
    expect(alternateRequests).toBe(0); expect((await hostLog(page)).openLinks).toEqual([]);
  });

  test('receipt navigation and model context reject userinfo and alternate domains', async ({ page }) => {
    const runs = ['https://user@flofi.xyz/app/dashboard/runs/run-1', 'https://flo.finance/app/dashboard/runs/run-1',
      `${origin}/app/dashboard/runs/run-1?redirect=https://flo.finance`, `${origin}/app/dashboard/runs/run-1`]
      .map(receiptUrl => ({ executionId: 'run-1', flow: 'jupiter-swap', status: 'RECONCILED', reconciled: true, receiptUrl }));
    const panel = await openHost(page, fakeClient({ ok: true, status: 'APPLIED', runs }), html(), {}, { structuredContent: approved });
    await panel.getByRole('button', { name: 'Refresh status' }).click();
    await expect(panel.getByRole('button', { name: 'View receipt' })).toHaveCount(1);
    await panel.getByRole('button', { name: 'View receipt' }).click();
    await expect.poll(async () => (await hostLog(page)).openLinks).toEqual([`${origin}/app/dashboard/runs/run-1`]);
    const context = JSON.stringify((await hostLog(page)).modelContext);
    expect(context).not.toMatch(/flo\.finance|user@|redirect=/);
    expect(context).toContain(`${origin}/app/dashboard/runs/run-1`);
  });
});
