// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001 — the Editor starts the SAME workflow run chats, MCP clients and channels start, from the canonical
 * workflow the owner built and simulated on the Canvas, without rebuilding it elsewhere:
 *
 *   signed-in FloFi account → two Base Sepolia swaps on the Canvas (the second funded by the first) → Execute: "Run workflow" is offered but
 *   disabled until the workflow is simulated → simulate → enabled → an edit makes it stale (disabled, with the reason) → simulate again → "Run
 *   workflow" → `/approve`, the shared approval page, with ONE pending EDITOR_SESSION approval whose plan is SEQUENTIAL; nothing is authorized.
 *
 * The wallet is passive: the button asks it for nothing (no signature, no transaction), and nothing reaches a public network (the synthetic
 * loopback swap RPC and disposable PostgreSQL). The account session is created by the account store exactly as an email sign-in creates it and
 * its cookie is sealed with this run's deployment secret (the sign-in screens are covered by auth-wallets.spec.ts).
 */
import type { Page } from '@playwright/test';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { createAccountStore } from '../src/accounts/account-store';
import { ACCOUNT_SESSION_COOKIE, sealAccountSession, type AccountSessionToken } from '../src/accounts/account-session';
import { APP_ORIGIN } from './app-origin';
import { openBuilder, openEditorSection } from './build-entry-navigation';
import { expect, test } from './fixtures';
import { installJourneyWallet } from './journey-fixtures';

test.skip(process.env.FLOFI_WORKFLOW_RUNS !== 'enabled' || process.env.GRYLOO_CLOUD_RUNTIME_E2E !== 'EMBEDDED_LOOPBACK_ONLY'
  || process.env.FLOFI_SWAP_READ_E2E !== 'MOCKED_LOOPBACK_ONLY' || !process.env.FLOFI_E2E_SESSION_SECRET || !process.env.FLOFI_E2E_DATABASE_URL,
'Requires workflow runs on the embedded loopback runtime, the loopback swap read harness and a per-run session secret');
test.setTimeout(180_000);

const BASE_SEPOLIA = '0x14a34';
/** Wallet methods that would ask the owner for anything (a signature, a transaction, a network or permission change). */
const ASKING = /^(personal_sign|eth_sign|eth_signTypedData.*|eth_sendTransaction|eth_sendRawTransaction|wallet_.*)$/;
const chat = (page: Page) => page.locator('.chat-messages[role="log"]');
const flofi = (page: Page) => chat(page).locator('.message:not(.you):not(.conversation-execution-message)').last();
const cards = (page: Page) => page.locator('.build-flow-surface .composer-card');
const runRegion = (page: Page) => page.getByRole('region', { name: 'Run the whole workflow', exact: true });
const runButton = (page: Page) => runRegion(page).getByRole('button', { name: 'Run workflow', exact: true });
async function say(page: Page, text: string, answer: string) {
  await page.locator('#mock-prompt').fill(text);
  await page.locator('.chat-form button[type=submit]').click();
  await expect(flofi(page)).toContainText(answer);
}
async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  try { return (await db.query(sql, params)).rows as T[]; } finally { await db.close(); }
}
/** A FloFi account holding the test wallet, signed in through the account store as an email sign-in leaves it. */
async function signedInAccount(page: Page, wallet: string): Promise<AccountSessionToken> {
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  let session: AccountSessionToken;
  try {
    const store = createAccountStore(db, 'default');
    session = await store.signIn({ kind: 'email', subject: `editor-run-${Date.now()}@flofi-e2e.test`, label: null });
    await store.setOnboarding(session.accountId, 'completed');
    await store.saveWallet(session.accountId, { ecosystem: 'evm', address: wallet, origin: 'external', provider: 'io.metamask', providerName: 'MetaMask',
      providerResource: null, label: 'MetaMask' });
  } finally { await db.close(); }
  await page.context().addCookies([{ name: ACCOUNT_SESSION_COOKIE, url: APP_ORIGIN, httpOnly: true, sameSite: 'Lax',
    value: sealAccountSession({ FLOFI_SESSION_SECRET: process.env.FLOFI_E2E_SESSION_SECRET! }, session, new URL(APP_ORIGIN).host, new Date()) }]);
  return session;
}
/** Simulates the Canvas workflow (its current step) from the Canvas lifecycle action; read-only, nothing is signed. */
async function simulate(page: Page) {
  await openEditorSection(page, 'Build');
  const action = page.locator('.canvas-primary-action [data-lifecycle-action="simulate"]');
  await expect(action).toBeEnabled({ timeout: 30_000 });
  await action.click();
  await expect(page.locator('[data-lifecycle-action="approve"]').first()).toBeVisible({ timeout: 45_000 });
}

test('a simulated multi-step Canvas workflow starts the shared workflow run on /approve; stale or unsimulated, it cannot; the wallet is never asked', async ({ page, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const owner = createTestWallet();
  // Every wallet method the page calls, across navigations (the wallet double's own log lives in one document only).
  const methods: string[] = [];
  await page.exposeFunction('flofiEditorRunWalletLog', (method: string) => { methods.push(method); });
  await installJourneyWallet(page, [owner], { chain: BASE_SEPOLIA, transactionControl: async () => { throw Error('FINANCIAL_REQUEST_FORBIDDEN'); } });
  await page.addInitScript(() => {
    const w = window as unknown as { ethereum: { request: (input: { method: string }) => Promise<unknown> }; flofiEditorRunWalletLog: (method: string) => Promise<void> };
    const request = w.ethereum.request;
    w.ethereum.request = input => { void w.flofiEditorRunWalletLog(input.method); return request(input); };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { provider: w.ethereum, info: { rdns: 'io.metamask', name: 'MetaMask', uuid: 'editor-run-metamask' } } })));
  });
  const session = await signedInAccount(page, owner.address);
  await openBuilder(page);
  await expect(page.locator('.header-wallet-provider')).toHaveAttribute('title', 'MetaMask');
  await say(page, 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps', 'Swap added to your workflow: 1 USDC');
  await say(page, 'swap 0.001 WETH to USDC on Base Sepolia slippage 50 bps', 'Swap added to your workflow: 0.001 WETH');
  await expect(cards(page)).toHaveCount(2);

  // Offered for the two-step workflow, but not before it is simulated.
  await openEditorSection(page, 'Execute');
  await expect(runRegion(page)).toContainText('Runs all 2 steps in order on FloFi\'s approval page');
  await expect(runButton(page)).toBeDisabled();
  await expect(runRegion(page)).toContainText('Simulate the workflow before running it.');

  // Simulated at the current revision: ready.
  await simulate(page);
  await openEditorSection(page, 'Execute');
  await expect(runButton(page)).toBeEnabled();

  // An edit after the simulation is a new revision: the earlier simulation never stands for it.
  await openEditorSection(page, 'Build');
  const amount = cards(page).nth(1).getByRole('textbox', { name: 'Source amount (WETH)', exact: true });
  await amount.fill('0.002');
  await amount.blur();
  await expect(amount).toHaveValue('0.002');
  await openEditorSection(page, 'Execute');
  await expect(runButton(page)).toBeDisabled();
  await expect(runRegion(page)).toContainText('The workflow changed after it was simulated. Simulate it again to run it.');

  await simulate(page);
  await openEditorSection(page, 'Execute');
  await expect(runButton(page)).toBeEnabled();
  const before = (await query<{ handoff_id: string }>('SELECT handoff_id FROM mcp_handoffs')).map(row => row.handoff_id);
  const asked = methods.length;
  await runButton(page).click();

  // The shared approval page: the Editor's proposal, waiting for the owner's wallet proof; nothing is authorized.
  await page.waitForURL(url => url.pathname === '/approve', { timeout: 30_000 });
  const notice = page.getByRole('region', { name: 'Proposal from FloFi Editor', exact: true });
  await expect(notice).toContainText('Nothing is authorized yet.');
  await expect(notice).toContainText('From FloFi Editor');
  // The secret left the address bar (it is only in this tab's memory).
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  const created = await query<{ handoff_id: string; requester_kind: string; requester_ref: string; status: string; plan: string; steps: number; strategy: unknown }>(
    `SELECT handoff_id, requester_kind, requester_ref, status, plan->>'kind' AS plan, jsonb_array_length(plan->'steps') AS steps, strategy FROM mcp_handoffs
     WHERE NOT (handoff_id = ANY($1::text[]))`, [before]);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ requester_kind: 'EDITOR_SESSION', requester_ref: session.accountId, status: 'PENDING', plan: 'SEQUENTIAL', steps: 2,
    strategy: { version: 2, steps: [{ action: 'swap', network: 'base-sepolia', amount: '1' }, { action: 'swap', network: 'base-sepolia', amount: '0.002' }],
      bindings: [{ step: 1, amountFrom: 0 }] } });
  expect(await query('SELECT run_id FROM workflow_runs WHERE handoff_id = $1', [created[0]!.handoff_id])).toEqual([]);

  // "Run workflow" asked the wallet for nothing; nothing on this journey asked it for a signature or a transaction.
  expect(methods.slice(asked).filter(method => ASKING.test(method))).toEqual([]);
  expect(methods.filter(method => /^(eth_sendTransaction|eth_sendRawTransaction|eth_signTypedData.*)$/.test(method))).toEqual([]);
  expect(errors).toEqual([]);
  networkGuard.assertClean();
});
