// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { E2E_APP_ORIGIN, E2E_APP_PORT } from './e2e/app-origin';

// Dashboard → actual server actions → embedded backend → disposable PostgreSQL.
// No RPC harness server or financial execution is needed: the spec prepares its
// records through the existing engine using an in-process synthetic chain.
const cache = process.env.BUILD002_BROWSER_CACHE;
if (!cache || basename(cache) !== 'chromium_headless_shell-1243') throw Error('VERIFIED_BROWSER_REQUIRED');
const executablePath = join(cache, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
if (!existsSync(executablePath) || process.env.NEXT_TELEMETRY_DISABLED !== '1' || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD !== '1') throw Error('BROWSER_CONTROLS_REQUIRED');
const database = new URL(process.env.TEST_DATABASE_URL ?? 'invalid:');
if (!['127.0.0.1','localhost','[::1]'].includes(database.hostname)) throw Error('LOOPBACK_DATABASE_REQUIRED');
if (!process.env.FLOFI_E2E_DATABASE_URL) {
  database.pathname = `/flofi_e2e_history_${Date.now()}_${process.pid}`;
  process.env.FLOFI_E2E_DATABASE_URL = database.href;
} else database.href = process.env.FLOFI_E2E_DATABASE_URL;
if (!['127.0.0.1','localhost','[::1]'].includes(database.hostname) || !/^\/flofi_e2e_history_[0-9_]+$/.test(database.pathname)) throw Error('HISTORY_DATABASE_REQUIRED');
process.env.FLOFI_E2E_NETWORK_SCOPE = 'PUBLIC_MAINNET';

export default defineConfig({
  testDir: './e2e', testMatch: ['owner-history.spec.ts', 'dashboard-final-acceptance.spec.ts'], workers: 1, fullyParallel: false, retries: 0,
  globalSetup: './e2e/cloud-runtime-setup.ts', timeout: 60_000, expect: { timeout: 10_000 }, reporter: 'list',
  use: { baseURL: E2E_APP_ORIGIN, browserName: 'chromium', headless: true, launchOptions: { executablePath },
    viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', locale: 'en-US', colorScheme: 'light', reducedMotion: 'reduce',
    trace: 'off', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm start', url: E2E_APP_ORIGIN, reuseExistingServer: false, timeout: 60_000,
    env: { PORT: String(E2E_APP_PORT), NEXT_TELEMETRY_DISABLED: '1', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      FLOFI_RUNTIME: 'embedded', DATABASE_URL: database.href } },
});
