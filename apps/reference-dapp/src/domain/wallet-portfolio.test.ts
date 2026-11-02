// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { formatObservedAt, formatShare, formatTokenAmount, formatUsdPrice, formatUsdValue, isSolanaAddressText, normalizeEvmAddress, portfolioSummary,
  priceObservedAt, shortAddress, sortHoldings, sumUsd, usdCents, type PortfolioHolding, type PortfolioNetwork, type WalletPortfolio } from './wallet-portfolio';

const holding = (symbol: string, units: string, decimals: number, valueUsd: string | null, network: PortfolioHolding['networkId'] = 'base'): PortfolioHolding => ({
  networkId: network, network: network === 'solana' ? 'Solana' : 'Base', chain: network === 'solana' ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' : 'eip155:8453',
  symbol, name: symbol, address: symbol === 'ETH' || symbol === 'SOL' ? null : `0x${symbol.toLowerCase().padStart(40, '0')}`, decimals, units, displayUnits: units,
  displayBasis: 'RAW', unavailableCode: null, native: symbol === 'ETH' || symbol === 'SOL',
  provenance: 'PUBLIC_MAINNET', price: valueUsd ? { usd: '3000', source: 'CHAINLINK', observedAt: `2026-11-02T11:5${symbol.length}:00.000Z` } : null, valueUsd, logo: null });
const network = (id: PortfolioNetwork['id'], status: PortfolioNetwork['status'], tokens: PortfolioNetwork['tokens'] = status === 'READ' ? 'ALL' : null): PortfolioNetwork => ({
  id, name: id === 'solana' ? 'Solana' : id === 'base' ? 'Base' : id, chain: 'eip155:1', chainId: 1, ecosystem: id === 'solana' ? 'solana' : 'evm', status,
  provenance: status === 'NOT_ENABLED' ? null : 'PUBLIC_MAINNET', observedAt: null, block: null, slot: null, tokens, uncheckedTokens: 0, code: null });
function portfolio(holdings: PortfolioHolding[], networks: PortfolioNetwork[] = [network('base', 'READ'), network('solana', 'READ')]): WalletPortfolio {
  return { format: 'flofi.wallet-portfolio.v2', observedAt: '2026-11-02T12:00:00.000Z', accounts: [], networks, holdings, pricedTotalUsd: sumUsd(holdings.map(h => h.valueUsd)),
    unpricedCount: holdings.filter(h => !h.valueUsd).length, unlisted: 0, priceSource: 'CHAINLINK', mocked: false };
}

describe('wallet portfolio presentation', () => {
  it('formats exact token amounts by language, truncating and never rounding a balance up', () => {
    expect(formatTokenAmount('1234567891234567891234', 18)).toBe('1,234.56');
    expect(formatTokenAmount('1234567891234567891234', 18, 'PT')).toBe('1.234,56');
    expect(formatTokenAmount('1999999999999999999', 18)).toBe('1.9999');
    expect(formatTokenAmount('123456789', 9, 'PT')).toBe('0,123456');
    expect(formatTokenAmount('100000000', 6)).toBe('100');
    expect(formatTokenAmount('5', 18)).toBe('< 0.000001');
    expect(formatTokenAmount('5', 18, 'PT')).toBe('< 0,000001');
    expect(formatTokenAmount('1', 2)).toBe('0.01');
    expect(formatTokenAmount('42', 0)).toBe('42');
    expect(formatTokenAmount('0', 18)).toBe('0');
    expect(formatTokenAmount('-1', 18)).toBe('—'); expect(formatTokenAmount('1.5', 18)).toBe('—'); expect(formatTokenAmount('1', 40)).toBe('—');
  });
  it('formats USD values and unit prices by language, without inventing precision', () => {
    expect(formatUsdValue('1234567.89')).toBe('$1,234,567.89');
    expect(formatUsdValue('1234567.89', 'PT')).toBe('US$ 1.234.567,89');
    expect(formatUsdValue('0.00')).toBe('< $0.01'); expect(formatUsdValue('0.00', 'PT')).toBe('< US$ 0,01');
    expect(formatUsdValue('12.3')).toBe('—');
    expect(formatUsdPrice('2950.505')).toBe('$2,950.51'); expect(formatUsdPrice('2950.5', 'PT')).toBe('US$ 2.950,50'); expect(formatUsdPrice('x')).toBe('—');
    expect(sumUsd(['1.10', null, '2.95'])).toBe('4.05'); expect(sumUsd([null, undefined])).toBeNull(); expect(usdCents('10.05')).toBe(1005n); expect(usdCents('10.5')).toBeNull();
    expect(formatShare(0)).toBe('0%'); expect(formatShare(3)).toBe('<1%'); expect(formatShare(615)).toBe('62%');
  });
  it('validates and shortens wallet addresses', () => {
    expect(normalizeEvmAddress('0x' + 'AB'.repeat(20))).toBe('0x' + 'ab'.repeat(20));
    expect(normalizeEvmAddress('0x123')).toBeNull(); expect(normalizeEvmAddress(null)).toBeNull();
    expect(isSolanaAddressText('So11111111111111111111111111111111111111112')).toBe(true);
    expect(isSolanaAddressText('0x' + 'a'.repeat(40))).toBe(false);
    expect(shortAddress('0x' + '12'.repeat(20))).toBe('0x1212…1212');
    expect(shortAddress('So11111111111111111111111111111111111111112')).toBe('So11…1112');
  });
  it('sorts priced holdings by value, then every holding by its decimal amount', () => {
    const sorted = sortHoldings([holding('USDC', '500000000', 6, null), holding('WETH', '10', 18, '0.01'), holding('DAI', '2000000000000000000000', 18, null),
      holding('ETH', '10', 18, '120.00'), holding('SOL', '1000000000', 9, '150.00', 'solana')]);
    expect(sorted.map(h => h.symbol)).toEqual(['SOL', 'ETH', 'WETH', 'DAI', 'USDC']);
  });
  it('orders by the shown balance, never the raw one, and lists an unavailable balance last', () => {
    // A scaled token whose raw amount is the largest but whose shown amount is the smallest, and a balance that cannot be interpreted.
    const scaled = { ...holding('SCALED', '9000000', 6, null, 'solana'), displayUnits: '4500', displayBasis: 'SCALED_UI_AMOUNT' as const };
    const unknown = { ...holding('ODD', '1', 6, null, 'solana'), displayUnits: null, unavailableCode: 'SOLANA_TOKEN_EXTENSION_UNSUPPORTED' };
    const sorted = sortHoldings([unknown, scaled, holding('USDC', '1000000', 6, null, 'solana')]);
    expect(sorted.map(h => h.symbol)).toEqual(['USDC', 'SCALED', 'ODD']);
  });
  it('summarizes the priced share of the top holdings, the rest as Other, per network and by coverage', () => {
    const value = portfolio([holding('ETH', '1', 18, '600.00'), holding('WETH', '1', 18, '200.00'), holding('SOL', '1', 9, '150.00', 'solana'),
      holding('WSOL', '1', 9, '50.00', 'solana'), holding('USDC', '1', 6, null)],
    [network('ethereum', 'NOT_ENABLED'), network('base', 'READ', 'PARTIAL'), network('arbitrum-one', 'UNAVAILABLE'), network('solana', 'READ')]);
    const summary = portfolioSummary(value);
    expect(summary.segments.map(s => [s.symbol, s.perMille])).toEqual([['ETH', 600], ['WETH', 200], ['SOL', 150]]);
    expect(summary.other).toEqual({ valueUsd: '50.00', perMille: 50 });
    expect(summary.top.map(h => h.symbol)).toEqual(['ETH', 'WETH', 'SOL']);
    expect(summary.byNetwork).toEqual([{ id: 'base', name: 'Base', holdings: 3, valueUsd: '800.00' }, { id: 'solana', name: 'Solana', holdings: 2, valueUsd: '200.00' }]);
    expect([summary.read.length, summary.unavailable.length, summary.notEnabled.length, summary.partial.map(n => n.id)]).toEqual([2, 1, 1, ['base']]);
    expect(summary.pricedCount).toBe(4);
    expect(priceObservedAt(value)).toBe('2026-11-02T11:53:00.000Z');
  });
  it('draws no bar and no share without a priced total', () => {
    const summary = portfolioSummary(portfolio([holding('USDC', '1', 6, null)]));
    expect(summary.segments).toEqual([]); expect(summary.other).toBeNull(); expect(summary.pricedCount).toBe(0);
    expect(priceObservedAt(portfolio([holding('USDC', '1', 6, null)]))).toBeNull();
  });
  it('formats observation times in UTC for each language', () => {
    expect(formatObservedAt('2026-11-02T14:03:00.000Z')).toMatch(/Nov.*2026.*2:03.*UTC$/);
    expect(formatObservedAt('2026-11-02T14:03:00.000Z', 'PT')).toMatch(/nov.*2026.*14:03 UTC$/);
    expect(formatObservedAt('not a date')).toBeNull(); expect(formatObservedAt(null)).toBeNull();
  });
});
