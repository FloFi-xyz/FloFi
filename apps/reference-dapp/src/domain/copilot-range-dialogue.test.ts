// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { applyRangeAnswer, readRangeAnswer, type RangeAnswer } from './copilot-range-dialogue';
import type { CopilotLiquidityAction } from './copilot-intent';

const SOL = { quote: 'USDC', base: 'SOL' }, WETH = { quote: 'USDC', base: 'WETH' };
const read = (text: string, units = SOL) => readRangeAnswer(text, units);
const action = (fields: Partial<CopilotLiquidityAction> = {}): CopilotLiquidityAction => ({ type: 'LIQUIDITY', protocol: 'ORCA', network: 'SOLANA',
  deposits: [{ asset: 'SOL', maxAmount: '0.1' }, { asset: 'USDC', maxAmount: '10' }], rangeUnit: null, lower: null, upper: null, slippageBps: null, ...fields });

describe('readRangeAnswer: short answers to FloFi\'s range question (EN/PT)', () => {
  it.each<[string, RangeAnswer]>([
    ['lower', { kind: 'SIDE', side: 'LOWER', value: null }], ['Lower', { kind: 'SIDE', side: 'LOWER', value: null }],
    ['the lower one', { kind: 'SIDE', side: 'LOWER', value: null }], ["it's the upper bound", { kind: 'SIDE', side: 'UPPER', value: null }],
    ['inferior', { kind: 'SIDE', side: 'LOWER', value: null }], ['é o superior', { kind: 'SIDE', side: 'UPPER', value: null }], ['mínimo', { kind: 'SIDE', side: 'LOWER', value: null }],
    ['1usdc', { kind: 'VALUE', value: '1', unit: 'PRICE' }], ['1 USDC', { kind: 'VALUE', value: '1', unit: 'PRICE' }], ['180', { kind: 'VALUE', value: '180', unit: null }],
    ['$180', { kind: 'VALUE', value: '180', unit: 'PRICE' }], ['180 USDC per SOL', { kind: 'VALUE', value: '180', unit: 'PRICE' }], ['1,5', { kind: 'VALUE', value: '1.5', unit: null }],
    ['upper 180', { kind: 'SIDE', side: 'UPPER', value: '180', unit: null }], ['the upper is 180', { kind: 'SIDE', side: 'UPPER', value: '180', unit: null }],
    ['o superior é 180', { kind: 'SIDE', side: 'UPPER', value: '180', unit: null }], ['make the lower 120', { kind: 'SIDE', side: 'LOWER', value: '120', unit: null }],
    ['muda o inferior para 120', { kind: 'SIDE', side: 'LOWER', value: '120', unit: null }], ['150 as the lower', { kind: 'SIDE', side: 'LOWER', value: '150', unit: null }],
    ['±10%', { kind: 'PERCENT', percent: '10' }], ['10% range', { kind: 'PERCENT', percent: '10' }], ['+/- 10%', { kind: 'PERCENT', percent: '10' }],
    ['10 percent around current price', { kind: 'PERCENT', percent: '10' }], ['faixa de 10%', { kind: 'PERCENT', percent: '10' }],
    ['10% para cada lado', { kind: 'PERCENT', percent: '10' }], ['mais ou menos 2,5%', { kind: 'PERCENT', percent: '2.5' }], ['a 10% range', { kind: 'PERCENT', percent: '10' }],
    ['A percentage range (for example, ±10%)', { kind: 'PERCENT', percent: null }], ['faixa percentual', { kind: 'PERCENT', percent: null }],
    ['full range', { kind: 'FULL' }], ['Full range', { kind: 'FULL' }], ['faixa completa', { kind: 'FULL' }], ['use the full range', { kind: 'FULL' }],
    ['a price range', { kind: 'UNIT', unit: 'PRICE' }], ['ticks', { kind: 'UNIT', unit: 'TICK' }], ['faixa de preço', { kind: 'UNIT', unit: 'PRICE' }],
    ['150 to 180', { kind: 'BOUNDS', unit: 'PRICE', lower: '150', upper: '180' }], ['between 150 and 180 USDC', { kind: 'BOUNDS', unit: 'PRICE', lower: '150', upper: '180' }],
    ['de 150 a 180', { kind: 'BOUNDS', unit: 'PRICE', lower: '150', upper: '180' }], ['150-180', { kind: 'BOUNDS', unit: 'PRICE', lower: '150', upper: '180' }],
    ['lower 150 and upper 180', { kind: 'BOUNDS', unit: 'PRICE', lower: '150', upper: '180' }], ['max 180 min 150', { kind: 'BOUNDS', unit: 'PRICE', lower: '150', upper: '180' }],
    ['ticks -600 to 600', { kind: 'BOUNDS', unit: 'TICK', lower: '-600', upper: '600' }], ['-600 to 600', { kind: 'BOUNDS', unit: 'TICK', lower: '-600', upper: '600' }],
  ])('%s', (text, expected) => expect(read(text)).toEqual(expected));
  it('keeps a unit named next to a side, and refuses a contradictory one', () => {
    expect(read('lower tick 600')).toEqual({ kind: 'SIDE', side: 'LOWER', value: '600', unit: 'TICK' });
    expect(read('upper 180 usdc')).toEqual({ kind: 'SIDE', side: 'UPPER', value: '180', unit: 'PRICE' });
    expect(read('preço superior 180')).toEqual({ kind: 'SIDE', side: 'UPPER', value: '180', unit: 'PRICE' });
    expect(read('lower tick 600 usdc')).toBeNull();
    expect(read('lower price -600')).toBeNull();
  });
  it('reads dollars and ETH for a USDC-per-WETH pool', () => {
    expect(read('2800 dollars', WETH)).toEqual({ kind: 'VALUE', value: '2800', unit: 'PRICE' });
    expect(read('3200 usdc per eth', WETH)).toEqual({ kind: 'VALUE', value: '3200', unit: 'PRICE' });
  });
  it.each(['0.1 SOL', '10 SOL', 'swap 1 USDC to WETH on Base', 'add liquidity 10 USDC and 0.004 ETH on Base', 'what is a range?', 'yes please do it now',
    '1,000', 'remove the last step', '-5% to +10%', 'lower or upper?', 'price -150', '180 WETH per USDC'])('is not a range answer: %s', text => {
    expect(read(text, text.includes('WETH') ? WETH : SOL)).toBeNull();
  });
});

describe('applyRangeAnswer: only the range slots change', () => {
  it('1usdc → hold and ask the side; lower → the held value becomes the lower bound; 180 → the upper bound', () => {
    const first = applyRangeAnswer(action(), null, read('1usdc')!)!;
    expect(first).toMatchObject({ ask: 'SIDE', hold: { value: '1' }, action: { rangeUnit: null, lower: null, upper: null } });
    const second = applyRangeAnswer(first.action, first.hold, read('lower')!)!;
    expect(second).toMatchObject({ ask: null, hold: null, action: { rangeUnit: 'PRICE', lower: '1', upper: null } });
    const third = applyRangeAnswer(second.action, second.hold, read('180')!)!;
    expect(third.action).toEqual(action({ rangeUnit: 'PRICE', lower: '1', upper: '180' }));
  });
  it('a side without a value waits for that value; a named side replaces only that bound', () => {
    const waiting = applyRangeAnswer(action(), null, read('upper')!)!;
    expect(waiting).toMatchObject({ ask: 'BOUND', hold: { side: 'UPPER' } });
    expect(applyRangeAnswer(waiting.action, waiting.hold, read('180')!)!.action).toMatchObject({ rangeUnit: 'PRICE', lower: null, upper: '180' });
    const both = action({ rangeUnit: 'PRICE', lower: '150', upper: '180' });
    expect(applyRangeAnswer(both, null, read('make the lower 120')!)!.action).toEqual(action({ rangeUnit: 'PRICE', lower: '120', upper: '180' }));
    // A bare value when both bounds exist is never assigned silently.
    expect(applyRangeAnswer(both, null, read('120')!)).toMatchObject({ ask: 'SIDE', hold: { value: '120' }, action: both });
  });
  it('a named unit decides the bound: "lower tick 600" in a price range starts tick bounds; choosing the kind in use keeps its bounds', () => {
    const prices = action({ rangeUnit: 'PRICE', lower: '150', upper: null });
    expect(applyRangeAnswer(prices, null, read('lower tick 600')!)!.action).toMatchObject({ rangeUnit: 'TICK', lower: '600', upper: null });
    expect(applyRangeAnswer(prices, null, read('upper 180 usdc')!)!.action).toMatchObject({ rangeUnit: 'PRICE', lower: '150', upper: '180' });
    expect(applyRangeAnswer(prices, null, read('a price range')!)!.action).toEqual(prices);
    expect(applyRangeAnswer(prices, null, read('ticks')!)!.action).toMatchObject({ rangeUnit: 'TICK', lower: null, upper: null });
  });
  it('a percentage, the full range or a unit replace the range only; deposits, network and slippage are untouched', () => {
    const base = action({ slippageBps: '50', rangeUnit: 'PRICE', lower: '150', upper: null });
    expect(applyRangeAnswer(base, null, read('±10%')!)!.action).toEqual({ ...base, rangeUnit: 'PERCENT', lower: null, upper: '10' });
    expect(applyRangeAnswer(base, null, read('full range')!)!.action).toEqual({ ...base, rangeUnit: 'FULL', lower: null, upper: null });
    const percent = applyRangeAnswer(base, null, read('a percentage range')!)!.action;
    expect(percent).toEqual({ ...base, rangeUnit: 'PERCENT', lower: null, upper: null });
    expect(applyRangeAnswer(percent, null, read('10')!)!.action).toEqual({ ...base, rangeUnit: 'PERCENT', lower: null, upper: '10' });
  });
});
