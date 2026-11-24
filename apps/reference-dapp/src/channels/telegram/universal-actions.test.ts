// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNELS-001: Telegram's approval message keeps its one URL button first and adds the one-tap actions as callback
 * buttons; each action id is answered exactly like its typed command, in the conversation's language, with no model. WhatsApp (no
 * `linkWithChoices`) is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { APPROVAL_ACTIONS, decideTurn, freshState, parseState, type ChannelState, type TurnDecision } from '../core/conversation.ts';
import { channelCopy } from '../core/copy.ts';
import { createTelegramAdapter } from './adapter.ts';
import { renderSendMessage } from './render.ts';

const LINK = 'https://flofi.test/approve#flofi_chs_' + 'a'.repeat(43), to = { kind: 'chat', value: '900000001' };
const SWAP = 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps';

function chat(language: 'EN' | 'PT') {
  let state: ChannelState = freshState(language);
  const turn = async (content: { kind: 'TEXT'; text: string } | { kind: 'CHOICE'; id: string; label: string }): Promise<TurnDecision> => {
    const decided = await decideTurn({ content, state, optedOut: false, interpret: null, support: 's@flofi.test', privacy: 'https://flofi.test/p' });
    state = parseState(JSON.stringify(decided.state), language);
    return decided;
  };
  return { turn, get state() { return state; } };
}

describe('BUILD-FLOFI-UNIVERSAL-CHANNELS-001 Telegram one-tap actions', () => {
  it('renders the URL button first, then the actions two per row; without a link the choices are unchanged', () => {
    const a = channelCopy('EN').actions;
    const reply = { text: 'Strategy ready', link: { label: 'Authorize', url: LINK }, choices: [{ id: 'act:status', label: a.status }, { id: 'act:add', label: a.add },
      { id: 'act:cancel', label: a.cancel }] };
    expect(renderSendMessage(to, reply)).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: 'Authorize', url: LINK }],
      [{ text: 'Check status', callback_data: 'act:status' }, { text: 'Add another action', callback_data: 'act:add' }], [{ text: 'Cancel request', callback_data: 'act:cancel' }]] } });
    // A link alone is exactly as before.
    expect(renderSendMessage(to, { text: 'x', choices: [], link: { label: 'Authorize', url: LINK } })).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: 'Authorize', url: LINK }]] } });
    expect(createTelegramAdapter('1', async () => ({ ok: true, result: {} }) as never).linkWithChoices).toBe(true);
    for (const language of ['EN', 'PT'] as const) for (const label of Object.values(channelCopy(language).actions)) expect(label.length).toBeLessThanOrEqual(64);
  });

  for (const language of ['EN', 'PT'] as const) it(`each action is its typed command (${language})`, async () => {
    for (const [id, words] of Object.entries(APPROVAL_ACTIONS)) {
      const tapped = chat(language), typed = chat(language);
      await tapped.turn({ kind: 'TEXT', text: SWAP });
      await typed.turn({ kind: 'TEXT', text: SWAP });
      // The buttons speak the conversation's current language (an English command may have switched a PT conversation to EN).
      const a = await tapped.turn({ kind: 'CHOICE', id, label: id }), b = await typed.turn({ kind: 'TEXT', text: words[typed.state.language] });
      expect([a.action, a.outcome], id).toEqual([b.action, b.outcome]);
      expect(tapped.state, id).toEqual(typed.state);
      expect(a.action, id).not.toBe('PROPOSE');
    }
  });

  it('a tap that sounds like an approval is never one, and an unknown action id is not a command', async () => {
    const c = chat('EN');
    await c.turn({ kind: 'TEXT', text: SWAP });
    const unknown = await c.turn({ kind: 'CHOICE', id: 'act:execute', label: 'act:execute' });
    expect(['PROPOSE', 'ADD_STEP', 'CANCEL', 'STATUS']).not.toContain(unknown.action);
    expect(Object.keys(APPROVAL_ACTIONS).sort()).toEqual(['act:add', 'act:cancel', 'act:status', 'act:steps']);
  });
});
