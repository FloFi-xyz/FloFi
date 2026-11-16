// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { basisPointsLabel, bridgeIncludedCost, HIGH_BRIDGE_COST_BASIS_POINTS } from './bridge-costs';
import { translate } from '../i18n/locale';

const BASE_USDC = { chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC' };
const fee = (amount: string, extra: Partial<{ chainId: string; token: string; decimals: number; symbol: string; included: boolean }> = {}) =>
  ({ amount, chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC', included: true, ...extra });

describe('bridge cost disclosure (Incident E)', () => {
  it('Base → Solana 1 USDC (production quote): 0.148723 USDC included, 14.8% of the input, warned before authorization', () => {
    const cost = bridgeIncludedCost({ inputAmount: '1000000', inputToken: BASE_USDC, fees: [fee('128418'), fee('20305', { chainId: 'eip155:8453', token: BASE_USDC.address }),
      fee('2100000000000', { chainId: 'eip155:8453', token: 'native', decimals: 18, symbol: 'ETH', included: false })] });
    expect(cost).toEqual({ units: 148723n, decimals: 6, symbol: 'USDC', basisPoints: 1487 });
    // Exactly the gap between the amount sent and the quoted 0.851277: the included total is never added on top of the output difference.
    expect(1_000_000n - cost!.units).toBe(851_277n);
    expect(basisPointsLabel(cost!.basisPoints)).toBe('14.8%');
    expect(cost!.basisPoints).toBeGreaterThanOrEqual(HIGH_BRIDGE_COST_BASIS_POINTS);
  });
  it('a small fee share is shown without a warning', () => {
    const cost = bridgeIncludedCost({ inputAmount: '100000000', inputToken: BASE_USDC, fees: [fee('30000')] })!;
    expect(basisPointsLabel(cost.basisPoints)).toBe('<0.1%'); expect(cost.basisPoints).toBeLessThan(HIGH_BRIDGE_COST_BASIS_POINTS);
    expect(basisPointsLabel(55)).toBe('0.5%');
  });
  it('claims no total or percentage when an included fee is in another asset, when nothing is included, or when the data is malformed', () => {
    expect(bridgeIncludedCost({ inputAmount: '1000000', inputToken: BASE_USDC, fees: [fee('100'), fee('5', { symbol: 'SOL', decimals: 9 })] })).toBeNull();
    expect(bridgeIncludedCost({ inputAmount: '1000000', inputToken: BASE_USDC, fees: [fee('100', { included: false })] })).toBeNull();
    expect(bridgeIncludedCost({ inputAmount: 'x', inputToken: BASE_USDC, fees: [fee('100')] })).toBeNull();
    expect(bridgeIncludedCost({ inputAmount: '10', inputToken: BASE_USDC, fees: [fee('100')] })).toBeNull();
  });
  it('native ETH bridges sum fees the provider names as native ETH', () => {
    const eth = { chainId: 'eip155:8453', address: null, decimals: 18, symbol: 'ETH' };
    expect(bridgeIncludedCost({ inputAmount: '1000000000000000', inputToken: eth, fees: [fee('20000000000000', { chainId: 'eip155:8453', token: 'native', decimals: 18, symbol: 'ETH' })] }))
      .toMatchObject({ basisPoints: 200 });
  });
  it('the consumer copy is translated with its value', () => {
    expect(translate('PT', 'About 14.8% of the amount you send. Already taken out of the expected amount; never charged again.')).toMatch(/^Cerca de 14\.8% do valor/);
    expect(translate('PT', 'The recipient’s Solana wallet has no USDC account yet. The bridge provider creates it at delivery; its one-time cost is part of the provider’s destination fee, already included in the quote.'))
      .toMatch(/^A carteira Solana do destinatário ainda não tem uma conta de USDC/);
    expect(translate('PT', 'Provider fees take about 14.8% of the amount you send. Fixed costs weigh more for small amounts. Review the amounts before you continue.'))
      .toContain('14.8%');
    expect(translate('PT', 'Provider fees take about 14.8% of the amount you send. Fixed costs weigh more for small amounts. Review the amounts before you continue.'))
      .toMatch(/^As taxas do provedor/);
  });
});
