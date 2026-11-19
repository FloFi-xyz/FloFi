// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the owner's own liquidity positions managed from chat, in the public (Mainnet-only) scope. The engine, the
 * exact command validation and the editor are the real ones; the interpreter is scripted (exactly what a model may return) and the verified
 * positions are scripted discovery views handed to the engine exactly as the web chat hands them (Uniswap v3 on Base and Arbitrum One with the SAME
 * token id, Orca SOL/USDC on Solana). Scripted answers prove FloFi's deterministic resolution, not that a real model understands these phrases.
 * Nothing here signs, simulates on a network or sends a transaction: a conversational confirmation is never a wallet authorization.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catalogPoolOn, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as ORCA } from '@defi-workflow-engine/action-registry';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { FIXTURE, OTHER_ADDRESS, TEST_WALLET } from './copilot-test-fixtures';
import { finishTurn, startTurn, type CopilotReply, type CopilotVerified } from './copilot-conversation';
import { liquidityPositionOperations, type LiquidityPositionView } from './liquidity-positions';
import { mergeLiquidityFacts, positionScanFacts, readPositionAnswer, type CopilotLiquidityFacts } from './copilot-positions';
import { glossaryEntries, type LexiconEntry } from './copilot-lexicon';
import { setActiveNetworkScope } from './network-scope';

beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));
afterEach(() => setActiveNetworkScope(null));

const SOL_OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const BASE_WETH = { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 };
const BASE_USDC = { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
const ARB_WETH = { symbol: 'WETH', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18 };
const ARB_USDC = { symbol: 'USDC', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 };
type ViewPatch = Partial<Omit<LiquidityPositionView, 'operations'>>;
/** A verified Uniswap v3 view as discovery builds it: the CREATE2 pool of the pinned factory, the pinned position manager, the owner's own NFT. */
function uniswap(chain: 'eip155:8453' | 'eip155:42161', positionId: string, patch: ViewPatch = {}): LiquidityPositionView {
  const [a, b] = chain === 'eip155:8453' ? [BASE_WETH, BASE_USDC] : [ARB_WETH, ARB_USDC], profile = catalogPoolOn(chain, a, b, 500);
  const view = { ref: { protocol: 'UNISWAP_V3' as const, chain, network: chain === 'eip155:8453' ? 'Base' : 'Arbitrum One', manager: profile.positionManager, pool: profile.pool,
      positionId, owner: TEST_WALLET }, token0: { symbol: profile.token0.symbol, address: profile.token0.address, decimals: profile.token0.decimals },
    token1: { symbol: profile.token1.symbol, address: profile.token1.address, decimals: profile.token1.decimals }, feeTier: 500, tickLower: -200_000, tickUpper: -190_000,
    price: { base: 'USDC', quote: 'WETH' }, lowerPrice: '0.000207', upperPrice: '0.000560', currentPrice: '0.000333', rangeState: 'IN_RANGE' as const,
    liquidity: '123456789', principal: ['500000000000000000', '1500000000'] as const, recordedOwed: ['0', '0'] as const,
    collectable: ['1000000000000000', '2500000'] as const, status: 'OPEN' as const, manageable: { ok: true } as const, observedAt: '2026-11-19T00:00:00.000Z',
    observedAtHeight: 30_000_000, ...patch };
  return { ...view, operations: liquidityPositionOperations(view) };
}
function orca(patch: ViewPatch = {}): LiquidityPositionView {
  const view = { ref: { protocol: 'ORCA' as const, chain: ORCA.chain, network: 'Solana', manager: ORCA.programs.whirlpool, pool: ORCA.pool.address, positionId: MINT, owner: SOL_OWNER },
    token0: { symbol: 'SOL', address: ORCA.token0.mint, decimals: 9 }, token1: { symbol: 'USDC', address: ORCA.token1.mint, decimals: 6 }, feeTier: 3000,
    tickLower: -19_200, tickUpper: -18_560, price: { base: 'SOL', quote: 'USDC' }, lowerPrice: '146.5', upperPrice: '156.2', currentPrice: '150.1', rangeState: 'IN_RANGE' as const,
    liquidity: '1000000000', principal: ['100000000', '15000000'] as const, recordedOwed: ['1000', '50000'] as const, collectable: null, status: 'OPEN' as const,
    manageable: { ok: true } as const, observedAt: '2026-11-19T00:00:00.000Z', observedAtHeight: 380_000_000, ...patch };
  return { ...view, operations: liquidityPositionOperations(view) };
}
const BASE = uniswap('eip155:8453', '123456');
// The same token id on Arbitrum One is another position; this one is out of range and its WETH principal could not be read.
const ARB = uniswap('eip155:42161', '123456', { rangeState: 'BELOW_RANGE', principal: [null, '2000000000'], collectable: null });
const ORCA_POSITION = orca();
const WALLETS = [{ namespace: 'eip155' as const, address: TEST_WALLET, status: 'COMPLETE' as const }, { namespace: 'solana' as const, address: SOL_OWNER, status: 'COMPLETE' as const }];
const facts = (positions: readonly LiquidityPositionView[], wallets: CopilotLiquidityFacts['wallets'] = WALLETS): CopilotVerified =>
  ({ orcaPrice: null, solanaOwner: SOL_OWNER, orcaPositions: null, remaining: [], liquidity: { wallets, positions } });
function session(positions: readonly LiquidityPositionView[] = [BASE, ARB, ORCA_POSITION], language?: 'EN' | 'PT') {
  const s = new CopilotSession();
  s.walletChainId = 'eip155:8453';
  s.verified = facts(positions);
  if (language) s.interfaceLanguage = language;
  return s;
}
const position = (operation: string, extra: Record<string, unknown> = {}, language: 'EN' | 'PT' = 'EN') =>
  ({ version: '2', language, kind: 'POSITION', operation, protocol: null, network: null, percent: null, select: null, ...extra });
/** A turn FloFi must answer itself: the harness throws if the interpreter is asked without a scripted answer. */
function local(s: CopilotSession, text: string): CopilotReply {
  const reply = s.say(text)!;
  expect(s.turns.at(-1)!.request, `“${text}” must be answered without a model call`).toBeNull();
  return reply;
}
const textOf = (reply: CopilotReply | null) => [reply?.text ?? '', ...reply?.notes ?? [], ...reply?.options ?? []].join('\n');
const choiceOf = (reply: CopilotReply | null) => {
  expect(reply?.command?.type, reply?.text).toBe('MANAGE_LIQUIDITY_POSITION');
  return (reply!.command as Extract<NonNullable<CopilotReply['command']>, { type: 'MANAGE_LIQUIDITY_POSITION' }>);
};

describe('reading the owner’s positions (FloFi’s own answer from verified facts)', () => {
  it('lists every position with protocol, network, pair, fee tier, id, range state and principal; an unread amount is “unavailable”, never 0', () => {
    const s = session();
    const reply = s.say('Show my liquidity positions', position('LIST'))!;
    expect(reply).toMatchObject({ kind: 'ANSWER', text: 'You have 3 liquidity positions in your connected wallets:' });
    expect(reply.command).toBeUndefined();
    expect(reply.notes).toContain('Uniswap v3 WETH/USDC 0.05% position #123456 on Base — in range; Range 0.000207–0.000560 WETH per USDC; 0.5 WETH + 1500 USDC');
    expect(reply.notes).toContain('Uniswap v3 WETH/USDC 0.05% position #123456 on Arbitrum One — out of range (below it); Range 0.000207–0.000560 WETH per USDC; unavailable WETH + 2000 USDC');
    expect(textOf(reply)).toContain('Orca SOL/USDC 0.3% position 7xKX…gAsU on Solana — in range');
    expect(textOf(reply)).toContain('Fees owed recorded on chain: 0.000001 SOL + 0.05 USDC');
    expect(textOf(reply)).not.toMatch(/APY|APR|PnL|profit|0 WETH \+ 2000/i);
    expect(s.state.draft).toBeNull();
  });
  it('answers “which are in range?” with the in-range positions only', () => {
    const s = session();
    const reply = s.say('Which of my pools are in range?', position('LIST'))!;
    expect(reply.text).toBe('2 of your 3 liquidity positions are in range:');
    expect(textOf(reply)).toContain('position #123456 on Base');
    expect(textOf(reply)).not.toContain('Arbitrum One');
    expect(s.say('Which ones are out of range?', position('LIST'))!.text).toBe('1 of your 3 liquidity positions is out of range:');
  });
  it('lists in Portuguese', () => {
    const s = session(undefined, 'PT');
    const reply = s.say('Quais são as minhas pools?', position('LIST', {}, 'PT'))!;
    expect(reply.text).toBe('Você tem 3 posições de liquidez nas suas carteiras conectadas:');
    expect(textOf(reply)).toContain('posição Uniswap v3 WETH/USDC 0.05% #123456 na Base — dentro da faixa');
    expect(textOf(reply)).toContain('fora da faixa (abaixo dela)');
  });
  it('inspects what can be collected now versus what is recorded as owed (exact amounts; an unread collectable is said as such)', () => {
    const s = session();
    const reply = s.say('How much can I collect from my Uniswap position?', position('INSPECT', { protocol: 'UNISWAP_V3' }))!;
    expect(reply).toMatchObject({ kind: 'ANSWER', text: '2 positions match:' });
    const text = textOf(reply);
    expect(text).toContain('Collectable now: 0.001 WETH + 2.5 USDC.');
    expect(text).toContain('Owed tokens recorded on chain (may include principal removed earlier, not only fees): 0 WETH + 0 USDC.');
    expect(text).toContain('Collectable now: not read (Simulate states the exact amount before you sign).');
    expect(text).toContain('Liquidity (principal at the current price): unavailable WETH + 2000 USDC.');
    expect(text).not.toContain('Orca');
    const one = session([ORCA_POSITION]).say('What does my Orca position hold?', position('INSPECT', { protocol: 'ORCA' }))!;
    expect(one.text).toBe('Your Orca SOL/USDC 0.3% position 7xKX…gAsU on Solana:');
    expect(textOf(one)).toContain('Fees owed recorded on chain: 0.000001 SOL + 0.05 USDC.');
    expect(textOf(one)).toContain('FloFi can prepare: collect fees and owed tokens, remove part of the liquidity, exit (remove all).');
  });
});

describe('preparing an operation the owner asked for (MANAGE_LIQUIDITY_POSITION, never executed from chat)', () => {
  it('collects the fees of the Base position only: liquidity unchanged, network default slippage, principal as the pool input', () => {
    const s = session();
    const reply = s.say('Collect my fees on Base', position('COLLECT', { network: 'BASE' }))!;
    const command = choiceOf(reply);
    expect(command).toMatchObject({ source: 'CHAT', baseRevision: 0, choice: { operation: 'COLLECT', partBps: null, close: false, position: BASE.ref },
      pool: { token0: BASE.token0, token1: BASE.token1, feeTier: 500, tickLower: -200_000, tickUpper: -190_000, amount0: '500000000000000000', amount1: '1500000000', slippageBps: 100 } });
    expect(reply.sentence).toBe('collect the fees and owed tokens of Uniswap v3 position #123456 WETH/USDC on Base');
    expect(reply.text).toBe('Collect the fees and owed tokens of your Uniswap v3 WETH/USDC 0.05% position #123456 on Base. Its liquidity stays in the position. ' +
      'Apply the proposal, then Simulate, Review and sign in your wallet.');
    expect(reply.notes).toContain('Collecting never removes liquidity. If nothing is due, Simulate says so and nothing is sent.');
    // Applying only stages the position's own pool step on its network (its operation travels with the staged choice); nothing is signed or sent.
    s.apply();
    const steps = s.workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
    expect(steps.map(node => [node.actionType, node.chainId])).toEqual([['asset.liquidity.concentrated', 'eip155:8453']]);
  });
  it('“Coleta minhas taxas da Uniswap” asks which Uniswap position (same token id on two networks) and never auto-selects', () => {
    const s = session(undefined, 'PT');
    const which = s.say('Coleta minhas taxas da Uniswap', position('COLLECT', { protocol: 'UNISWAP_V3' }, 'PT'))!;
    expect(which).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POSITION_WHICH', text: 'Qual posição você quer dizer?' });
    expect(which.command).toBeUndefined();
    expect(which.options).toEqual(['Uniswap v3 · Base · WETH/USDC 0.05% · #123456 · 0.5 WETH + 1500 USDC · dentro da faixa',
      'Uniswap v3 · Arbitrum One · WETH/USDC 0.05% · #123456 · indisponível WETH + 2000 USDC · fora da faixa (abaixo dela)']);
    expect(choiceOf(local(s, 'Arbitrum')).choice).toMatchObject({ operation: 'COLLECT', position: { chain: 'eip155:42161', positionId: '123456' } });
  });
  it('“Remove 50% of my liquidity” with several positions → which → “the first one” (local) → the proposal', () => {
    const s = session();
    const which = s.say('Remove 50% of my liquidity', position('DECREASE', { percent: '50' }))!;
    expect(which).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POSITION_WHICH' });
    expect(which.options).toHaveLength(3);
    const reply = local(s, 'the first one');
    expect(choiceOf(reply).choice).toEqual({ position: BASE.ref, operation: 'DECREASE', partBps: 5000, close: false });
    expect(reply.sentence).toBe('remove 50% of the liquidity of Uniswap v3 position #123456 WETH/USDC on Base');
    expect(reply.notes).toContain('The removal is bounded by 100 bps of slippage (this network’s default); Review shows the minimum amounts before you sign.');
  });
  it('“Retira metade da minha liquidez” → which → “a segunda” (local): the Arbitrum position, never an Aave Withdraw', () => {
    const s = session(undefined, 'PT');
    expect(s.say('Retira metade da minha liquidez', position('DECREASE', { percent: '50' }, 'PT'))).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POSITION_WHICH' });
    const reply = local(s, 'a segunda');
    expect(choiceOf(reply).choice).toMatchObject({ operation: 'DECREASE', partBps: 5000, position: { chain: 'eip155:42161' } });
    expect(reply.text).toBe('Remover 50% da liquidez da sua posição Uniswap v3 WETH/USDC 0.05% #123456 na Arbitrum One e coletar os tokens liberados com as taxas. ' +
      'Aplique a proposta e depois simule, revise e assine na sua carteira.');
    expect(reply.notes).toContain('Parte do principal desta posição não pôde ser lida agora; o Simulate lê de novo antes de você assinar.');
    // Even an interpreter that read it as an Aave Withdraw prepares a position removal: the words are about the user's liquidity.
    const misread = session(undefined, 'PT');
    const rerouted = misread.say('retira metade da minha liquidez', intent.action(act.lending('WITHDRAW', { asset: null, amount: null }), 'PT'))!;
    expect(rerouted).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POSITION_WHICH' });
    expect(local(misread, 'o último').command).toMatchObject({ type: 'MANAGE_LIQUIDITY_POSITION', choice: { operation: 'DECREASE', partBps: 5000, position: { protocol: 'ORCA' } } });
  });
  it('“sacar meu USDC da Aave” stays an Aave Withdraw', () => {
    const s = new CopilotSession();
    s.verified = facts([BASE]);
    const reply = s.say('sacar 10 USDC da Aave na Base', intent.action(act.lending('WITHDRAW', { asset: 'USDC', amount: '10', network: 'BASE' }), 'PT'))!;
    expect(reply.command?.type).toBe('ADD_WITHDRAW');
    // The glossary never tells the model that "sacar" means an Aave Withdraw when the words are about liquidity.
    const global: LexiconEntry[] = [{ term: 'sacar', target: 'operation:WITHDRAW', source: 'GLOBAL' }, { term: 'retirar', target: 'operation:WITHDRAW', source: 'GLOBAL' }];
    expect(glossaryEntries('quero sacar minha liquidez da pool', global)).toEqual([]);
    expect(glossaryEntries('retirar liquidez', global)).toEqual([]);
    expect(glossaryEntries('sacar meu USDC da Aave', global).map(entry => entry.term)).toEqual(['sacar']);
  });
  it('asks the portion with only the operations the position offers, and reads “metade”, “50”, “tudo” and “só os rendimentos” locally', () => {
    const answers: readonly [string, Record<string, unknown>][] = [['metade', { operation: 'DECREASE', partBps: 5000 }], ['50', { operation: 'DECREASE', partBps: 5000 }],
      ['12,5%', { operation: 'DECREASE', partBps: 1250 }], ['tudo', { operation: 'EXIT', partBps: null, close: false }], ['100%', { operation: 'EXIT', partBps: null, close: false }],
      ['só os rendimentos', { operation: 'COLLECT', partBps: null, close: false }], ['half', { operation: 'DECREASE', partBps: 5000 }],
      ['all of it', { operation: 'EXIT', close: false }], ['only the fees', { operation: 'COLLECT' }]];
    for (const [answer, expected] of answers) {
      const s = session([BASE]);
      const portion = s.say('quero tirar um pouco da minha liquidez na Base', position('DECREASE', { network: 'BASE' }, 'PT'))!;
      expect(portion).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POSITION_PORTION', options: ['25%', '50%', '75%', 'Tudo (sair)'] });
      expect(portion.text).toBe('Quanto da liquidez da sua posição Uniswap v3 WETH/USDC 0.05% #123456 na Base o FloFi deve remover? Escolha 25%, 50% ou 75%, digite outra porcentagem, ou remova tudo (sair).');
      expect(choiceOf(local(s, answer)).choice, answer).toMatchObject(expected);
    }
    const s = session([BASE]);
    s.say('Remove some liquidity from my Base position', position('DECREASE', { network: 'BASE' }));
    expect(local(s, 'All (exit)').command).toMatchObject({ choice: { operation: 'EXIT', close: false } });
  });
  it('a which → portion → yes dialogue never exhausts the clarification budget, even after the model asked twice', () => {
    const s = session();
    expect(s.say('remove some liquidity', intent.clarify(['target'], 'Which liquidity do you mean?'))!.kind).toBe('CLARIFICATION');
    expect(s.say('the pools', intent.clarify(['target'], 'Which pools?'))!.kind).toBe('CLARIFICATION');
    const which = s.say('my Uniswap positions', position('DECREASE', { protocol: 'UNISWAP_V3' }))!;
    expect(which).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POSITION_WHICH' });
    expect(s.state.clarifications).toBe(3);
    expect(local(s, 'the second one')).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POSITION_PORTION' });
    expect(local(s, 'yes')).toMatchObject({ kind: 'CLARIFICATION', text: 'Which one? Choose one of the options.' });
    expect(choiceOf(local(s, '25%')).choice).toMatchObject({ operation: 'DECREASE', partBps: 2500, position: { chain: 'eip155:42161' } });
  });
  it('a Uniswap exit keeps the NFT unless the user asks to close it; “yes, close it” / “sim, fecha” then burns it (local)', () => {
    const s = session();
    const exit = s.say('Withdraw everything from my WETH/USDC position on Base', position('EXIT', { network: 'BASE', select: { ordinal: null, assets: ['WETH', 'USDC'] } }))!;
    expect(choiceOf(exit).choice).toEqual({ position: BASE.ref, operation: 'EXIT', partBps: null, close: false });
    expect(exit.notes).toContain('The position NFT stays in your wallet. To also close it (burn the NFT), say “close it”.');
    expect(exit.sentence).toBe('remove all liquidity from Uniswap v3 position #123456 WETH/USDC on Base');
    const close = local(s, 'yes, close it');
    expect(choiceOf(close).choice).toEqual({ position: BASE.ref, operation: 'EXIT', partBps: null, close: true });
    expect(close.text).toContain('collect everything owed and close the position: its NFT is burned.');
    expect(close.notes).toContain('Closing burns the position NFT, so the position cannot be reopened or added to.');

    const pt = session([BASE], 'PT');
    expect(choiceOf(pt.say('Quero sair completamente dessa pool', position('EXIT', {}, 'PT'))).choice).toMatchObject({ operation: 'EXIT', close: false });
    expect(choiceOf(local(pt, 'sim, fecha')).choice).toMatchObject({ operation: 'EXIT', close: true });
    // "Close" on a Uniswap position with liquidity: everything is removed, collected and the NFT burned — said clearly.
    const direct = session([BASE, ARB]).say('Close my Uniswap position on Arbitrum', position('CLOSE', { protocol: 'UNISWAP_V3', network: 'ARBITRUM' }))!;
    expect(choiceOf(direct).choice).toMatchObject({ operation: 'EXIT', close: true, position: { chain: 'eip155:42161' } });
    expect(direct.text).toBe('Remove all liquidity from your Uniswap v3 WETH/USDC 0.05% position #123456 on Arbitrum One, collect everything owed and close the position: its NFT is burned. ' +
      'Apply the proposal, then Simulate, Review and sign in your wallet.');
    // A model's CLOSE without the user's own close words never burns.
    expect(choiceOf(session([BASE]).say('Withdraw everything from my position', position('CLOSE'))).choice).toMatchObject({ operation: 'EXIT', close: false });
  });
  it('an Orca exit always closes the position and says the rent is refunded', () => {
    const s = session();
    const reply = s.say('Close my Orca position', position('CLOSE', { protocol: 'ORCA' }))!;
    expect(choiceOf(reply).choice).toEqual({ position: ORCA_POSITION.ref, operation: 'EXIT', partBps: null, close: true });
    expect(reply.sentence).toBe('remove all liquidity from Orca position 7xKX…gAsU SOL/USDC on Solana and close it');
    expect(reply.notes).toContain('An Orca exit always closes the position: its position NFT is closed and the rent of its accounts is refunded to your wallet.');
    expect(choiceOf(reply).pool).toMatchObject({ amount0: '100000000', amount1: '15000000', slippageBps: 100, feeTier: 3000, tickLower: -19_200, tickUpper: -18_560 });
    s.apply();
    expect(s.workflow.nodes.filter(node => !node.actionType.startsWith('mock-')).map(node => [node.actionType, node.chainId])).toEqual([['asset.liquidity.concentrated', ORCA.chain]]);
    const pt = session([ORCA_POSITION], 'PT').say('Sai da minha posição na Orca', position('EXIT', { protocol: 'ORCA' }, 'PT'))!;
    expect(choiceOf(pt).choice).toMatchObject({ operation: 'EXIT', close: true });
    expect(pt.notes).toContain('Sair de uma posição na Orca sempre a fecha: o NFT da posição é fechado e o aluguel (rent) das contas dela é devolvido à sua carteira.');
  });
});

describe('what FloFi refuses, honestly', () => {
  it('a collection never becomes a removal: an empty position with nothing owed has nothing to collect', () => {
    const empty = uniswap('eip155:8453', '777', { liquidity: '0', status: 'EMPTY', principal: ['0', '0'], recordedOwed: ['0', '0'], collectable: ['0', '0'], rangeState: null });
    expect(empty.operations).toEqual(['EXIT']);
    const s = session([empty]);
    const reply = s.say('Collect my fees', position('COLLECT'))!;
    expect(reply).toMatchObject({ kind: 'UNSUPPORTED', text: 'FloFi cannot prepare this for your Uniswap v3 WETH/USDC 0.05% position #777 on Base: it has no liquidity and nothing owed to collect. Nothing changed.' });
    expect(reply.command).toBeUndefined();
    // Closing that emptied position is what it offers: no removal, only the burn.
    const close = session([empty]).say('close my empty position', position('CLOSE'))!;
    expect(choiceOf(close).choice).toMatchObject({ operation: 'EXIT', close: true });
    expect(close.text).toContain('Collect anything still owed by your Uniswap v3 WETH/USDC 0.05% position #777 on Base and close it: its position NFT is burned.');
  });
  it('explains a wallet that is not connected, not verified, unreadable or partly read, and a position it cannot manage', () => {
    const none = session(); none.verified = facts([], []);
    expect(none.say('Show my pools', position('LIST'))).toMatchObject({ kind: 'UNSUPPORTED',
      text: 'Connect the wallet that holds the position (an EVM wallet for Uniswap v3, a Solana wallet for Orca) so FloFi can read its positions. Nothing changed.' });
    const solana = session(); solana.verified = facts([BASE], [WALLETS[0]!]);
    expect(solana.say('Close my Orca position', position('CLOSE', { protocol: 'ORCA' }))!.text).toBe('Connect your Solana wallet so FloFi can read its Orca positions. Nothing changed.');
    const unverified = session(); unverified.verified = facts([], [{ ...WALLETS[0]!, status: 'UNVERIFIED' }]);
    expect(unverified.say('Collect my fees', position('COLLECT'))!.text).toBe('FloFi reads positions only for a wallet verified or linked in your FloFi session. Verify or link the connected wallet, then ask again. Nothing changed.');
    const unavailable = session(); unavailable.verified = facts([], [{ ...WALLETS[0]!, status: 'UNAVAILABLE' }]);
    expect(unavailable.say('Collect my fees', position('COLLECT'))).toMatchObject({ kind: 'FAILED', code: 'COPILOT_POSITIONS_UNAVAILABLE',
      text: 'FloFi could not read your positions right now, so it cannot select one. Try again in a moment. Nothing changed.' });
    const partial = session(); partial.verified = facts([BASE], [{ ...WALLETS[0]!, status: 'PARTIAL' }]);
    expect(partial.say('Show my pools', position('LIST'))!.notes).toContain('Some networks could not be read right now: positions there are not shown, and FloFi does not assume there are none.');
    const unmanaged = uniswap('eip155:8453', '99', { manageable: { ok: false, reason: 'POOL_NOT_VERIFIED' } });
    expect(unmanaged.operations).toEqual([]);
    expect(session([unmanaged]).say('Remove 50% of my liquidity', position('DECREASE', { percent: '50' }))!.text)
      .toBe('FloFi cannot prepare this for your Uniswap v3 WETH/USDC 0.05% position #99 on Base: its pool is not one FloFi can verify (a token outside the network’s official catalog, or a non-standard pool). Nothing changed.');
    const legacy = orca({ manageable: { ok: false, reason: 'LEGACY_POSITION_TOKEN' } });
    expect(session([legacy]).say('Close my Orca position', position('CLOSE', { protocol: 'ORCA' }))!.text).toContain('an older Orca position token');
    const rewards = orca({ manageable: { ok: false, reason: 'REWARDS_UNSUPPORTED' } });
    expect(session([rewards]).say('Collect my Orca fees', position('COLLECT', { protocol: 'ORCA' }))!.text).toContain('Orca rewards owed, which FloFi does not collect');
  });
  it('refuses a workflow with other steps, and a chat channel (no verified wallet there)', () => {
    const s = new CopilotSession([FIXTURE.baseSwap]);
    s.verified = facts([BASE]);
    expect(s.say('Collect my fees', position('COLLECT'))).toMatchObject({ kind: 'UNSUPPORTED',
      text: 'This workflow has other steps. A position is managed from a workflow that holds only its position step: remove or finish the other steps first, or start a new workflow. Nothing changed.' });
    const channel = session();
    const start = startTurn(channel.state, 'Collect my fees', { ...channel.env(), surface: 'TELEGRAM' });
    if (start.kind !== 'REMOTE') throw new Error('expected a model turn');
    const done = finishTurn(start.turn, { ok: true, intent: position('COLLECT') }, { ...channel.env(), surface: 'TELEGRAM' });
    expect(done.reply).toMatchObject({ kind: 'UNSUPPORTED' });
    expect(done.reply.text).toContain('done in the FloFi web app');
    expect(done.reply.command).toBeUndefined();
  });
  it('never proposes a Devnet position in the public product', () => {
    const s = session();
    s.verified = { ...facts([BASE]), orcaPositions: [{ positionMint: MINT, status: 'ACTIVE', tickLower: -19_200, tickUpper: -18_560, liquidity: '1000' }],
      orcaPrice: { price: '150', tickCurrentIndex: -18_880 } };
    const devnet = s.say('Remove 50% of my Solana Devnet liquidity', position('DECREASE', { percent: '50', network: 'SOLANA_DEVNET' }))!;
    expect(devnet).toMatchObject({ kind: 'UNSUPPORTED', text: 'Solana Devnet is a test network. FloFi runs on mainnets only, with real funds: rebuild this on Solana.' });
    const reply = s.say('Remove 50% of my liquidity', position('DECREASE', { percent: '50' }))!;
    expect(choiceOf(reply).choice.position.chain).toBe('eip155:8453');
    for (const turn of s.turns) expect(textOf(turn.reply)).not.toMatch(/devUSDC|Devnet position|MANAGE_SOLANA_POSITION/);
    expect(s.turns.every(turn => turn.reply?.command?.type !== 'MANAGE_SOLANA_POSITION')).toBe(true);
  });
});

describe('the structured reference is re-read every turn', () => {
  it('a wallet switch mid-dialogue invalidates the open question (COPILOT_CONTEXT_CHANGED); nothing is proposed', () => {
    const s = session();
    s.say('Remove 50% of my liquidity', position('DECREASE', { percent: '50' }));
    s.wallet = OTHER_ADDRESS;
    const reply = local(s, 'the first one');
    expect(reply).toMatchObject({ kind: 'FAILED', code: 'COPILOT_CONTEXT_CHANGED' });
    expect(reply.command).toBeUndefined();
    expect(s.state.draft).toBeNull();
  });
  it('a chosen position that is no longer in the verified facts ends the request', () => {
    const s = session();
    s.say('Remove some of my liquidity', position('DECREASE'));
    expect(local(s, 'the first one')).toMatchObject({ code: 'COPILOT_POSITION_PORTION' });
    s.verified = facts([ARB, ORCA_POSITION]);
    expect(local(s, '50%')).toMatchObject({ kind: 'FAILED', code: 'COPILOT_CONTEXT_CHANGED' });
  });
  it('an ordinal the user wrote picks among the eligible positions; one that does not exist is asked again', () => {
    const s = session();
    expect(choiceOf(s.say('Collect the fees of my second position', position('COLLECT', { select: { ordinal: 'SECOND', assets: [] } }))).choice.position.chain).toBe('eip155:42161');
    // A model's ordinal or pair that is not in the user's words never narrows the choice.
    const t = session();
    expect(t.say('Collect my fees', position('COLLECT', { select: { ordinal: 'FIRST', assets: ['WETH', 'USDC'] } }))).toMatchObject({ kind: 'CLARIFICATION', code: 'COPILOT_POSITION_WHICH' });
    const u = session();
    expect(u.say('Collect the fees of my fifth position', position('COLLECT', { select: { ordinal: 'FIFTH', assets: [] } }))).toMatchObject({ kind: 'CLARIFICATION',
      text: 'Only 3 positions match. Which one do you mean?' });
  });
});

describe('reading verified facts and short answers', () => {
  it('turns a discovery answer into facts of that owner only; an unread network makes the wallet PARTIAL', () => {
    const scans = [{ protocol: 'Aave V3', status: 'COMPLETE', positions: [{ id: 'x' }] },
      { protocol: 'Uniswap V3', network: 'Base', status: 'COMPLETE', positions: [{ id: '123456', liquidity: BASE }, { id: '5', liquidity: { ...BASE, ref: { ...BASE.ref, owner: OTHER_ADDRESS } } },
        { id: '6', liquidity: { ...BASE, feeTier: 'x' } }] },
      { protocol: 'Uniswap V3', network: 'Arbitrum One', status: 'NETWORK_UNAVAILABLE', positions: [] }];
    const read = positionScanFacts({ namespace: 'eip155', address: TEST_WALLET.toUpperCase().replace('0X', '0x') }, scans);
    expect(read).toEqual({ wallet: { namespace: 'eip155', address: TEST_WALLET, status: 'PARTIAL' }, positions: [BASE] });
    expect(positionScanFacts({ namespace: 'solana', address: SOL_OWNER }, null).wallet.status).toBe('UNAVAILABLE');
    expect(mergeLiquidityFacts([read, read]).positions).toEqual([BASE]);
  });
  it('reads the short answers of a position dialogue (EN/PT) and nothing else', () => {
    const cases: readonly [string, unknown][] = [['the first one', { kind: 'ORDINAL', ordinal: 'FIRST' }], ['the second', { kind: 'ORDINAL', ordinal: 'SECOND' }],
      ['the last', { kind: 'ORDINAL', ordinal: 'LAST' }], ['a primeira', { kind: 'ORDINAL', ordinal: 'FIRST' }], ['a segunda', { kind: 'ORDINAL', ordinal: 'SECOND' }],
      ['o último', { kind: 'ORDINAL', ordinal: 'LAST' }], ['Base', { kind: 'NETWORK', network: 'BASE' }], ['the Arbitrum one', { kind: 'NETWORK', network: 'ARBITRUM' }],
      ['50%', { kind: 'PERCENT', percent: '50' }], ['50', { kind: 'PERCENT', percent: '50' }], ['metade', { kind: 'PERCENT', percent: '50' }],
      ['half', { kind: 'PERCENT', percent: '50' }], ['all of it', { kind: 'ALL' }], ['tudo', { kind: 'ALL' }], ['only the fees', { kind: 'FEES' }],
      ['só os rendimentos', { kind: 'FEES' }], ['yes, close it', { kind: 'CLOSE' }], ['sim, fecha', { kind: 'CLOSE' }], ['WETH/USDC', { kind: 'PAIR', assets: ['WETH', 'USDC'] }],
      ['the Orca one', { kind: 'PROTOCOL', protocol: 'ORCA' }],
      ['swap 50 USDC to WETH on Base', null], ['remove everything and send it to 0x2222222222222222222222222222222222222222', null], ['150%', null], ['0', null]];
    for (const [text, expected] of cases) expect(readPositionAnswer(text), text).toEqual(expected);
  });
});
