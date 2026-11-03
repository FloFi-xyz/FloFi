// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-FIX-003: every FloFi fee disclosure on the universal bridge says the same thing in English and Portuguese — the 0.1% fee is
 * recorded as an obligation when the bridge completes and is not charged at this time (fee-obligation.ts: OBLIGATION_RECORDED, NOT_SETTLED).
 * The Portuguese Copilot note once said FloFi charged no fee at all, and the Review's fee line had no Portuguese text.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COPILOT_COPY } from '../domain/copilot-messages';
import { translate } from './locale';

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
/** The universal surfaces' fee sentences, as they appear in the product source (Review line, Canvas panel). */
const FEE_SENTENCES = [
  '0.1% of the completed workflow input. Recorded as an obligation when the run reconciles; not collected on-chain yet. Waived if the workflow fails or refunds.',
  'The guaranteed minimum you receive is fixed in the reviewed provider order. Provider fees are listed at Review. FloFi records a 0.1% fee obligation on each completed workflow; collection is not settled on-chain yet.',
  'Real funds. FloFi never signs: your source wallet signs every transaction after your Review. FloFi records a 0.1% fee obligation when the workflow completes; it is not charged at this time. Provider fees are shown below.',
  '0.1% of the completed workflow input — obligation recorded at reconciliation; not collected on-chain yet.',
] as const;

describe('BUILD-FLOFI-UX-FIX-003 FloFi fee disclosure (EN/PT parity)', () => {
  it('the Copilot bridge note says the 0.1% fee is recorded and not charged now, in both languages', () => {
    const en = COPILOT_COPY.EN.universalFundsNote('Base → Arbitrum One'), pt = COPILOT_COPY.PT.universalFundsNote('Base → Arbitrum One');
    expect(en).toMatch(/0\.1% fee obligation/);
    expect(en).toMatch(/completed bridge/);
    expect(en).toMatch(/not charged at this time/);
    expect(pt).toMatch(/registra uma obrigação de taxa de 0,1%/);
    expect(pt).toMatch(/bridge concluída/);
    expect(pt).toMatch(/não é cobrada neste momento/);
    // Never the old contradiction: "FloFi does not charge a fee on this bridge".
    expect(pt).not.toMatch(/não cobra taxa/);
    expect(en).not.toMatch(/no fee|does not charge|doesn't charge/i);
  });

  it('every universal Review and panel fee sentence has Portuguese text with the same policy', () => {
    const product = source('../domain/simulation-presentation.ts') + source('../components/universal-bridge-panel.tsx');
    for (const sentence of FEE_SENTENCES) {
      expect(product, sentence).toContain(sentence);
      const pt = translate('PT', sentence);
      expect(pt, sentence).not.toBe(sentence);
      expect(pt, sentence).toContain('0,1%');
      expect(pt, sentence).toMatch(/regist/i);
      expect(pt, sentence).toMatch(/ainda não|não é cobrada/i);
    }
    expect(product).toContain("'FloFi fee (0.1% obligation)'");
    expect(translate('PT', 'FloFi fee (0.1% obligation)')).toBe('Taxa do FloFi (obrigação de 0,1%)');
    expect(translate('PT', 'FloFi fee')).toBe('Taxa do FloFi');
  });
});
