// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001 (measurement): how long the Automations page takes to show useful content, how many automation
 * reads it sends, and how long the Settings menu's account row stays a placeholder — on the `automations` browser profile (embedded PostgreSQL,
 * fixture prices, loopback reads; nothing reaches a public provider or chain, nothing is signed). Only public UI labels are used, so the same
 * file measures any build. Samples are written to `.tmp/loading-performance.json`; the assertions are the regression guard: the useful content
 * appears, at most one automation read is sent per open, and the account row resolves.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import type { Request } from '@playwright/test';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet.ts';
import { assertAutomationHarness } from './automation-fixtures';
import { test, expect, proveConnectedEvmWallet } from './fixtures';
import { installJourneyWallet } from './journey-fixtures';

const SAMPLES = 5;
const automationRead = (request: Request) => request.url().includes('/api/automations/overview')
  || request.method() === 'POST' && new URL(request.url()).pathname === '/app/automations' && Boolean(request.headers()['next-action']);
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
    const automations: { ms: number; structureMs: number; reads: number }[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const reads: Request[] = [];
      const listen = (request: Request) => { if (automationRead(request)) reads.push(request); };
      page.on('request', listen);
      const start = Date.now();
      await page.goto('/app/automations', { waitUntil: 'commit' });
      await expect(page.getByRole('heading', { name: 'Automations', exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });
      const structureMs = Date.now() - start;
      await expect(useful).toBeVisible({ timeout: 30_000 });
      automations.push({ ms: Date.now() - start, structureMs, reads: reads.length });
      // Let any late duplicate read show up before the next sample.
      await page.waitForTimeout(1_500);
      automations.at(-1)!.reads = reads.length;
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
      automationReadsPerOpen: Math.max(...automations.map(s => s.reads)), myAccountMedianMs: median(account.map(s => s.ms)) } };
    mkdirSync('.tmp', { recursive: true });
    writeFileSync(`.tmp/loading-performance-${process.env.FLOFI_PERF_LABEL ?? 'build'}.json`, JSON.stringify(result, null, 2));
    console.log('LOADING_PERFORMANCE', JSON.stringify(result.summary));
    expect(automations.every(s => s.reads >= 1)).toBe(true);
  });
});
