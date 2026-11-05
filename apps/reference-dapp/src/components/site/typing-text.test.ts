// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { SITE_COPY } from './site-copy';
import { SLOT_MS, START_MS, typedAt } from './typing-text';

// BUILD-FLOFI-LAUNCH-001: the approved typing hero's timeline (five phrases in the board's 19.67 s loop).
describe('typing hero timeline', () => {
  const verbs = SITE_COPY.EN.home.heroVerbs, sentences = SITE_COPY.EN.home.heroSentences;
  it('types each verb, holds it, and backspaces it before the next slot', () => {
    expect(typedAt('word', verbs, 0)).toBe('');
    expect(typedAt('word', verbs, 95 * 2)).toBe('sw');
    expect(typedAt('word', verbs, 1_000)).toBe('swap');
    expect(typedAt('word', verbs, SLOT_MS - 100)).toBe('');
    expect(typedAt('word', verbs, SLOT_MS + 2_000)).toBe('bridge');
    expect(typedAt('word', verbs, SLOT_MS * 3 + 2_000)).toBe('add liquidity');
    // The loop repeats.
    expect(typedAt('word', verbs, SLOT_MS * 5 + 1_000)).toBe('swap');
  });
  it('types each sentence, shows it whole, then clears it for the rest of its slot', () => {
    expect(typedAt('sentence', sentences, 32 * 6)).toBe('I want');
    expect(typedAt('sentence', sentences, 2_500)).toBe('I want to swap 50 USDC for ETH on Base.');
    expect(typedAt('sentence', sentences, SLOT_MS * 0.9)).toBe('');
    expect(typedAt('sentence', sentences, SLOT_MS * 4 + 2_500)).toBe('I want to transfer 20 USDC to another wallet.');
  });
  it('starts where the first phrases are whole, so the server-rendered phrase stays through hydration', () => {
    for (const language of ['EN', 'PT'] as const) {
      const t = SITE_COPY[language].home;
      expect(typedAt('word', t.heroVerbs, START_MS)).toBe(t.heroVerbs[0]);
      expect(typedAt('sentence', t.heroSentences, START_MS)).toBe(t.heroSentences[0]);
    }
  });
  it('never shows more than the approved phrase, in either language', () => {
    for (const language of ['EN', 'PT'] as const) {
      const t = SITE_COPY[language].home;
      expect(t.heroVerbs).toHaveLength(5); expect(t.heroSentences).toHaveLength(5);
      for (let at = 0; at < SLOT_MS * 5; at += 37) {
        const word = typedAt('word', t.heroVerbs, at), index = Math.floor(at / SLOT_MS);
        expect(t.heroVerbs[index]!.startsWith(word)).toBe(true);
        expect(t.heroSentences[index]!.startsWith(typedAt('sentence', t.heroSentences, at))).toBe(true);
      }
    }
  });
});
