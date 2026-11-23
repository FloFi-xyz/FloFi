// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the private Admin console in a real browser, on a disposable loopback database (`FLOFI_ADMIN_E2E=LOOPBACK_ONLY`).
 * A verified wallet is refused until the operator CLI grants it; the granted operator sees the overview (network distribution included)
 * built from seeded durable records, changes the Copilot settings (versioned, audited), cannot be driven cross-origin, and signs out.
 * The injected test wallet only signs sign-in messages; nothing is sent to any chain and no public network is reached.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CERTIFIED_FORWARD_MIGRATIONS, createDatabase, loadMigrations, migrate, type Database } from '@defi-workflow-engine/cloud-runtime';
import { defineIntegrationPackage, type IntegrationPackage } from '@defi-workflow-engine/developer-sdk';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet.ts';
import { runAdminCommand } from '../src/admin/cli-commands.ts';
import { adminConfig } from '../src/admin/config.ts';
import { authenticateAdmin } from '../src/admin/guard.ts';
import { sealAdminSession } from '../src/admin/session.ts';
import { createAdminStore } from '../src/admin/store.ts';
import { createDeveloperConsoleStore } from '../src/developer/console-store.ts';
import { decideStudioCertification, parseStudioDecision, studioCertificationQueue } from '../src/studio/certification-store.ts';
import type { StudioEvidence } from '../src/studio/integration-probe.ts';
import { createStudioStore } from '../src/studio/integration-store.ts';
import { persistCopilotInterpretation, persistCopilotTurn } from '../src/server/copilot-metrics-store.ts';
import { expect, test } from './fixtures';
import { installJourneyWallet } from './journey-fixtures';
import { chooseLanguage } from './app-origin';
import { openEditorSection } from './build-entry-navigation';

const BASE_SEPOLIA = 'eip155:84532', ARBITRUM_SEPOLIA = 'eip155:421614', SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function seedRun(db: Database, run: { id: string; flow: string; status: string; provenance: string; node: Record<string, unknown>; attempt: { state: string; hash: string | null; reconciled: boolean } }) {
  const bytes = Buffer.from(JSON.stringify({ review: { workflow: { nodes: [run.node] } } }) + '\n'), name = `${run.id}.jsonl`;
  await db.query(`INSERT INTO workflows (tenant_id, workflow_id) VALUES ('default', $1) ON CONFLICT DO NOTHING`, [`wf-${run.id}`]);
  await db.query(`INSERT INTO execution_logs (tenant_id, namespace, name, kind, version, segment_count, byte_length, content_sha256) VALUES ('default', $1, $2, 'RUN', 1, 1, $3, $4)`,
    [run.flow, name, bytes.length, sha(bytes)]);
  await db.query(`INSERT INTO execution_log_segments (tenant_id, namespace, name, seq, bytes, segment_sha256, content_sha256) VALUES ('default', $1, $2, 0, $3, $4, $4)`,
    [run.flow, name, bytes, sha(bytes)]);
  await db.query(`INSERT INTO execution_runs (tenant_id, run_id, namespace, log_name, workflow_id, flow, status, provenance, needs_observation, has_evidence, log_version, created_at)
    VALUES ('default', $1, $2, $3, $4, $2, $5, $6, false, $7, 1, now() - interval '2 hours')`, [run.id, run.flow, name, `wf-${run.id}`, run.status, run.provenance, run.attempt.reconciled]);
  await db.query(`INSERT INTO execution_attempts (tenant_id, attempt_id, run_id, step, state, transaction_hash, reconciled) VALUES ('default', $1, $2, 'MAIN', $3, $4, $5)`,
    [`${run.id}.MAIN`, run.id, run.attempt.state, run.attempt.hash, run.attempt.reconciled]);
}

test('admin console: refusal until granted, overview with network distribution, versioned AI settings, CSRF refusal, sign-out', async ({ page, networkGuard }) => {
  test.setTimeout(120_000);
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 2 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await seedRun(db, { id: 'e2e-swap', flow: 'base-sepolia-swap', status: 'RECONCILED', provenance: 'PUBLIC_TESTNET',
      node: { nodeId: 's', actionType: 'asset.swap.exact-input', chainId: BASE_SEPOLIA }, attempt: { state: 'CONFIRMED', hash: '0x' + 'a'.repeat(64), reconciled: true } });
    await seedRun(db, { id: 'e2e-bridge', flow: 'crosschain-router-testnet', status: 'IN_FLIGHT', provenance: 'PUBLIC_TESTNET',
      node: { nodeId: 'b', actionType: 'asset.bridge', chainId: BASE_SEPOLIA, inputs: [{ name: 'asset-out', kind: 'ASSET', value: { chainId: ARBITRUM_SEPOLIA } }] },
      attempt: { state: 'CONFIRMED', hash: '0x' + 'b'.repeat(64), reconciled: false } });
    await seedRun(db, { id: 'e2e-sol', flow: 'solana-devnet-swap', status: 'DIVERGENT', provenance: 'PUBLIC_DEVNET',
      node: { nodeId: 'x', actionType: 'asset.swap.exact-input', chainId: SOLANA_DEVNET }, attempt: { state: 'REVERTED', hash: 'c'.repeat(88), reconciled: false } });
    // Synthetic metric seeds exercise the real persistence → Admin rendering boundary; no live model request is made.
    const metricsHost = { db, tenantId: 'default' }, metric = { event: 'flofi.copilot.interpret', protocol: 'v2', mode: 'live', model: 'browser-fixture-model', outcome: 'OK',
      intentKind: 'GOAL', topic: null, durationMs: 100, messages: 1, userTurns: 1, inputTokens: 20, outputTokens: 10, reasoningTokens: null,
      responseModel: null, surface: 'WEB', toolCalls: 2, toolFailures: 0, toolRounds: 1 } as const;
    await persistCopilotInterpretation(metricsHost, metric);
    await persistCopilotInterpretation(metricsHost, { ...metric, mode: 'replay', toolCalls: 7 });
    await persistCopilotTurn(metricsHost, 'live', { event: 'flofi.copilot.turn', version: 1, surface: 'WEB', outcome: 'PROPOSAL', code: null,
      interpreted: 'GOAL', mismatch: false, clarifications: 0, repeatedQuestions: 0, corrections: 0, turnsInRequest: 1, proposalSteps: 2 }, 'CLIENT');

    const stranger = createTestWallet(), operator = createTestWallet();
    await installJourneyWallet(page, [stranger, operator], { chain: '0x14a34' });
    const first = await page.goto('/admin');
    expect(new URL(page.url()).pathname).toBe('/admin/login');
    expect(first!.headers()['x-frame-options']).toBe('DENY');
    expect(first!.headers()['cache-control']).toContain('no-store');
    expect(first!.headers()['x-robots-tag']).toBe('noindex, nofollow');
    // BUILD-FLOFI-UX-UI-002: the approved FloFi symbol and wordmark (never the legacy Gryloo artwork) in both console themes.
    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme });
      const brand = page.locator('.admin-sign-in .admin-brand');
      await expect(brand.getByRole('img', { name: 'FloFi', exact: true })).toBeVisible();
      await expect.poll(() => brand.locator('img:visible').evaluateAll(images => images.map(image => {
        const img = image as HTMLImageElement;
        return img.complete && img.naturalWidth > 0 ? new URL(img.currentSrc).pathname : null;
      }))).toEqual([`/brand/flofi-symbol-${colorScheme}.svg`, `/brand/flofi-wordmark-${colorScheme}.png`]);
    }
    await expect(page.locator('img[src="/flofi-logo.png"]')).toHaveCount(0);

    // A verified wallet is not an administrator.
    await page.getByRole('listitem').filter({ hasText: 'Browser wallet' }).click();
    await expect(page.locator('.admin-sign-in [role="alert"]')).toContainText('not an administrator');
    expect(new URL(page.url()).pathname).toBe('/admin/login');

    // Granted only by the operator CLI (database access), never by the console.
    await runAdminCommand('grant', { wallet: operator.address, role: 'OPERATOR', label: 'E2E operator' }, db, 'default');
    await page.evaluate(address => (window as unknown as { flofiJourneyWallet: { switchAccount(a: string): void } }).flofiJourneyWallet.switchAccount(address), operator.address);
    await page.getByRole('listitem').filter({ hasText: 'Browser wallet' }).click();
    await page.waitForURL(url => url.pathname === '/admin');
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Admin' });
    for (const label of ['Overview', 'Workflows', 'Automations', 'AI Settings', 'AI Analytics', 'AI Learning', 'System Health', 'Access & audit']) await expect(nav.getByRole('link', { name: label })).toBeVisible();
    // BUILD-ADMIN-AI-PROVIDERS-001 (Admin UX): links are grouped by task; every route and link name is unchanged.
    for (const [group, links] of [['Monitor', ['Overview', 'System Health']], ['Operations', ['Workflows', 'Automations']], ['AI Copilot', ['AI Settings', 'AI Analytics', 'AI Learning']],
      ['Campaigns', ['Flight FloFi']], ['Security', ['Access & audit']]] as const)
      for (const link of links) await expect(nav.getByRole('list', { name: group }).getByRole('link', { name: link })).toHaveAttribute('href', /^\/admin/);
    await expect(page.getByRole('heading', { name: 'Status at a glance' })).toBeVisible();
    await expect(page.locator('.admin-tile').filter({ hasText: 'AI Copilot' })).toBeVisible();
    await expect(nav.locator('.admin-brand').getByRole('img', { name: 'FloFi', exact: true })).toHaveAttribute('src', '/brand/flofi-wordmark-light.png');
    if (process.env.FLOFI_ADMIN_EVIDENCE) for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme }); await page.waitForTimeout(150);
      await nav.locator('.admin-brand').screenshot({ path: `e2e/visual-evidence/flofi-ux-ui-002/admin-nav-${colorScheme}.png` });
      if (colorScheme === 'dark') await page.emulateMedia({ colorScheme: 'light' });
    }

    // Testnet/Devnet is chosen automatically (no mainnet activity); MOCKED and mainnet are separate views.
    await expect(page.getByRole('navigation', { name: 'Environment' }).getByRole('link', { name: 'Testnet / Devnet · 3' })).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.admin-kpi').filter({ hasText: 'Executed workflows' }).locator('strong')).toHaveText('3');
    await expect(page.locator('.admin-kpi').filter({ hasText: 'Completed & reconciled' }).locator('strong')).toHaveText('1');
    await expect(page.locator('.admin-kpi').filter({ hasText: 'Failed (confirmed)' }).locator('strong')).toHaveText('1');
    await page.screenshot({ path: test.info().outputPath('admin-overview-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileMenu = page.locator('.admin-nav-mobile summary');
    await mobileMenu.focus();
    await page.keyboard.press('Enter');
    await expect(nav.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Support & Recovery' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('admin-navigation-mobile.png') });
    await mobileMenu.click();
    await page.screenshot({ path: test.info().outputPath('admin-overview-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByText('Execution metrics and trends', { exact: true }).click();
    const networks = page.getByRole('region', { name: 'Network distribution' }).or(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Network distribution' }) }));
    await expect(networks.getByRole('img', { name: /Share of executed actions by network/ })).toBeVisible();
    const shares = networks.locator('table').first();
    await expect(shares.getByRole('row', { name: /Base Sepolia/ })).toContainText('66.7%');
    expect(await shares.locator('td.num').first().evaluate(cell => ({
      alignment: getComputedStyle(cell).textAlign, numerals: getComputedStyle(cell).fontVariantNumeric,
    }))).toEqual({ alignment: 'right', numerals: 'tabular-nums' });
    await expect(shares.getByRole('row', { name: /Solana Devnet/ })).toContainText('33.3%');
    await expect(networks.getByRole('row', { name: /Base Sepolia → .*Arbitrum Sepolia/ })).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: test.info().outputPath('admin-overview.png'), fullPage: true });

    // The action/outcome filters narrow the network section only.
    await networks.getByLabel('Action type').selectOption('BRIDGE');
    await networks.getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('.admin-donut-layout table').getByRole('row', { name: /Base Sepolia/ })).toContainText('100.0%');
    await expect(page.locator('.admin-kpi').filter({ hasText: 'Executed workflows' }).locator('strong')).toHaveText('3');

    await nav.getByRole('link', { name: 'AI Analytics' }).click();
    await expect(page.getByRole('heading', { name: 'AI Analytics', level: 1 })).toBeVisible();
    await expect(page.locator('.admin-kpi').filter({ hasText: 'Model requests' }).locator('strong')).toHaveText('1');
    await expect(page.locator('.admin-kpi').filter({ hasText: 'Tool calls' }).locator('strong')).toHaveText('2');
    await expect(page.locator('.admin-kpi').filter({ hasText: 'Browser proposal reports' }).locator('strong')).toHaveText('1');
    await expect(page.getByText(/may be missing or forged/)).toBeVisible();
    await page.getByLabel('Data source').selectOption('replay');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.locator('.admin-kpi').filter({ hasText: 'Tool calls' }).locator('strong')).toHaveText('7');
    await expect(page.locator('.admin-kpi').filter({ hasText: 'Browser proposal reports' }).locator('strong')).toHaveText('0');

    // AI settings: an operator versions the Copilot settings; no key is ever shown.
    await nav.getByRole('link', { name: 'AI Settings' }).click();
    await expect(page.getByRole('heading', { name: 'AI Settings', level: 1 })).toBeVisible();
    // BUILD-ADMIN-AI-PROVIDERS-001: provider connections are shown (never a key); neither provider is connected in this harness.
    await expect(page.locator('.admin-provider').filter({ hasText: 'OpenAI' })).toContainText('Not connected');
    await expect(page.locator('.admin-provider').filter({ hasText: 'Anthropic' })).toContainText('Not connected');
    // The editor is a client component rendered on the server first: text typed before it hydrates never reaches its state (Save stays
    // disabled). Type again until the editor registers the change, then save exactly as before.
    const save = page.getByRole('button', { name: 'Save and activate version 1' });
    await expect(async () => {
      await page.getByLabel('Model').first().fill('');
      await page.getByLabel('Model').first().fill('gpt-4o-mini');
      await page.getByLabel('Reason (optional, stored in the version history)').fill('E2E: cheaper interpreter');
      await expect(save).toBeEnabled({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole('note').filter({ hasText: 'Saving will change' })).toContainText('FloFi chat (web): OpenAI');
    await save.click();
    await expect(page.getByRole('button', { name: 'Save and activate version 2' })).toBeVisible();
    // Provider-aware editing: Anthropic offers Claude models with friendly names and exact ids, Anthropic efforts, and no temperature.
    const defaults = page.getByRole('region', { name: 'Default settings' }).or(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Default settings' }) }));
    await defaults.getByRole('radio', { name: /Anthropic/ }).check();
    const model = defaults.getByLabel('Model', { exact: false }).first();
    await expect(model).toHaveValue('claude-sonnet-5-5');
    await expect(model.locator('option', { hasText: 'Claude Sonnet 5.5 — claude-sonnet-5-5' })).toHaveCount(1);
    await expect(defaults.getByLabel('Reasoning effort').locator('option', { hasText: 'Extra high' })).toHaveCount(1);
    await expect(defaults.getByLabel('Send temperature')).toHaveCount(0);
    await expect(defaults.getByText(/Anthropic is not connected on this deployment/)).toBeVisible();
    await expect(defaults.getByRole('button', { name: 'Test connection and model' })).toBeDisabled();
    await expect(page.getByRole('note').filter({ hasText: 'Saving will change' })).toContainText('OpenAI · gpt-4o-mini → Anthropic · claude-sonnet-5-5');
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(defaults.getByLabel('Model').first()).toHaveValue('gpt-4o-mini');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('admin-ai-settings-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('region', { name: 'Version history' }).or(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Version history' }) })))
      .toContainText('E2E: cheaper interpreter');
    await page.screenshot({ path: test.info().outputPath('admin-ai-settings.png'), fullPage: true });

    // The settings API refuses a cross-origin or token-less request even with the session cookie.
    const forged = await page.request.post('/admin/api/settings/copilot', { data: { action: 'reset', expectedVersion: 1 }, headers: { origin: 'http://evil.example' } });
    expect(forged.status()).toBe(403);
    const tokenless = await page.request.post('/admin/api/settings/copilot', { data: { action: 'reset', expectedVersion: 1 }, headers: { origin: new URL(page.url()).origin } });
    expect([tokenless.status(), (await tokenless.json()).code]).toEqual([403, 'ADMIN_CSRF_INVALID']);
    expect((await db.query(`SELECT count(*)::int AS n FROM admin_settings_versions`)).rows).toEqual([{ n: 1 }]);

    // BUILD-CHAT-LEARNING-001: AI Learning renders aggregates only (learning is off in this harness) and its API keeps the same CSRF rule.
    await nav.getByRole('link', { name: 'AI Learning' }).click();
    await expect(page.getByRole('heading', { name: 'AI Learning', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Learning on this deployment' })).toBeVisible();
    await expect(page.getByText('off (FLOFI_LEARNING not enabled)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load reviewed PT-BR/EN starter set' })).toBeVisible();
    const learningTokenless = await page.request.post('/admin/api/learning', { data: { action: 'starter' }, headers: { origin: new URL(page.url()).origin } });
    expect([learningTokenless.status(), (await learningTokenless.json()).code]).toEqual([403, 'ADMIN_CSRF_INVALID']);
    expect((await db.query(`SELECT count(*)::int AS n FROM learning_candidates`)).rows).toEqual([{ n: 0 }]);

    for (const [label, heading] of [['Workflows', 'Workflows'], ['Automations', 'Automations'], ['System Health', 'System Health'], ['Access & audit', 'Access & audit']] as const) {
      await nav.getByRole('link', { name: label }).click();
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      if (label === 'Workflows') await expect(page.getByRole('heading', { name: 'By flow' })).toBeVisible();
      if (label === 'Automations') await expect(page.getByRole('heading', { name: 'From proposal to execution' })).toBeVisible();
    }
    await expect(page.getByRole('table').last()).toContainText('ADMIN_COPILOT_SETTINGS_SAVED');
    await expect(page.getByRole('table').last()).toContainText('AI settings saved');
    await page.getByRole('navigation', { name: 'Audit outcome' }).getByRole('link', { name: 'Refused' }).click();
    await expect(page.getByRole('table').last()).toContainText('ADMIN_SIGN_IN');
    await expect(page.getByRole('table').last()).not.toContainText('ADMIN_COPILOT_SETTINGS_SAVED');

    await nav.getByRole('link', { name: 'FinOps & Unit Economics' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'FinOps & Unit Economics' })).toBeVisible();
    await page.getByRole('link', { name: 'Expenses & invoices' }).click();
    await expect(page.getByText('Billing ledger unavailable.', { exact: false })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Provider cost breakdown' }).getByRole('row', { name: /Railway.*flofi-api/ })).toContainText('UNAVAILABLE');
    await page.getByLabel('Period', { exact: true }).selectOption('previous');
    await page.getByRole('button', { name: 'Apply period' }).click();
    await page.waitForURL(url => url.searchParams.get('range') === 'previous');
    expect(new URL(page.url()).searchParams.get('section')).toBe('expenses');
    await page.getByRole('link', { name: 'Investor reporting' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Investor Reporting' })).toBeVisible();
    const exportResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/admin/api/finops/export');
    const investorDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download investor CSV' }).click();
    const report = await exportResponse;
    expect(report.status()).toBe(200);
    const file = await investorDownload;
    expect(file.suggestedFilename()).toBe('flofi-finops-report.csv');
    const contents = await readFile((await file.path())!, 'utf8');
    expect(contents).toContain('"quality","source","freshness_utc"');
    expect(contents).not.toContain(operator.address);
    await page.emulateMedia({ media: 'print' });
    await expect(nav).toBeHidden();
    await expect(page.getByRole('article', { name: 'Investor financial report' })).toBeVisible();
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => { document.cookie = 'flofi_language=PT; Path=/; SameSite=Lax'; });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Relatório para investidores' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Baixar CSV para investidores' })).toBeVisible();

    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/admin/login');
    await page.goto('/admin/ai-settings');
    expect(new URL(page.url()).pathname).toBe('/admin/login');
    await page.goto('/admin/ai-analytics');
    expect(new URL(page.url()).pathname).toBe('/admin/login');
    await page.goto('/admin/finops/report');
    await expect(page).toHaveURL(/\/admin\/login$/);
    await expect(page.getByRole('article', { name: 'Relatório financeiro para investidores' })).toHaveCount(0);
    const kinds = (await db.query<{ kind: string; outcome: string }>(`SELECT kind, outcome FROM admin_audit_events ORDER BY event_id`)).rows.map(r => `${r.kind}:${r.outcome}`);
    expect(kinds).toEqual(['ADMIN_SIGN_IN:REFUSED', 'ADMIN_PRINCIPAL_GRANTED:OK', 'ADMIN_SIGN_IN:OK', 'ADMIN_COPILOT_SETTINGS_SAVED:OK',
      'ADMIN_FINOPS_EXPORTED:OK', 'ADMIN_SIGN_OUT:OK']);
    expect(errors).toEqual([]);
    networkGuard.assertClean();
  } finally { await db.close(); }
});

test('FinOps exposes CSV import, shows partial coverage and keeps original currency and FX source', async ({ page, networkGuard }, info) => {
  test.setTimeout(90_000);
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 2 });
  const operator = createTestWallet();
  try {
    const finance = CERTIFIED_FORWARD_MIGRATIONS.flatMap(c => c.migrations).find(m => m.version === 29)!;
    const sql = await readFile(new URL('../../../packages/cloud-runtime/test/fixtures/0029_finops_ledger.sql', import.meta.url), 'utf8');
    expect(sha(Buffer.from(sql))).toBe(finance.sha256);
    await migrate(db, [...await loadMigrations(), { ...finance, sql }]);
    await runAdminCommand('grant', { wallet: operator.address, role: 'OPERATOR', label: 'FinOps operator' }, db, 'default');
    await installJourneyWallet(page, [operator], { chain: '0x14a34' });
    await page.goto('/admin/finops');
    await page.getByRole('listitem').filter({ hasText: 'Browser wallet' }).click();
    await page.waitForURL(url => url.pathname === '/admin');
    await page.goto('/admin/finops?range=7d');
    await page.screenshot({ path: info.outputPath('finops-overview-desktop.png') });
    await expect(page.getByRole('navigation', { name: 'FinOps sections' }).getByRole('link')).toHaveCount(4);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('finops-overview-mobile.png') });
    await page.getByRole('link', { name: 'Import CSV', exact: true }).click();
    await expect(page.getByLabel('CSV data')).toBeVisible();
    await page.screenshot({ path: info.outputPath('finops-import-mobile.png') });

    const now = Date.now(), day = new Date(now - 86_400_000).toISOString().slice(0, 10);
    const today = new Date(now).toISOString().slice(0, 10);
    const csv = [
      'scope,environment,start,end,source,reference,currency,net,coverage,fxUsd,fxSource',
      `openai,production,${day},${today},INVOICE,Loopback invoice,BRL,10.25,PARTIAL,0.2,Invoice fixture rate`,
    ].join('\n');
    await page.getByLabel('CSV data').fill(csv);
    const imported = page.waitForResponse(response => new URL(response.url()).pathname === '/admin/api/finops/import');
    await page.getByRole('button', { name: 'Import financial records' }).click();
    expect((await imported).status()).toBe(200);
    await expect(page.getByText('1 saved, 0 already recorded.')).toBeVisible();
    await page.getByText('Financial records and reconciliation', { exact: true }).click();
    const invoice = page.getByRole('table', { name: 'Financial record ledger' }).getByRole('row', { name: /Loopback invoice/ });
    await expect(invoice).toContainText('Invoice fixture rate');
    await expect(invoice).toContainText('PARTIAL');
    await expect(invoice).toContainText(/R\$\s?10\.25/);
    expect(await invoice.locator('td.num').first().evaluate(cell => getComputedStyle(cell).textAlign)).toBe('right');
    expect(await invoice.locator('td.num').first().evaluate(cell => getComputedStyle(cell).fontVariantNumeric)).toBe('tabular-nums');

    await chooseLanguage(page.context(), 'PT');
    await page.reload();
    await expect(page.getByRole('link', { name: 'Despesas e faturas' })).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('link', { name: 'Importar CSV' })).toBeVisible();
    networkGuard.assertClean();
  } finally { await db.close(); }
});

test('Flight Admin: live aggregates, OPERATOR subscriber filters/export and VIEWER privacy on mobile', async ({ page, networkGuard }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 2 });
  const operator = createTestWallet(), viewer = createTestWallet();
  try {
    await db.query(`INSERT INTO flight_list_entries (tenant_id, entry_id, email, flight, language, notice, joined_at)
      SELECT 'default', 'fle_' || lpad(n::text, 32, '0'), 'flight-admin-' || lpad(n::text, 2, '0') || '@example.test',
        CASE WHEN n = 26 THEN 'NEXT' ELSE 'FIRST' END, CASE WHEN n % 2 = 0 THEN 'PT' ELSE 'EN' END,
        '2026-11-09', '2026-11-09T12:00:00Z'::timestamptz + n * interval '1 minute' FROM generate_series(1,26) n`);
    await runAdminCommand('grant', { wallet: operator.address, role: 'OPERATOR', label: 'Flight browser operator' }, db, 'default');
    await runAdminCommand('grant', { wallet: viewer.address, role: 'VIEWER', label: 'Flight browser viewer' }, db, 'default');
    await installJourneyWallet(page, [operator, viewer], { chain: '0x14a34' });
    await page.goto('/admin/flight');
    expect(new URL(page.url()).pathname).toBe('/admin/login');
    await page.getByRole('listitem').filter({ hasText: 'Browser wallet' }).click();
    await page.waitForURL(url => url.pathname === '/admin');
    await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Flight FloFi' }).click();
    await expect(page.getByRole('heading', { name: 'Flight FloFi', exact: true })).toBeVisible();
    await expect(page.locator('.admin-kpi').filter({ hasText: 'FIRST registrations' }).locator('strong')).toHaveText('25');
    await expect(page.locator('.admin-kpi').filter({ hasText: 'NEXT registrations' }).locator('strong')).toHaveText('1');
    await expect(page.locator('.admin-kpi').filter({ hasText: 'List awaiting boarding' }).locator('strong')).toHaveText('26');
    await expect(page.getByText('DELIVERED: unverified', { exact: false })).toBeVisible();
    await page.getByLabel('Email search').fill('flight-admin-');
    await page.getByRole('button', { name: 'Search subscribers' }).click();
    const table = page.getByRole('table', { name: 'Flight subscribers' });
    await expect(table.locator('tbody tr')).toHaveCount(25);
    await expect(page.getByText('26 matching registrations')).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await page.getByLabel('Flight', { exact: true }).selectOption('NEXT');
    await page.getByLabel('Language', { exact: true }).selectOption('PT');
    await page.getByLabel('From', { exact: true }).fill('2026-11-09');
    await page.getByLabel('Through', { exact: true }).fill('2026-11-09');
    await page.getByRole('button', { name: 'Search subscribers' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table).toContainText('flight-admin-26@example.test');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export filtered CSV' }).click();
    const downloaded = await downloadEvent, csv = await readFile((await downloaded.path())!, 'utf8');
    expect(csv).toContain('flight-admin-26@example.test');
    expect(csv).not.toContain('flight-admin-25@example.test');
    const pii = await page.request.get('/admin/api/flight/entries');
    expect(pii.status()).toBe(405);
    expect(pii.headers()['cache-control']).toContain('no-store');
    expect(pii.headers()['x-robots-tag']).toBe('noindex, nofollow');
    await page.screenshot({ path: test.info().outputPath('flight-admin-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel('Email search')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('flight-admin-mobile.png'), fullPage: true });

    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/admin/login');
    await page.evaluate(address => (window as unknown as { flofiJourneyWallet: { switchAccount(a: string): void } }).flofiJourneyWallet.switchAccount(address), viewer.address);
    await page.getByRole('listitem').filter({ hasText: 'Browser wallet' }).click();
    await page.waitForURL(url => url.pathname === '/admin');
    await page.goto('/admin/flight');
    await expect(page.getByRole('region', { name: 'Campaign totals' })).toBeVisible();
    await expect(page.getByText('Subscriber addresses and CSV exports require an OPERATOR session.')).toBeVisible();
    await expect(page.getByLabel('Email search')).toHaveCount(0);
    expect(await page.content()).not.toContain('flight-admin-26@example.test');
    const metrics = await page.request.get('/admin/api/flight');
    expect(metrics.status()).toBe(200);
    expect(await metrics.text()).not.toContain('@example.test');
    const events = (await db.query<{ kind: string; detail: unknown }>(`SELECT kind, detail FROM admin_audit_events WHERE kind IN ('ADMIN_FLIGHT_VIEWED','ADMIN_FLIGHT_EXPORTED')`)).rows;
    expect(events.filter(row => row.kind === 'ADMIN_FLIGHT_VIEWED')).toHaveLength(3);
    expect(events.filter(row => row.kind === 'ADMIN_FLIGHT_EXPORTED')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('flight-admin-');
    networkGuard.assertClean();
  } finally { await db.close(); }
});

test('Support & Recovery: discover a stopped check, preview, confirm, run and verify; VIEWER stays read-only; mobile layout', async ({ page, networkGuard }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 2 });
  const operator = createTestWallet(), viewer = createTestWallet(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    // A possibly-submitted execution whose transaction check exhausted its budget and stopped (the queue flagged it for attention).
    await seedRun(db, { id: 'e2e-stuck', flow: 'base-sepolia-swap', status: 'SUBMISSION_RESULT_UNKNOWN', provenance: 'PUBLIC_TESTNET',
      node: { nodeId: 's', actionType: 'asset.swap.exact-input', chainId: BASE_SEPOLIA }, attempt: { state: 'SUBMISSION_RESULT_UNKNOWN', hash: null, reconciled: false } });
    await db.query(`UPDATE execution_runs SET needs_observation = true, attention_required = true, updated_at = now() - interval '1 hour' WHERE run_id = 'e2e-stuck'`);
    await db.query(`INSERT INTO work_items (tenant_id, kind, dedupe_key, run_id, payload, state, deliveries, last_error, completed_at)
      VALUES ('default', 'reconcile', 'base-sepolia-swap:e2e-stuck', 'e2e-stuck', '{"namespace":"base-sepolia-swap","runId":"e2e-stuck"}', 'DEAD', 500, 'OBSERVATION_BUDGET_EXHAUSTED', now())`);
    // A terminal execution flagged earlier (its check stopped, then it was reconciled without an Evidence Bundle): historical, not active, not verified.
    await seedRun(db, { id: 'e2e-historical', flow: 'base-sepolia-swap', status: 'RECONCILED', provenance: 'PUBLIC_TESTNET',
      node: { nodeId: 's', actionType: 'asset.swap.exact-input', chainId: BASE_SEPOLIA }, attempt: { state: 'CONFIRMED', hash: '0x' + 'c'.repeat(64), reconciled: true } });
    await db.query(`UPDATE execution_runs SET attention_required = true, has_evidence = false WHERE run_id = 'e2e-historical'`);
    await db.query(`INSERT INTO work_items (tenant_id, kind, dedupe_key, run_id, payload, state, deliveries, last_error, completed_at)
      VALUES ('default', 'reconcile', 'base-sepolia-swap:e2e-historical', 'e2e-historical', '{"namespace":"base-sepolia-swap","runId":"e2e-historical"}', 'DEAD', 500,
        'OBSERVATION_BUDGET_EXHAUSTED', now() - interval '3 days')`);
    await runAdminCommand('grant', { wallet: operator.address, role: 'OPERATOR', label: 'Support operator' }, db, 'default');
    await runAdminCommand('grant', { wallet: viewer.address, role: 'VIEWER', label: 'Support viewer' }, db, 'default');
    await installJourneyWallet(page, [operator, viewer], { chain: '0x14a34' });
    await page.goto('/admin/support');
    expect(new URL(page.url()).pathname).toBe('/admin/login');
    await page.getByRole('listitem').filter({ hasText: 'Browser wallet' }).click();
    await page.waitForURL(url => url.pathname === '/admin');
    const nav = page.getByRole('navigation', { name: 'Admin' });
    await expect(nav.getByRole('list', { name: 'Operations' }).getByRole('link', { name: 'Support & Recovery' })).toHaveAttribute('href', '/admin/support');
    await nav.getByRole('link', { name: 'Support & Recovery' }).click();
    await expect(page.getByRole('heading', { name: 'Support & Recovery', level: 1 })).toBeVisible();
    const card = page.locator('.admin-incident').filter({ hasText: 'Transaction check stopped' }).filter({ hasText: 'base-sepolia-swap' });
    await expect(card).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('support-production-desktop.png') });
    await db.query('ALTER TABLE execution_nonce_conflicts RENAME TO e2e_nonce_conflicts_unavailable');
    try {
      await page.reload();
      await expect(page.getByRole('alert')).toContainText('Unavailable sources: Executions');
      await expect(page.locator('.admin-incident-summary')).toContainText('Matching records Unavailable');
    } finally { await db.query('ALTER TABLE e2e_nonce_conflicts_unavailable RENAME TO execution_nonce_conflicts'); }
    await page.goto('/admin/support?network=ALL');
    await expect(card).toBeVisible();
    await expect(page.getByRole('link', { name: 'Production incidents' })).not.toHaveAttribute('aria-current', 'true');
    await page.getByRole('link', { name: 'Testnet audit' }).click();
    await expect(card).toContainText('Recoverable now');
    await expect(card).toContainText('Outcome unknown');
    await expect(card).toContainText('Test or mocked funds only'); // a testnet run never claims real funds
    await page.getByText('Incident and recovery statistics', { exact: true }).click();
    await expect(page.locator('.admin-kpi').filter({ hasText: 'Recoverable here' }).locator('strong')).not.toHaveText('0');
    await expect(card).toContainText('Active');
    // The historical flag is counted separately and kept out of the open list; it is listed under its own lifecycle, never as resolved.
    await expect(page.locator('.admin-kpi').filter({ hasText: 'Historical attention' }).locator('strong')).toHaveText('1');
    await expect(page.locator('.admin-kpi').filter({ hasText: 'Raw execution flags' }).locator('strong')).toHaveText('2');
    await expect(page.locator('.admin-incident').filter({ hasText: 'Earlier attention' })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('support-testnet-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin/support?lifecycle=HISTORICAL#support-incidents');
    const historical = page.locator('.admin-incident').filter({ hasText: 'Earlier attention — no active condition' });
    await expect(historical).toContainText('Historical attention');
    await expect(historical).toContainText('No action needed');
    await expect(historical).toContainText('Completed');
    // Workflows and System Health show the same split.
    await page.goto('/admin/workflows');
    const requiring = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Requiring attention' }) });
    await expect(requiring.getByRole('row').filter({ hasText: 'e2e-stuck' })).toHaveCount(0);
    await requiring.getByText(/^Test and mock incidents \(/).click();
    await expect(requiring.getByRole('row').filter({ hasText: 'e2e-stuck' })).toContainText('Active');
    await expect(requiring).not.toContainText('e2e-historical');
    await expect(page.getByRole('heading', { name: 'Historical attention' })).toBeVisible();
    await page.goto('/admin/health');
    await expect(page.getByRole('row').filter({ hasText: 'Historical attention' })).toContainText('1');
    await expect(page.getByRole('row').filter({ hasText: 'Observation exhausted' })).toContainText('1');
    await page.goto('/admin/support?network=TESTNET');

    // Diagnose: timeline marks the unknown submission; preview → confirm → run → verified state.
    await card.getByRole('link', { name: /^Diagnose/ }).click();
    await expect(page.getByRole('heading', { name: 'Transaction check stopped', level: 1 })).toBeVisible();
    await expect(page.locator('.admin-timeline li').filter({ hasText: 'Transaction submitted' })).toContainText('Unknown');
    await expect(page.getByRole('heading', { name: 'Background check gave up' })).toBeVisible();
    const previewButton = page.getByRole('button', { name: 'Preview: Resume transaction check' });
    await expect(async () => { await previewButton.click(); await expect(page.getByText('✓ Eligible now')).toBeVisible({ timeout: 2_000 }); }).toPass({ timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'Recovery preview' })).toContainText('No funds move');
    await page.getByRole('button', { name: 'Continue to confirmation' }).click();
    const run = page.getByRole('button', { name: 'Run: Resume transaction check' });
    await expect(run).toBeDisabled();
    await page.getByLabel('Reason (recorded in the audit trail)').fill('E2E: provider outage resolved');
    await page.getByLabel(/I reviewed the target/).check();
    await run.click();
    const result = page.locator('section[aria-label="Recovery result"]');
    await expect(result).toContainText(/Accepted — pending verification|Verified: task completed|Not resolved: stopped again|Inconclusive/);
    await expect(result).toContainText(/rop_[a-z2-7]{26}/);
    expect((await db.query(`SELECT count(*)::int AS n FROM work_items WHERE run_id = 'e2e-stuck' AND kind = 'reconcile' AND state <> 'DEAD'`)).rows).toEqual([{ n: 1 }]);
    // BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001: the audit skeleton references the reason; its text lives in the governed text store.
    expect((await db.query(`SELECT a.outcome, a.detail ? 'reason' AS inline, t.body AS reason FROM admin_audit_events a
      JOIN admin_support_texts t ON t.tenant_id = a.tenant_id AND t.text_id = a.detail->>'reasonRef' WHERE a.kind = 'SUPPORT_RECOVERY'`)).rows)
      .toEqual([{ outcome: 'OK', inline: false, reason: 'E2E: provider outage resolved' }]);
    await page.getByRole('textbox', { name: /^Note \(plain text/ }).fill('Customer informed; watching the check.');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByText('Note added.')).toBeVisible();
    // An explicit note is what makes an open incident "under investigation" — never the page view. The re-queued check has not finished, so the
    // incident stays open and the transaction outcome is still not established (a separate dimension).
    const summary = page.locator('section[aria-labelledby="support-incident-summary"]');
    await expect(summary).toContainText('Under investigation');
    await expect(summary).toContainText('Queued again — not finished');
    await expect(summary).toContainText('(not established)');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Recovery attempts for this execution' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('support-incident-mobile.png'), fullPage: true });

    // An audited lookup by execution id, sent as a POST (the identifier never enters the URL); on a phone the whole console fits the width.
    await page.goto('/admin/support');
    await expect(async () => {
      await page.getByLabel(/^Transaction hash, wallet/).fill('e2e-stuck');
      await page.getByRole('button', { name: 'Look up' }).click();
      await expect(page.getByRole('table', { name: 'Search results' })).toContainText('e2e-stuck', { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    expect(page.url()).not.toContain('e2e-stuck');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('support-overview-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('table', { name: 'Recovery history' })).toContainText('Resume transaction check');

    // A VIEWER can read and preview, never run or write; the API refuses a token-less request.
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/admin/login');
    await page.evaluate(address => (window as unknown as { flofiJourneyWallet: { switchAccount(a: string): void } }).flofiJourneyWallet.switchAccount(address), viewer.address);
    await page.getByRole('listitem').filter({ hasText: 'Browser wallet' }).click();
    await page.waitForURL(url => url.pathname === '/admin');
    await page.goto('/admin/support/incident?id=run%3Ae2e-stuck');
    await expect(page.getByText('Your role is read-only: an OPERATOR can add notes.')).toBeVisible();
    await expect(page.getByText('Customer informed; watching the check.')).toBeVisible();
    const tokenless = await page.request.post('/admin/api/support', { data: { action: 'note', incidentId: 'run:e2e-stuck', kind: 'FINDING', text: 'forged' },
      headers: { origin: new URL(page.url()).origin } });
    expect([tokenless.status(), (await tokenless.json()).code]).toEqual([403, 'ADMIN_CSRF_INVALID']);
    expect((await db.query(`SELECT count(*)::int AS n FROM admin_audit_events WHERE kind = 'SUPPORT_NOTE'`)).rows).toEqual([{ n: 1 }]);
    expect(errors).toEqual([]);
    networkGuard.assertClean();
  } finally { await db.close(); }
});

test('Studio certification: an independent operator publishes, suspends and revokes certified metadata and rejects another package', async ({ page, networkGuard }, info) => {
  test.setTimeout(120_000);
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 2 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const operator = createTestWallet();
  // Unique chains per run, so a retry never meets this run's publication; the finally block revokes anything still published.
  const chainBase = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  let cleanup: (() => Promise<unknown>) | null = null;
  try {
    // The optional Studio schema through the operator CLI, exactly as an owner would apply it (0029–0036, each step repeatable).
    for (const command of ['finops-migrate', 'finops-sync-migrate', 'position-purge-migrate', 'single-step-runs-migrate', 'workflow-run-purge-migrate',
      'developer-projects-migrate', 'studio-migrate', 'studio-certification-migrate'] as const) await runAdminCommand(command, {}, db, 'default');
    const owner = `acct_${randomBytes(16).toString('hex')}`, reviewer = `acct_${randomBytes(16).toString('hex')}`;
    await db.query('INSERT INTO flofi_accounts (tenant_id,account_id) VALUES ($1,$2),($1,$3)', ['default', owner, reviewer]);
    await runAdminCommand('grant', { wallet: operator.address, role: 'OPERATOR', label: 'Studio reviewer' }, db, 'default');
    // The reviewer's admin wallet is bound to a FloFi account other than the package owner's: no self-certification.
    await db.query(`INSERT INTO flofi_account_identities (tenant_id,kind,subject,account_id) VALUES ('default','EIP155',$1,$2)`, [operator.address.toLowerCase(), reviewer]);

    // Two submitted packages for networks absent from FloFi's registries, with fixture observations: this profile never reaches an RPC.
    const now = new Date(), projectId = await createDeveloperConsoleStore(db, 'default', owner).create('Partner networks', '', now);
    const studio = createStudioStore(db, 'default', owner);
    const evidence = (manifest: IntegrationPackage, mode: 'verify' | 'test'): StudioEvidence => ({ schemaVersion: 2, source: 'PROPOSAL_RPC', mode,
      adapterId: 'evm-rpc', adapterVersion: 1, chainRef: manifest.chainRef!, rpcUrl: manifest.rpcUrl!, observedAt: now.toISOString(),
      checkpointHash: manifest.checkpoint!.hash, block: { height: '0x10', hash: `0x${'2'.repeat(64)}`, timestamp: '0x1', baseFeePerGas: '0x1' },
      facts: { browserFixture: true } });
    const network = (slug: string, name: string, chainRef: string) => defineIntegrationPackage({ schemaVersion: 2, kind: 'network', slug, name, chainRef,
      architecture: 'evm', environment: 'mainnet', rpcUrl: `https://${slug}.rpc.example.org/`, checkpoint: { height: '0x0', hash: `0x${'1'.repeat(64)}` },
      adapter: { kind: 'builtin', id: 'evm-rpc', version: 1 }, capabilities: ['network.read'], dependencies: [] });
    const submit = async (manifest: IntegrationPackage) => {
      const latest = async () => (await studio.list(projectId)).find(item => item.slug === manifest.slug)!;
      await studio.create(projectId, manifest, now);
      await studio.probe(projectId, await latest(), 'verify', () => now, async () => evidence(manifest, 'verify'));
      await studio.probe(projectId, await latest(), 'test', () => now, async () => evidence(manifest, 'test'));
      await studio.submit(projectId, await latest(), now);
      const { slug, version, generation } = await latest();
      return { projectId, slug, version, generation };
    };
    const certified = await submit(network('aurora-partner', 'Aurora Partner Network', `eip155:${chainBase}`));
    await submit(network('boreal-partner', 'Boreal Partner Network', `eip155:${chainBase + 1}`));

    // Approval needs an independent RPC observation; here it is injected, the only step not driven through the console.
    const config = adminConfig({ FLOFI_ADMIN: 'enabled', FLOFI_ADMIN_SESSION_SECRET: randomBytes(32).toString('hex') });
    if (!config.enabled) throw new Error('ADMIN_TEST_CONFIG_INVALID');
    const store = createAdminStore(db, 'default');
    const { rows: [principal] } = await db.query<{ principal_id: string }>(
      `SELECT principal_id FROM admin_principals WHERE tenant_id='default' AND account=$1 AND state='ACTIVE'`, [operator.address.toLowerCase()]);
    const sessionId = randomBytes(16).toString('hex'), expiresAt = new Date(now.getTime() + 3_600_000);
    await store.createSession({ sessionId, principalId: principal!.principal_id, createdAt: now, expiresAt });
    const token = sealAdminSession(config.key, { sessionId, principalId: principal!.principal_id, issuedAt: now, expiresAt, domain: '127.0.0.1' });
    const reviewerContext = await authenticateAdmin({ store, key: config.key, token, now, domain: '127.0.0.1' });
    if (!reviewerContext) throw new Error('TEST_ADMIN_UNAVAILABLE');
    expect(await decideStudioCertification(db, 'default', reviewerContext, parseStudioDecision({ ...certified, action: 'approve', catalogRevision: '0',
      reason: 'Chain identity and checkpoint confirmed independently', reference: 'https://aurora-reference.example.org/', rpcUrl: 'https://aurora-independent.example.org/' }),
    () => now, async manifest => evidence(manifest, 'test'))).toEqual({ status: 'CERTIFIED' });
    cleanup = async () => {
      const head = (await studioCertificationQueue(db, 'default')).find(row => row.project_id === projectId && row.slug === certified.slug);
      if (!head || head.status === 'REVOKED') return;
      await decideStudioCertification(db, 'default', reviewerContext, parseStudioDecision({ ...certified, action: 'revoke',
        catalogRevision: head.catalog_revision, reason: 'Browser test cleanup' }), () => new Date());
    };

    await installJourneyWallet(page, [operator], { chain: '0x14a34' });
    await page.goto('/admin/studio');
    expect(new URL(page.url()).pathname).toBe('/admin/login');
    await page.getByRole('listitem').filter({ hasText: 'Browser wallet' }).click();
    await page.waitForURL(url => url.pathname === '/admin');
    await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Studio certification' }).click();
    await expect(page.getByRole('heading', { name: 'Submitted integrations' })).toBeVisible();
    const card = (name: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: new RegExp(name) }) });
    const aurora = card('Aurora Partner Network'), boreal = card('Boreal Partner Network');
    await expect(aurora).toContainText('Certified');
    await expect(boreal).toContainText('Awaiting review');
    // The decision rests on a summary of the evidence, not on raw records.
    await expect(boreal.getByRole('definition').filter({ hasText: `eip155:${chainBase + 1}` })).toBeVisible();
    await expect(boreal).toContainText('boreal-partner.rpc.example.org');
    await expect(boreal).toContainText('evm-rpc v1');
    await page.screenshot({ path: info.outputPath('studio-certification-queue-desktop.png'), fullPage: true });
    const decide = async (target: typeof aurora, action: string, reason: string, visibility?: 'Public' | 'Private') => {
      await target.getByLabel('Decision', { exact: true }).selectOption({ label: action });
      await target.getByLabel('Reason (visible to the owner)').fill(reason);
      if (visibility) await target.getByLabel('Visibility', { exact: true }).selectOption({ label: visibility });
      // Every decision is confirmed in place, with its consequence, before the button is enabled.
      const submitButton = target.getByRole('button', { name: action, exact: true });
      await expect(submitButton).toBeDisabled();
      await target.getByRole('checkbox', { name: 'I reviewed this decision.' }).check();
      const response = page.waitForResponse(item => new URL(item.url()).pathname === '/admin/api/studio');
      await submitButton.click();
      expect((await response).status()).toBe(200);
      await expect(target.getByText('Decision recorded.')).toBeVisible();
    };

    await decide(boreal, 'Reject', 'Checkpoint could not be corroborated');
    await expect(boreal).toContainText('Rejected');
    await expect(boreal).toContainText('Checkpoint could not be corroborated');

    // Publication reaches the product catalog as metadata only; suspension and revocation remove it immediately.
    await decide(aurora, 'Publish', 'Published for every eligible FloFi user', 'Public');
    await expect(aurora).toContainText('Published');
    await expect(aurora).toContainText('v1 · Public');
    // The product shows it in the Editor as reference information (never on the Chat landing). Same page: the guard allows no popups.
    const openProduct = async () => {
      await page.goto('/app');
      await expect(page.locator('.app-shell').first()).not.toHaveAttribute('inert', { timeout: 30_000 });
      await expect(page.locator('details.studio-discovery')).toHaveCount(0);
      await openEditorSection(page, 'Build');
    };
    const backToQueue = async () => {
      await page.goto('/admin/studio');
      await expect(page.getByRole('heading', { name: 'Submitted integrations' })).toBeVisible();
    };
    await openProduct();
    const discovery = page.locator('details.studio-discovery');
    await discovery.locator('summary').click();
    await expect(discovery).toContainText('Aurora Partner Network');
    await expect(discovery).toContainText(`eip155:${chainBase}`);
    await expect(discovery).toContainText('They cannot be used in actions yet.');
    await expect(discovery).not.toContainText('Boreal Partner Network');
    await expect(discovery).not.toContainText('rpc.example.org');
    await page.screenshot({ path: info.outputPath('studio-published-metadata-product.png') });
    await backToQueue();

    await decide(aurora, 'Suspend', 'Provider incident under investigation');
    await expect(aurora).toContainText('Suspended');
    await openProduct();
    await expect(page.locator('details.studio-discovery')).toHaveCount(0);
    await backToQueue();

    await decide(aurora, 'Revoke', 'Certification withdrawn');
    await expect(aurora).toContainText('Revoked');
    await expect(aurora.getByLabel('Decision', { exact: true })).toHaveCount(0);
    expect((await db.query<{ kind: string }>(`SELECT kind FROM admin_audit_events WHERE target LIKE $1 ORDER BY event_id`, [`${projectId}:%`])).rows.map(row => row.kind))
      .toEqual(['ADMIN_STUDIO_APPROVE', 'ADMIN_STUDIO_REJECT', 'ADMIN_STUDIO_PUBLISH', 'ADMIN_STUDIO_SUSPEND', 'ADMIN_STUDIO_REVOKE']);

    await chooseLanguage(page.context(), 'PT');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(card('Aurora Partner Network')).toContainText('Revogada');
    await expect(card('Boreal Partner Network')).toContainText('Rejeitada');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // The records disclosure scrolls inside itself: opening it on a phone never scrolls the page sideways.
    await card('Aurora Partner Network').getByText('Registros de configuração e evidências').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('studio-certification-queue-pt-mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
    networkGuard.assertClean();
  } finally {
    await cleanup?.().catch(() => undefined);
    await db.close();
  }
});
