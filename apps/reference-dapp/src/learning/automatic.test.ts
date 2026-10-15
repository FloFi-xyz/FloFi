// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { automaticPermitted, decideLanguage, decideTerm, type AutomaticSetting } from './automatic.ts';
import { validateLexiconEntry } from '../domain/copilot-lexicon.ts';

/** BUILD-CHAT-LEARNING-002: the promotion and permission rules, exactly as documented for users, operators and counsel. */
const row = (target: string, counts: Partial<Record<'stated' | 'clarified' | 'corrected' | 'confirmed' | 'conversations', number>> = {}) =>
  ({ target, stated: 0, clarified: 0, corrected: 0, confirmed: 0, conversations: 0, ...counts });
const setting = (enabled: boolean, basis: AutomaticSetting['basis'], noticeVersion = 2): AutomaticSetting => ({ enabled, basis, noticeVersion, decidedAt: '2026-10-15T00:00:00.000Z' });

describe('BUILD-CHAT-LEARNING-002 permission per legal basis', () => {
  it('off never; consent only after an opt-in under the current notice; legitimate interest unless the identity objected', () => {
    expect(automaticPermitted('OFF', setting(true, 'CONSENT'))).toBe(false);
    expect(automaticPermitted('CONSENT', null)).toBe(false);
    expect(automaticPermitted('CONSENT', setting(true, 'CONSENT'))).toBe(true);
    expect(automaticPermitted('CONSENT', setting(true, 'CONSENT', 1))).toBe(false);
    expect(automaticPermitted('CONSENT', setting(true, 'LEGITIMATE_INTEREST'))).toBe(false);   // not a consent
    expect(automaticPermitted('CONSENT', setting(false, 'CONSENT'))).toBe(false);
    expect(automaticPermitted('LEGITIMATE_INTEREST', null)).toBe(true);
    expect(automaticPermitted('LEGITIMATE_INTEREST', setting(false, 'LEGITIMATE_INTEREST'))).toBe(false);
    expect(automaticPermitted('LEGITIMATE_INTEREST', setting(false, 'CONSENT'))).toBe(false);  // a withdrawn consent is also an objection
    expect(automaticPermitted('LEGITIMATE_INTEREST', setting(true, 'CONSENT'))).toBe(true);
  });
});

describe('BUILD-CHAT-LEARNING-002 promotion', () => {
  it('a statement at once; otherwise repeated, dominant evidence; ties and close calls are conflicts', () => {
    expect(decideTerm([row('network:ARBITRUM', { stated: 1 }), row('network:BASE', { clarified: 9 })])).toEqual({ target: 'network:ARBITRUM', reason: 'STATED' });
    expect(decideTerm([row('network:ARBITRUM', { clarified: 1 })])).toEqual({ target: null, reason: 'INSUFFICIENT' });
    expect(decideTerm([row('network:ARBITRUM', { clarified: 1, confirmed: 1 })])).toEqual({ target: 'network:ARBITRUM', reason: 'REPEATED' });
    expect(decideTerm([row('network:ARBITRUM', { corrected: 2 }), row('network:BASE', { clarified: 1 })])).toEqual({ target: null, reason: 'CONFLICT' });
    expect(decideTerm([row('network:ARBITRUM', { corrected: 3 }), row('network:BASE', { clarified: 1 })])).toEqual({ target: 'network:ARBITRUM', reason: 'REPEATED' });
    expect(decideTerm([row('network:ARBITRUM', { clarified: 3 }), row('network:BASE', { clarified: 1 }), row('network:SOLANA', { clarified: 1 })]))
      .toEqual({ target: null, reason: 'CONFLICT' });   // 3 against 2 combined
    expect(decideTerm([row('network:ARBITRUM', { clarified: 2 }), row('network:BASE', { clarified: 2 })])).toEqual({ target: null, reason: 'CONFLICT' });
  });
  it('the starting language: three conversations, three times any other', () => {
    expect(decideLanguage([row('language:PT', { conversations: 2 })])).toBeNull();
    expect(decideLanguage([row('language:PT', { conversations: 3 })])).toBe('PT');
    expect(decideLanguage([row('language:PT', { conversations: 5 }), row('language:EN', { conversations: 2 })])).toBeNull();
    expect(decideLanguage([row('language:EN', { conversations: 6 }), row('language:PT', { conversations: 2 })])).toBe('EN');
  });
  it('words naming a financial parameter can never be learned (EN and PT)', () => {
    for (const term of ['slippage', 'amount', 'recipient', 'address', 'balance', 'fee', 'deslizamento', 'valor', 'quantia', 'destinatário', 'endereço', 'saldo', 'taxa'])
      expect(validateLexiconEntry(term, 'operation:SWAP'), term).toEqual({ ok: false, code: 'LEARNING_TERM_RESERVED' });
  });
});
