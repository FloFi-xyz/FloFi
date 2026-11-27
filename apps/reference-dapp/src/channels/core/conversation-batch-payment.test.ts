// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (chat review C2): on Telegram and WhatsApp a `pay` request FloFi read and refused says why, exactly as
 * FloFi's own chat does, in English and Portuguese. It never reaches the interpreter (which could author separate, non-atomic transfers) and nothing is
 * proposed or kept: the channel's pending proposal stays exactly as it was.
 */
import { describe, expect, it } from 'vitest';
import { copilotRejection } from '../../domain/copilot-authoring';
import { decideTurn, freshState, parseState, type ChannelState, type TurnDecision } from './conversation.ts';

const A = '0x2222222222222222222222222222222222222222', B = '0x3333333333333333333333333333333333333333';
const SOL_A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', SOL_B = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
const CASES: readonly (readonly [string, string])[] = [
  [`pay 1 USDC to my wallet and 2 USDC to ${B} on Base`, 'BATCH_PAYMENT_RECIPIENT_INVALID'],
  [`pay 0.001 ETH to ${A} and 0.002 ETH to ${A} on Base`, 'BATCH_PAYMENT_DUPLICATE_RECIPIENT'],
  [`batch pay 1 USDC to ${A} and 0.002 ETH to ${B} on Base`, 'BATCH_PAYMENT_ASSET_MIXED'],
  [`pay 0 ETH to ${A} and 0.002 ETH to ${B} on Base`, 'BATCH_PAYMENT_AMOUNT_INVALID'],
  [`pay 1.1234567 USDC to ${A} and 2 USDC to ${B} on Base`, 'BATCH_PAYMENT_AMOUNT_TOO_PRECISE'],
  [`batch pay 1 SOL to ${SOL_A} and 2 SOL to ${SOL_B} on Solana`, 'BATCH_PAYMENT_NETWORK_UNSUPPORTED'],
];

/** A channel turn whose interpreter fails the test if it is ever called. */
async function turn(text: string, state: ChannelState): Promise<{ decided: TurnDecision; calls: number }> {
  let calls = 0;
  const decided = await decideTurn({ content: { kind: 'TEXT', text }, state, optedOut: false, support: 'support@flofi.test', privacy: 'https://flofi.test/privacy',
    interpret: async () => { calls += 1; throw new Error('unexpected model call'); } });
  return { decided, calls };
}

describe('chat review C2: a `pay` refusal in a channel', () => {
  for (const language of ['EN', 'PT'] as const) {
    it(`says the closed refusal in ${language}, never calls the interpreter and proposes nothing`, async () => {
      for (const [text, code] of CASES) {
        const { decided, calls } = await turn(text, freshState(language));
        expect(calls, text).toBe(0);
        expect(decided, text).toMatchObject({ action: 'REPLY', outcome: code, command: null, aiInterpreted: false });
        expect(decided.replies.at(-1)!.text, text).toBe(copilotRejection(code, language).message);
        expect(decided.state.pending, text).toBeNull();
      }
    });
  }

  it('keeps the pending proposal exactly as it was (nothing is committed)', async () => {
    const proposed = await turn(`pay 1 USDC to ${A} and 2 USDC to ${B} on Base`, { ...freshState('EN'), greeted: true });
    expect(proposed.decided).toMatchObject({ action: 'PROPOSE', outcome: 'PROPOSED_EXACT', command: { type: 'ADD_BATCH_PAYMENT' } });
    const state = parseState(JSON.stringify(proposed.decided.state), 'EN');
    const { decided, calls } = await turn(`pay 1 USDC to Alice and 2 USDC to ${B} on Base`, state);
    expect(calls).toBe(0);
    expect(decided).toMatchObject({ action: 'REPLY', outcome: 'BATCH_PAYMENT_RECIPIENT_INVALID', command: null });
    expect(decided.replies).toEqual([{ text: copilotRejection('BATCH_PAYMENT_RECIPIENT_INVALID', 'EN').message, choices: [], link: null }]);
    expect(decided.state.pending).toEqual(state.pending);
  });
});
