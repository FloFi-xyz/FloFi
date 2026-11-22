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
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', DATABASE_URL: process.env.FLOFI_E2E_DATABASE_URL!, FLOFI_DEVELOPER_SECRET: process.env.FLOFI_E2E_DEVELOPER_SECRET! } });
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
      const created = await flofi.approvals.create({ strategy });
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

test('a FloFi account creates an isolated project and rotates a server credential', async ({ browser }) => {
  assertMcpHarness();
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  try {
    for (const command of ['finops-migrate', 'finops-sync-migrate', 'position-purge-migrate', 'single-step-runs-migrate',
      'workflow-run-purge-migrate', 'developer-projects-migrate'] as const) await runAdminCommand(command, {}, db, 'default');
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

    await page.getByText('Generate key (sandbox)', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'strategies' }).check();
    await page.getByRole('button', { name: 'Generate key', exact: true }).click();
    const output = page.getByTestId('developer-one-time-key');
    await expect(output).toBeVisible();
    const apiKey = await output.innerText();
    const sdk = new FloFi({ apiKey, baseUrl: APP_ORIGIN });
    expect((await sdk.capabilities.list()).environment).toBe('sandbox');
    await page.getByRole('button', { name: 'Hide key' }).click();
    await expect(output).toHaveCount(0);
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
    expect(unexpected).toEqual([]);
  } finally { await context.close(); }
});
