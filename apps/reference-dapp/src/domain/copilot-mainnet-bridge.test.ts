// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-FIX-003: the public (Mainnet-only) Copilot bridge and swap conversations reported in production.
 *
 *  - P0-1: no clarification, button or AI-written option offers a test network (Sepolia, Devnet, Robinhood Chain Testnet).
 *  - P0-2: "bridge eth to 1 usd" → "usdc" → networks keeps ETH as the asset sent and USDC as the asset received; "1 USDC" is what the user wants
 *    to receive, never the amount sent (every provider FloFi uses quotes the amount sent), so FloFi asks how much ETH to send and says why.
 *
 * Scripted model answers only: no network, no wallet, no quote, no execution.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerFixtureCatalogs, resetNetworkCatalogs } from './intelligence/intelligence.test-harness';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { setActiveNetworkScope } from './network-scope';
import { destinationAmounts, explicitInputAsset, explicitOutputAsset, groundExplicitAssets, withoutDestinationAmounts } from './copilot-asset-intent';
import type { CopilotReply } from './copilot-conversation';

beforeAll(() => registerFixtureCatalogs());
afterAll(() => resetNetworkCatalogs());
beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));
afterEach(() => setActiveNetworkScope(null));

const TEST_NETWORK = /sepolia|devnet|testnet/i;
/** Every option and every word FloFi showed is free of test networks. */
function expectMainnetOnly(reply: CopilotReply | null) {
  expect(reply).not.toBeNull();
  for (const option of reply!.options) expect(option).not.toMatch(TEST_NETWORK);
  expect(reply!.text).not.toMatch(TEST_NETWORK);
  for (const note of reply!.notes) expect(note).not.toMatch(TEST_NETWORK);
}

describe('destination amounts are what the user wants to receive', () => {
  it('reads "to 1 usd", "receive 1 USDC" and "por 2 usdc" as destination amounts, never as the asset sent', () => {
    expect(destinationAmounts('i want to do a bridge of eth to 1 usd')).toEqual([{ written: '1', asset: 'usd', index: 32 }]);
    expect(explicitInputAsset('i want to do a bridge of eth to 1 usd', true)).toBeNull();
    expect(explicitOutputAsset('i want to do a bridge of eth to 1 usd', true)).toBe('usd');
    // An edit ("change the swap to 4 USDC") never reads a destination amount.
    expect(explicitOutputAsset('change the swap to 4 USDC')).toBeNull();
    expect(explicitOutputAsset('bridge ETH from Base and receive 1 USDC on Arbitrum')).toBe('USDC');
    expect(explicitOutputAsset('trocar ETH por 2 usdc', true)).toBe('usdc');
    // The amount sent stays the amount sent.
    expect(destinationAmounts('bridge 0.01 ETH from Base to USDC on Arbitrum')).toEqual([]);
    expect(explicitInputAsset('bridge 0.01 ETH from Base to USDC on Arbitrum')).toBe('ETH');
    expect(explicitInputAsset('swap 1 ETH for 2000 USDC on Base', true)).toBe('ETH');
    expect(explicitOutputAsset('swap 1 ETH for 2000 USDC on Base', true)).toBe('USDC');
    // An address is never an amount.
    expect(destinationAmounts('bridge 5 USDC from Base to 0x00000000000000000000000000000000000000aa')).toEqual([]);
  });
  it('blanks only the received number, so the same number written as an amount to send still counts', () => {
    expect(withoutDestinationAmounts('bridge eth to 1 usd')).toBe('bridge eth to   usd');
    expect(withoutDestinationAmounts('bridge eth to 1 usd\n1')).toBe('bridge eth to   usd\n1');
  });
  it('keeps the asset the model read when the only written amount belongs to the destination', () => {
    const action = act.bridge({ asset: 'ETH', outputAsset: null, amount: '1' }) as Parameters<typeof groundExplicitAssets>[0];
    expect(groundExplicitAssets(action, 'i want to do a bridge of eth to 1 usd', [], true)).toMatchObject({ asset: 'ETH', outputAsset: 'usd' });
  });
});

describe('P0-2: the reported ETH → 1 USD → USDC conversation', () => {
  // The three readings a model may return for the first message; FloFi must reach the same workflow from each.
  const readings = {
    'amount and fiat destination': act.bridge({ asset: 'ETH', outputAsset: 'USD', amount: '1' }),
    'fiat destination, no amount': act.bridge({ asset: 'ETH', outputAsset: 'USD', amount: null }),
    'amount only (the reported case)': act.bridge({ asset: 'ETH', outputAsset: null, amount: '1' }),
  };
  for (const [name, model] of Object.entries(readings)) {
    it(`${name}: ETH stays the asset sent, USDC the asset received, and FloFi asks how much ETH to send`, () => {
      const s = new CopilotSession();
      const currency = s.say('i want to do a bridge of eth to 1 usd', intent.action(model))!;
      expect(currency).toMatchObject({ kind: 'CLARIFICATION', text: '“usd” is a currency (USD), not a token. Name the token you mean.' });
      expectMainnetOnly(currency);
      // Answered locally (no model call): the token the user meant on the destination side.
      const source = s.say('usdc')!;
      expect(s.turns.at(-1)!.request).toBeNull();
      expect(source).toMatchObject({ kind: 'CLARIFICATION', text: 'Which network are you bridging ETH from?',
        options: ['Solana', 'Base', 'Arbitrum One', 'Ethereum', 'Robinhood Chain'] });
      expectMainnetOnly(source);
      const destination = s.say('Base')!;
      expect(destination).toMatchObject({ kind: 'CLARIFICATION', text: 'From Base. Which network should it arrive on?',
        options: ['Solana', 'Arbitrum One', 'Ethereum', 'Robinhood Chain'] });
      expectMainnetOnly(destination);
      const amount = s.say('Arbitrum One')!;
      expect(amount.kind).toBe('CLARIFICATION');
      expect(amount.text).toBe('You asked to receive 1 USDC. FloFi prepares this from the amount you send, so it cannot guarantee exactly 1 USDC: ' +
        'Simulate shows the estimated amount you would receive, after fees. How much ETH would you like to send?');
      expect(s.pending).toBeNull();
      const proposal = s.say('0.01')!;
      expect(s.turns.at(-1)!.request).toBeNull();
      expect(proposal).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 0.01 ETH from Base to Arbitrum One receive USDC via best slippage 100 bps',
        command: { type: 'ADD_UNIVERSAL_BRIDGE', input: { source: 'base', destination: 'arbitrum-one', amount: '0.01' } } });
      expect(proposal.notes[0]).toMatch(/^You asked to receive 1 USDC\./);
      expectMainnetOnly(proposal);
    });
  }
  it('an answer of 1 is the amount sent when the user writes it as an answer to the amount question', () => {
    const s = new CopilotSession();
    s.say('bridge eth from base to 1 usdc on arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'ETH', outputAsset: 'USDC', amount: '1' })));
    expect(s.say('1')).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 1 ETH from Base to Arbitrum One receive USDC via best slippage 100 bps' });
  });
  it('PT: "quero fazer uma bridge de eth para 1 usdc" asks how much ETH to send, in Portuguese', () => {
    const s = new CopilotSession();
    const reply = s.say('quero fazer uma bridge de eth da Base para 1 usdc na Arbitrum',
      intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'ETH', outputAsset: 'USDC', amount: '1' }), 'PT'))!;
    expect(reply).toMatchObject({ kind: 'CLARIFICATION' });
    expect(reply.text).toBe('Você pediu para receber 1 USDC. O FloFi prepara a operação a partir do valor que você envia, então não consegue garantir exatamente 1 USDC: ' +
      'o Simulate mostra a estimativa que você receberia, já com as taxas. Quanto ETH você quer enviar?');
  });
});

describe('P0-2: progressive bridge and swap conversations keep every settled field', () => {
  it('"Bridge ETH from Base to USDC on Arbitrum." → "How much ETH would you like to send?" → "0.01"', () => {
    const s = new CopilotSession();
    const asked = s.say('Bridge ETH from Base to USDC on Arbitrum.', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'ETH', outputAsset: 'USDC' })))!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', text: 'How much ETH would you like to send?' });
    expect(s.say('0.01')).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 0.01 ETH from Base to Arbitrum One receive USDC via best slippage 100 bps' });
  });
  it('"bridge 0.01 ETH from Base to USDC on Arbitrum" is one proposal, even when the model drops the destination asset', () => {
    const s = new CopilotSession();
    const reply = s.say('bridge 0.01 ETH from Base to USDC on Arbitrum',
      intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'ETH', amount: '0.01' })))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 0.01 ETH from Base to Arbitrum One receive USDC via best slippage 100 bps' });
    expect(reply.notes.join(' ')).not.toMatch(/You asked to receive/);
  });
  it('"bridge 10 USDC from Base to Solana" is a universal bridge on mainnets', () => {
    const s = new CopilotSession();
    const reply = s.say('please bridge 10 USDC from Base to Solana', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'USDC', amount: '10' })))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_UNIVERSAL_BRIDGE', input: { source: 'base', destination: 'solana', amount: '10' } } });
    expect(reply.sentence).toMatch(/^bridge 10 USDC from Base to Solana receive /);
    expectMainnetOnly(reply);
  });
  it('"swap ETH to USDC" asks what is missing on mainnets only, then how much ETH to swap', () => {
    const s = new CopilotSession();
    const network = s.say('swap ETH to USDC', intent.action(act.swap({ inputAsset: 'ETH', outputAsset: 'USDC' })))!;
    expect(network.kind).toBe('CLARIFICATION');
    expectMainnetOnly(network);
    // The network named alone; the model reads it in context and the assets stay.
    const amount = s.say('on Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'ETH', outputAsset: 'USDC' })))!;
    expect(amount).toMatchObject({ kind: 'CLARIFICATION', text: 'How much ETH would you like to swap?' });
    expect(s.say('0.5')).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 0.5 ETH to USDC on Base slippage 100 bps' });
  });
  it('a swap that names its network asks the amount in the asset swapped', () => {
    const s = new CopilotSession();
    expect(s.say('swap ETH to USDC on Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'ETH', outputAsset: 'USDC' }))))
      .toMatchObject({ kind: 'CLARIFICATION', text: 'How much ETH would you like to swap?' });
  });
  it('a bridge that omits the amount and later completes it keeps both networks and both assets', () => {
    const s = new CopilotSession();
    s.say('Move ETH from Base to Arbitrum and receive USDC', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'ETH', outputAsset: 'USDC' })));
    expect(s.say('0.02')).toMatchObject({ kind: 'PROPOSAL', command: { input: { source: 'base', destination: 'arbitrum-one', amount: '0.02' } },
      sentence: 'bridge 0.02 ETH from Base to Arbitrum One receive USDC via best slippage 100 bps' });
  });
  it('changing only the destination network keeps the assets and the amount', () => {
    const s = new CopilotSession();
    s.say('bridge 0.01 ETH from Base to USDC on Arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'ETH', outputAsset: 'USDC', amount: '0.01' })));
    const revised = s.say('change the destination to Ethereum', intent.edit({ destinationNetwork: 'ETHEREUM' }))!;
    // The destination token is carried by symbol and resolved again on Ethereum: never Arbitrum One's USDC contract on another chain.
    expect(revised).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 0.01 ETH from Base to Ethereum receive USDC via best slippage 100 bps' });
    expect(revised.sentence).not.toMatch(/0x/);
  });
  it('changing only the destination asset keeps the asset sent', () => {
    const s = new CopilotSession();
    s.say('bridge 0.01 ETH from Base to USDC on Arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'ETH', outputAsset: 'USDC', amount: '0.01' })));
    const revised = s.say('actually receive DAI', intent.edit({ outputAsset: 'DAI' }))!;
    expect(revised.kind).toBe('PROPOSAL');
    expect(revised.sentence).toBe('bridge 0.01 ETH from Base to Arbitrum One receive DAI via best slippage 100 bps');
    expect(revised.command).toMatchObject({ type: 'ADD_UNIVERSAL_BRIDGE', input: { inputAsset: 'ETH', amount: '0.01', source: 'base', destination: 'arbitrum-one' } });
  });
});

describe('BUILD-FLOFI-UX-FIX-003 specialist review follow-up', () => {
  const ethToUsdc = act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'ETH', outputAsset: 'USDC', amount: '1' });
  it('"1 USDC" never answers "How much ETH would you like to send?": it is asked again, then a bare amount is the ETH sent', () => {
    const s = new CopilotSession();
    s.say('Bridge ETH from Base to 1 USDC on Arbitrum', intent.action(ethToUsdc));
    const again = s.say('1 USDC')!;
    expect(s.turns.at(-1)!.request).toBeNull();
    expect(again).toMatchObject({ kind: 'CLARIFICATION', text: 'That amount is in USDC, but this step sends ETH. How much ETH?' });
    expect(s.pending).toBeNull();
    expect(s.say('0.01')).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 0.01 ETH from Base to Arbitrum One receive USDC via best slippage 100 bps' });
  });
  it('"up to 50 USDC" and an amount of the asset sent are amounts sent, never amounts to receive', () => {
    const s = new CopilotSession();
    const capped = s.say('please bridge up to 50 USDC from Base to Arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', amount: '50' })))!;
    expect(capped).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 50 USDC from Base to Arbitrum via auto slippage 100 bps' });
    expect(capped.notes.join(' ')).not.toMatch(/You asked to receive/);
    const t = new CopilotSession();
    t.say('Bridge ETH from Base to USDC on Arbitrum.', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'ETH', outputAsset: 'USDC' })));
    const corrected = t.say('set it to 0.5 ETH', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'ETH', outputAsset: 'USDC', amount: '0.5' })))!;
    expect(corrected).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 0.5 ETH from Base to Arbitrum One receive USDC via best slippage 100 bps' });
    expect(corrected.notes.join(' ')).not.toMatch(/You asked to receive/);
  });
  it('an ambiguous written amount keeps its own question in the public product', () => {
    const s = new CopilotSession();
    const reply = s.say('please bridge 1,000 USDC from Base to Solana', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'USDC', amount: '1000' })))!;
    expect(reply.kind).toBe('CLARIFICATION');
    expect(reply.options).toEqual(['1', '1000']);
    expect(reply.text).not.toBe('How much USDC would you like to send?');
  });
  it('a source other than Base or Solana is also asked for its destination among every mainnet', () => {
    const s = new CopilotSession();
    const reply = s.say('Bridge 5 USDC from Arbitrum One', intent.action(act.bridge({ sourceNetwork: 'ARBITRUM', asset: 'USDC', amount: '5' })))!;
    expect(reply).toMatchObject({ kind: 'CLARIFICATION', text: 'From Arbitrum One. Which network should it arrive on?', options: ['Solana', 'Base', 'Ethereum', 'Robinhood Chain'] });
  });
  it('a destination token FloFi cannot name never moves to another chain as the old chain’s contract', () => {
    const token = '0x' + '12'.repeat(20) + '@18';
    const s = new CopilotSession();
    const first = s.say(`bridge 0.01 ETH from Base to Arbitrum and receive ${token}`, intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'ETH', outputAsset: token, amount: '0.01' })))!;
    expect(first.kind).toBe('PROPOSAL');
    const moved = s.say('change the destination to Ethereum', intent.edit({ destinationNetwork: 'ETHEREUM' }))!;
    expect(JSON.stringify(moved)).not.toContain('12'.repeat(20));
  });
  it('a side the user named is kept even when the model leaves it out: only the destination is asked', () => {
    const s = new CopilotSession();
    const reply = s.say('bridge 5 USDC from Base', intent.action(act.bridge({ asset: 'USDC', amount: '5' })))!;
    expect(reply).toMatchObject({ kind: 'CLARIFICATION', text: 'From Base. Which network should it arrive on?' });
  });
  it('moving a destination re-applies FloFi’s default token there (the Router USDC → USDG route into Robinhood Chain)', () => {
    const s = new CopilotSession();
    s.say('please bridge 5 USDC from Base to Arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: 'USDC', amount: '5' })));
    const moved = s.say('change the destination to Robinhood Chain', intent.edit({ destinationNetwork: 'ROBINHOOD' }))!;
    expect(moved).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_ROUTER_BRIDGE', input: { source: 'Base', destination: 'Robinhood Chain', amount: '5' } } });
  });
  it('a native coin received is never carried to a network whose native coin differs: ETH to Solana receives SOL, stated', () => {
    const s = new CopilotSession();
    s.say('bridge 0.01 ETH from Base to Arbitrum and receive ETH', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'ETH', outputAsset: 'ETH', amount: '0.01' })));
    const moved = s.say('change the destination to Solana', intent.edit({ destinationNetwork: 'SOLANA' }))!;
    expect(moved).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 0.01 ETH from Base to Solana receive SOL via best slippage 100 bps' });
    expect(moved.notes.join(' ')).toMatch(/You receive SOL on Solana/);
  });
  it('Portuguese "redes de teste" offered by a model is filtered like English test-network wording', () => {
    const s = new CopilotSession();
    const reply = s.say('quero fazer uma bridge', intent.clarify(['sourceNetwork'], 'De qual rede?', ['Usar redes de teste', 'Base'], 'PT'))!;
    expect(reply.options).toEqual(['Base']);
  });
});

describe('P0-1: the public product never offers a test network', () => {
  it('a bridge with no networks named asks for the source among the mainnets, never "Base Sepolia → Arbitrum Sepolia"', () => {
    const s = new CopilotSession();
    const reply = s.say('Bridge 5 USDC', intent.action(act.bridge({ asset: 'USDC', amount: '5' })))!;
    expect(reply).toMatchObject({ kind: 'CLARIFICATION', text: 'Which network are you bridging USDC from?' });
    expectMainnetOnly(reply);
  });
  it('a bridge from Base asks for the destination among the other mainnets, then authors the certified Router route', () => {
    const s = new CopilotSession();
    const reply = s.say('Bridge 5 USDC from Base', intent.action(act.bridge({ sourceNetwork: 'BASE', asset: 'USDC', amount: '5' })))!;
    expect(reply).toMatchObject({ kind: 'CLARIFICATION', options: ['Solana', 'Arbitrum One', 'Ethereum', 'Robinhood Chain'] });
    expectMainnetOnly(reply);
    expect(s.say('Arbitrum One')).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 5 USDC from Base to Arbitrum via auto slippage 100 bps', command: { type: 'ADD_ROUTER_BRIDGE' } });
  });
  it('options a model writes that name a test network are never shown, and its test-network prose is replaced', () => {
    const s = new CopilotSession();
    const reply = s.say('I want to bridge', intent.clarify(['sourceNetwork'], 'Bridge on Base Sepolia or Base?', ['Base Sepolia → Arbitrum Sepolia', 'Base → Arbitrum One', 'Solana Devnet']))!;
    expect(reply.kind).toBe('CLARIFICATION');
    expect(reply.options).toEqual(['Base → Arbitrum One']);
    expectMainnetOnly(reply);
  });
  it('a model refusal that names a test network is replaced by FloFi’s own words', () => {
    const s = new CopilotSession();
    const reply = s.say('stake my ETH', intent.unsupported('Staking is only available on Ethereum Sepolia.'))!;
    expect(reply.kind).toBe('UNSUPPORTED');
    expectMainnetOnly(reply);
  });
  it('the liquidity pool buttons author on the mainnet they name', () => {
    const s = new CopilotSession();
    const asked = s.say('add liquidity with uniswap and orca', intent.action(act.liquidity({ deposits: [{ asset: 'USDC', maxAmount: '10' }] })))!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', options: ['Uniswap v3 on Base', 'Orca on Solana', 'Uniswap v3 on Ethereum'] });
    const picked = s.say('Uniswap v3 on Base')!;
    expectMainnetOnly(picked);
    expect(JSON.stringify(s.state.draft?.intent ?? null)).not.toMatch(/SEPOLIA|DEVNET/);
  });
});
