// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-UNIFIED-COPILOT-001: the deterministic helpers behind resume, typo tolerance, the optional recipient save and the reply language. */
import { describe, expect, it } from 'vitest';
import { correctTypos, questionLanguage, recipientOfferAnswer, resumeRequest } from './copilot-assist';

describe('resumeRequest', () => {
  it('reads only a plain "go back to my request", never a new value or an approval', () => {
    for (const text of ['Ok, vamos continuar', 'continuar o swap', 'pode seguir com o pedido', "let's continue", 'back to my request', 'Resume, please']) expect(resumeRequest(text), text).toBe(true);
    for (const text of ['sim', 'continuar com 10 USDC', 'continue on Base', 'approve', 'ok', 'confirma']) expect(resumeRequest(text), text).toBe(false);
  });
});

describe('correctTypos', () => {
  it('corrects unambiguous network and coin names and reports each correction', () => {
    const fixed = correctTypos('trocar etheruem por usdc na arbriturm');
    expect(fixed.text).toBe('trocar ethereum por usdc na arbitrum');
    // "ethereum" is also the registry's network name; whether the user meant the coin or the network is decided by authoring (ETHEREUM_AS_COIN).
    expect(fixed.corrections.map(item => [item.written, item.corrected, item.network])).toEqual([['etheruem', 'ethereum', true], ['arbriturm', 'arbitrum', true]]);
    expect(correctTypos('swap 1 solanna to usdc').corrections.map(item => item.corrected)).toEqual(['solana']);
  });
  it('leaves known words, short words, everyday look-alikes and tickers alone (no identity is invented)', () => {
    for (const text of ['swap ETH to USDC on Arbitrum One', 'meu saldo na base', 'arbitragem de preço', 'USDC.e on Arbitrum', 'troca ARB por WETH', 'send to 0xabc']) {
      expect(correctTypos(text).corrections, text).toEqual([]);
    }
    // A word close to two names is ambiguous and is never corrected.
    expect(correctTypos('xxxxx').corrections).toEqual([]);
  });
});

describe('recipientOfferAnswer', () => {
  it('reads an explicit save (with an optional name, as written) or a decline; anything else is not an answer', () => {
    expect(recipientOfferAnswer('Salvar')).toEqual({ kind: 'ACCEPT', label: null });
    expect(recipientOfferAnswer('sim, salva como Carteira da Ana')).toEqual({ kind: 'ACCEPT', label: 'Carteira da Ana' });
    expect(recipientOfferAnswer('save it as "Mom"')).toEqual({ kind: 'ACCEPT', label: 'Mom' });
    expect(recipientOfferAnswer('agora não')).toEqual({ kind: 'DECLINE' });
    expect(recipientOfferAnswer('not now')).toEqual({ kind: 'DECLINE' });
    expect(recipientOfferAnswer('sim')).toBeNull();
    expect(recipientOfferAnswer('envia 5 USDC')).toBeNull();
  });
});

describe('questionLanguage', () => {
  it('decides only from opening question words', () => {
    expect(questionLanguage('O que é colateral?')).toBe('PT');
    expect(questionLanguage('Não entendi')).toBe('PT');
    expect(questionLanguage('hey, how do I connect Phantom?')).toBe('EN');
    expect(questionLanguage('explain impermanent loss')).toBe('EN');
    expect(questionLanguage('slippage')).toBeNull();
  });
});
