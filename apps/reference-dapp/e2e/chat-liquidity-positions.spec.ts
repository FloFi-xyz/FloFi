// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 — the owner's existing Uniswap v3 positions managed from the FloFi chat, end to end with the Dashboard and the
 * Canvas, on the MOCKED Base mainnet loopback harness (e2e/base-mainnet-serve.ts `/__harness/uniswap`, 127.0.0.1:8562) and the closed Copilot
 * replay (FLOFI_COPILOT=replay, e2e/copilot/replay-v2.json: a request the model would interpret is answered from a committed recording keyed by the
 * open request's user turns; FloFi's own questions are answered locally, with no model at all). In English and Portuguese:
 *
 *   "show my liquidity positions" → FloFi's own answer from the verified facts it read through the Dashboard's discovery route (MOCKED test data,
 *   said as such); an ambiguous removal ("remove some of my liquidity") → FloFi asks which position (never auto-selects) → "The first one" (local)
 *   → how much → "Only the fees" (local) → a COLLECT choice committed as MANAGE_LIQUIDITY_POSITION (the Canvas card says "Collect fees") → Simulate
 *   (the hand-off FloFi named: its Simulation result, then Execute) runs exactly that collection → "50%" (local) re-stages DECREASE 5000 as a new
 *   revision, so the earlier simulation no longer applies and the next one simulates the withdrawal; asking to do this through Telegram / MCP is
 *   answered plainly as unsupported. The chat never authorizes or signs: the browser asks the wallet for no transaction and nothing is sent.
 *
 * MOCKED loopback only (the shared network guard): nothing is signed with a real key or broadcast; none of this is mainnet evidence.
 */
import type { Page } from '@playwright/test';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { chooseLanguage } from './app-origin';
import { expectEditorSection, openBuilder, openEditorSection } from './build-entry-navigation';
import { CHAT_COMMITTED, expect, test } from './fixtures';
import { installJourneyWallet, walletRequests } from './journey-fixtures';
import { BASE_CHAIN_HEX, harnessSends, ownerRuntime, POSITION_RUN_KEY, resetBasePositions } from './liquidity-position-fixtures';
import type { SeededPosition } from './base-mainnet-serve';

/** Selected (the MOCKED liquidity-positions profile with the replay Copilot), this proof runs or FAILS; otherwise it is skipped. */
const SELECTED = process.env.FLOFI_LIQUIDITY_POSITIONS_E2E === 'MOCKED_LOOPBACK_ONLY';
const MISSING = [...process.env.GRYLOO_BASE_MAINNET_E2E === 'MOCKED_LOOPBACK_ONLY' ? [] : ['GRYLOO_BASE_MAINNET_E2E'],
  ...process.env.GRYLOO_BASE_JOURNAL?.trim() ? [] : ['GRYLOO_BASE_JOURNAL'], ...process.env.FLOFI_COPILOT === 'replay' ? [] : ['FLOFI_COPILOT']];
if (SELECTED && MISSING.length) throw new Error(`CHAT_LIQUIDITY_POSITIONS_E2E_PREREQUISITE_MISSING: ${MISSING.join(', ')}`);
test.skip(!SELECTED, 'Runs only in the MOCKED liquidity-positions profile (FLOFI_LIQUIDITY_POSITIONS_E2E=MOCKED_LOOPBACK_ONLY, FLOFI_COPILOT=replay)');
test.setTimeout(180_000);

/** In range, with owed tokens and fees (it offers collect, remove and close); out of range with nothing owed (remove and close only). */
const IN_RANGE: SeededPosition = { tickLower: -197_000, tickUpper: -195_500, liquidity: '1000000000000000', owed0: '1000000000000000', owed1: '3000000',
  fees0: '2100000000000000', fees1: '6500000' };
const OUT_OF_RANGE: SeededPosition = { tickLower: -199_000, tickUpper: -198_000, liquidity: '400000000000000' };
const ASKING = /^(eth_sendTransaction|eth_sendRawTransaction|eth_signTypedData.*|eth_sign|wallet_sendCalls|wallet_switchEthereumChain|wallet_addEthereumChain|wallet_requestPermissions)$/;

const WORDS = {
  EN: { verify: 'Verify wallet for history', history: 'Saved history is unavailable in this environment', positions: 'My DeFi Positions', list: 'Show my liquidity positions',
    listed: 'You have 2 liquidity positions in your connected wallets:', inRange: 'in range', outOfRange: 'out of range (above it)',
    mocked: 'Test data (MOCKED): these positions were not read from a public network.', ambiguous: 'Remove some of my liquidity', which: 'Which position do you mean?',
    first: 'The first one', portion: 'How much of the liquidity of your Uniswap v3 WETH/USDC 0.05% position #9001 on Base should FloFi remove?',
    fees: 'Only the fees', collected: 'Collect the fees and owed tokens of your Uniswap v3 WETH/USDC 0.05% position #9001 on Base.',
    flow: 'Next, Simulate reads the position again and shows its Simulation result (what is removed or collected, with the minimum amounts); then you authorize it on Execute. FloFi never authorizes or signs for you.',
    wallet: 'Position operation: no token approval; your wallet is asked for one request, a single transaction to the Uniswap v3 position manager on Base, and FloFi records the result after 2 confirmations.',
    collect: 'Collect fees', half: '50%', decreased: 'Remove 50% of the liquidity of your Uniswap v3 WETH/USDC 0.05% position #9001 on Base',
    replaced: 'This replaces the position choice FloFi prepared before; only this one applies.', remove50: 'Remove 50% of liquidity',
    channel: 'Can I manage my liquidity positions through MCP?', unsupported: 'Telegram, WhatsApp, MCP and the Developer API cannot manage liquidity positions in this build.',
    simulate: 'Simulate workflow', review: 'Review operation', subject: 'Uniswap v3 position #9001', graph: 'Simulation workflow graph', simulation: 'Simulation',
    stale: 'The workflow or wallet has changed. Simulate again before continuing.' },
  PT: { verify: 'Verificar carteira para consultar o histórico', history: 'O histórico salvo está indisponível neste ambiente', positions: 'Minhas posições DeFi', list: 'Quais são as minhas pools?',
    listed: 'Você tem 2 posições de liquidez nas suas carteiras conectadas:', inRange: 'dentro da faixa', outOfRange: 'fora da faixa (acima dela)',
    mocked: 'Dados de teste (MOCKED)', ambiguous: 'Quero tirar um pouco da minha liquidez', which: 'Qual posição você quer dizer?', first: 'A primeira',
    portion: 'Quanto da liquidez da sua posição Uniswap v3 WETH/USDC 0.05% #9001 na Base o FloFi deve remover?', fees: 'Só os rendimentos',
    collected: 'Coletar as taxas e os tokens devidos da sua posição Uniswap v3 WETH/USDC 0.05% #9001 na Base.',
    flow: 'Depois, o Simular lê a posição de novo e mostra o Resultado da simulação (o que é removido ou coletado, com os valores mínimos); em seguida, você autoriza em Executar. O FloFi nunca autoriza nem assina por você.',
    wallet: 'Operação de posição: sem approval de token; sua carteira recebe um único pedido, uma transação para o gerenciador de posições da Uniswap v3 na Base, e o FloFi registra o resultado depois de 2 confirmações.',
    collect: 'Coletar taxas', half: '50%', decreased: 'Remover 50% da liquidez da sua posição Uniswap v3 WETH/USDC 0.05% #9001 na Base',
    replaced: 'Isto substitui a escolha de posição que o FloFi preparou antes; só esta vale.', remove50: 'Remover 50% da liquidez',
    channel: 'Posso gerenciar minhas posições de liquidez pelo Telegram?', unsupported: 'Telegram, WhatsApp, MCP e a API para desenvolvedores não gerenciam posições de liquidez nesta versão.',
    simulate: 'Simular fluxo', review: 'Revisar operação', subject: 'Posição Uniswap v3 #9001', graph: 'Grafo de simulação do fluxo', simulation: 'Simulação',
    stale: 'O fluxo ou a carteira mudou. Simule novamente antes de continuar.' },
} as const;
type Language = keyof typeof WORDS;

const conversation = (page: Page) => page.locator('.chat-messages[role="log"]');
/** FloFi's latest message (never the owner's own, never the live execution card). */
const flofi = (page: Page) => conversation(page).locator('.message:not(.you):not(.conversation-execution-message)').last();
const footer = (page: Page) => page.locator('footer.summary-bar');
const card = (page: Page) => page.locator('.build-flow-surface .composer-card');
const revision = async (page: Page) => Number(await footer(page).getAttribute('data-workflow-revision'));
const positionRun = (page: Page) => page.evaluate(key => (JSON.parse(window.localStorage.getItem(key) ?? 'null') as { id?: string } | null)?.id ?? null, POSITION_RUN_KEY);
async function say(page: Page, text: string) {
  const mine = conversation(page).locator('.message.you');
  const before = await mine.count();
  await page.locator('#mock-prompt').fill(text);
  await page.locator('.chat-form button[type=submit]').click();
  await expect(mine).toHaveCount(before + 1);
}
/** FloFi committed a change to the workflow (the conversational flow commits a valid request at once; nothing to accept). */
async function committed(page: Page, count: number) {
  await expect(conversation(page).locator('.message', { hasText: CHAT_COMMITTED })).toHaveCount(count, { timeout: 30_000 });
}
async function expectNothingAsked(page: Page) {
  expect((await walletRequests(page)).filter(method => ASKING.test(method))).toEqual([]);
}

async function setup(page: Page, language: Language) {
  const W = WORDS[language];
  const wallet = createTestWallet(), owner = wallet.address.toLowerCase();
  expect(await resetBasePositions(owner, [IN_RANGE, OUT_OF_RANGE])).toMatchObject({ tokenIds: ['9001', '9002'] });
  await installJourneyWallet(page, [wallet], { chain: BASE_CHAIN_HEX, transactionControl: async () => { throw new Error('FINANCIAL_REQUEST_FORBIDDEN'); } });
  if (language === 'PT') await chooseLanguage(page.context(), 'PT');
  // FloFi reads positions only for a wallet verified in this session: the owner's one sign-in message on the Dashboard.
  await page.goto('/app/dashboard');
  const verify = page.getByRole('button', { name: W.verify, exact: true });
  await expect(verify.or(page.getByText(W.history, { exact: true }))).toBeVisible({ timeout: 30_000 });
  if (await verify.count()) { await verify.click(); await expect(verify).toHaveCount(0); }
  // The Dashboard reads the same verified positions the chat will answer from (its discovery route accepts the verified wallet).
  const disclosure = page.getByRole('button', { name: W.positions, exact: true });
  await disclosure.click();
  await expect(page.getByRole('region', { name: 'Uniswap V3 · Base', exact: true }).locator('[data-liquidity-position="9001"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-liquidity-position="9002"]')).toBeVisible();
  await openBuilder(page);
  return { owner };
}

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const errors: string[] = []; pageErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message)); });
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

for (const language of ['EN', 'PT'] as const) {
  test(`${language}: positions from chat — verified facts, a clarified choice committed to the Canvas, Simulate hand-off, a re-staged change, unsupported channels`,
    async ({ page, networkGuard }) => {
      const W = WORDS[language];
      await setup(page, language);
      const sends = await harnessSends();

      // FloFi's own answer from the verified facts (read through the Dashboard's discovery route): both positions, their range state, test data.
      await say(page, W.list);
      await expect(flofi(page)).toContainText(W.listed, { timeout: 30_000 });
      await expect(flofi(page)).toContainText('#9001');
      await expect(flofi(page)).toContainText('#9002');
      await expect(flofi(page)).toContainText(W.inRange);
      await expect(flofi(page)).toContainText(W.outOfRange);
      await expect(flofi(page)).toContainText(W.mocked);
      await expect(flofi(page)).not.toContainText(/APY|APR|PnL|\byield\b|rendimento/i);
      await expect(card(page)).toHaveCount(0);

      // An ambiguous request: FloFi asks which position (both can be removed from), never picks one itself; nothing is staged.
      await say(page, W.ambiguous);
      await expect(flofi(page)).toContainText(W.which, { timeout: 30_000 });
      await expect(flofi(page).getByRole('button')).toHaveCount(2);
      await expect(flofi(page).getByRole('button').nth(0)).toContainText('#9001');
      await expect(flofi(page).getByRole('button').nth(1)).toContainText('#9002');
      await expect(card(page)).toHaveCount(0);
      // A short answer (local): the first one → how much (only what that position offers).
      await say(page, W.first);
      await expect(flofi(page)).toContainText(W.portion);
      await expect(flofi(page).getByRole('button')).toHaveText(['25%', '50%', '75%', language === 'PT' ? 'Tudo (sair)' : 'All (exit)']);
      await expect(card(page)).toHaveCount(0);
      // "Only the fees" (local): a collection of that same position, committed as MANAGE_LIQUIDITY_POSITION; the Canvas card names it.
      const before = await revision(page);
      await say(page, W.fees);
      await committed(page, 1);
      const collect = conversation(page).locator('.message:not(.you)', { hasText: W.collected }).last();
      await expect(collect).toContainText(W.wallet);
      await expect(collect).toContainText(W.flow);
      await expect(collect).toContainText(W.mocked);
      await expect(card(page)).toHaveCount(1);
      await expect(card(page)).toHaveAttribute('data-position-operation', 'COLLECT');
      await expect(card(page).locator('.composer-action-name')).toHaveText(W.collect);
      await expect(card(page)).toContainText(W.subject);
      await expect(card(page).getByRole('textbox')).toHaveCount(0);
      expect(await revision(page)).toBeGreaterThan(before);
      const collected = await revision(page);

      // The hand-off FloFi named: Simulate (the footer's one action) runs exactly this collection, read-only; Review is on Execute, never in chat.
      await footer(page).locator('.canvas-primary-action').getByRole('button', { name: W.simulate, exact: true }).click();
      await expectEditorSection(page, 'Simulate', { timeout: 30_000 });
      await expect.poll(async () => /^balp-[a-f0-9]{32}$/.test(await positionRun(page) ?? ''), { timeout: 60_000 }).toBe(true);
      const first = (await positionRun(page))!;
      const runtime = ownerRuntime(), simulated = await runtime.positionStatus(first);
      expect(simulated).toMatchObject({ provenance: 'MOCKED', authorization: null, attempts: [], request: { operation: 'COLLECT', tokenId: '9001', partBps: null, close: false } });
      await expect(footer(page).getByRole('button', { name: new RegExp(`^${W.review}`) })).toBeEnabled({ timeout: 30_000 });

      // "50%" right after (local): the same position, now a 50% withdrawal — a NEW revision that replaces the choice; the earlier simulation no
      // longer applies (Simulate is offered again), and the next simulation is of the withdrawal.
      await say(page, W.half);
      await committed(page, 2);
      const decrease = conversation(page).locator('.message:not(.you)', { hasText: W.decreased }).last();
      await expect(decrease).toContainText(W.replaced);
      expect(await revision(page)).toBeGreaterThan(collected);
      // Simulate (where the owner is) now shows the withdrawal, says the earlier result no longer applies and offers Simulate again; Review
      // operation is closed until then.
      await expect(page.getByRole('region', { name: W.graph, exact: true })).toContainText(W.remove50);
      const panel = page.getByRole('region', { name: W.simulation, exact: true });
      await expect(panel).toContainText(W.stale);
      await expect(panel).not.toContainText(W.collect);
      await expect(footer(page).getByRole('button', { name: new RegExp(`^${W.review}`) })).toBeDisabled();
      await panel.getByRole('button', { name: W.simulate, exact: true }).click();
      await expect.poll(async () => { const id = await positionRun(page); return id !== first && /^balp-[a-f0-9]{32}$/.test(id ?? ''); }, { timeout: 60_000 }).toBe(true);
      const second = await runtime.positionStatus((await positionRun(page))!);
      expect(second).toMatchObject({ authorization: null, attempts: [], request: { operation: 'DECREASE', tokenId: '9001', partBps: 5_000, close: false } });
      expect((await runtime.positionStatus(first)).attempts).toEqual([]);
      // The Canvas (Create) holds the re-staged step: one card, the withdrawal of the same position.
      await openEditorSection(page, 'Build');
      await expect(card(page)).toHaveCount(1);
      await expect(card(page)).toHaveAttribute('data-position-operation', 'DECREASE');
      await expect(card(page).locator('.composer-action-name')).toHaveText(W.remove50);
      await expect(card(page)).toContainText(W.subject);

      // Another surface: answered plainly (FloFi's own platform answer), nothing staged or changed.
      const now = await revision(page);
      await say(page, W.channel);
      await expect(flofi(page)).toContainText(W.unsupported, { timeout: 30_000 });
      expect(await revision(page)).toBe(now);

      // The chat never authorized or signed anything: no wallet transaction was asked of the browser and nothing was sent.
      expect(await harnessSends()).toBe(sends);
      await expectNothingAsked(page);
      networkGuard.assertClean();
    });
}
