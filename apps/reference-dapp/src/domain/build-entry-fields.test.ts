// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { BUILD_ENTRY_SUGGESTIONS } from './build-entry';
import { adjacentField, fieldAt, fieldSuggestions, fillField, nextPlaceholder, sessionOf, templateFields } from './build-entry-fields';

const template = (id: (typeof BUILD_ENTRY_SUGGESTIONS)[number]['id'], language: 'EN' | 'PT'): string => BUILD_ENTRY_SUGGESTIONS.find(item => item.id === id)!.template[language];
/** Fills the part at `index` as the request field does (the text the person ends up with). */
function fill(text: string, session: ReturnType<typeof sessionOf>, index: number, value: string) {
  return fillField(text, templateFields(text, session)[index]!, value).text;
}

describe('PR #254 follow-up: a suggestion\'s template is filled part by part inside the same request text', () => {
  it('finds every part of each existing template, in order, in English and Portuguese (the templates themselves are unchanged)', () => {
    expect(template('swap', 'EN')).toBe('Swap [amount] [token] for [token] on [network]');
    expect(template('swap', 'PT')).toBe('Trocar [valor] [token] por [token] na [rede]');
    const kinds = { swap: ['amount', 'token', 'token', 'network'], yield: ['amount', 'token', 'network'], liquidity: ['token', 'token', 'network'],
      collateral: ['amount', 'token', 'token', 'network'], multi: ['amount', 'token', 'token', 'network', 'network'] } as const;
    for (const item of BUILD_ENTRY_SUGGESTIONS) for (const language of ['EN', 'PT'] as const) {
      const text = item.template[language], session = sessionOf(item.id, language), parts = templateFields(text, session);
      expect(parts.map(part => part.kind), `${item.id} ${language}`).toEqual(kinds[item.id]);
      expect(parts.every(part => part.placeholder && text.slice(part.start, part.end) === part.value)).toBe(true);
    }
  });

  it('the example journey: amount, source token, destination token and network, each replaced and confirmed in turn', () => {
    const session = sessionOf('swap', 'PT');
    let text = template('swap', 'PT');
    // The first part is selected first; typing replaces it (a decimal amount, never advanced per keystroke).
    expect(nextPlaceholder(templateFields(text, session), 0)).toMatchObject({ index: 0, value: '[valor]' });
    text = fill(text, session, 0, '10.5');
    // Confirming (Enter or Tab) moves to the next part still to fill.
    let parts = templateFields(text, session);
    expect(nextPlaceholder(parts, parts[0]!.end)).toMatchObject({ index: 1, kind: 'token' });
    text = fill(text, session, 1, 'USDC'); text = fill(text, session, 2, 'ETH'); text = fill(text, session, 3, 'Base');
    expect(text).toBe('Trocar 10.5 USDC por ETH na Base');
    parts = templateFields(text, session);
    expect(parts.map(part => part.value)).toEqual(['10.5', 'USDC', 'ETH', 'Base']);
    expect(parts.some(part => part.placeholder)).toBe(false);
    // Nothing left to fill: Enter now creates the workflow (an explicit key press; filling the last part never submits by itself).
    expect(nextPlaceholder(parts, text.length)).toBeNull();
  });

  it('Tab and Shift+Tab reach every part, a filled one included (to revisit it), and leave the request past either end', () => {
    const session = sessionOf('swap', 'EN');
    const text = fill(fill(template('swap', 'EN'), session, 0, '10'), session, 1, 'USDC');
    const parts = templateFields(text, session);
    expect(adjacentField(parts, parts[1]!.end, 1)).toMatchObject({ index: 2, placeholder: true });
    expect(adjacentField(parts, parts[1]!.start, -1)).toMatchObject({ index: 0, value: '10', placeholder: false });
    expect(adjacentField(parts, parts[0]!.start, -1)).toBeNull();
    expect(adjacentField(parts, parts[3]!.end, 1)).toBeNull();
    // The caret inside a part (clicked or tapped) is that part.
    expect(fieldAt(parts, parts[2]!.start + 2)).toMatchObject({ index: 2 });
    // A filled part can be revisited and replaced; the others are untouched.
    expect(fill(text, session, 0, '25.75')).toBe('Swap 25.75 USDC for [token] on [network]');
  });

  it('keeps conversational freedom: added instructions, pasted text, a rewritten sentence or free text', () => {
    const session = sessionOf('swap', 'EN');
    // Text added after the sentence is part of the last part's value until it is confirmed; the sentence's own words stay intact.
    expect(templateFields('Swap 10 USDC for ETH on Base, then stop', session).at(-1)).toMatchObject({ value: 'Base, then stop', placeholder: false });
    // The sentence's own words changed: free text; only the [placeholders] still in it are parts (Enter still refuses to submit them).
    const rewritten = templateFields('Please swap 10 [token] to ETH on [network]', session);
    expect(rewritten.map(part => [part.kind, part.placeholder])).toEqual([['token', true], ['network', true]]);
    // A part typed so that a placeholder ends up inside another part's value ("10 USDC" typed into [amount]: the single space between the parts
    // matches inside it) is ambiguous: the placeholders alone count, so the visible [token] is still a part to fill and Enter never submits it.
    const ambiguous = templateFields('Swap 10 USDC [token] for [token] on Base', session);
    expect(ambiguous.map(part => [part.value, part.placeholder])).toEqual([['[token]', true], ['[token]', true]]);
    expect(nextPlaceholder(ambiguous, 0)).toMatchObject({ start: 'Swap 10 USDC '.length });
    // Free text with no template part has no parts at all (Enter submits it as before), and brackets of the person's own are not parts.
    expect(templateFields('swap 10 USDC to ETH on Base', null)).toEqual([]);
    expect(templateFields('note [this] and [that]', null)).toEqual([]);
    // Multi-character symbols and network names, and decimals.
    expect(fill(fill(template('yield', 'EN'), sessionOf('yield', 'EN'), 1, 'wstETH'), sessionOf('yield', 'EN'), 2, 'Arbitrum One'))
      .toBe('Supply [amount] wstETH to Aave on Arbitrum One');
  });

  it('suggests only existing supported mainnet networks and tokens of the template\'s own action, never a test network', () => {
    const swap = sessionOf('swap', 'EN'), text = template('swap', 'EN'), parts = templateFields(text, swap);
    const networks = fieldSuggestions(swap, parts, parts[3]!);
    expect(networks).toEqual(expect.arrayContaining(['Base', 'Ethereum', 'Arbitrum One', 'Solana']));
    expect(networks.some(network => /sepolia|devnet|testnet/i.test(network))).toBe(false);
    expect(fieldSuggestions(swap, parts, parts[0]!)).toEqual([]);
    // Tokens follow the network already chosen in the sentence, and the other token is not offered twice.
    const onBase = fill(fill(text, swap, 3, 'Base'), swap, 1, 'USDC'), baseParts = templateFields(onBase, swap);
    expect(fieldSuggestions(swap, baseParts, baseParts[2]!)).toEqual(['ETH', 'WETH']);
    const onSolana = fill(text, swap, 3, 'Solana'), solanaParts = templateFields(onSolana, swap);
    expect(fieldSuggestions(swap, solanaParts, solanaParts[1]!)).toEqual(['SOL', 'USDC', 'USDT']);
    // Earn yield and collateral use Aave's networks and reserves; liquidity its pool networks.
    const yieldSession = sessionOf('yield', 'EN'), yieldParts = templateFields(template('yield', 'EN'), yieldSession);
    expect(fieldSuggestions(yieldSession, yieldParts, yieldParts[2]!)).toEqual(['Base', 'Arbitrum One', 'Ethereum']);
    const pool = sessionOf('liquidity', 'PT'), poolParts = templateFields(template('liquidity', 'PT'), pool);
    expect(fieldSuggestions(pool, poolParts, poolParts[2]!)).toEqual(expect.arrayContaining(['Base', 'Ethereum', 'Solana']));
    // Multi-step: the bridge's destination is any other universal bridge network.
    const multi = sessionOf('multi', 'EN'), multiText = fill(template('multi', 'EN'), multi, 3, 'Base'), multiParts = templateFields(multiText, multi);
    const destinations = fieldSuggestions(multi, multiParts, multiParts[4]!);
    expect(destinations).toContain('Arbitrum One'); expect(destinations).not.toContain('Base');
  });
});
