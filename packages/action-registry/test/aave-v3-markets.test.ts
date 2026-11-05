// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { AAVE_V3_ADDRESS_BOOK, AAVE_V3_ADDRESS_BOOK_COMMIT, AAVE_V3_ARBITRUM, AAVE_V3_BASE, AAVE_V3_BASE_SEPOLIA, AAVE_V3_ETHEREUM, AAVE_V3_ETHEREUM_SEPOLIA,
  AAVE_V3_LENDING_PROFILES, AAVE_V3_MARKETS, aaveLendingProfile, aaveMarketReserves, aaveReserveLabel, aaveReserveProfile, assertAaveLendingProfile,
  isAaveExpansionReserve } from '../src/index.js';

const WETH = { 'eip155:8453': '0x4200000000000000000000000000000000000006', 'eip155:1': '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'eip155:42161': '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' } as const;

describe('BUILD AAVE-V3-EXPANSION-001 market catalog', () => {
  it('lists every reserve of the three mainnet Core markets from one pinned address-book commit', () => {
    expect(AAVE_V3_ADDRESS_BOOK_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(AAVE_V3_MARKETS.map(m => [m.chain, m.reserves.length])).toEqual([['eip155:1', 67], ['eip155:8453', 15], ['eip155:42161', 20]]);
    expect(aaveMarketReserves('eip155:8453')).toHaveLength(15);
    expect(aaveMarketReserves('eip155:42161')).toHaveLength(20);
    expect(aaveMarketReserves('eip155:1')).toHaveLength(67);
    // The testnets keep their one verified asset each; no other network gains a market.
    expect(aaveMarketReserves('eip155:84532')).toEqual([AAVE_V3_BASE_SEPOLIA]);
    expect(aaveMarketReserves('eip155:11155111')).toEqual([AAVE_V3_ETHEREUM_SEPOLIA]);
    expect(aaveMarketReserves('eip155:10')).toEqual([]);
    expect(AAVE_V3_LENDING_PROFILES).toHaveLength(2 + 67 + 15 + 20);
  });
  it('keeps the verified native-USDC profiles as the same frozen objects, first in each market', () => {
    for (const legacy of [AAVE_V3_BASE, AAVE_V3_ARBITRUM, AAVE_V3_ETHEREUM]) {
      const market = AAVE_V3_MARKETS.find(m => m.chain === legacy.chain)!;
      expect(market.primary).toBe(legacy);
      expect(market.reserves[0]).toBe(legacy);
      expect(aaveLendingProfile(legacy.chain)).toBe(legacy);
      expect(aaveReserveProfile(legacy.chain, legacy.asset)).toBe(legacy);
      expect(isAaveExpansionReserve(legacy)).toBe(false);
      expect(market.pool).toBe(legacy.pool);
    }
  });
  it('derives each other reserve from its own market, identified by chain + Pool + underlying + decimals', () => {
    for (const market of AAVE_V3_MARKETS) {
      const book = AAVE_V3_ADDRESS_BOOK.find(b => b.chain === market.chain)!;
      for (const reserve of market.reserves) {
        const entry = book.reserves.find(r => r.underlying === reserve.asset)!;
        expect(entry).toBeDefined();
        expect(reserve).toMatchObject({ chain: market.chain, pool: market.pool, provider: market.provider, oracle: market.oracle, reserveId: entry.id,
          decimals: entry.decimals, aToken: entry.aToken, variableDebtToken: entry.variableDebtToken, protocol: 'aave-v3', environment: 'MAINNET' });
        expect(Object.isFrozen(reserve)).toBe(true);
        expect(assertAaveLendingProfile(reserve)).toBe(reserve);
        if (isAaveExpansionReserve(reserve)) {
          expect(reserve).toMatchObject({ ownerBeneficiary: true, validateSupplyCap: true, priceSource: entry.oracle, addressBookKey: entry.key });
          expect(reserve.officialSource).toContain(AAVE_V3_ADDRESS_BOOK_COMMIT);
        }
        for (const address of [reserve.asset, reserve.aToken, reserve.variableDebtToken]) expect(address).toMatch(/^0x[0-9a-f]{40}$/);
      }
      // Ids, underlyings, aTokens, debt tokens and (case-insensitive) labels are unique within a market.
      for (const field of ['reserveId', 'asset', 'aToken', 'variableDebtToken'] as const)
        expect(new Set(market.reserves.map(r => r[field])).size).toBe(market.reserves.length);
      expect(new Set(market.reserves.map(r => r.symbol.toLowerCase())).size).toBe(market.reserves.length);
    }
  });
  it('resolves reserves by exact address and decimals, never by symbol, and refuses copies', () => {
    for (const [chain, weth] of Object.entries(WETH)) {
      const profile = aaveReserveProfile(chain, weth.toUpperCase().replace('0X', '0x'), 18);
      expect(profile).toMatchObject({ symbol: 'WETH', decimals: 18, asset: weth });
      expect(() => aaveReserveProfile(chain, weth, 6)).toThrow('AAVE_PROFILE_UNSUPPORTED');
    }
    expect(aaveReserveProfile('eip155:8453', '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf')).toMatchObject({ symbol: 'cbBTC', decimals: 8 });
    expect(aaveReserveProfile('eip155:1', '0xdac17f958d2ee523a2206206994597c13d831ec7')).toMatchObject({ symbol: 'USDT', decimals: 6, reserveId: 8 });
    expect(aaveReserveProfile('eip155:1', '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f')).toMatchObject({ symbol: 'GHO', decimals: 18 });
    // WETH of Base is not a reserve of Arbitrum.
    expect(() => aaveReserveProfile('eip155:42161', WETH['eip155:8453'])).toThrow('AAVE_PROFILE_UNSUPPORTED');
    expect(() => aaveReserveProfile('eip155:8453', 'WETH')).toThrow('AAVE_PROFILE_UNSUPPORTED');
    const copy = { ...aaveReserveProfile('eip155:8453', WETH['eip155:8453']) };
    expect(() => assertAaveLendingProfile(copy)).toThrow('AAVE_PROFILE_UNSUPPORTED');
  });
  it('labels address-book keys with their token symbols (labels are display/alias only)', () => {
    expect(aaveReserveLabel('USDCn')).toBe('USDC');
    expect(aaveReserveLabel('USDCe')).toBe('USDC.e');
    expect(aaveReserveLabel('ONE_INCH')).toBe('1INCH');
    expect(aaveReserveLabel('PT_eUSDE_29MAY2025')).toBe('PT-eUSDE-29MAY2025');
    const arbitrum = aaveMarketReserves('eip155:42161');
    expect(arbitrum.find(r => r.symbol === 'USDC')).toBe(AAVE_V3_ARBITRUM);
    expect(arbitrum.find(r => r.symbol === 'USDC.e')?.asset).toBe('0xff970a61a04b1ca14834a43f5de4533ebddb5cc8');
  });
});
