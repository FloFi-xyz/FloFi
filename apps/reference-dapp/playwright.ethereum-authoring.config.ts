// SPDX-License-Identifier: AGPL-3.0-only
/** One authoring-only product spec. Replay model, passive wallet, all financial gates off; no fork or financial harness. */
import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { E2E_APP_ORIGIN, E2E_APP_PORT, e2eNetworkScopeEnv } from './e2e/app-origin';
const cache = process.env.BUILD002_BROWSER_CACHE;
if (!cache || basename(cache) !== 'chromium_headless_shell-1243') throw Error('VERIFIED_BROWSER_1243_REQUIRED');
const executablePath = join(cache, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
if (!existsSync(executablePath)) throw Error('VERIFIED_BROWSER_EXECUTABLE_MISSING');
if (process.env.NEXT_TELEMETRY_DISABLED !== '1' || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD !== '1') throw Error('BROWSER_DOWNLOAD_AND_TELEMETRY_CONTROLS_REQUIRED');
const gateNames = ['GRYLOO_ETHEREUM_MAINNET', 'GRYLOO_ETHEREUM_OWNER_EXECUTION', 'GRYLOO_ARBITRUM_MAINNET', 'GRYLOO_ARBITRUM_OWNER_EXECUTION', 'GRYLOO_BASE_MAINNET', 'GRYLOO_BASE_OWNER_EXECUTION',
  'GRYLOO_ROUTER', 'GRYLOO_ROUTER_OWNER_EXECUTION', 'GRYLOO_ROBINHOOD_MAINNET', 'GRYLOO_ROBINHOOD_OWNER_EXECUTION'];
for (const name of gateNames) if (process.env[name]) throw Error('AUTHORING_CERTIFICATION_REQUIRES_GATES_OFF');
export default defineConfig({
  testDir: './e2e', testMatch: 'ethereum-authoring-certification.spec.ts', workers: 1, fullyParallel: false, retries: 0,
  timeout: 30_000, expect: { timeout: 10_000 }, reporter: 'list',
  use: { baseURL: E2E_APP_ORIGIN, browserName: 'chromium', headless: true, launchOptions: { executablePath },
    serviceWorkers: 'block', trace: 'off', screenshot: 'only-on-failure', video: 'off' },
  webServer: { command: 'pnpm --filter @defi-workflow-engine/reference-dapp start', url: E2E_APP_ORIGIN, reuseExistingServer: false, timeout: 60_000,
    env: { PORT: String(E2E_APP_PORT), FLOFI_ENGINEERING_UI: 'LOOPBACK_ONLY', ...e2eNetworkScopeEnv(), FLOFI_COPILOT: 'replay',
      NEXT_TELEMETRY_DISABLED: '1', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } },
});
