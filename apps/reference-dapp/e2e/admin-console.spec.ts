// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the private Admin console in a real browser, on a disposable loopback database (`FLOFI_ADMIN_E2E=LOOPBACK_ONLY`).
 * A verified wallet is refused until the operator CLI grants it; the granted operator sees the overview (network distribution included)
 * built from seeded durable records, changes the Copilot settings (versioned, audited), cannot be driven cross-origin, and signs out.
 * The injected test wallet only signs sign-in messages; nothing is sent to any chain and no public network is reached.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDatabase, type Database } from '@defi-workflow-engine/cloud-runtime';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet.ts';
import { runAdminCommand } from '../src/admin/cli-commands.ts';
import { persistCopilotInterpretation, persistCopilotTurn } from '../src/server/copilot-metrics-store.ts';
import { expect, test } from './fixtures';
import { installJourneyWallet } from './journey-fixtures';

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
      await expect.poll(() => brand.locator('img').evaluateAll(images => images.map(image => {
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
    const networks = page.getByRole('region', { name: 'Network distribution' }).or(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Network distribution' }) }));
    await expect(networks.getByRole('img', { name: /Share of executed actions by network/ })).toBeVisible();
    const shares = networks.locator('table').first();
    await expect(shares.getByRole('row', { name: /Base Sepolia/ })).toContainText('66.7%');
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
    await expect(page.getByText('Not configured', { exact: true }).first()).toBeVisible();
    // The editor is a client component rendered on the server first: text typed before it hydrates never reaches its state (Save stays
    // disabled). Type again until the editor registers the change, then save exactly as before.
    const save = page.getByRole('button', { name: 'Save as version 1' });
    await expect(async () => {
      await page.getByLabel('Model').first().fill('');
      await page.getByLabel('Model').first().fill('gpt-4o-mini');
      await page.getByLabel('Reason (optional, stored in the version history)').fill('E2E: cheaper interpreter');
      await expect(save).toBeEnabled({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await save.click();
    await expect(page.getByRole('button', { name: 'Save as version 2' })).toBeVisible();
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

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(url => url.pathname === '/admin/login');
    await page.goto('/admin/ai-settings');
    expect(new URL(page.url()).pathname).toBe('/admin/login');
    await page.goto('/admin/ai-analytics');
    expect(new URL(page.url()).pathname).toBe('/admin/login');
    const kinds = (await db.query<{ kind: string; outcome: string }>(`SELECT kind, outcome FROM admin_audit_events ORDER BY event_id`)).rows.map(r => `${r.kind}:${r.outcome}`);
    expect(kinds).toEqual(['ADMIN_SIGN_IN:REFUSED', 'ADMIN_PRINCIPAL_GRANTED:OK', 'ADMIN_SIGN_IN:OK', 'ADMIN_COPILOT_SETTINGS_SAVED:OK', 'ADMIN_SIGN_OUT:OK']);
    expect(errors).toEqual([]);
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
