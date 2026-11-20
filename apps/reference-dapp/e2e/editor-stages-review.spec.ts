// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio's approved UX, references A2 / B2 / C1 / C2) on the Editor's whole-workflow path:
 *
 *   Create (stage indicator in the Editor header, Execute closed until a simulation exists, no authorization copy) → "Simulate workflow" runs the
 *   read-only whole-workflow Review IN Simulate, whose panel states the result with no authorization copy and no Authorize control → the footer's
 *   "Review operation" opens Execute → the valid Review (C1: "Review before authorizing", "Authorize workflow" in the footer, once) → its validity passes
 *   (client clock only) → C2: "Your review expired", the fee and permission marked as needing a refreshed Review, no Authorize, "Refresh review"
 *   as the one action, the Assistant's local note → "Refresh review" prepares a fresh Review in place → Authorize is offered again.
 *
 * Nothing is authorized: the wallet double answers `wallet_getCapabilities` only and any request that would ask the owner for anything fails the
 * test. MOCKED loopback only (the Base authoring harness, disposable PostgreSQL); nothing reaches a public network or is signed.
 *
 * Local evidence only: FLOFI_UX_EVIDENCE_DIR saves screenshots of each state and FLOFI_UX_EVIDENCE_LANG=PT runs it in Portuguese. Neither is set in CI.
 */
import { request as apiRequest, type APIRequestContext, type Page, type Request } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { createAccountStore } from '../src/accounts/account-store';
import { ACCOUNT_SESSION_COOKIE, sealAccountSession } from '../src/accounts/account-session';
import { APP_ORIGIN, chooseLanguage } from './app-origin';
import { editorSectionAction, editorStep, editorSteps, expectEditorSection, openBuilder } from './build-entry-navigation';
import { expect, test } from './fixtures';
import { installJourneyWallet } from './journey-fixtures';

const SELECTED = process.env.FLOFI_USER_FUNDED_E2E === 'MOCKED_LOOPBACK_ONLY';
const PREREQUISITES: Readonly<Record<string, string | null>> = { GRYLOO_BASE_MAINNET_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_WORKFLOW_RUNS: 'enabled',
  FLOFI_E2E_SESSION_SECRET: null, FLOFI_E2E_DATABASE_URL: null };
const MISSING = Object.entries(PREREQUISITES).filter(([name, value]) => value === null ? !process.env[name]?.trim() : process.env[name] !== value).map(([name]) => name);
if (SELECTED && MISSING.length) throw new Error(`EDITOR_STAGES_E2E_PREREQUISITE_MISSING: ${MISSING.join(', ')}`);
test.skip(!SELECTED, 'Runs only in the MOCKED user-funded profile (FLOFI_USER_FUNDED_E2E=MOCKED_LOOPBACK_ONLY)');
test.setTimeout(240_000);

const BASE = '0x2105', BASE_HARNESS = 'http://127.0.0.1:8562', CHAIN_HARNESS = 'https://127.0.0.1:8567';
const PT = process.env.FLOFI_UX_EVIDENCE_LANG === 'PT';
const EVIDENCE = process.env.FLOFI_UX_EVIDENCE_DIR ?? null;
/** The few visible words this proof reads, in the interface language it runs in. */
const W = PT ? { simulate: 'Simular fluxo', review: 'Revisar operação', authorizing: 'Revise antes de autorizar', authorize: 'Autorizar fluxo', validFor: /Revisão válida por \d+:\d\d/,
  expired: 'Sua revisão expirou', refreshFee: 'Precisa ser atualizada', refreshPermission: 'Depende da revisão atualizada', reviewExpired: 'Revisão expirada',
  refresh: 'Atualizar revisão', executeClosed: /Simule o fluxo primeiro/, simulateClosed: /Adicione uma ação ao seu fluxo primeiro/, operate: 'Operar', areas: 'Áreas do produto',
  assistant: 'Sua revisão expirou. Atualize os valores', result: 'Resultado da simulação', swap: /Trocar 3 USDC → WETH · Base/, card: ['Trocar', 'Depositar', 'Pedir emprestado'] }
  : { simulate: 'Simulate workflow', review: 'Review operation', authorizing: 'Review before authorizing', authorize: 'Authorize workflow', validFor: /Review valid for \d+:\d\d/,
  expired: 'Your review expired', refreshFee: 'Needs to be refreshed', refreshPermission: 'Depends on the updated review', reviewExpired: 'Review expired',
  refresh: 'Refresh review', executeClosed: /Simulate the workflow first/, simulateClosed: /Add an action to your workflow first/, operate: 'Operate', areas: 'Product areas',
  assistant: 'Your review expired. Refresh the values', result: 'Simulation result', swap: /Swap 3 USDC → WETH · Base/, card: ['Swap', 'Supply', 'Borrow'] };
/** Wallet methods that would ask the owner for anything (a signature, a transaction, a network or permission change). */
const ASKING = /^(personal_sign|eth_sign|eth_signTypedData.*|eth_sendTransaction|eth_sendRawTransaction|wallet_sendCalls|wallet_switchEthereumChain|wallet_addEthereumChain|wallet_requestPermissions)$/;

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
async function evidence(page: Page, name: string) {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}/${PT ? 'pt' : 'en'}-${name}.png` });
}
const footer = (page: Page) => page.locator('footer.summary-bar');
/** BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (approved references): on a desktop viewport the Editor fits it; the Canvas and the Assistant end above
 * the sticky footer and the page itself does not scroll. BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002: the docked panel scrolls inside its frame, so a
 * three-step Review and an opened "Technical details" fit too. */
async function fitsViewport(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0);
}
const runPanel = (page: Page) => page.locator('.editor-workflow-run.editor-review-block');

test('Create → Simulate → Execute: simulated in Simulate, authorized only from Execute, an expired Review must be refreshed; the wallet is never asked', async ({ page, networkGuard }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const wallet = createTestWallet(), owner = wallet.address.toLowerCase();
  const response = await fetch(`${BASE_HARNESS}/__harness/chain`, { method: 'POST', body: JSON.stringify({ action: 'reset' }) });
  expect(response.ok).toBe(true);
  await control('MOCK_reset', [owner, '10000000', '100000000000000000']);
  await installJourneyWallet(page, [wallet], { chain: BASE, transactionControl: async () => { throw Error('FINANCIAL_REQUEST_FORBIDDEN'); } });
  const methods = await installCapabilitiesWallet(page);
  await signedIn(page, owner);
  if (PT) await chooseLanguage(page.context(), 'PT');
  // The client clock flows normally; it is moved forward only to let the Review's own validity pass (C2).
  await page.clock.install();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page);

  // Global navigation: product areas, Operate current; the stage indicator lives in the Editor header, never in the top bar.
  await expect(page.getByRole('navigation', { name: W.areas, exact: true }).getByRole('link', { name: W.operate, exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('header.top-bar').getByRole('navigation', { name: /^(Editor steps|Etapas do editor)$/ })).toHaveCount(0);
  await expect(page.locator('.canvas-head .canvas-head-stages').getByRole('navigation', { name: /^(Editor steps|Etapas do editor)$/ })).toBeVisible();
  // Create, empty: the future stages are closed and say why.
  await expect(editorSectionAction(page, 'Simulate')).toHaveAccessibleName(W.simulateClosed);
  // BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (approved reference "Criar"): the creation tools are ONE docked row of named tools under the Editor
  // header (Create only), and the workflow's state is a discreet dot and words beside the step count (no pill).
  const tools = page.locator('.build-canvas-head .canvas-toolbar-row').getByRole('toolbar', { name: /^(Canvas tools|Ferramentas do Canvas)$/ });
  await expect(tools).toBeVisible();
  await expect(tools.locator('.canvas-rail-label').first()).toBeVisible();
  await expect(page.locator('.build-flow-surface .floating-toolbox')).toHaveCount(0);
  expect(await page.locator('.build-canvas-head .editor-state-pill').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  // Pressing a closed stage says why (no hover needed) and opens nothing; Escape dismisses it (forced past Playwright's aria-disabled check).
  await editorSectionAction(page, 'Simulate').click({ force: true });
  await expect(editorSteps(page).getByRole('status')).toHaveText(W.simulateClosed);
  await expectEditorSection(page, 'Build');
  await page.keyboard.press('Escape');
  await expect(editorSteps(page).getByRole('status')).toHaveCount(0);
  await fitsViewport(page);
  await evidence(page, 'create-empty');
  await say(page, 'swap 3 USDC to WETH on Base slippage 50 bps', W.card[0]!);
  await say(page, 'supply 0.0013 WETH to Aave on Base', W.card[1]!);
  // The approved references' size (two steps): Simulate before a result fits the desktop viewport too. Opening it simulates and requests nothing.
  await editorStep(page, 'Simulate').click();
  await expectEditorSection(page, 'Simulate');
  await expect(page.locator('.simulation-context-panel')).toHaveAttribute('data-review-state', 'pending');
  await fitsViewport(page);
  await editorStep(page, 'Build').click();
  await expectEditorSection(page, 'Build');
  await say(page, 'borrow 0.8 USDC on Base', W.card[2]!);
  await expect(editorSectionAction(page, 'Simulate')).not.toHaveAttribute('aria-disabled', 'true');
  // A reason is never left on screen for a stage that has since opened.
  await expect(editorSteps(page).getByRole('status')).toHaveCount(0);
  await expect(editorSectionAction(page, 'Execute')).toHaveAccessibleName(W.executeClosed);
  // No authorization copy on Create; its one primary action is the footer's Simulate.
  await expect(page.locator('main')).not.toContainText(W.authorizing);
  await expect(footer(page).locator('.canvas-primary-action').getByRole('button', { name: W.simulate, exact: true })).toBeEnabled();
  await fitsViewport(page);
  await evidence(page, 'create-populated');

  // Simulate before a simulation (B2): the stage indicator opens it; its panel lists the operations and holds the ONE primary action, and the
  // footer's "Review operation" stays closed until a valid result. Nothing is simulated or requested by opening it.
  await editorStep(page, 'Simulate').click();
  await expectEditorSection(page, 'Simulate');
  const simulation = page.locator('.simulation-context-panel');
  await expect(simulation).toHaveAttribute('data-review-state', 'pending');
  await expect(simulation.getByRole('button', { name: W.simulate, exact: true })).toBeEnabled();
  await expect(page.locator('main, .summary-bar').getByRole('button', { name: W.simulate, exact: true })).toHaveCount(1);
  await expect(footer(page).getByRole('button', { name: W.review, exact: true })).toBeDisabled();
  await expect(page.locator('main')).not.toContainText(W.authorizing);
  // BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (approved reference "Simular"): networks read as names (no chain number), the technical details are one
  // collapsed row (the chain identifiers live there), and Simulate has no creation tools.
  for (const chip of await simulation.locator('.operation-summary-chip').allInnerTexts()) expect(chip).not.toMatch(/\(\d+\)/);
  const simulateTechnical = simulation.locator('details.review-panel-technical');
  await expect(simulateTechnical).toHaveCount(1); await expect(simulateTechnical).not.toHaveAttribute('open', '');
  await expect(page.getByRole('toolbar', { name: /^(Canvas tools|Ferramentas do Canvas)$/ })).toHaveCount(0);
  await simulateTechnical.locator('> summary').click();
  await expect(simulateTechnical).toContainText('eip155:8453');
  await simulateTechnical.locator('> summary').click();
  await fitsViewport(page);
  await evidence(page, 'simulate-awaiting');
  await editorStep(page, 'Build').click();
  await expectEditorSection(page, 'Build');

  // Simulate (B2): the whole-workflow Review is the simulation; it runs here, and its result has no authorization copy and no Authorize control.
  await footer(page).locator('.canvas-primary-action').getByRole('button', { name: W.simulate, exact: true }).click();
  await expectEditorSection(page, 'Simulate');
  await expect(simulation).toHaveAttribute('data-review-state', 'ready', { timeout: 60_000 });
  const reviewSeenAt = Date.now();
  await expect(simulation.getByRole('heading', { name: W.result, exact: true })).toBeVisible();
  await expect(simulation.getByRole('list').first()).toContainText(W.swap);
  await expect(page.locator('main')).not.toContainText(W.authorizing);
  await expect(page.getByRole('button', { name: W.authorize, exact: true })).toHaveCount(0);
  // Simulate has no creation toolbar; the stage indicator marks Simulate.
  await expect(page.getByRole('toolbar', { name: /^(Canvas tools|Ferramentas do Canvas)$/ })).toHaveCount(0);
  const reviewOperation = footer(page).getByRole('button', { name: W.review, exact: true });
  await expect(reviewOperation).toBeEnabled();
  await fitsViewport(page);
  await evidence(page, 'simulate-result');
  expect(methods.filter(method => ASKING.test(method))).toEqual([]);

  // Execute (C1): the valid Review the owner would authorize; ONE Authorize, in the footer, with the Review's validity beside it.
  await reviewOperation.click();
  await expectEditorSection(page, 'Execute');
  await expect(runPanel(page).getByRole('heading', { name: W.authorizing, exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('main, .summary-bar').getByRole('button', { name: W.authorize, exact: true })).toHaveCount(1);
  await expect(footer(page).getByRole('button', { name: W.authorize, exact: true })).toBeEnabled();
  await expect(footer(page)).toContainText(W.validFor);
  await evidence(page, 'execute-valid');

  // BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002 (TEC-01, TEC-02): "Technical details" is collapsed by default; opened, it is a few labelled groups in a
  // bounded area inside the panel — the page does not grow, the one primary action stays on screen, and opening or closing it requests nothing
  // (no server action, no wallet request). The material rows stay visible above it.
  const validTechnical = runPanel(page).locator('details.review-panel-technical');
  await expect(validTechnical).toHaveCount(1); await expect(validTechnical).not.toHaveAttribute('open', '');
  for (const row of PT ? ['Taxa de rede, no máximo', 'Permissão de token', 'Pedidos à carteira'] : ['Network fee, at most', 'Token permission', 'Wallet requests'])
    await expect(runPanel(page).locator('.review-block-rows')).toContainText(row);
  const actions: string[] = [];
  const recordAction = (request: Request) => { if (request.method() === 'POST' && request.headers()['next-action']) actions.push(request.url()); };
  page.on('request', recordAction);
  await validTechnical.locator('> summary').click();
  await expect(validTechnical).toHaveAttribute('open', '');
  const technicalBody = validTechnical.locator('> .technical-body');
  for (const group of PT ? ['Operações', 'Valores e limites', 'Taxas e permissões', 'Solicitações à carteira', 'Identificadores e evidências']
    : ['Operations', 'Amounts and limits', 'Fees and permissions', 'Requests to your wallet', 'Identifiers and evidence'])
    await expect(technicalBody.getByRole('region', { name: group, exact: true })).toHaveCount(1);
  expect(await technicalBody.evaluate(element => element.clientHeight)).toBeLessThanOrEqual(400);
  await fitsViewport(page);
  await expect(footer(page).getByRole('button', { name: W.authorize, exact: true })).toBeInViewport();
  await expect(page.locator('main, .summary-bar').getByRole('button', { name: W.authorize, exact: true })).toHaveCount(1);
  await validTechnical.locator('> summary').click();
  await expect(validTechnical).not.toHaveAttribute('open', '');
  await page.waitForTimeout(300);
  page.off('request', recordAction);
  expect(actions).toEqual([]);

  // C2: the Review's validity passes (client clock only). The client clock is never rewound (the footer never reads an expired Review as valid
  // again), so real time first passes since the server dated this Review; the clock then moves just past its validity (the footer's countdown).
  // The refreshed Review, dated later by the server, is then valid against the client clock for at least that real interval.
  await page.waitForTimeout(Math.max(0, reviewSeenAt + 15_000 - Date.now()));
  const left = /(\d+):(\d\d)/.exec(W.validFor.exec(await footer(page).innerText())?.[0] ?? '');
  expect(left, 'the footer counts the Review validity down').not.toBeNull();
  await page.clock.fastForward((Number(left![1]) * 60 + Number(left![2])) * 1000 + 2_000);
  await expect(runPanel(page).getByRole('alert').filter({ hasText: W.expired })).toBeVisible();
  await expect(runPanel(page)).toContainText(W.refreshFee);
  await expect(runPanel(page)).toContainText(W.refreshPermission);
  await expect(runPanel(page).getByRole('heading', { name: W.authorizing, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: W.authorize, exact: true })).toHaveCount(0);
  await expect(footer(page)).toContainText(W.reviewExpired);
  await expect(page.locator('.copilot-stage-note')).toContainText(W.assistant);
  await expect(page.locator('.simulation-workflow-canvas .composer-card')).toHaveCount(3);
  // BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (approved reference "Executar — revisão expirada"): the notice, then ONE card with the numbered summary as
  // configured, the fee and permission marked for the refreshed Review (each with why), and collapsed technical details that state no stale figure.
  const expiredCard = runPanel(page).locator('.review-expired-card');
  await expect(expiredCard.locator('.operation-summary[data-variant="numbered"] li')).toHaveCount(3);
  await expect(expiredCard.locator('.operation-summary-sentence').first()).toContainText(PT ? 'na rede Base' : 'on Base');
  await expect(expiredCard.locator('.review-refresh-badge')).toHaveCount(2);
  for (const badge of await expiredCard.locator('.review-refresh-badge').all()) await expect(badge).toHaveAttribute('title', /./);
  const expiredTechnical = expiredCard.locator('details.review-panel-technical');
  await expect(expiredTechnical).not.toHaveAttribute('open', '');
  await expiredTechnical.locator('> summary').click();
  await expect(expiredTechnical).toContainText('eip155:8453');
  await expect(expiredTechnical).toContainText(PT ? 'não estão mais atualizados' : 'no longer current');
  await expiredTechnical.locator('> summary').click();
  // "Refresh review" is the one primary action on screen.
  await expect(page.locator('main, .summary-bar').locator('button.primary:visible')).toHaveCount(1);
  await fitsViewport(page);
  await evidence(page, 'execute-expired');
  if (EVIDENCE) {
    await page.setViewportSize({ width: 390, height: 844 });
    await evidence(page, 'execute-expired-mobile');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  expect(methods.filter(method => ASKING.test(method))).toEqual([]);

  // "Refresh review": a fresh read-only Review of the same workflow, in place (no stage change, nothing sent).
  const refresh = footer(page).getByRole('button', { name: W.refresh, exact: true });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(runPanel(page).getByRole('heading', { name: W.authorizing, exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(footer(page).getByRole('button', { name: W.authorize, exact: true })).toBeEnabled();
  await expectEditorSection(page, 'Execute');
  expect(methods.filter(method => ASKING.test(method))).toEqual([]);

  // Back to Create: the same workflow, editable again.
  await editorStep(page, 'Build').click();
  await expectEditorSection(page, 'Build');
  await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(3);
  await expect(editorSteps(page)).toBeVisible();
  expect(errors).toEqual([]);
  networkGuard.assertClean();
});
