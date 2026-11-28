// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { detectLanguage, languageRequest, replyLanguage } from './conversation-language';

// BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (A09): FloFi answers in the language the person writes in, whatever the interface shows.
describe('the conversation language', () => {
  it('detects Portuguese and English messages, and nothing in a message that tells nothing', () => {
    for (const text of ['O que significa supply?', 'Compensa fazer uma bridge de 0,1 USDC?', 'Altere a segunda etapa para 0,2.', 'Mude o supply para 0,2.', 'Revisar fluxo',
      'Sim, confirmo', 'Deu certo?', 'troca 0,001 WETH por USDC na eth sepolia', 'Quanto custa?', 'não'])
      expect(detectLanguage(text), text).toBe('PT');
    for (const text of ['What does supply mean?', 'Change the second step to 0.2', 'swap 10 USDC to WETH on Base Sepolia slippage 100 bps', 'Yes, I confirm', 'Review workflow',
      'Is it worth bridging 0.1 USDC?', 'How much does it cost?'])
      expect(detectLanguage(text), text).toBe('EN');
    for (const text of ['ok', '0,2', 'Base', 'USDC', 'swap', 'status', ''])
      expect(detectLanguage(text), text).toBeNull();
    // FloFi's exact command grammar (English by design) tells no language: a typed command keeps the conversation's, else the interface's.
    const portuguese = replyLanguage('O que significa supply?', 'EN', null).state;
    expect(replyLanguage('swap 10 USDC to WETH on Base Sepolia', 'PT', null, true)).toEqual({ language: 'PT', state: null });
    expect(replyLanguage('swap 10 USDC to WETH on Base Sepolia', 'EN', portuguese, true).language).toBe('PT');
    expect(replyLanguage('Buy Salesforce with 20 USDG on Robinhood Chain', 'EN', portuguese).language).toBe('EN');
    // An address or hash is not words: its letters ("e", "a") never read as Portuguese or English.
    for (const text of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'])
      expect(detectLanguage(text), text).toBeNull();
    expect(detectLanguage('Send 5 USDC on Arbitrum to 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe('EN');
    expect(detectLanguage('Envie 5 USDC na Arbitrum para 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe('PT');
  });
  it('reads an explicit request for a reply language', () => {
    expect(languageRequest('Reply in English')).toBe('EN'); expect(languageRequest('Please answer in Portuguese.')).toBe('PT');
    expect(languageRequest('Can you reply in English?')).toBe('EN'); expect(languageRequest('responda em inglês')).toBe('EN');
    expect(languageRequest('Pode responder em português?')).toBe('PT'); expect(languageRequest('em inglês, por favor')).toBe('EN');
    expect(languageRequest('mude o idioma para inglês')).toBe('EN');
    for (const text of ['O que significa supply?', 'swap 1 USDC to ETH', 'change the language of the label']) expect(languageRequest(text), text).toBeNull();
  });
  it('answers in the message language, else the language already spoken, else the interface; an explicit choice holds', () => {
    let state = replyLanguage('O que significa supply?', 'EN', null).state;
    expect(replyLanguage('O que significa supply?', 'EN', null).language).toBe('PT');
    expect(replyLanguage('0,2', 'EN', state).language).toBe('PT');
    expect(replyLanguage('0,2', 'EN', null).language).toBe('EN');
    expect(replyLanguage('What does supply mean?', 'PT', state).language).toBe('EN');
    const chosen = replyLanguage('Reply in English', 'PT', state);
    expect(chosen).toEqual({ language: 'EN', state: { language: 'EN', chosen: true } });
    state = chosen.state;
    expect(replyLanguage('O que significa supply?', 'PT', state).language).toBe('EN');
    expect(replyLanguage('responda em português', 'EN', state).language).toBe('PT');
  });
});
