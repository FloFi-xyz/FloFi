// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 — local visual evidence only (never part of a certification profile): the approved references' scenario
 * (a two-step Swap → Send workflow) captured on Create, Simulate (before and after the simulation) and Execute (valid and expired Review), at the
 * references' desktop viewport and on a phone. MOCKED loopback only (the Base authoring harness); the wallet double answers capabilities only and any
 * request that would ask the owner for anything fails the test. Nothing is signed or sent.
 *
 *   FLOFI_UX_EVIDENCE_DIR=<dir> [FLOFI_UX_EVIDENCE_LANG=PT] [CAP_W=1815 CAP_H=866] in the editor-wallet-batch profile environment.
 */
import { request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { createAccountStore } from '../src/accounts/account-store';
import { ACCOUNT_SESSION_COOKIE, sealAccountSession } from '../src/accounts/account-session';
import { APP_ORIGIN, chooseLanguage } from './app-origin';
import { editorStep, expectEditorSection, openBuilder } from './build-entry-navigation';
import { expect, test } from './fixtures';
import { installJourneyWallet } from './journey-fixtures';

const SELECTED = process.env.FLOFI_USER_FUNDED_E2E === 'MOCKED_LOOPBACK_ONLY';
const PREREQUISITES: Readonly<Record<string, string | null>> = { GRYLOO_BASE_MAINNET_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_WORKFLOW_RUNS: 'enabled',
  FLOFI_E2E_SESSION_SECRET: null, FLOFI_E2E_DATABASE_URL: null };
const MISSING = Object.entries(PREREQUISITES).filter(([name, value]) => value === null ? !process.env[name]?.trim() : process.env[name] !== value).map(([name]) => name);
if (SELECTED && MISSING.length) throw new Error(`EDITOR_STAGES_E2E_PREREQUISITE_MISSING: ${MISSING.join(', ')}`);
test.skip(!SELECTED || !process.env.FLOFI_UX_EVIDENCE_DIR, 'Local evidence only: the MOCKED user-funded profile with FLOFI_UX_EVIDENCE_DIR set');
test.setTimeout(240_000);

const BASE = '0x2105', BASE_HARNESS = 'http://127.0.0.1:8562', CHAIN_HARNESS = 'https://127.0.0.1:8567';
const PT = process.env.FLOFI_UX_EVIDENCE_LANG === 'PT';
/** The few visible words this proof reads, in the interface language it runs in. */
const W = PT ? { simulate: 'Simular fluxo', review: 'Continuar para autorização', authorizing: 'Confira sua operação', authorize: 'Executar fluxo', validFor: /Revisão válida por \d+:\d\d/,
  expired: 'Sua revisão expirou', refreshFee: 'Precisa ser atualizada', refreshPermission: 'Depende da revisão atualizada', reviewExpired: 'Revisão expirada',
  refresh: 'Atualizar revisão', executeClosed: /Simule o fluxo primeiro/, simulateClosed: /Adicione uma ação ao seu fluxo primeiro/, operate: 'Operar', areas: 'Áreas do produto',
  assistant: 'Sua revisão expirou. Atualize os valores', result: 'Resultado da simulação', swap: /Trocar\s*3 USDC → (≈ )?[\d.,]+ WETH/, card: ['Trocar', 'Depositar', 'Pedir emprestado'] }
  : { simulate: 'Simulate workflow', review: 'Continue to authorization', authorizing: 'Check your operation', authorize: 'Execute workflow', validFor: /Review valid for \d+:\d\d/,
  expired: 'Your review expired', refreshFee: 'Needs to be refreshed', refreshPermission: 'Depends on the updated review', reviewExpired: 'Review expired',
  refresh: 'Refresh review', executeClosed: /Simulate the workflow first/, simulateClosed: /Add an action to your workflow first/, operate: 'Operate', areas: 'Product areas',
  assistant: 'Your review expired. Refresh the values', result: 'Simulation result', swap: /Swap\s*3 USDC → (≈ )?[\d.,]+ WETH/, card: ['Swap', 'Supply', 'Borrow'] };

let api: APIRequestContext | null = null;
test.afterAll(async () => { await api?.dispose(); api = null; });
/** The MOCKED chain double's test-only control (loopback only; its per-run certificate is self-signed, as for the other loopback harnesses). */
async function control<T>(method: string, params: unknown[] = []): Promise<T> {
  api ??= await apiRequest.newContext({ ignoreHTTPSErrors: true });
  const response = await api.post(`${CHAIN_HARNESS}/control`, { data: { jsonrpc: '2.0', id: 1, method, params } });
  expect(response.ok()).toBe(true);
  const value = await response.json() as { result?: T; error?: { message: string } };
  if (value.error) throw new Error(value.error.message);
  return value.result as T;
}
async function signedIn(page: Page, wallet: string) {
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  try {
    const store = createAccountStore(db, 'default');
    const session = await store.signIn({ kind: 'email', subject: `editor-stages-${Date.now()}@flofi-e2e.test`, label: null });
    await store.setOnboarding(session.accountId, 'completed');
    await store.saveWallet(session.accountId, { ecosystem: 'evm', address: wallet, origin: 'external', provider: 'io.metamask', providerName: 'MetaMask',
      providerResource: null, label: 'MetaMask' });
    await page.context().addCookies([{ name: ACCOUNT_SESSION_COOKIE, url: APP_ORIGIN, httpOnly: true, sameSite: 'Lax',
      value: sealAccountSession({ FLOFI_SESSION_SECRET: process.env.FLOFI_E2E_SESSION_SECRET! }, session, new URL(APP_ORIGIN).host, new Date()) }]);
  } finally { await db.close(); }
}
/** The owner's EIP-5792 wallet as far as a Review needs it: it reports atomic batching on Base. Every other request is logged. */
async function installCapabilitiesWallet(page: Page) {
  const methods: string[] = [];
  await page.exposeFunction('flofiStagesWallet', async (method: string) => {
    methods.push(method);
    return method === 'wallet_getCapabilities' ? { result: { [BASE]: { atomic: { status: 'supported' } } } } : { passthrough: true };
  });
  await page.addInitScript(() => {
    const w = window as unknown as { ethereum: { request: (input: { method: string; params?: unknown[] }) => Promise<unknown> };
      flofiStagesWallet: (method: string) => Promise<{ result?: unknown; passthrough?: boolean }> };
    const request = w.ethereum.request;
    w.ethereum.request = async input => { const answer = await w.flofiStagesWallet(input.method); return answer.passthrough ? request(input) : answer.result; };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { provider: w.ethereum, info: { rdns: 'io.metamask', name: 'MetaMask', uuid: 'editor-stages-metamask' } } })));
  });
  return methods;
}
async function say(page: Page, text: string, label: string) {
  const cards = page.locator('.build-flow-surface .composer-card'), before = await cards.count();
  await page.locator('#mock-prompt').fill(text);
  await page.locator('.chat-form button[type=submit]').click();
  await expect(cards).toHaveCount(before + 1, { timeout: 20_000 });
  await expect(cards.nth(before)).toContainText(label);
}
const footer = (page: Page) => page.locator('footer.summary-bar');


const VIEW = { width: Number(process.env.CAP_W ?? 1815), height: Number(process.env.CAP_H ?? 866) };
/** BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002: the visible Technical details opened (viewport and whole page, so a page that grows shows it), then closed. */
async function snapDetails(page: Page, name: string) {
  const details = page.locator('main details.review-panel-technical:visible').first();
  await details.locator('> summary').click();
  await expect(details).toHaveAttribute('open', '');
  await page.waitForTimeout(500);
  const dir = process.env.FLOFI_UX_EVIDENCE_DIR!; mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/${name}.png` });
  await page.screenshot({ path: `${dir}/${name}-page.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/${name}-mobile.png`, fullPage: true });
  await page.setViewportSize(VIEW); await page.waitForTimeout(300);
  await details.locator('> summary').click();
  await expect(details).not.toHaveAttribute('open', '');
  await page.evaluate(() => window.scrollTo(0, 0));
}
async function snap(page: Page, name: string) {
  const dir = process.env.FLOFI_UX_EVIDENCE_DIR!; mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/${name}.png` });
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/${name}-mobile.png`, fullPage: true });
  await page.setViewportSize(VIEW); await page.waitForTimeout(300);
}
test('evidence: Create → Simulate → Execute (valid, expired) on the references\' two-step workflow', async ({ page }) => {
  test.setTimeout(300_000);
  const wallet = createTestWallet(), owner = wallet.address.toLowerCase();
  const response = await fetch(`${BASE_HARNESS}/__harness/chain`, { method: 'POST', body: JSON.stringify({ action: 'reset' }) });
  expect(response.ok).toBe(true);
  await control('MOCK_reset', [owner, '10000000', '100000000000000000']);
  await installJourneyWallet(page, [wallet], { chain: BASE, transactionControl: async () => { throw Error('FINANCIAL_REQUEST_FORBIDDEN'); } });
  await installCapabilitiesWallet(page);
  await signedIn(page, owner);
  if (PT) await chooseLanguage(page.context(), 'PT');
  await page.clock.install();
  await page.setViewportSize(VIEW);
  await openBuilder(page);
  await snap(page, 'create-empty');
  await say(page, process.env.CAP_STEP1 ?? 'swap 3 USDC to WETH on Base slippage 50 bps', W.card[0]!);
  if (process.env.CAP_STEP2 !== 'none') await say(page, process.env.CAP_STEP2 ?? 'send 0.0008 WETH on Base to 0x282091e22697dd3434ad1847fc830e1eff912edc', PT ? 'Enviar' : 'Send');
  await snap(page, 'create-populated');
  await editorStep(page, 'Simulate').click();
  await expectEditorSection(page, 'Simulate');
  await snap(page, 'simulate-awaiting');
  const simulation = page.locator('.simulation-context-panel');
  await simulation.getByRole('button', { name: W.simulate, exact: true }).click();
  await expect(simulation).toHaveAttribute('data-review-state', 'ready', { timeout: 60_000 });
  const reviewSeenAt = Date.now();
  await snap(page, 'simulate-result');
  await snapDetails(page, 'simulate-result-details');
  await page.locator('.simulation-context-panel').getByRole('button', { name: W.review, exact: true }).click();
  await expectEditorSection(page, 'Execute');
  await expect(footer(page).getByRole('button', { name: W.authorize, exact: true })).toBeEnabled({ timeout: 60_000 });
  await snap(page, 'execute-valid');
  await snapDetails(page, 'execute-valid-details');
  await page.waitForTimeout(Math.max(0, reviewSeenAt + 15_000 - Date.now()));
  const left = /(\d+):(\d\d)/.exec(W.validFor.exec(await footer(page).innerText())?.[0] ?? '');
  await page.clock.fastForward((Number(left![1]) * 60 + Number(left![2])) * 1000 + 2_000);
  await expect(page.getByRole('button', { name: W.authorize, exact: true })).toHaveCount(0);
  await snap(page, 'execute-expired');
  await snapDetails(page, 'execute-expired-details');
});
