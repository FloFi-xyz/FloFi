// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const cache = process.env.BUILD002_BROWSER_CACHE;
if (!cache || !cache.endsWith('/chromium_headless_shell-1243')) throw Error('Use the existing verified Chromium 1243 cache; no browser download');
const executablePath = join(cache, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
if (!existsSync(executablePath)) throw Error('Verified Chromium executable missing');
// No app build, server, database, provider or wallet. All browser requests are intercepted by the spec.
export default defineConfig({ testDir: './e2e', testMatch: 'solana-transfer-ux.spec.ts', workers: 1, retries: 0, timeout: 30_000,
  reporter: 'list', use: { browserName: 'chromium', headless: true, launchOptions: { executablePath }, serviceWorkers: 'block',
    trace: 'off', screenshot: 'only-on-failure', video: 'off', reducedMotion: 'reduce' } });
