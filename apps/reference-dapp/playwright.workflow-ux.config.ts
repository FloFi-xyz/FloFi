// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ARB-001 Phase 7: owner-approved workflow UX authoring spec on normal /app. Replay Copilot, passive wallet, every financial gate off;
 * the only extra service is the MOCKED loopback Robinhood Stock Token registry (no chain, no send path). No fork or financial harness.
 */
import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { E2E_APP_ORIGIN, E2E_APP_PORT, e2eNetworkScopeEnv } from './e2e/app-origin';
const cache = process.env.BUILD002_BROWSER_CACHE;
if (!cache || basename(cache) !== 'chromium_headless_shell-1243') throw Error('VERIFIED_BROWSER_1243_REQUIRED');
const executablePath = join(cache, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
if (!existsSync(executablePath)) throw Error('VERIFIED_BROWSER_EXECUTABLE_MISSING');
if (process.env.NEXT_TELEMETRY_DISABLED !== '1' || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD !== '1') throw Error('BROWSER_DOWNLOAD_AND_TELEMETRY_CONTROLS_REQUIRED');
const gateNames = ['GRYLOO_ARBITRUM_MAINNET', 'GRYLOO_ARBITRUM_OWNER_EXECUTION', 'GRYLOO_BASE_MAINNET', 'GRYLOO_BASE_OWNER_EXECUTION',
  'GRYLOO_ROUTER', 'GRYLOO_ROUTER_OWNER_EXECUTION', 'GRYLOO_ROBINHOOD_MAINNET', 'GRYLOO_ROBINHOOD_OWNER_EXECUTION'];
for (const name of gateNames) if (process.env[name]) throw Error('WORKFLOW_UX_REQUIRES_GATES_OFF');
// The spec needs this configuration's registry harness and automation settings; under another configuration it skips itself.
process.env.FLOFI_WORKFLOW_UX_AUTHORING_E2E = 'MOCKED_LOOPBACK_ONLY';
export default defineConfig({
  testDir: './e2e', testMatch: 'workflow-ux-authoring.spec.ts', workers: 1, fullyParallel: false, retries: 0,
  timeout: 45_000, expect: { timeout: 10_000 }, reporter: 'list',
  use: { baseURL: E2E_APP_ORIGIN, browserName: 'chromium', headless: true, launchOptions: { executablePath },
    serviceWorkers: 'block', trace: 'off', screenshot: 'only-on-failure', video: 'off' },
  webServer: [
    { command: 'node e2e/robinhood-mainnet-serve.ts', url: 'http://127.0.0.1:8561', reuseExistingServer: false, timeout: 30_000 },
    { command: 'pnpm --filter @defi-workflow-engine/reference-dapp start', url: E2E_APP_ORIGIN, reuseExistingServer: false, timeout: 60_000,
      env: { PORT: String(E2E_APP_PORT), FLOFI_ENGINEERING_UI: 'LOOPBACK_ONLY', ...e2eNetworkScopeEnv(), FLOFI_COPILOT: 'replay',
        GRYLOO_ROBINHOOD_MAINNET_HARNESS: 'MOCKED_LOOPBACK_ONLY', GRYLOO_ROBINHOOD_JOURNAL: join(tmpdir(), 'gryloo-workflow-ux-' + Date.now() + '-' + process.pid),
        // The existing automation entry point, so its header placement is visible; a per-run disposable secret, never committed.
        FLOFI_AUTOMATIONS: 'enabled', FLOFI_PUBLIC_ORIGIN: E2E_APP_ORIGIN, FLOFI_AUTOMATION_SECRET: randomBytes(32).toString('hex'),
        NEXT_TELEMETRY_DISABLED: '1', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } },
  ],
});
