// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { reviewBlockView, shortDecimal } from './review-block';
import { swapBridgeReview } from './review-block-test-harness';

describe('board 06: what the owner is authorizing, in plain words', () => {
  it('at most 6 significant digits: a minimum is never overstated, a spend or fee never understated', () => {
    expect(shortDecimal('796123456789123', 18, 'down')).toBe('0.000796123');
    expect(shortDecimal('796123456789123', 18, 'up')).toBe('0.000796124');
    expect(shortDecimal('2000000', 6, 'up')).toBe('2');
    expect(shortDecimal('123456789', 6, 'down')).toBe('123.456');
    expect(shortDecimal('300000000000000', 18, 'down')).toBe('0.0003');
    expect(shortDecimal('0', 18, 'up')).toBe('0');
  });
  it('one line per step (verb, amount, asset, network), the final minimum, the fee ceiling, each token permission and the wallet requests', () => {
    const view = reviewBlockView(swapBridgeReview());
    expect(view.steps).toEqual([
      { key: 'Swap {0} → {1} · {2}', parameters: ['2 USDC', 'WETH', 'Base'], full: null },
      { key: 'Bridge {0} to {1}', parameters: ['0.000796124 WETH', 'Arbitrum One'], full: '0.000796123456789123 WETH' },
    ]);
    // The last step's exact delivery on Arbitrum One, shortened DOWN; the full value stays for the tooltip.
    expect(view.minimum).toEqual({ key: '{0}', parameters: ['0.000790555 WETH'], full: '0.000790555555555555 WETH' });
    expect(view.fee).toEqual({ key: '{0}', parameters: ['0.000454 ETH'], full: null });
    expect(view.permissions.map(p => [p.key, ...p.parameters])).toEqual([['{0} uses up to {1}', 'Uniswap', '2 USDC'], ['{0} uses up to {1}', 'Across', '0.000796124 WETH']]);
    expect(view.walletRequests).toEqual({ key: '{0}', parameters: ['1'], full: null });
  });
  it('never claims a total it does not know: a later request is quoted when due, a step-by-step count is a minimum', () => {
    const base = swapBridgeReview();
    const later = reviewBlockView(swapBridgeReview({ mode: 'GROUPED', groups: [{ ...base.groups[0]!, steps: [0, 0], calls: [{ kind: 'ERC20_APPROVE', step: 0 }, { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', step: 0 }] },
      { ...base.groups[0]!, index: 1, steps: [1, 1], signing: 'WHEN_DUE', calls: null, approvals: null, fee: null }],
      counts: { ...base.counts, walletPrompts: 2, atLeast: true } }));
    expect(later.fee).toMatchObject({ key: '{0} + later requests, quoted when due', parameters: ['0.000454 ETH'] });
    expect(later.permissions.map(p => p.key)).toEqual(['{0} uses up to {1}', 'Later steps ask when they are due']);
    expect(later.walletRequests).toEqual({ key: 'at least {0}', parameters: ['2'], full: null });
    const unprepared = reviewBlockView(swapBridgeReview({ groups: base.groups.map(g => ({ ...g, calls: null, approvals: null, fee: null })),
      steps: base.steps.map(s => ({ ...s, minimum: null, expected: null })) }));
    expect(unprepared.fee?.key).toBe('Quoted when each request is due');
    expect(unprepared.permissions.map(p => p.key)).toEqual(['Asked when each step is due']);
    expect(unprepared.minimum?.key).toBe('Quoted when this step becomes due');
    expect(unprepared.steps[0]).toEqual({ key: 'Swap {0} · {1}', parameters: ['2 USDC', 'Base'], full: null });
    expect(reviewBlockView(swapBridgeReview({ groups: base.groups.map(g => ({ ...g, calls: [{ kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', step: 0 }], approvals: 0 })) })).permissions
      .map(p => p.key)).toEqual(['None needed']);
  });
});
