// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-DEVELOPER-001 acceptance in a real browser: a third-party server application integrates FloFi with the SDK alone, against
 * the running app on the embedded PostgreSQL runtime with the MOCKED loopback router chains and a loopback webhook receiver (never
 * a public network, never a real transaction):
 *
 *   operator CLI: project + sandbox key (mode-0600 file) → SDK: capabilities, immutable strategy, validate, simulate, webhook endpoint,
 *   approval → the end user opens the approval link: a third-party proposal (not an AI one), sharing OFF until they opt in, wallet
 *   proof, the existing proposal card → the product's own simulation and Strategy Manifest Review → current main blocks MOCKED
 *   financial authority: no approval of the Review, no execution, no wallet transaction → the app sees the approval applied and the
 *   prepared run, signed webhooks verified by the SDK, and no reconciliation or evidence claimed.
 *
 * The owner's full execution lifecycle (Review, wallet-signed transactions, reconciliation, Evidence Bundle, `execution.reconciled`)
 * is proven by `src/developer/journey.pg.test.ts`, as for MCP.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test, expect, type Page } from '@playwright/test';
import { FloFi, verifyWebhook, type WebhookEvent } from '../../../packages/developer-sdk/src/index.ts';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet.ts';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import { runAdminCommand } from '../src/admin/cli-commands';
import type { StudioEvidence } from '../src/studio/integration-probe';
import { createStudioStore } from '../src/studio/integration-store';
import { E2E_APP_ORIGIN as APP_ORIGIN, chooseLanguage } from './app-origin';
import { signedIn } from './batch-wallet-fixtures';
import { AUTHORIZE_IN_WALLET, openProposalSimulationDetails, proveConnectedEvmWallet, signingSurface } from './fixtures';
import { guardedContext, installJourneyWallet, journeySends, walletRequests } from './journey-fixtures';
import { assertMcpHarness } from './mcp-fixtures';
import { assertExecutionBlocked } from './release-safety-fixtures';
import { routerControl } from './router-fixtures';

const approval = (page: Page) => page.getByRole('region', { name: 'Proposal from Acme Wallet' });
const bridge = (page: Page) => page.getByRole('region', { name: 'Cross-chain bridge' });

/** The operator's CLI against the run's disposable database: one project, one sandbox key written to a new mode-0600 file. */
async function operatorKey(): Promise<{ key: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'flofi-developer-e2e-')), keyFile = join(dir, 'key');
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const cli = (args: string[]) => promisify(execFile)(process.execPath, ['backend/developer-admin.ts', ...args, '--tenant', 'default'], { cwd, timeout: 60_000,
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', DATABASE_ADMIN_OPERATIONS_URL: process.env.FLOFI_E2E_DATABASE_URL!, FLOFI_DEVELOPER_SECRET: process.env.FLOFI_E2E_DEVELOPER_SECRET! } });
  const project = JSON.parse((await cli(['create-project', '--name', 'Acme Wallet'])).stdout) as { projectId: string };
  await cli(['create-key', '--project', project.projectId, '--key-file', keyFile]);
  return { key: (await readFile(keyFile, 'utf8')).trim(), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test.describe('BUILD-DEVELOPER-001 third-party integration (SDK → FloFi /approve → owner Review; MOCKED execution blocked)', () => {
  test.beforeAll(() => {
    assertMcpHarness();
    if (!process.env.FLOFI_E2E_DEVELOPER_SECRET || !process.env.FLOFI_E2E_DEVELOPER_DISPATCH_TOKEN) throw new Error('DEVELOPER_E2E_NOT_CONFIGURED');
  });

  test('a third-party app hands a strategy to its user; FloFi reviews it but blocks MOCKED execution; the app sees status and signed webhooks, no evidence', async ({ browser }) => {
    test.setTimeout(120_000);
    const received: { headers: IncomingHttpHeaders; body: string }[] = [];
    const receiver = createServer((req, res) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { received.push({ headers: req.headers, body }); res.end(); }); });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    const owner = createTestWallet(), { key, cleanup } = await operatorKey();
    try {
      await routerControl('MOCK_reset', [{ network: 'testnet', owner: owner.address, wallets: [] }]);
      // ── The third-party server ──
      const flofi = new FloFi({ apiKey: key, baseUrl: APP_ORIGIN });
      const { data } = await flofi.capabilities.list({ network: 'base-sepolia', action: 'bridge' });
      const row = data.find(r => r.destinationNetwork === 'arbitrum-sepolia'
        && r.operations.compose.available && r.operations.simulate.available && r.operations.approve.available);
      if (!row?.availability.mockedHarness) throw new Error('Local MOCKED bridge flow unavailable');
      expect(row.operations.execute).toMatchObject({ available: false });
      const strategy = await flofi.strategies.create({ strategy: row.exampleStrategy });
      expect((await flofi.strategies.validate(strategy.id)).availability.approvable).toBe(true);
      expect(await flofi.strategies.simulate(strategy.id, { simulationSubject: owner.address })).toMatchObject({ provenance: 'MOCKED', authorizable: false });
      const endpoint = await flofi.webhookEndpoints.create({ url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/flofi` });
      const created = await flofi.approvals.create({ strategy, returnTarget: {
        url: 'https://example.com/flofi/return', state: 'sandbox-integration-state',
      } });
      expect(created.approvalUrl).toMatch(new RegExp(`^${APP_ORIGIN.replace(/[.]/g, '\\.')}/approve#flofi_dhs_[A-Za-z0-9_-]{43}$`));
      expect(await journeySends()).toBe(0);

      // ── The end user, in FloFi ──
      const { context, unexpected } = await guardedContext(browser);
      const page = await context.newPage(), errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      await installJourneyWallet(page, [owner]);
      const response = await page.goto(created.approvalUrl!);
      expect(response?.headers()['content-security-policy']).toContain("connect-src 'self'");
      expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
      const region = approval(page);
      await expect(region).toContainText('From Acme Wallet');
      await expect(region).toContainText('Nothing is authorized yet.');
      await expect(region).toContainText('Created by Acme Wallet, a third-party app registered with FloFi, not by FloFi.');
      await expect(region).not.toContainText('AI assistant');
      expect(page.url()).not.toContain('flofi_dhs_');
      // Status sharing with the app is OFF until the user turns it on.
      await expect(region.getByRole('checkbox')).not.toBeChecked();
      await region.getByRole('checkbox').check();
      // BUILD-SOLANA-TRANSFER-UX-001: the app's link opens the signing surface; the wallet already connected in this browser is recognized
      // (no selector) and only signs FloFi's sign-in message.
      await expect(signingSurface(page)).toBeVisible();
      await proveConnectedEvmWallet(page, region, owner.address);
      // BUILD-FLOFI-UX-UI-002: the proof loads the exact proposal; no separate Load step.
      await expect(region.getByRole('status')).toContainText('Ready for your review.');
      const returnLink = region.getByRole('link', { name: 'Return to example.com' });
      await expect(returnLink).toHaveAttribute('href', `https://example.com/flofi/return?approvalId=${created.id}&state=sandbox-integration-state`);
      await expect(returnLink).toHaveAttribute('referrerpolicy', 'no-referrer');
      await expect(region.getByRole('button', { name: 'Load proposal' })).toHaveCount(0);
      // FloFi prepares the fresh simulation for that wallet; MOCKED evidence keeps the one owner action disabled.
      await expect(signingSurface(page).getByRole('button', { name: AUTHORIZE_IN_WALLET, exact: true })).toBeDisabled({ timeout: 30_000 });
      expect((await walletRequests(page)).filter(method => method === 'personal_sign')).toHaveLength(1);
      // The authoritative product's simulation and Review; a MOCKED route cannot authorize execution.
      await openProposalSimulationDetails(page);
      await expect(bridge(page)).toContainText('Strategy Manifest');
      await expect(bridge(page)).toContainText(`Owner ${owner.address}`);
      expect(await walletRequests(page)).toContain('personal_sign');
      await expect(page.locator('.canvas-primary-action').getByRole('button', { name: AUTHORIZE_IN_WALLET, exact: true })).toBeDisabled();
      await expect(page.locator('.review-authorization-details')).toContainText('A simulation that can authorize this workflow is required before approval.');
      await expect(page.getByRole('region', { name: 'Authorization technical details', exact: true })).toContainText('Strategy Manifest');
      await expect(page.getByRole('button', { name: 'Review approved', exact: true })).toHaveCount(0);
      await assertExecutionBlocked(page, journeySends);
      // A reload keeps the same boundary.
      await page.reload();
      await assertExecutionBlocked(page, journeySends);
      expect(await walletRequests(page)).not.toContain('eth_sendTransaction');
      expect(await journeySends()).toBe(0);
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);

      // An unknown developer link keeps the shared route state's heading, worded for the app that sent it.
      const stray = await context.newPage();
      await stray.goto(`${APP_ORIGIN}/approve#flofi_dhs_${'A'.repeat(43)}`);
      await expect(stray.getByRole('heading', { name: 'Open this link from your assistant' })).toBeVisible();
      await expect(stray.getByText('Open the FloFi approval link again from the app that sent it.')).toBeVisible();
      await context.close();

      // ── Back in the third-party server: the approval is applied, the run is prepared, nothing is reconciled or evidenced ──
      await expect.poll(async () => (await flofi.approvals.get(created.id)).executions.length, { timeout: 30_000 }).toBe(1);
      const progress = await flofi.approvals.get(created.id);
      expect(progress).toMatchObject({ status: 'APPLIED', statusShared: true, executionsVisible: true,
        executions: [{ reconciled: false, terminal: false, evidence: null }] });
      const executionId = progress.executions[0]!.id;
      expect(await flofi.executions.get(executionId)).toMatchObject({ approvalId: created.id, reconciled: false, owner: owner.address, provenance: 'MOCKED' });
      expect(await flofi.executions.evidence(executionId)).toMatchObject({ evidence: null, reason: 'NO_RECONCILED_EVIDENCE_YET' });
      // The deployment's scheduler delivers what is due (the claim and apply notifications went out right after /approve).
      const dispatch = await fetch(`${APP_ORIGIN}/api/developer/v1/internal/dispatch`, { headers: { authorization: `Bearer ${process.env.FLOFI_E2E_DEVELOPER_DISPATCH_TOKEN}` } });
      expect(dispatch.status).toBe(200);
      await expect.poll(() => received.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
      const events: WebhookEvent[] = [];
      for (const r of received) events.push(await verifyWebhook({ payload: r.body, headers: r.headers as Record<string, string>, secret: endpoint.secret! }));
      expect(events.map(e => e.type).sort()).toEqual(['approval.applied', 'approval.claimed', 'execution.started']);
      expect(events.find(e => e.type === 'execution.started')!.data).toMatchObject({ approvalId: created.id, executionId });
      expect(received.map(r => r.body).join('')).not.toMatch(/flofi_sk_|flofi_dhs_|whsec_|calldata|RECONCILED/);
      expect(await journeySends()).toBe(0);
    } finally {
      await cleanup();
      await new Promise(resolve => receiver.close(resolve));
    }
  });
});

test('a FloFi account manages its Studio packages and rotates an isolated project credential', async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  assertMcpHarness();
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  try {
    for (const command of ['finops-migrate', 'finops-sync-migrate', 'position-purge-migrate', 'single-step-runs-migrate',
      'workflow-run-purge-migrate', 'developer-projects-migrate', 'studio-migrate'] as const) await runAdminCommand(command, {}, db, 'default');
  } finally { await db.close(); }

  const { context, unexpected } = await guardedContext(browser);
  const page = await context.newPage();
  const wallet = createTestWallet();
  try {
    await chooseLanguage(context, 'EN');
    await page.goto('/developers');
    await page.getByRole('link', { name: 'Start building' }).click();
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fdevelopers%2Fconsole/);
    await signedIn(page, wallet.address, 'developer-owner');
    const response = await page.goto('/developers/console');
    expect(response?.headers()['cache-control']).toContain('no-store');
    expect(response?.headers()['x-frame-options']).toBe('DENY');
    await page.getByRole('textbox', { name: 'Project name' }).fill('Portfolio integration');
    await page.getByRole('textbox', { name: 'Description' }).fill('Portfolio workflows');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page).toHaveURL(/\/developers\/console\?project=prj_[a-z2-7]{26}$/);
    const projectUrl = page.url();
    await expect(page.getByRole('heading', { name: 'Portfolio integration' })).toBeVisible();

    const studio = page.getByRole('region', { name: 'FloFi Studio' });
    const studioNavigation = studio.getByRole('navigation', { name: 'FloFi Studio' });
    const navigateStudio = (name: string) => studioNavigation.getByRole('button', { name, exact: true }).click();
    const integration = (name: string) => studio.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    const next = () => studio.getByRole('button', { name: 'Continue' }).click();
    const checkpointHash = '0x' + 'a'.repeat(64);
    const openCreate = async (category: string, architecture: string) => {
      await navigateStudio('Create Integration');
      await studio.getByRole('radio', { name: category }).check();
      await next();
      await studio.getByRole('radio', { name: architecture, exact: true }).check();
      await next();
    };
    const fillEvmConfig = async (name: string, slug: string, chain: string, rpc: string) => {
      await studio.getByRole('textbox', { name: 'Integration name' }).fill(name);
      await studio.getByRole('textbox', { name: 'Integration slug' }).fill(slug);
      await studio.getByRole('textbox', { name: 'CAIP-2 network ID' }).fill(chain);
      await studio.getByRole('textbox', { name: 'Public HTTPS endpoint' }).fill(rpc);
      await studio.getByRole('textbox', { name: 'Checkpoint height (hex)' }).fill('0x0');
      await studio.getByRole('textbox', { name: 'Checkpoint hash' }).fill(checkpointHash);
    };
    const declare = async (name: string) => {
      await next();
      await studio.getByRole('checkbox', { name }).check();
      await next();
      await expect(studio.getByRole('heading', { name: 'Review your draft' })).toBeVisible();
    };
    const capture = (name: string) => studio.screenshot({ path: testInfo.outputPath(name), animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await expect(studio.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await capture('studio-overview-en-desktop.png');

    await openCreate('Blockchain', 'EVM');
    await fillEvmConfig('Example EVM', 'example-evm', 'eip155:42424242', 'https://rpc.example.org');
    await capture('studio-configuration-en-desktop.png');
    await declare('Read network identity');
    await expect(studio).toContainText('evm-rpc@1');
    await capture('studio-summary-en-desktop.png');
    await studio.getByRole('button', { name: 'Save draft' }).click();
    const network = integration('Example EVM');
    await expect(network).toContainText('Version 1');
    await expect(network).toContainText('Draft');
    await expect(network.getByRole('button', { name: 'Verify' })).toBeVisible();
    await expect(network.getByRole('button', { name: 'Submit for certification' })).toHaveCount(0);

    await openCreate('Blockchain', 'EVM');
    await fillEvmConfig('Duplicate example', 'example-evm', 'eip155:42424242', 'https://rpc.example.org');
    await declare('Read network identity');
    await studio.getByRole('button', { name: 'Save draft' }).click();
    await expect(studio.getByRole('alert')).toHaveText('This slug is already used in the project.');
    for (let index = 0; index < 2; index++) await studio.getByRole('button', { name: 'Back' }).click();
    await expect(studio.getByRole('textbox', { name: 'Integration name' })).toHaveValue('Duplicate example');
    await expect(studio.getByRole('textbox', { name: 'Integration slug' })).toHaveValue('example-evm');
    await navigateStudio('Overview');

    await openCreate('Vault', 'EVM');
    await fillEvmConfig('Example vault', 'example-vault', 'eip155:42424242', 'https://rpc.example.org');
    await studio.getByRole('textbox', { name: 'Vault contract address' }).fill('0x' + 'a'.repeat(40));
    await studio.getByRole('textbox', { name: 'Underlying token contract' }).fill('0x' + 'b'.repeat(40));
    await declare('Read vault positions and previews');
    await studio.getByRole('button', { name: 'Save draft' }).click();
    const vault = integration('Example vault');
    await expect(vault.getByRole('button', { name: 'Verify' })).toBeVisible();
    await vault.locator('summary').filter({ hasText: /^Revoke version$/ }).click();
    const revoke = vault.locator('form').getByRole('button', { name: 'Revoke version' });
    await revoke.click();
    await expect(vault).toContainText('Draft');
    await vault.getByRole('checkbox', { name: 'Permanently revoke this version.' }).check();
    await revoke.click();
    await expect(vault).toContainText('Revoked');
    await expect(vault.getByRole('button', { name: 'Verify' })).toHaveCount(0);

    await openCreate('Blockchain', 'Move');
    await studio.getByRole('textbox', { name: 'Integration name' }).fill('Example Move');
    await studio.getByRole('textbox', { name: 'Integration slug' }).fill('example-move');
    await studio.getByRole('textbox', { name: 'CAIP-2 network ID' }).fill('sui:studio-fixture');
    await studio.getByRole('textbox', { name: 'GitHub repository' }).fill('https://github.com/example/studio-adapter');
    await studio.getByRole('textbox', { name: 'Commit SHA' }).fill('b'.repeat(40));
    await studio.getByRole('textbox', { name: 'Source SHA-256' }).fill('c'.repeat(64));
    await declare('Read network identity');
    await studio.getByRole('button', { name: 'Save draft' }).click();
    const move = integration('Example Move');
    await expect(move.getByRole('button', { name: 'Verify' })).toHaveCount(0);
    await move.getByRole('button', { name: 'Submit adapter for review' }).click();
    await expect(move).toContainText('Adapter review pending');
    await expect(move.getByRole('button', { name: 'Test' })).toHaveCount(0);

    // Seed both read observations through the real store with fixture data. This profile never calls a public RPC.
    const fixturesDb = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
    try {
      const projectId = new URL(projectUrl).searchParams.get('project')!;
      const { rows: [owner] } = await fixturesDb.query<{ account_id: string }>(
        'SELECT account_id FROM developer_project_owners WHERE tenant_id=$1 AND project_id=$2', ['default', projectId],
      );
      const store = createStudioStore(fixturesDb, 'default', owner!.account_id);
      const version = async () => (await store.list(projectId)).find(row => row.slug === 'example-evm')!;
      const now = new Date();
      const verify: StudioEvidence = {
        schemaVersion: 2, mode: 'verify', source: 'PROPOSAL_RPC', chainRef: 'eip155:42424242',
        adapterId: 'evm-rpc', adapterVersion: 1, rpcUrl: 'https://rpc.example.org/', observedAt: now.toISOString(),
        checkpointHash, block: { height: '0x100', hash: '0x' + 'b'.repeat(64), timestamp: '0x1', baseFeePerGas: '0x1' },
        facts: { canonicalNativeTransferProfile: false, browserFixture: true },
      };
      await store.probe(projectId, await version(), 'verify', () => now, async () => verify);
      await page.reload();
      await navigateStudio('My Integrations');
      await expect(network.getByRole('button', { name: 'Test' })).toBeVisible();
      await store.probe(projectId, await version(), 'test', () => now, async () => ({ ...verify, mode: 'test' }));
    } finally {
      await fixturesDb.close();
    }
    await page.reload();
    await navigateStudio('My Integrations');
    await network.getByRole('button', { name: 'Submit for certification' }).click();
    await expect(network).toContainText('Certification pending');
    await navigateStudio('Certification');
    await network.getByText('Verification evidence', { exact: true }).click();
    await expect(network).toContainText('Proposed RPC');
    await expect(network).toContainText('The canonical transfer adapter has no approved profile for this network.');
    await capture('studio-certification-en-desktop.png');

    await navigateStudio('Versions & Activity');
    await expect(studio).toContainText('Compatibility tested');
    await expect(studio).toContainText('Adapter submitted');
    await navigateStudio('Documentation / SDK');
    await expect(studio.getByRole('link', { name: 'TypeScript SDK guide' })).toHaveAttribute('href', '/docs/typescript-sdk#studio-integration-packages');

    await chooseLanguage(context, 'PT');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await navigateStudio('Minhas integrações');
    await expect(studio.getByRole('heading', { name: 'Minhas integrações' })).toBeVisible();
    await expect(network).toContainText('Certificação pendente');
    expect(await studio.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await capture('studio-integrations-pt-mobile.png');
    await navigateStudio('Criar integração');
    const continueInPortuguese = studio.getByRole('button', { name: 'Continuar' });
    await continueInPortuguese.focus();
    await page.keyboard.press('Enter');
    const mobileStep = studio.getByRole('heading', { name: 'Escolha a família tecnológica' });
    await expect(mobileStep).toBeFocused();
    await expect(mobileStep).toBeInViewport();
    await page.setViewportSize({ width: 820, height: 1024 });
    await navigateStudio('Certificação');
    await expect(studio.getByRole('heading', { name: 'Certificação' })).toBeVisible();
    expect(await studio.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await capture('studio-certification-pt-tablet.png');
    await chooseLanguage(context, 'EN');
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.reload();

    await page.getByText('Generate key (sandbox)', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'strategies' }).check();
    await page.getByRole('button', { name: 'Generate key', exact: true }).click();
    const output = page.getByTestId('developer-one-time-key');
    await expect(output).toBeVisible();
    const apiKey = await output.innerText();
    const sdk = new FloFi({ apiKey, baseUrl: APP_ORIGIN });
    expect((await sdk.capabilities.list()).environment).toBe('sandbox');
    const strategy = { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '5' } as const;
    const saved = await sdk.strategies.create({ strategy });
    await page.getByRole('button', { name: 'Hide key' }).click();
    await expect(output).toHaveCount(0);
    await expect(async () => {
      await page.reload();
      await expect(page.getByText('Strategies created · sandbox')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await page.getByText('Playground', { exact: true }).click();
    await page.getByRole('textbox', { name: 'StrategySpec JSON' }).fill(JSON.stringify(strategy));
    await page.getByRole('button', { name: 'Inspect strategy' }).click();
    await expect(page.getByLabel('Playground result')).toContainText(saved.workflowHash);
    await expect(page.getByLabel('Playground result')).toContainText('"authority": "NONE"');
    await page.getByRole('textbox', { name: 'StrategySpec JSON' }).fill(JSON.stringify(strategy));
    await page.getByRole('textbox', { name: 'Public address for the preview (optional)' }).fill('invalid wallet');
    await page.getByRole('button', { name: 'Inspect strategy' }).click();
    await expect(page.locator('#developer-console').getByRole('alert')).toContainText('SIMULATION_SUBJECT_INVALID');
    await page.getByRole('button', { name: 'Rotate', exact: true }).click();
    await expect(output).toBeVisible();
    const replacement = new FloFi({ apiKey: await output.innerText(), baseUrl: APP_ORIGIN });
    await expect(sdk.capabilities.list()).rejects.toMatchObject({ status: 401 });
    expect((await replacement.capabilities.list()).environment).toBe('sandbox');
    await page.getByRole('button', { name: 'Hide key' }).click();

    const other = await context.newPage();
    await signedIn(other, createTestWallet().address, 'developer-outsider');
    await other.goto(projectUrl);
    await expect(other.getByText('Project not found.')).toBeVisible();
    await expect(other.getByRole('heading', { name: 'Portfolio integration' })).toHaveCount(0);
    await expect(other.getByRole('region', { name: 'FloFi Studio' })).toHaveCount(0);
    expect(unexpected).toEqual([]);
  } finally { await context.close(); }
});
