// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 universal execution (case D): the Editor's whole-workflow path really asks the browser wallet for ONE EIP-5792 `wallet_sendCalls` batch —
 * proven at the wallet boundary, not by a button label.
 *
 *   signed-in FloFi account → Swap 3 USDC → WETH, Supply the swap's WETH, Borrow 0.8 USDC on Base (chat) → Execute → "Review whole workflow"
 *   (`wallet_getCapabilities` only; nothing is sent) → "Authorize workflow" → exactly one `wallet_sendCalls` with the prepared atomic batch
 *   (chain 0x2105, the owner as `from`, `atomicRequired`, no capabilities, approve/swap/approve/supply/borrow) → the wallet double executes it on
 *   the MOCKED Base chain (one transaction from the owner's own account) → `wallet_getCallsStatus` → FloFi reconciles every step from the chain
 *   → reload: the run is recovered from FloFi, and the wallet is never asked to send again.
 *
 * MOCKED loopback only: the Base authoring harness (127.0.0.1:8562), the user-funded chain double (https://127.0.0.1:8567, e2e/
 * user-funded-chain-serve.ts) and disposable PostgreSQL. The wallet is this spec's double; nothing reaches a public network, nothing is
 * signed with a real key, and none of this is evidence of a mainnet execution.
 */
import { request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { createAccountStore } from '../src/accounts/account-store';
import { ACCOUNT_SESSION_COOKIE, sealAccountSession } from '../src/accounts/account-session';
import { APP_ORIGIN } from './app-origin';
import { openBuilder, openEditorSection } from './build-entry-navigation';
import { expect, test } from './fixtures';
import { installJourneyWallet } from './journey-fixtures';

/**
 * Selected (FLOFI_USER_FUNDED_E2E), this proof runs or FAILS: a missing or empty prerequisite (e.g. an inherited empty session secret, which
 * the config's `??=` keeps) is never a skip that the guarded runner, judging a profile by its exit code, would count as a PASS. Not selected,
 * it is skipped. Only the names of what is missing are reported, never a value.
 */
const SELECTED = process.env.FLOFI_USER_FUNDED_E2E === 'MOCKED_LOOPBACK_ONLY';
const PREREQUISITES: Readonly<Record<string, string | null>> = { GRYLOO_BASE_MAINNET_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_WORKFLOW_RUNS: 'enabled',
  FLOFI_E2E_SESSION_SECRET: null, FLOFI_E2E_DATABASE_URL: null };
const MISSING = Object.entries(PREREQUISITES).filter(([name, value]) => value === null ? !process.env[name]?.trim() : process.env[name] !== value).map(([name]) => name);
if (SELECTED && MISSING.length) throw new Error(`USER_FUNDED_E2E_PREREQUISITE_MISSING: ${MISSING.join(', ')}`);
test.skip(!SELECTED, 'Runs only in the MOCKED user-funded profile (FLOFI_USER_FUNDED_E2E=MOCKED_LOOPBACK_ONLY)');
test.setTimeout(240_000);

const BASE = '0x2105', CHAIN_HARNESS = 'https://127.0.0.1:8567', BASE_HARNESS = 'http://127.0.0.1:8562';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', BASE_WETH = '0x4200000000000000000000000000000000000006';
type SentBatch = { version: string; id?: string; chainId: string; from: string; atomicRequired: boolean; calls: { to: string; data: string; value: string }[]; capabilities?: unknown };

let api: APIRequestContext | null = null;
test.afterAll(async () => { await api?.dispose(); api = null; });
/** The chain double's test-only control (loopback only); its per-run certificate is self-signed, as for the other loopback harnesses. */
async function control<T>(method: string, params: unknown[] = []): Promise<T> {
  api ??= await apiRequest.newContext({ ignoreHTTPSErrors: true });
  const response = await api.post(`${CHAIN_HARNESS}/control`, { data: { jsonrpc: '2.0', id: 1, method, params } });
  expect(response.ok()).toBe(true);
  const value = await response.json() as { result?: T; error?: { message: string } };
  if (value.error) throw new Error(value.error.message);
  return value.result as T;
}
async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  try { return (await db.query(sql, params)).rows as T[]; } finally { await db.close(); }
}
/** A FloFi account holding the test wallet, signed in through the account store as an email sign-in leaves it. */
async function signedIn(page: Page, wallet: string) {
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  try {
    const store = createAccountStore(db, 'default');
    const session = await store.signIn({ kind: 'email', subject: `wallet-batch-${Date.now()}@flofi-e2e.test`, label: null });
    await store.setOnboarding(session.accountId, 'completed');
    await store.saveWallet(session.accountId, { ecosystem: 'evm', address: wallet, origin: 'external', provider: 'io.metamask', providerName: 'MetaMask',
      providerResource: null, label: 'MetaMask' });
    await page.context().addCookies([{ name: ACCOUNT_SESSION_COOKIE, url: APP_ORIGIN, httpOnly: true, sameSite: 'Lax',
      value: sealAccountSession({ FLOFI_SESSION_SECRET: process.env.FLOFI_E2E_SESSION_SECRET! }, session, new URL(APP_ORIGIN).host, new Date()) }]);
  } finally { await db.close(); }
}
/**
 * The owner's EIP-5792 wallet: it reports atomic batching on Base, and for `wallet_sendCalls` it does what MetaMask does with an EIP-7702 account —
 * executes exactly the requested calls as ONE transaction from the owner's own account (here on the MOCKED chain) and answers the batch id; it
 * honours the app-provided id (a second request with it is refused 5720) and reports the receipts through `wallet_getCallsStatus`.
 * Every request is logged in the test process, across reloads.
 */
async function installBatchWallet(page: Page, owner: string) {
  const methods: string[] = [], sent: SentBatch[] = [];
  const batches = new Map<string, { hash: string }>();
  await page.exposeFunction('flofiBatchWallet', async (method: string, params: unknown[]) => {
    methods.push(method);
    if (method === 'wallet_getCapabilities') return { result: { [BASE]: { atomic: { status: 'supported' } } } };
    if (method === 'wallet_sendCalls') {
      const request = params[0] as SentBatch;
      sent.push(request);
      if (request.id && batches.has(request.id)) return { error: { code: 5720, message: 'Duplicate id' } };
      if (request.chainId !== BASE || request.from.toLowerCase() !== owner || request.atomicRequired !== true) return { error: { code: 5700, message: 'Unsupported request' } };
      const hash = await control<string>('MOCK_walletBatch', [owner, request.calls]);
      const id = request.id ?? `0x${'b'.repeat(64)}`;
      batches.set(id, { hash });
      return { result: { id } };
    }
    if (method === 'wallet_getCallsStatus') {
      const batch = batches.get(String(params[0]));
      if (!batch) return { error: { code: 5730, message: 'Unknown bundle id' } };
      const receipt = await control<{ status: number; blockNumber: number }>('MOCK_receipt', [batch.hash]);
      return { result: { version: '2.0.0', id: params[0], chainId: BASE, atomic: true, status: 200,
        receipts: [{ transactionHash: batch.hash, status: receipt.status === 1 ? '0x1' : '0x0', blockNumber: '0x' + receipt.blockNumber.toString(16), gasUsed: '0x30d40', logs: [] }] } };
    }
    return { passthrough: true };
  });
  await page.addInitScript(() => {
    type Answer = { result?: unknown; error?: { code: number; message: string }; passthrough?: boolean };
    const w = window as unknown as { ethereum: { request: (input: { method: string; params?: unknown[] }) => Promise<unknown> };
      flofiBatchWallet: (method: string, params: unknown[]) => Promise<Answer> };
    const request = w.ethereum.request;
    w.ethereum.request = async input => {
      const answer = await w.flofiBatchWallet(input.method, input.params ?? []);
      if (answer.passthrough) return request(input);
      if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
      return answer.result;
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { provider: w.ethereum, info: { rdns: 'io.metamask', name: 'MetaMask', uuid: 'wallet-batch-metamask' } } })));
  });
  return { methods, sent };
}
/** One command of the Canvas's own grammar; it adds exactly one card (`label`) to the workflow. */
async function say(page: Page, text: string, label: string) {
  const cards = page.locator('.build-flow-surface .composer-card'), before = await cards.count();
  await page.locator('#mock-prompt').fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(cards).toHaveCount(before + 1, { timeout: 20_000 });
  await expect(cards.nth(before)).toContainText(label);
}
const panel = (page: Page) => page.getByRole('region', { name: 'Whole workflow', exact: true });

test('Swap → Supply → Borrow on Base: the Editor asks the wallet for ONE wallet_sendCalls batch, reconciles it, and never sends it again', async ({ page, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const wallet = createTestWallet(), owner = wallet.address.toLowerCase();
  const response = await fetch(`${BASE_HARNESS}/__harness/chain`, { method: 'POST', body: JSON.stringify({ action: 'reset' }) });
  expect(response.ok).toBe(true);
  await control('MOCK_reset', [owner, '10000000', '100000000000000000']);
  await installJourneyWallet(page, [wallet], { chain: BASE, transactionControl: async () => { throw Error('FINANCIAL_REQUEST_FORBIDDEN'); } });
  const log = await installBatchWallet(page, owner);
  await signedIn(page, owner);
  await openBuilder(page);
  // The Canvas's own command grammar (deterministic, no Copilot): the Supply is funded by the swap's WETH; the beneficiary is the connected wallet.
  await say(page, 'swap 3 USDC to WETH on Base slippage 50 bps', 'Swap');
  await say(page, 'supply 0.0013 WETH to Aave on Base', 'Supply');
  await say(page, 'borrow 0.8 USDC on Base', 'Borrow');
  await expect(page.locator('.build-flow-surface .composer-card').nth(1)).toContainText(/Funded by step 1/);
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(3);

  // Review: read-only. The wallet is asked what it can do (no prompt) and nothing else.
  await openEditorSection(page, 'Execute');
  await panel(page).getByRole('button', { name: 'Review whole workflow', exact: true }).click();
  await expect(panel(page).locator('.editor-run-mechanism')).toBeVisible({ timeout: 60_000 });
  await expect(panel(page).locator('.editor-run-mechanism')).toHaveAttribute('data-mode', 'ONE_WALLET_CONFIRMATION', { timeout: 60_000 });
  await expect(panel(page)).toContainText('5 calls in the batch (2 token approvals)');
  await expect(panel(page)).toContainText('(FloFi requires at least 2.00)');
  expect(log.methods).toContain('wallet_getCapabilities');
  expect(log.sent).toEqual([]);

  // Authorize: the sign-in proof, then exactly ONE wallet_sendCalls carrying the prepared atomic batch.
  await panel(page).getByRole('button', { name: 'Authorize workflow', exact: true }).click();
  await expect(panel(page)).toContainText('Every step reconciled.', { timeout: 90_000 });
  expect(log.sent).toHaveLength(1);
  const batch = log.sent[0]!;
  expect(batch).toMatchObject({ version: '2.0.0', chainId: BASE, from: owner, atomicRequired: true });
  expect(batch.id).toMatch(/^0x[0-9a-f]{64}$/);
  expect(batch).not.toHaveProperty('capabilities');
  const router = batch.calls[1]!.to;
  expect(batch.calls.map(c => [c.to, c.data.slice(0, 10), c.value])).toEqual([
    [BASE_USDC, '0x095ea7b3', '0x0'], [router, '0x5ae401dc', '0x0'], [BASE_WETH, '0x095ea7b3', '0x0'], [batch.calls[3]!.to, '0x617ba037', '0x0'],
    [batch.calls[3]!.to, '0xa415bcad', '0x0']]);
  // The calls the wallet received are exactly the ones FloFi prepared and stored for the run's group.
  const [group] = await query<{ request: SentBatch; state: string }>(`SELECT prepared->'request' AS request, state FROM workflow_run_groups ORDER BY created_at DESC LIMIT 1`);
  expect(group!.state).toBe('RECONCILED');
  expect(group!.request.calls).toEqual(batch.calls);
  expect(group!.request.id).toBe(batch.id);
  // One atomic transaction on the chain, from the owner's own account; the owner's Aave health factor stays at least 2.0.
  expect(await control<number>('MOCK_batches')).toBe(1);
  expect(BigInt((await control<{ hf: string }>('MOCK_accountData', [owner])).hf)).toBeGreaterThanOrEqual(2n * 10n ** 18n);
  const [run] = await query<{ state: string; mode: string }>(`SELECT state, mode FROM workflow_runs ORDER BY created_at DESC LIMIT 1`);
  expect(run).toEqual({ state: 'COMPLETED', mode: 'USER_FUNDED' });

  // Reload: P0 hotfix (execution continuity) — the Canvas keeps its workflow id across the reload (`domain/editor-persistence.ts`), so the run
  // is THIS workflow's own (never offered as an earlier visit's run). Its progress is loaded only by the owner's click (the read may need the
  // session's wallet sign-in; never a send). It must be loaded, and show its result read from FloFi, before anything below is asserted: a
  // check made before the run loads would pass even if the recovered run sent the batch again.
  await page.reload();
  await openEditorSection(page, 'Execute');
  const load = panel(page).getByRole('button', { name: 'Load workflow progress', exact: true });
  await expect(load).toBeVisible({ timeout: 30_000 });
  await expect(panel(page).getByRole('button', { name: 'Show its progress', exact: true })).toHaveCount(0);
  await expect(panel(page)).not.toContainText('Every step reconciled.');
  await load.click();
  await expect(panel(page)).toHaveAttribute('data-run-state', 'COMPLETED', { timeout: 60_000 });
  await expect(panel(page)).toContainText('Every step reconciled.');
  await expect(panel(page).getByRole('button', { name: 'Authorize workflow', exact: true })).toHaveCount(0);
  // Settled: a finished run, once shown, has nothing left to do (no automatic recovery or status poll applies to a COMPLETED run). For 5 more
  // seconds the wallet must never be asked to send again (even a duplicate the wallet refuses is logged), and the chain still holds exactly
  // the one batch. (Reading back a batch the wallet holds after a reload is covered by the unit tests of the Editor's recovery.)
  const settledFrom = Date.now();
  await expect.poll(() => log.sent.length !== 1 ? `SENT ${log.sent.length}` : Date.now() - settledFrom < 5_000 ? 'SETTLING' : 'SETTLED',
    { timeout: 15_000, intervals: [250] }).toBe('SETTLED');
  expect(log.sent).toHaveLength(1);
  expect(log.methods.filter(m => m === 'eth_sendTransaction' || m === 'eth_sendRawTransaction')).toEqual([]);
  expect(await control<number>('MOCK_batches')).toBe(1);
  expect(errors).toEqual([]);
  networkGuard.assertClean();
});
