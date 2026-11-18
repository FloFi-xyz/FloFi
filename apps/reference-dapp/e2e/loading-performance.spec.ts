// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001 (measurement): how long the Automations page takes to show useful content, how many automation
 * reads it sends, and how long the Settings menu's account row stays a placeholder — on the `automations` browser profile (embedded PostgreSQL,
 * fixture prices, loopback reads; nothing reaches a public provider or chain, nothing is signed). Only public UI labels are used, so the same
 * file measures any build. Samples are written to `.tmp/loading-performance-<FLOFI_PERF_LABEL>.json`.
 *
 * A manual measurement, not part of a CI browser profile (run it on the base and on a branch with the same environment to compare). When it
 * runs on a build that has the automations GET, its assertions check the bounds this build claims: the useful content appears; each open sends
 * at most one owner overview read and at most two automation reads in all (availability alone before the wallet is known, then the owner's
 * overview); and the account row resolves without a presence read (the layout's verified bootstrap).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import type { Request } from '@playwright/test';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet.ts';
import { assertAutomationHarness } from './automation-fixtures';
import { test, expect, proveConnectedEvmWallet } from './fixtures';
import { installJourneyWallet } from './journey-fixtures';

const SAMPLES = 5;
/** The automation reads this build sends as GET requests, and every Server Action the page posts (they are dispatched one at a time per client). */
const automationGet = (request: Request) => request.url().includes('/api/automations/overview');
/** What one automations GET asked for: the owner's overview (a wallet header) or availability alone. */
const automationScope = (request: Request) => `${new URL(request.url()).searchParams.get('scope') ?? 'all'}${request.headers()['x-flofi-account'] ? '+owner' : ''}`;
const serverAction = (request: Request) => request.method() === 'POST' && Boolean(request.headers()['next-action']);
const presenceRead = (request: Request) => request.url().includes('/api/account/presence');
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

test.describe('loading performance (measurement)', () => {
  test.beforeAll(() => assertAutomationHarness());
  test('Automations useful content and My Account resolution', async ({ page }) => {
    test.setTimeout(240_000);
    const owner = createTestWallet();
    await installJourneyWallet(page, [owner], { chain: '0x14a34' });
    await page.goto('/app/automations');
    const workspace = page.getByRole('region', { name: 'Automations', exact: true });
    await proveConnectedEvmWallet(page, workspace, owner.address);
    const useful = workspace.getByRole('heading', { name: 'Create an automation', exact: true });
    await expect(useful).toBeVisible({ timeout: 30_000 });
    const automations: { ms: number; structureMs: number; automationGets: number; ownerReads: number; reads: string[]; serverActions: number }[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const gets: Request[] = [], actions: Request[] = [];
      const listen = (request: Request) => { if (automationGet(request)) gets.push(request); if (serverAction(request)) actions.push(request); };
      page.on('request', listen);
      const start = Date.now();
      await page.goto('/app/automations', { waitUntil: 'commit' });
      await expect(page.getByRole('heading', { name: 'Automations', exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });
      const structureMs = Date.now() - start;
      await expect(useful).toBeVisible({ timeout: 30_000 });
      const ms = Date.now() - start, actionsUntilUseful = actions.length;
      // Let any late duplicate read show up before the next sample.
      await page.waitForTimeout(1_500);
      const reads = gets.map(automationScope);
      automations.push({ ms, structureMs, automationGets: gets.length, ownerReads: reads.filter(read => read.endsWith('+owner')).length, reads, serverActions: actionsUntilUseful });
      page.off('request', listen);
    }
    const account: { ms: number; reads: number }[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const reads: Request[] = [];
      const listen = (request: Request) => { if (presenceRead(request)) reads.push(request); };
      page.on('request', listen);
      await page.goto('/app/workflows');
      const gear = page.getByRole('button', { name: 'Settings', exact: true });
      await expect(gear).toBeVisible();
      const start = Date.now();
      await gear.click();
      const menu = page.getByRole('group', { name: 'Settings options', exact: true });
      await expect(menu.locator('.header-settings-pending')).toHaveCount(0, { timeout: 30_000 });
      await expect(menu.getByRole('link', { name: /^(My account|Sign in)$/ })).toBeVisible();
      account.push({ ms: Date.now() - start, reads: reads.length });
      page.off('request', listen);
    }
    const result = { automations, account, summary: { automationsMedianMs: median(automations.map(s => s.ms)), automationsStructureMedianMs: median(automations.map(s => s.structureMs)),
      automationGetsPerOpen: Math.max(...automations.map(s => s.automationGets)), serverActionsBeforeUsefulMedian: median(automations.map(s => s.serverActions)),
      myAccountMedianMs: median(account.map(s => s.ms)), presenceReads: account.reduce((n, s) => n + s.reads, 0) } };
    mkdirSync('.tmp', { recursive: true });
    writeFileSync(`.tmp/loading-performance-${process.env.FLOFI_PERF_LABEL ?? 'build'}.json`, JSON.stringify(result, null, 2));
    console.log('LOADING_PERFORMANCE', JSON.stringify(result.summary));
    expect(automations.every(s => s.ms > 0)).toBe(true);
    // The bounds hold only on a build that reads automations over the GET route (the base sends Server Actions: nothing to bound here).
    if (automations.some(s => s.automationGets > 0)) {
      expect(automations.every(s => s.ownerReads <= 1 && s.automationGets <= 2)).toBe(true);
      expect(account.every(s => s.reads === 0)).toBe(true);
    }
  });
});
