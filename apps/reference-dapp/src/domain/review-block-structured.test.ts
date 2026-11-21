// SPDX-License-Identifier: AGPL-3.0-only
/**
 * UX-01 / UX-03 (owner guidelines of 21-11-2026): the structured, presentation-only views of the whole-workflow Review — its steps for the shared
 * step card and its token approvals as "Access to <token>" rows — say exactly what the Review's lines say: the same steps, amounts, recipients,
 * approvals, limits and spenders, never fewer.
 */
import { describe, expect, it } from 'vitest';
import { reviewBlockView, reviewStepItems } from './review-block';
import { swapBridgeReview } from './review-block-test-harness';

describe('UX-01 / UX-03: structured Review views', () => {
  it('one item per step with the Review\'s own amounts: a swap\'s quoted output is an estimate, a bridge delivers exactly', () => {
    const items = reviewStepItems(swapBridgeReview());
    expect(items.map(item => [item.index, item.action, item.network, item.destination, item.receiveKind])).toEqual([
      [0, 'swap', 'Base', null, 'expected'], [1, 'bridge', 'Base', 'Arbitrum One', 'exact']]);
    expect(items[0]!.spend?.units).toBe('2000000');
    expect(items[0]!.receive?.units).toBe('800123456789000');
    expect(items[1]!.spend?.units).toBe('796123456789123');
    expect(items[1]!.receive?.units).toBe('790555555555555');
  });
  it('a transfer keeps its full recipient (shortened only by the view, with the full address one click away)', () => {
    const base = swapBridgeReview();
    const recipient = '0x282091e22697dd3434ad1847fc830e1eff912edc';
    const review = swapBridgeReview({ steps: [base.steps[0]!, { ...base.steps[1]!, action: 'transfer', destination: null, expected: null, minimum: null, recipient }] });
    const send = reviewStepItems(review)[1]!;
    expect(send.recipient).toBe(recipient);
    expect(send.receive).toBeNull();
  });
  it('every token approval becomes one access row with its limit rounded UP and its spender; nothing else is dropped', () => {
    const view = reviewBlockView(swapBridgeReview());
    expect(view.access).toEqual([
      { symbol: 'USDC', limit: '2 USDC', full: null, spender: 'Uniswap', step: 0 },
      { symbol: 'WETH', limit: '0.000796124 WETH', full: '0.000796123456789123 WETH', spender: 'Across', step: 1 }]);
    expect(view.otherPermissions).toEqual([]);
    // The same approvals as the sentence lines, one for one.
    expect(view.permissions).toHaveLength(view.access!.length);
  });
  it('a permission the access rows cannot word stays visible as its own line (fails closed)', () => {
    const base = swapBridgeReview(), g = base.groups[0]!;
    // Approvals in a later group (not prepared): "Later steps ask when they are due" stays beside the access rows.
    const later = reviewBlockView(swapBridgeReview({ mode: 'GROUPED', groups: [{ ...g, steps: [0, 0], calls: [{ kind: 'ERC20_APPROVE', step: 0 }] },
      { ...g, index: 1, steps: [1, 1], calls: null, fee: null }] }));
    expect(later.access!.map(a => a.symbol)).toEqual(['USDC']);
    expect(later.otherPermissions!.map(line => line.key)).toEqual(['Later steps ask when they are due']);
    // No approval at all: "No new token permission" stays a line of its own, never an empty row.
    const none = reviewBlockView(swapBridgeReview({ groups: [{ ...g, calls: [{ kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', step: 0 }, { kind: 'ACROSS_DEPOSIT', step: 1 }] }] }));
    expect(none.access).toEqual([]);
    expect(none.otherPermissions!.map(line => line.key)).toEqual(['No new token permission']);
  });
});
