// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { relativeAmountIn, relativeBasisPoints } from './relative-amount';
import { relativeShortcut } from './amount-shortcuts';

describe('relative amounts (BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001)', () => {
  it.each([
    ['Converta todo o USDC que tenho em ETH.', { kind: 'ALL' }], ['Troque toda a minha WETH por USDC', { kind: 'ALL' }],
    ['swap all my USDC to ETH on Base', { kind: 'ALL' }], ['bridge all of the USDC to Arbitrum', { kind: 'ALL' }],
    ['quero trocar tudo que tenho de SOL', { kind: 'ALL' }], ['swap half my ETH for USDC', { kind: 'PERCENT', percent: '50' }],
    ['troque metade do meu SOL por USDC', { kind: 'PERCENT', percent: '50' }], ['swap 25% of my SOL to USDC', { kind: 'PERCENT', percent: '25' }],
    ['troque 12,5% do meu USDC por ETH', { kind: 'PERCENT', percent: '12.5' }], ['100% do meu USDC', { kind: 'ALL' }],
  ])('%s', (text, expected) => expect(relativeAmountIn(text)).toEqual(expected));
  it.each(['swap 1 USDC to ETH with 1% of slippage', 'troque 1 USDC por ETH com slippage de 2%', 'compre ETH todo dia às 9h', 'toda semana compre 10 USDC de ETH',
    'swap 10 USDC to ETH', 'troque 150% do meu USDC', '0% of my USDC'])('%s is not relative', text => expect(relativeAmountIn(text)).toBeNull());
  it('reads percentages as integer hundredths', () => {
    expect(relativeBasisPoints({ kind: 'ALL' })).toBe(10_000n);
    expect(relativeBasisPoints({ kind: 'PERCENT', percent: '12.5' })).toBe(1_250n);
  });
  it('writes the token balance exactly for ALL, rounds percentages down, and keeps the native fee reserve', () => {
    const usdc = { decimals: 6, native: false, chain: 'eip155:8453' };
    expect(relativeShortcut(12_345_678n, usdc, { kind: 'ALL' }).amount).toBe('12.345678');
    expect(relativeShortcut(10_000_001n, usdc, { kind: 'PERCENT', percent: '50' }).amount).toBe('5');
    const eth = { decimals: 18, native: true, chain: 'eip155:8453' };
    // 0.01 ETH minus Base's 0.0005 ETH reserve.
    expect(relativeShortcut(10_000_000_000_000_000n, eth, { kind: 'ALL' }).amount).toBe('0.0095');
    // A balance under the reserve writes nothing: FloFi never proposes an amount the wallet cannot spend with its fees.
    expect(relativeShortcut(400_000_000_000_000n, eth, { kind: 'ALL' }).amount).toBeNull();
    expect(relativeShortcut(0n, usdc, { kind: 'ALL' }).amount).toBeNull();
    // A native coin without a defined reserve has no "all".
    expect(relativeShortcut(10n ** 18n, { decimals: 18, native: true, chain: 'eip155:999999' }, { kind: 'ALL' }).amount).toBeNull();
  });
});
