// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-P1 pool conversational reliability: a liquidity position requested by conversation, answered naturally in separate messages, in the public
 * (Mainnet-only) scope. The engine is the real one; the interpreter is scripted (exactly what a model may return) and a pool read is a scripted,
 * read-only fixture handed back exactly as the web chat hands it. Every range is checked against the canonical tick math the Canvas, the exact
 * grammar and MCP use. Nothing here signs, simulates on a network or sends a transaction.
 */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseArbitrumTokenList, parseEthereumTokenList } from '@defi-workflow-engine/action-registry';
import { sqrtRatioAtTick, uniswapAlignPriceRange, uniswapBandAroundSqrtPriceIn, uniswapPriceAtTick } from '@defi-workflow-engine/reference-compiler';
import { readConcentratedLiquidity, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { baseCatalog } from '../server/base-mainnet.test-harness';
import { setActiveNetworkScope } from './network-scope';
import { priceBoundsAround } from './pool-price-bounds';
import { solanaLiquidityTicks } from './solana-liquidity-authoring';
import { COPILOT_V2_COMMANDS, startTurn } from './copilot-conversation';
import { parseLocalCommand } from './commands';
import { editorReducer } from './editor';
import { composeStrategy, semanticWorkflowHash } from '../engine/strategy-engine';
import { canonicalStrategy } from '../channels/core/strategy';
import { strategyFlow } from '../mcp/simulation';
import { ORCA_MAINNET_POOL, POOL_PRICE_MAX_AGE_MS, type PoolPriceRead, type PoolRef } from './pool-range';
import type { CopilotReply } from './copilot-conversation';

const arbitrum = parseArbitrumTokenList(readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8'), '2026-10-12T00:00:00Z');
const ethereum = parseEthereumTokenList(readFileSync(new URL('../../../../packages/action-registry/test/fixtures/ethereum-token-list-fixture.json', import.meta.url), 'utf8'), '2026-10-12T00:00:00Z');
beforeAll(() => { registerNetworkCatalog(baseCatalog()); registerNetworkCatalog(arbitrum); registerNetworkCatalog(ethereum); });
afterAll(() => resetNetworkCatalogs());
beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));
afterEach(() => setActiveNetworkScope(null));

const NOW = 1_800_000_000_000;
const ORCA = { protocol: 'ORCA', network: 'SOLANA' } as const;
const SOL_USDC = [{ asset: 'SOL', maxAmount: '0.1' }, { asset: 'USDC', maxAmount: '10' }];
const BASE = { network: 'BASE', deposits: [{ asset: 'USDC', maxAmount: '10' }, { asset: 'ETH', maxAmount: '0.004' }] };
/** On Base and Arbitrum One WETH is token0 and USDC token1: USDC per WETH is token1 per token0. ~3,000 and ~2,900 USDC per WETH. */
const TICKS: Record<string, number> = { 'eip155:8453': -196_257, 'eip155:42161': -196_597,
  // On Ethereum USDC is token0: USDC per WETH is token0 per token1 (a higher tick is a lower price), ~3,000 USDC per WETH.
  'eip155:1': 196_257 };
const ORCA_PRICE = '150.000000', ORCA_TICK = -18_972, SPACING = 60;
const good = (ref: PoolRef, readAt = NOW): PoolPriceRead => ref.kind === 'UNISWAP_V3'
  ? { ref, readAt, ok: true, sqrtPrice: sqrtRatioAtTick(TICKS[ref.chain]!).toString(), tick: TICKS[ref.chain]!, at: 22_000_000 }
  : { ref, readAt, ok: true, price: ORCA_PRICE, tick: ORCA_TICK, at: 300_000_000 };
const session = (language?: 'EN' | 'PT') => Object.assign(new CopilotSession(), { poolReader: (ref: PoolRef) => good(ref), now: NOW },
  language ? { interfaceLanguage: language } : {});
const notes = (reply: CopilotReply | null) => reply?.notes.join('\n') ?? '';
const usdcPerWeth = (tick: number) => uniswapPriceAtTick(tick, 18, 6, 'TOKEN1_PER_TOKEN0');
const nodeOf = (s: CopilotSession) => readConcentratedLiquidity(structuredClone(s.workflow.nodes.at(-1)!) as SemanticWorkflow['nodes'][number]);
/** No model call: the turn must be FloFi's own (the harness throws if the interpreter is asked without a scripted answer). */
const local = (s: CopilotSession, text: string) => s.say(text);
/** An Orca mainnet request that already has its deposits: FloFi's question is the range only. */
function orcaOpen(language: 'EN' | 'PT' = 'EN') {
  const s = session(language);
  const asked = s.say(language === 'PT' ? 'quero adicionar liquidez na Orca na Solana com 0,1 SOL e 10 USDC' : 'Add liquidity on Orca on Solana with 0.1 SOL and 10 USDC',
    intent.action(act.liquidity({ ...ORCA, deposits: SOL_USDC }), language));
  expect(asked).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_REQUIRED' });
  expect(asked?.text).toMatch(language === 'PT' ? /USDC por SOL/ : /USDC per SOL/);
  return s;
}

describe('Orca SOL/USDC on Solana: the range in separate messages', () => {
  it('"1usdc" → "lower" → "180": only the missing part is asked each time, then the proposal', () => {
    const s = orcaOpen();
    const side = local(s, '1usdc');
    expect(side).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_SIDE_REQUIRED', options: ['Lower', 'Upper'] });
    expect(side?.text).toBe('Is 1 USDC per SOL the lower or the upper price of the range?');
    const upper = local(s, 'lower');
    expect(upper).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_BOUND_REQUIRED' });
    expect(upper?.text).toBe('The lower price is 1 USDC per SOL. What upper price in USDC per SOL should the range use?');
    const done = local(s, '180');
    expect(done?.kind).toBe('PROPOSAL');
    expect(done?.sentence).toBe('add liquidity 0.1 SOL and 10 USDC from 1 to 180 USDC per SOL on Solana slippage 100 bps');
    // The effective (aligned) range and where the verified price sits are shown before approval.
    const ticks = solanaLiquidityTicks({ rangeUnit: 'PRICE', lower: '1', upper: '180', network: 'Solana' });
    expect(notes(done)).toContain(`(ticks ${ticks.tickLower} to ${ticks.tickUpper})`);
    expect(notes(done)).toMatch(/inside this range/);
    expect(notes(done)).not.toMatch(/devUSDC|Devnet/);
    expect(s.state.clarifications).toBe(0);
  });
  it('the side buttons, "upper" first and a bound named with its value all work; the lower must be below the upper', () => {
    const s = orcaOpen();
    local(s, '180');
    expect(local(s, 'Upper')?.text).toMatch(/^The upper price is 180 USDC per SOL\. What lower price/);
    expect(local(s, '200')).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_ORDER_INVALID' });
    expect(local(s, 'lower 120')?.sentence).toBe('add liquidity 0.1 SOL and 10 USDC from 120 to 180 USDC per SOL on Solana slippage 100 bps');
  });
  it('an explicit change of a bound already given replaces only that bound', () => {
    const s = orcaOpen();
    local(s, '1usdc'); local(s, 'lower');
    expect(local(s, 'actually make the lower 120')?.text).toMatch(/^The lower price is 120 USDC per SOL\./);
    expect(local(s, '180')?.sentence).toBe('add liquidity 0.1 SOL and 10 USDC from 120 to 180 USDC per SOL on Solana slippage 100 bps');
  });
  it('±10% on mainnet: computed from the verified mainnet pool read, exactly as the Canvas range control', () => {
    const s = orcaOpen();
    const done = local(s, '±10%');
    const bounds = priceBoundsAround(ORCA_PRICE, -10, 10);
    expect(done?.sentence).toBe(`add liquidity 0.1 SOL and 10 USDC from ${bounds.lower} to ${bounds.upper} USDC per SOL on Solana slippage 100 bps`);
    expect(s.poolRequests).toEqual([expect.objectContaining({ kind: 'ORCA', network: 'SOLANA' })]);
    expect(notes(done)).toContain('Range: ±10% around the current verified pool price (150.000000 USDC per SOL).');
    expect(notes(done)).toContain('Pool price read on chain at slot 300000000');
    // Proposal → canonical IR: the ticks are the exact grammar's alignment of the same bounds.
    s.apply();
    expect(nodeOf(s)).toMatchObject({ ...solanaLiquidityTicks({ rangeUnit: 'PRICE', lower: bounds.lower, upper: bounds.upper, network: 'Solana' }) });
  });
  it('"a percentage range" first, then "10": FloFi asks for the percentage and reads the bare number as it', () => {
    const s = orcaOpen();
    expect(local(s, 'a percentage range')).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_PERCENT_REQUIRED' });
    expect(local(s, '10')?.kind).toBe('PROPOSAL');
  });
  it('the full range is not offered for Orca: FloFi says so and asks for a finite range', () => {
    const s = orcaOpen();
    expect(local(s, 'full range')).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_UNSUPPORTED' });
    expect(local(s, '150 to 180')?.sentence).toBe('add liquidity 0.1 SOL and 10 USDC from 150 to 180 USDC per SOL on Solana slippage 100 bps');
  });
  it('Portuguese: "1usdc" → "inferior" → "180", and "faixa de 10%"', () => {
    const s = orcaOpen('PT');
    expect(local(s, '1usdc')).toMatchObject({ text: '1 USDC por SOL é o preço inferior ou o superior da faixa?', options: ['Inferior', 'Superior'] });
    expect(local(s, 'inferior')?.text).toBe('O preço inferior é 1 USDC por SOL. Qual preço superior em USDC por SOL a faixa deve usar?');
    expect(local(s, '180')?.kind).toBe('PROPOSAL');
    const t = orcaOpen('PT');
    const done = local(t, 'faixa de 10%');
    expect(done?.kind).toBe('PROPOSAL');
    expect(notes(done)).toContain('Faixa: ±10% em torno do preço verificado atual do pool (150.000000 USDC por SOL).');
  });
  it('deposits given in separate messages: each answer fills only the token FloFi asked for', () => {
    const s = session();
    expect(s.say('Add liquidity on Orca on Solana', intent.action(act.liquidity({ ...ORCA })))?.kind).toBe('CLARIFICATION');
    const usdc = s.say('0.1 SOL', intent.action(act.liquidity({ ...ORCA, deposits: [{ asset: 'SOL', maxAmount: '0.1' }] })));
    expect(usdc).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_DEPOSIT_REQUIRED', text: 'How much USDC at most should the position use (0 for none)?' });
    expect(local(s, '2 SOL')?.text).toMatch(/asked for the USDC maximum/);
    expect(local(s, '2')).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_REQUIRED' });
    expect(local(s, '±5%')?.sentence).toMatch(/^add liquidity 0\.1 SOL and 2 USDC from \S+ to \S+ USDC per SOL on Solana slippage 100 bps$/);
  });
  it('a new request never inherits the previous request\'s range', () => {
    const s = orcaOpen();
    local(s, '150 to 180');
    expect(s.state.draft).toBeNull();
    const next = s.say('Add liquidity on Orca on Solana with 0.2 SOL and 20 USDC', intent.action(act.liquidity({ ...ORCA, deposits: [{ asset: 'SOL', maxAmount: '0.2' }, { asset: 'USDC', maxAmount: '20' }] })));
    expect(next).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_REQUIRED' });
  });
  it('a wallet change while FloFi\'s question is open invalidates the request (nothing stale is used)', () => {
    const s = orcaOpen();
    local(s, '1usdc');
    s.wallet = '0x9999999999999999999999999999999999999999';
    expect(local(s, 'lower')).toMatchObject({ kind: 'FAILED', code: 'COPILOT_CONTEXT_CHANGED' });
    expect(s.state.draft).toBeNull();
  });
  it('the answer is never a model call, and the request never runs out of questions while it progresses', () => {
    const s = session();
    s.say('I want to add liquidity on Orca on Solana', intent.action(act.liquidity({ ...ORCA })));
    s.say('0.1 SOL and 10 USDC', intent.action(act.liquidity({ ...ORCA, deposits: SOL_USDC })));
    for (const answer of ['1usdc', 'lower']) { expect(local(s, answer)?.kind).toBe('CLARIFICATION'); }
    expect(local(s, '180')?.kind).toBe('PROPOSAL');
    expect(s.turns.slice(2).every(turn => turn.request === null)).toBe(true);
  });
});

describe('Uniswap v3 on catalog networks: percentage, price and full ranges', () => {
  const pool = (chain: string) => ({ tick: TICKS[chain]!, sqrt: sqrtRatioAtTick(TICKS[chain]!) });
  it.each([['±10%', '±10%'], ['10% range', '10%'], ['10 percent around current price', '10'], ['faixa de 10%', '10']])('"%s" → ±10% around the verified pool price, in ticks', (answer, written) => {
    const s = session();
    const reply = s.say(`Add liquidity on Base with 10 USDC and 0.004 ETH, ${answer}`, intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'PERCENT', upper: written })));
    const ticks = uniswapBandAroundSqrtPriceIn(pool('eip155:8453').sqrt, 1_000, SPACING, 'TOKEN1_PER_TOKEN0');
    expect(reply?.kind).toBe('PROPOSAL');
    expect(reply?.sentence).toBe(`add liquidity 10 USDC and 0.004 WETH on Base ticks ${ticks.tickLower} to ${ticks.tickUpper} slippage 100 bps`);
    // ±10% in USDC per WETH (the person's direction), aligned outward: the effective bounds contain 2,700–3,300 USDC per WETH.
    const reference = Number(usdcPerWeth(pool('eip155:8453').tick));
    expect(Number(usdcPerWeth(ticks.tickLower))).toBeLessThanOrEqual(reference * 0.9 * 1.0001);
    expect(Number(usdcPerWeth(ticks.tickUpper))).toBeGreaterThanOrEqual(reference * 1.1 * 0.9999);
    expect(notes(reply)).toContain(`Effective range after aligning to the pool's ticks: ${usdcPerWeth(ticks.tickLower)}–${usdcPerWeth(ticks.tickUpper)} USDC per WETH`);
    expect(notes(reply)).toMatch(/Pool price read on chain at block 22000000/);
    expect(notes(reply)).not.toMatch(/full price range/);
  });
  it('the captured sequence: the model asks, the user answers "±10%" and the proposal follows (no generic validation failure)', () => {
    const s = session();
    s.say('Add liquidity to the USDC/ETH pool on Base with 10 USDC and 0.004 ETH',
      intent.clarify(['range'], 'What price range should I use for the USDC/ETH pool?', ['Full range', 'A percentage range (for example, ±10%)']));
    s.say('A percentage range (for example, ±10%)', intent.clarify(['range'], 'What percentage range would you like around the current pool price?'));
    expect(s.say('±10%', intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'PERCENT', upper: '±10%' })))?.kind).toBe('PROPOSAL');
  });
  it('a PERCENT request with the percentage still missing is asked for, then answered locally', () => {
    const s = session();
    expect(s.say('Add liquidity on Base with 10 USDC and 0.004 ETH in a percentage range', intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'PERCENT' }))))
      .toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_PERCENT_REQUIRED' });
    expect(local(s, '±10%')?.kind).toBe('PROPOSAL');
  });
  it('an explicit price range in USDC per WETH becomes outward-aligned ticks', () => {
    const s = session();
    const reply = s.say('Add liquidity on Base with 10 USDC and 0.004 ETH between 2800 and 3200 USDC', intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'PRICE', lower: '2800', upper: '3200' })));
    const ticks = uniswapAlignPriceRange('2800', '3200', 18, 6, SPACING, 'TOKEN1_PER_TOKEN0');
    expect(reply?.sentence).toBe(`add liquidity 10 USDC and 0.004 WETH on Base ticks ${ticks.tickLower} to ${ticks.tickUpper} slippage 100 bps`);
    expect(notes(reply)).toMatch(/inside this range/);
  });
  it('a price range given in two messages (lower in the request, upper as the answer)', () => {
    const s = session();
    expect(s.say('Add liquidity on Base with 10 USDC and 0.004 ETH, lower price 2800', intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'PRICE', lower: '2800' }))))
      .toMatchObject({ kind: 'CLARIFICATION', text: 'The lower price is 2800 USDC per WETH. What upper price in USDC per WETH should the range use?' });
    expect(local(s, '3200')?.sentence).toMatch(/ticks -?\d+ to -?\d+ slippage 100 bps$/);
  });
  it('the full range where supported: explicitly, or as the answer to FloFi\'s range question', () => {
    const s = session();
    expect(s.say('Add liquidity on Base with 10 USDC and 0.004 ETH over the full range', intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'FULL' })))?.sentence)
      .toBe('add liquidity 10 USDC and 0.004 WETH on Base slippage 100 bps');
    const t = session();
    t.say('Add liquidity on Base with 10 USDC and 0.004 ETH, lower price 2800', intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'PRICE', lower: '2800' })));
    expect(local(t, 'full range')?.sentence).toBe('add liquidity 10 USDC and 0.004 WETH on Base slippage 100 bps');
  });
  it('a network change during the request reads the new network\'s own pool (never the old price)', () => {
    const s = session();
    s.say('Add liquidity on Base with 10 USDC and 0.004 ETH in a percentage range', intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'PERCENT' })));
    s.say('on Arbitrum instead', intent.action(act.catalogLiquidity({ ...BASE, network: 'ARBITRUM', rangeUnit: 'PERCENT' })));
    const done = local(s, '±10%');
    const ticks = uniswapBandAroundSqrtPriceIn(pool('eip155:42161').sqrt, 1_000, SPACING, 'TOKEN1_PER_TOKEN0');
    expect(done?.sentence).toBe(`add liquidity 10 USDC and 0.004 WETH on Arbitrum One ticks ${ticks.tickLower} to ${ticks.tickUpper} slippage 100 bps`);
    expect(s.poolRequests.map(ref => ref.kind === 'UNISWAP_V3' && ref.chain)).toEqual(['eip155:42161']);
  });
  it('proposal → canonical IR → the same IR and hash MCP composes from the resolved ticks, on the registered flow', () => {
    const s = session();
    const reply = s.say('Add liquidity on Base with 10 USDC and 0.004 ETH, ±10%', intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'PERCENT', upper: '10' })));
    expect(parseLocalCommand(reply!.sentence!, s.workflow, s.context, s.wallet)).toEqual(reply!.command);
    const workflow = editorReducer({ workflow: s.workflow, error: null }, reply!.command!, s.context).workflow;
    const ticks = uniswapBandAroundSqrtPriceIn(pool('eip155:8453').sqrt, 1_000, SPACING, 'TOKEN1_PER_TOKEN0');
    const strategy = { action: 'add_liquidity', network: 'base', maxAmounts: { USDC: '10', WETH: '0.004' }, range: { unit: 'tick', lower: String(ticks.tickLower), upper: String(ticks.tickUpper) },
      feeTier: 3000, slippageBps: 100 } as const;
    const composed = composeStrategy(strategy);
    expect(composed.ok).toBe(true); if (!composed.ok) return;
    expect(composed.workflow).toEqual(workflow);
    expect(canonicalStrategy(reply!.command!)).toMatchObject({ ok: true, workflowHash: semanticWorkflowHash(workflow) });
    expect(strategyFlow(strategy)).toBe('base-liquidity');
    s.apply();
    expect(nodeOf(s)).toMatchObject({ tickLower: ticks.tickLower, tickUpper: ticks.tickUpper, feeTier: 3000 });
  });
});

describe('Verified market data: unavailable, stale or missing pools', () => {
  it('an unreadable pool price: FloFi says what it could not confirm, proposes nothing, and "Try again" reads it again', () => {
    const s = session();
    s.poolReader = ref => ({ ref, readAt: NOW, ok: false, code: 'BASE_MAINNET_NOT_ENABLED' });
    const failed = s.say('Add liquidity on Base with 10 USDC and 0.004 ETH, ±10%', intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'PERCENT', upper: '10' })));
    expect(failed).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POOL_PRICE_UNAVAILABLE', options: ['Try again'] });
    expect(failed?.command).toBeUndefined();
    expect(failed?.text).toMatch(/could not verify the current price of the Uniswap v3 WETH\/USDC 0\.3% \(Base\) pool/);
    s.poolReader = ref => good(ref); s.pools = [];
    expect(local(s, 'Try again')?.kind).toBe('PROPOSAL');
  });
  it('a pool that does not exist is named as such (nothing proposed)', () => {
    const s = session();
    s.poolReader = ref => ({ ref, readAt: NOW, ok: false, code: 'UNISWAP_POOL_MISMATCH' });
    expect(s.say('Add liquidity on Base with 10 USDC and 0.004 ETH at 1% fee, ±10%', intent.action(act.catalogLiquidity({ ...BASE, feeTier: '1', rangeUnit: 'PERCENT', upper: '10' }))))
      .toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POOL_NOT_FOUND' });
  });
  it('a stale read is never used: FloFi reads the pool again for this turn', () => {
    const t = orcaOpen();
    t.pools = [{ ref: ORCA_MAINNET_POOL, readAt: NOW - POOL_PRICE_MAX_AGE_MS - 1, ok: true, price: '999.000000', tick: 0, at: 1 }];
    const done = local(t, '±10%');
    expect(t.poolRequests).toEqual([ORCA_MAINNET_POOL]);
    expect(notes(done)).toContain('(150.000000 USDC per SOL)');
    expect(notes(done)).not.toContain('999');
  });
  it('a surface that cannot read pools (a channel) explains it instead of guessing', () => {
    const s = Object.assign(new CopilotSession(), { now: NOW });
    expect(s.say('Add liquidity on Orca on Solana with 0.1 SOL and 10 USDC, ±10%', intent.action(act.liquidity({ ...ORCA, deposits: SOL_USDC, rangeUnit: 'PERCENT', upper: '10' }))))
      .toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POOL_PRICE_UNAVAILABLE' });
  });
});

describe('Safety: the model and the user\'s words never become unverified financial values', () => {
  it('a malformed model answer is blocked and FloFi\'s open question stays open', () => {
    const s = orcaOpen();
    const reply = s.say('something odd', intent.action(act.liquidity({ ...ORCA, deposits: SOL_USDC, rangeUnit: 'PERCENT', upper: 'ten percent' })));
    expect(reply).toMatchObject({ kind: 'FAILED', code: 'COPILOT_INTENT_INVALID' });
    expect(notes(reply)).toMatch(/Which price range should the position use/);
    expect(s.state.draft).not.toBeNull();
  });
  it('a percentage or price the user did not write is not used', () => {
    const s = orcaOpen();
    expect(s.say('a tighter one please', intent.action(act.liquidity({ ...ORCA, deposits: SOL_USDC, rangeUnit: 'PERCENT', upper: '15' }))))
      .toMatchObject({ kind: 'CLARIFICATION' });
    expect(s.pending).toBeNull();
    const t = orcaOpen();
    expect(t.say('around the current price', intent.action(act.liquidity({ ...ORCA, deposits: SOL_USDC, rangeUnit: 'PRICE', lower: '140', upper: '160' }))))
      .toMatchObject({ kind: 'CLARIFICATION' });
    expect(t.pending).toBeNull();
  });
  it('"yes" never chooses a side, approves or signs; every proposal is an authoring command only', () => {
    const s = orcaOpen();
    local(s, '1usdc');
    expect(local(s, 'yes')).toMatchObject({ kind: 'CLARIFICATION', options: ['Lower', 'Upper'] });
    local(s, 'lower');
    const done = local(s, '180');
    expect(COPILOT_V2_COMMANDS.has(done!.command!.type)).toBe(true);
    expect(done!.command!.type).toBe('ADD_SOLANA_LIQUIDITY');
    // The default slippage is unchanged; nothing in the reply executes, submits or approves.
    expect(done?.sentence).toMatch(/slippage 100 bps$/);
  });
  it('the public product never mentions a test network or test token in the pool dialogue', () => {
    const s = orcaOpen();
    const replies = [local(s, '1usdc'), local(s, 'lower'), local(s, '180')];
    const t = orcaOpen();
    replies.push(local(t, 'full range'), local(t, '±10%'));
    for (const reply of replies) expect([reply?.text, ...reply?.notes ?? [], ...reply?.options ?? []].join(' ')).not.toMatch(/devUSDC|Devnet|Sepolia/i);
  });
});

describe('Specialist review regressions (security, liquidity, chat)', () => {
  it('a bare number answering another question never grounds a percentage the user did not write', () => {
    const s = session();
    expect(s.say('Add liquidity on Orca on Solana with 10 SOL', intent.action(act.liquidity({ ...ORCA, deposits: [{ asset: 'SOL', maxAmount: '10' }], rangeUnit: 'PERCENT', upper: '10' }))))
      .toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_DEPOSIT_REQUIRED' });
    const reply = local(s, '10');
    expect(reply).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_PERCENT_NOT_FOUND' });
    expect(s.poolRequests).toHaveLength(0);
    expect(local(s, '10%')?.kind).toBe('PROPOSAL');
  });
  it('a number written once grounds one field: deposit maxima never double as price bounds', () => {
    const s = session();
    const reply = s.say('Add liquidity on Base with 2800 USDC and 1 WETH', intent.action(act.catalogLiquidity({ network: 'BASE',
      deposits: [{ asset: 'USDC', maxAmount: '2800' }, { asset: 'WETH', maxAmount: '1' }], rangeUnit: 'PRICE', lower: '1', upper: '2800' })));
    expect(reply).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_NOT_FOUND' });
    expect(local(s, '2500 to 3500')?.sentence).toMatch(/^add liquidity 2800 USDC and 1 WETH on Base ticks -?\d+ to -?\d+ slippage 100 bps$/);
  });
  it('a fee-tier answer is never read as a percentage range (only FloFi\'s own range questions are read locally)', () => {
    const s = session();
    expect(s.say('Add liquidity on Base with 10 USDC and 0.004 ETH at 0.05%', intent.action(act.catalogLiquidity({ ...BASE }))))
      .toMatchObject({ kind: 'CLARIFICATION' });
    const reply = s.say('0.05%', intent.action(act.catalogLiquidity({ ...BASE, feeTier: '0.05' })));
    expect(s.turns.at(-1)!.request).not.toBeNull();
    expect(reply?.sentence).toBe('add liquidity 10 USDC and 0.004 WETH on Base fee 0.05% slippage 100 bps');
  });
  it('"at 10% around the current price" is a range, not a 10% fee tier', () => {
    const s = session();
    expect(s.say('Add liquidity on Base with 10 USDC and 0.004 ETH at 10% around the current price',
      intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'PERCENT', upper: '10' })))?.kind).toBe('PROPOSAL');
  });
  it('a range the user wrote but the interpreter dropped is asked for, never replaced by the full range', () => {
    const s = session();
    expect(s.say('Add liquidity on Base with 10 USDC and 0.004 ETH in a 10% range', intent.action(act.catalogLiquidity({ ...BASE }))))
      .toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_REQUIRED',
        text: 'Which range should the position use: the full range, the lower and upper prices in USDC per WETH, a percentage around the current pool price (for example ±10%), or ticks?' });
    expect(local(s, '±10%')?.sentence).toMatch(/ticks -?\d+ to -?\d+ slippage 100 bps$/);
    const t = session();
    t.say('Add liquidity on Base with 10 USDC and 0.004 ETH between 2800 and 3200', intent.action(act.catalogLiquidity({ ...BASE })));
    expect(local(t, 'full range')?.sentence).toBe('add liquidity 10 USDC and 0.004 WETH on Base slippage 100 bps');
  });
  it('repeated values without a side reach the question limit (no endless loop)', () => {
    const s = orcaOpen();
    expect(local(s, '1usdc')?.code).toBe('COPILOT_RANGE_SIDE_REQUIRED');
    expect(local(s, '2usdc')?.code).toBe('COPILOT_RANGE_SIDE_REQUIRED');
    expect(local(s, '3usdc')).toMatchObject({ kind: 'FAILED', code: 'COPILOT_CLARIFICATION_LIMIT' });
  });
  it('FloFi\'s own pool-read request never runs into the question limit', () => {
    const s = session();
    s.poolReader = ref => ({ ref, readAt: NOW, ok: false, code: 'BASE_MAINNET_NOT_ENABLED' });
    s.say('Add liquidity on Base with 10 USDC and 0.004 ETH, ±10%', intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'PERCENT', upper: '10' })));
    expect(local(s, 'Try again')?.code).toBe('COPILOT_POOL_PRICE_UNAVAILABLE');
    expect(local(s, 'Try again')?.code).toBe('COPILOT_POOL_PRICE_UNAVAILABLE');
    expect(s.state.clarifications).toBe(3);
    s.poolReader = ref => good(ref);
    expect(local(s, 'Try again')?.kind).toBe('PROPOSAL');
  });
  it('a malformed "successful" read is a failed read: a percentage is not computed, an explicit range proceeds without a position note', () => {
    const s = orcaOpen();
    s.poolReader = ref => ({ ref, readAt: NOW, ok: true, price: 'not-a-price', tick: 0, at: 1 });
    expect(local(s, '±10%')).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POOL_PRICE_UNAVAILABLE' });
    const t = orcaOpen();
    t.poolReader = ref => ({ ref, readAt: NOW, ok: true, price: 'not-a-price', tick: 0, at: 1 });
    const done = local(t, '150 to 180');
    expect(done?.kind).toBe('PROPOSAL');
    expect(notes(done)).not.toMatch(/current pool price is/);
  });
  it('a surface that cannot read pools is not offered a retry that cannot work', () => {
    const s = Object.assign(new CopilotSession(), { now: NOW });
    expect(s.say('Add liquidity on Orca on Solana with 0.1 SOL and 10 USDC, ±10%', intent.action(act.liquidity({ ...ORCA, deposits: SOL_USDC, rangeUnit: 'PERCENT', upper: '10' }))))
      .toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POOL_PRICE_UNAVAILABLE', options: [] });
  });
  it('a context change during the pool read ends the request instead of answering against stale state', () => {
    const s = orcaOpen(), before = s.state, env = { ...s.env(), poolReads: true, now: NOW };
    const first = startTurn(before, '±10%', env);
    expect(first.kind === 'LOCAL' && first.reply.pool).toBeTruthy();
    const changed = { ...env, wallet: '0x9999999999999999999999999999999999999999',
      verified: { orcaPrice: null, solanaOwner: null, orcaPositions: null, remaining: [], pools: [good(ORCA_MAINNET_POOL)] } };
    const replay = startTurn(before, '±10%', changed);
    expect(replay).toMatchObject({ kind: 'LOCAL', reply: { kind: 'FAILED', code: 'COPILOT_CONTEXT_CHANGED' } });
  });
  it('Review consistency: on Base the note gives the same ticks in the pool\'s own order (WETH per USDC) and names the token held', () => {
    const s = session();
    const reply = s.say('Add liquidity on Base with 10 USDC and 0.004 ETH, ±10%', intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'PERCENT', upper: '10' })));
    expect(notes(reply)).toMatch(/Review shows the same ticks, priced in the pool's order as [0-9.]+–[0-9.]+ WETH per USDC, before you sign\./);
    const t = session();
    const outside = t.say('Add liquidity on Base with 10 USDC and 0.004 ETH between 2000 and 2500 USDC',
      intent.action(act.catalogLiquidity({ ...BASE, rangeUnit: 'PRICE', lower: '2000', upper: '2500' })));
    expect(notes(outside)).toContain('The current pool price is outside this range: the position would hold only USDC');
    const o = orcaOpen();
    expect(notes(local(o, '100 to 120'))).toContain('The current pool price is outside this range: the position would hold only USDC');
    expect(notes(local(orcaOpen(), '200 to 300'))).toContain('the position would hold only SOL');
  });
  it('Ethereum (USDC is token0): ±10% in USDC per WETH uses the pool\'s own order, with no second price unit', () => {
    const s = session();
    const reply = s.say('Add liquidity on Ethereum with 10 USDC and 0.004 ETH, ±10%', intent.action(act.catalogLiquidity({ ...BASE, network: 'ETHEREUM', rangeUnit: 'PERCENT', upper: '10' })));
    const ticks = uniswapBandAroundSqrtPriceIn(sqrtRatioAtTick(TICKS['eip155:1']!), 1_000, SPACING, 'TOKEN0_PER_TOKEN1');
    expect(reply?.sentence).toBe(`add liquidity 10 USDC and 0.004 WETH on Ethereum ticks ${ticks.tickLower} to ${ticks.tickUpper} slippage 100 bps`);
    const usdc = (tick: number) => Number(uniswapPriceAtTick(tick, 6, 18, 'TOKEN0_PER_TOKEN1'));
    expect(usdc(ticks.tickUpper)).toBeLessThanOrEqual(3000 * 0.9 * 1.001); expect(usdc(ticks.tickLower)).toBeGreaterThanOrEqual(3000 * 1.1 * 0.999);
    expect(notes(reply)).toMatch(/Effective range after aligning to the pool's ticks: [0-9.]+–[0-9.]+ USDC per WETH/);
    expect(notes(reply)).not.toMatch(/pool's order/);
  });
  it('engineering scope: the Uniswap test pools say a percentage is not available instead of asking for one', () => {
    setActiveNetworkScope('ENGINEERING');
    const s = new CopilotSession();
    expect(s.say('Add Uniswap liquidity 100 USDC and 0.05 WETH on Base Sepolia in a percentage range',
      intent.action(act.liquidity({ protocol: 'UNISWAP_V3', network: 'BASE_SEPOLIA', deposits: [{ asset: 'USDC', maxAmount: '100' }, { asset: 'WETH', maxAmount: '0.05' }], rangeUnit: 'PERCENT' }))))
      .toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_RANGE_UNSUPPORTED' });
  });
});
