// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002 review round 2: after an in-place re-quote, each moved value reads "Before: … Now: …" to a screen reader (visually
 * hidden text, never an aria-label on a plain span), and the arrow that only draws the change is hidden from assistive technology.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BridgeRequoteChanges } from './bridge-requote-changes';
import { LocaleProvider, type Language } from '../i18n/locale';

const render = (changes: Parameters<typeof BridgeRequoteChanges>[0]['changes'], language: Language = 'EN') =>
  renderToStaticMarkup(createElement(LocaleProvider, { initialLanguage: language, children: createElement(BridgeRequoteChanges, { changes }) }));
/** What a screen reader reads: the markup without tags, after dropping what is aria-hidden. */
const spoken = (html: string) => html.replace(/<span aria-hidden="true">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('BUILD-FLOFI-MAINNET-EXEC-002 re-quote changes', () => {
  it('announces Before and Now with each value, hides the arrow and uses no aria-label on a span', () => {
    const html = render([{ label: 'Network fee, at most', before: '0.00000210982 ETH', after: '0.00000301801 ETH' }]);
    expect(html).toContain('<dt>Network fee, at most</dt>');
    expect(html).toContain('<dd><span class="sr-only">Before: </span><s>0.00000210982 ETH</s> <span aria-hidden="true">→</span> <span class="sr-only">Now: </span>0.00000301801 ETH</dd>');
    expect(html).not.toMatch(/<span aria-label=/);
    expect(spoken(html)).toContain('Network fee, at most Before: 0.00000210982 ETH Now: 0.00000301801 ETH');
    expect(spoken(html)).not.toContain('→');
  });
  it('reads in Portuguese, and says when nothing material changed', () => {
    const html = render([{ label: 'Minimum receipt', before: '1.881 USDC', after: '1.879 USDC' }], 'PT');
    expect(html).toContain('<span class="sr-only">Antes: </span><s>1.881 USDC</s>');
    expect(html).toContain('<span class="sr-only">Agora: </span>1.879 USDC');
    expect(render([])).toContain('Nothing material changed. Authorize the fresh Review to continue.');
  });
});
