// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-FIX-003: channels (Telegram, WhatsApp) share the Copilot conversation engine, so the public product's mainnet-only options and the
 * ETH → USDC bridge fix hold there too, across JSON rehydration between serverless instances. Scripted interpreter; nothing quotes or executes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, intent } from '../../domain/copilot-session.test-harness';
import { registerFixtureCatalogs, resetNetworkCatalogs } from '../../domain/intelligence/intelligence.test-harness';
import { setActiveNetworkScope } from '../../domain/network-scope';
import { decideTurn, freshState, parseState, type ChannelInterpreter, type ChannelState, type TurnDecision } from './conversation.ts';

beforeAll(() => registerFixtureCatalogs());
afterAll(() => resetNetworkCatalogs());
beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));
afterEach(() => setActiveNetworkScope(null));

function chat(script: Record<string, unknown>[]) {
  const pending = [...script];
  const interpret: ChannelInterpreter = async () => {
    const next = pending.shift();
    if (!next) throw new Error('unexpected model call');
    return { ok: true, intent: next as never };
  };
  let state: ChannelState = freshState('EN');
  const say = async (text: string): Promise<TurnDecision> => {
    const decided = await decideTurn({ content: { kind: 'TEXT', text }, state, optedOut: false, interpret, support: 'support@flofi.test', privacy: 'https://flofi.test/privacy' });
    state = parseState(JSON.stringify(decided.state), 'EN');
    return decided;
  };
  return { say, remaining: () => pending.length };
}
const labels = (decision: TurnDecision) => decision.replies.flatMap(reply => reply.choices.map(choice => choice.label));

describe('BUILD-FLOFI-UX-FIX-003 channel conversation (public, mainnet-only)', () => {
  it('"bridge eth to 1 usd" → "usdc" → Base → Arbitrum One → 0.01 proposes ETH → USDC and never offers a test network', async () => {
    const c = chat([intent.action(act.bridge({ asset: 'ETH', outputAsset: null, amount: '1' }))]);
    const decisions = [await c.say('i want to do a bridge of eth to 1 usd')];
    decisions.push(await c.say('usdc'));
    // A channel shows at most four buttons; every one is a mainnet (Robinhood Chain can still be typed).
    expect(labels(decisions.at(-1)!)).toEqual(['Solana', 'Base', 'Arbitrum One', 'Ethereum']);
    decisions.push(await c.say('Base'));
    decisions.push(await c.say('Arbitrum One'));
    expect(decisions.at(-1)!.replies.at(-1)!.text).toContain('How much ETH would you like to send?');
    const proposed = await c.say('0.01');
    expect(proposed).toMatchObject({ action: 'PROPOSE', command: { type: 'ADD_UNIVERSAL_BRIDGE', input: { source: 'base', destination: 'arbitrum-one', inputAsset: 'ETH', amount: '0.01' } } });
    for (const decision of [...decisions, proposed]) {
      for (const label of labels(decision)) expect(label).not.toMatch(/sepolia|devnet|testnet/i);
      for (const reply of decision.replies) expect(reply.text).not.toMatch(/sepolia|devnet|testnet/i);
    }
    expect(c.remaining()).toBe(0);
  });
});

describe('BUILD-P1 pool range dialogue on a channel (public, mainnet-only, across JSON rehydration)', () => {
  const ORCA = { protocol: 'ORCA', network: 'SOLANA', deposits: [{ asset: 'SOL', maxAmount: '0.1' }, { asset: 'USDC', maxAmount: '10' }] };
  it('"1usdc" → Lower → "180" keeps every value and proposes the Orca position; no percentage is offered where no pool can be read', async () => {
    const c = chat([intent.action(act.liquidity(ORCA))]);
    const asked = await c.say('Add liquidity on Orca on Solana with 0.1 SOL and 10 USDC');
    expect(asked.replies.at(-1)!.text).toContain('USDC per SOL');
    expect(asked.replies.at(-1)!.text).not.toMatch(/percentage|devUSDC|Devnet/i);
    const side = await c.say('1usdc');
    expect(side.replies.at(-1)!.text).toBe('Is 1 USDC per SOL the lower or the upper price of the range?');
    expect(labels(side)).toEqual(['Lower', 'Upper']);
    const bound = await c.say('Lower');
    expect(bound.replies.at(-1)!.text).toMatch(/upper price in USDC per SOL/);
    const proposed = await c.say('180');
    expect(proposed).toMatchObject({ action: 'PROPOSE', command: { type: 'ADD_SOLANA_LIQUIDITY' } });
    expect(JSON.stringify(proposed.command)).toContain('"lower":"1"');
    expect(JSON.stringify(proposed.command)).toContain('"upper":"180"');
    expect(c.remaining()).toBe(0);
  });
  it('a percentage on a channel is explained without a retry that cannot work, and the request stays open for prices', async () => {
    const c = chat([intent.action(act.liquidity({ ...ORCA, rangeUnit: 'PERCENT', upper: '10' }))]);
    const explained = await c.say('Add liquidity on Orca on Solana with 0.1 SOL and 10 USDC, ±10%');
    expect(explained.replies.at(-1)!.text).toContain('Give the range as prices or ticks.');
    expect(explained.replies.at(-1)!.text).not.toMatch(/Try again/);
    expect(labels(explained)).toEqual([]);
    expect(await c.say('150 to 180')).toMatchObject({ action: 'PROPOSE', command: { type: 'ADD_SOLANA_LIQUIDITY' } });
  });
});
