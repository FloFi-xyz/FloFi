// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001 browser suite: sign-in, wallet onboarding, My wallets and export on normal routes, against the MOCKED
 * loopback identity provider and wallet provider (e2e/account-harness.ts) and a disposable LOOPBACK PostgreSQL database. Every key and
 * secret below is generated for this run in memory and never written; no public provider is contacted and no real identity is used.
 * FloFi Wallet's signing journeys add the MOCKED loopback Solana Devnet/Orca harness (e2e/solana-devnet-harness.mjs): MOCKED evidence only.
 */
import { defineConfig } from '@playwright/test';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { E2E_APP_ORIGIN, E2E_APP_PORT, e2eNetworkScopeEnv } from './e2e/app-origin';

const cache = process.env.BUILD002_BROWSER_CACHE;
if (!cache || basename(cache) !== 'chromium_headless_shell-1243') throw Error('VERIFIED_BROWSER_1243_REQUIRED');
const executablePath = join(cache, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
if (!existsSync(executablePath)) throw Error('VERIFIED_BROWSER_EXECUTABLE_MISSING');
if (process.env.NEXT_TELEMETRY_DISABLED !== '1' || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD !== '1') throw Error('BROWSER_DOWNLOAD_AND_TELEMETRY_CONTROLS_REQUIRED');
if (!process.env.FLOFI_E2E_DATABASE_URL) {
  const server = new URL(process.env.TEST_DATABASE_URL ?? 'invalid:');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname)) throw Error('AUTH_WALLETS_E2E_NEEDS_LOOPBACK_TEST_DATABASE_URL');
  server.pathname = `/flofi_e2e_accounts_${randomBytes(4).toString('hex')}`;
  process.env.FLOFI_E2E_DATABASE_URL = server.href;
}
export const ACCOUNT_HARNESS_PORT = 8571, ACCOUNT_HARNESS_ORIGIN = `http://127.0.0.1:${ACCOUNT_HARNESS_PORT}`;
// Workers inherit the runner environment: the spec reads the harness origin and the database from here.
process.env.FLOFI_ACCOUNT_HARNESS_ORIGIN = ACCOUNT_HARNESS_ORIGIN;
process.env.FLOFI_AUTH_WALLETS_E2E = 'MOCKED_LOOPBACK_ONLY';
const parent = createECDH('prime256v1'); parent.generateKeys();
// The MOCKED provider's OTP signing key (encryption targets and verification tokens): private half to the harness, public half to the app.
const otpSigner = createECDH('prime256v1'); otpSigner.generateKeys();
const parentOrg = randomUUID(), googleClient = 'flofi-e2e.apps.loopback', googleSecret = randomBytes(24).toString('hex'), appleClient = 'xyz.flofi.e2e';
// FloFi Wallet runs on its own origin: the same loopback server under another host name (localhost vs 127.0.0.1), with its own OIDC clients.
export const WALLET_ORIGIN = `http://localhost:${E2E_APP_PORT}`;
process.env.FLOFI_E2E_WALLET_ORIGIN = WALLET_ORIGIN;
const walletGoogleClient = 'flofi-wallet-e2e.apps.loopback', walletGoogleSecret = randomBytes(24).toString('hex'), walletAppleClient = 'xyz.flofi.wallet.e2e';
// FloFi Wallet signing journeys: a reviewed Solana Devnet swap on the MOCKED loopback Devnet/Orca harness (127.0.0.1:8552, e2e/solana-devnet-harness.mjs)
// only; never public Devnet, never a public broadcast, MOCKED evidence only. The app's run journal is a fresh directory under the OS temp directory
// (workers inherit the runner's value, so fixtures and the server share it).
if (process.env.GRYLOO_SOLANA_DEVNET_E2E !== undefined && process.env.GRYLOO_SOLANA_DEVNET_E2E !== 'MOCKED_LOOPBACK_ONLY') throw Error('SOLANA_DEVNET_E2E_PERMITS_ONLY_MOCKED_LOOPBACK');
process.env.GRYLOO_SOLANA_DEVNET_E2E = 'MOCKED_LOOPBACK_ONLY';
process.env.GRYLOO_SOLANA_DEVNET_JOURNAL ??= join(tmpdir(), `gryloo-demo001-auth-wallets-${Date.now()}-${process.pid}`);
const devnetJournal = process.env.GRYLOO_SOLANA_DEVNET_JOURNAL;
if (!devnetJournal.startsWith(join(tmpdir(), 'gryloo-demo001-'))) throw Error('SOLANA_DEVNET_JOURNAL_MUST_BE_A_TEMPORARY_DIRECTORY');

export default defineConfig({
  testDir: './e2e', testMatch: 'auth-wallets.spec.ts', workers: 1, fullyParallel: false, retries: 0,
  timeout: 90_000, expect: { timeout: 15_000 }, reporter: 'list', globalSetup: './e2e/cloud-runtime-setup.ts',
  use: { baseURL: E2E_APP_ORIGIN, browserName: 'chromium', headless: true, launchOptions: { executablePath },
    serviceWorkers: 'block', trace: 'off', screenshot: 'only-on-failure', video: 'off' },
  webServer: [
    { command: 'node e2e/account-harness.ts', url: `${ACCOUNT_HARNESS_ORIGIN}/health`, reuseExistingServer: false, timeout: 30_000,
      env: { FLOFI_ACCOUNT_HARNESS_PORT: String(ACCOUNT_HARNESS_PORT), FLOFI_ACCOUNT_HARNESS_APP_ORIGIN: E2E_APP_ORIGIN,
        FLOFI_ACCOUNT_HARNESS_PARENT_PUBLIC_KEY: parent.getPublicKey('hex', 'compressed'), FLOFI_ACCOUNT_HARNESS_PARENT_ORG: parentOrg,
        FLOFI_ACCOUNT_HARNESS_GOOGLE_CLIENT: googleClient, FLOFI_ACCOUNT_HARNESS_GOOGLE_SECRET: googleSecret, FLOFI_ACCOUNT_HARNESS_APPLE_CLIENT: appleClient,
        FLOFI_ACCOUNT_HARNESS_OTP_SIGNER_PRIVATE_KEY: otpSigner.getPrivateKey('hex').padStart(64, '0'), FLOFI_ACCOUNT_HARNESS_WALLET_ORIGIN: WALLET_ORIGIN,
        FLOFI_ACCOUNT_HARNESS_WALLET_GOOGLE_CLIENT: walletGoogleClient, FLOFI_ACCOUNT_HARNESS_WALLET_GOOGLE_SECRET: walletGoogleSecret,
        FLOFI_ACCOUNT_HARNESS_WALLET_APPLE_CLIENT: walletAppleClient } },
    { command: 'node e2e/solana-devnet-harness.mjs --serve', url: 'http://127.0.0.1:8552', reuseExistingServer: false, timeout: 30_000 },
    { command: 'pnpm --filter @defi-workflow-engine/reference-dapp start', url: E2E_APP_ORIGIN, reuseExistingServer: false, timeout: 90_000,
      env: { PORT: String(E2E_APP_PORT), ...e2eNetworkScopeEnv(), FLOFI_COPILOT: 'replay', NEXT_TELEMETRY_DISABLED: '1', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
        // The Devnet swap is authored through the loopback-only engineering form (/__engineering) and runs only on the MOCKED harness above.
        FLOFI_ENGINEERING_UI: 'LOOPBACK_ONLY', GRYLOO_SOLANA_DEVNET_HARNESS: 'MOCKED_LOOPBACK_ONLY', GRYLOO_SOLANA_DEVNET_JOURNAL: devnetJournal,
        FLOFI_PUBLIC_ORIGIN: E2E_APP_ORIGIN, DATABASE_URL: process.env.FLOFI_E2E_DATABASE_URL!, FLOFI_SESSION_SECRET: randomBytes(32).toString('hex'),
        FLOFI_GOOGLE_CLIENT_ID: googleClient, FLOFI_GOOGLE_CLIENT_SECRET: googleSecret, FLOFI_APPLE_CLIENT_ID: appleClient,
        FLOFI_AUTH_E2E_IDP: 'MOCKED_LOOPBACK_ONLY', FLOFI_AUTH_E2E_IDP_ORIGIN: ACCOUNT_HARNESS_ORIGIN,
        FLOFI_TURNKEY_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_TURNKEY_ORGANIZATION_ID: parentOrg, FLOFI_TURNKEY_API_PUBLIC_KEY: parent.getPublicKey('hex', 'compressed'),
        FLOFI_TURNKEY_API_PRIVATE_KEY: parent.getPrivateKey('hex').padStart(64, '0'), FLOFI_TURNKEY_API_BASE_URL: ACCOUNT_HARNESS_ORIGIN,
        FLOFI_TURNKEY_OTP_SIGNER_PUBLIC_KEY: otpSigner.getPublicKey('hex', 'uncompressed'), FLOFI_WALLET_ORIGIN: WALLET_ORIGIN,
        FLOFI_WALLET_GOOGLE_CLIENT_ID: walletGoogleClient, FLOFI_WALLET_GOOGLE_CLIENT_SECRET: walletGoogleSecret, FLOFI_WALLET_APPLE_CLIENT_ID: walletAppleClient,
        FLOFI_TURNKEY_EXPORT_IFRAME_URL: `http://127.0.0.1:${ACCOUNT_HARNESS_PORT + 1}`, FLOFI_TURNKEY_IMPORT_IFRAME_URL: `http://127.0.0.1:${ACCOUNT_HARNESS_PORT + 2}` } },
  ],
});
