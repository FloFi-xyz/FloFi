// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD AAVE-V3-EXPANSION-001: live Aave reserve discovery against a scripted read-only Base market (no network). */
import { describe, expect, it } from 'vitest';
import { AAVE_V3_MARKETS } from '@defi-workflow-engine/action-registry';
import { aaveRateApyPercent, discoverAaveReserves, MULTICALL3 } from '../src/index.js';
import { createAaveMarketFixture, MAX_UINT256, MULTICALL3_ADDRESS, type AaveFixtureReserve } from './aave-market-fixture.ts';

const market = AAVE_V3_MARKETS.find(m => m.chain === 'eip155:8453')!;
const OWNER = '0x' + '3'.repeat(40);
type Reserve = AaveFixtureReserve;
const config = (decimals: number, extra = 0n) => 7500n | (7800n << 16n) | (BigInt(decimals) << 48n) | (1n << 56n) | (1n << 58n) | extra;
/** The scripted Base market (aave-market-fixture.ts) with one owner: wallet 7, supplied 5, no debt in every scripted reserve; USDC as collateral. */
function harness(reserves: Map<string, Reserve>, options: { multicall: boolean; extraListed?: string[]; failEMode?: boolean }) {
  return createAaveMarketFixture('eip155:8453', { reserves, multicall: options.multicall, extraListed: options.extraListed ?? [],
    account: { owner: OWNER, defaultPosition: { wallet: 7n, supplied: 5n, debt: 0n }, userConfiguration: 2n << 8n,
      accountData: [100n, 0n, 75n, 7800n, 7500n, MAX_UINT256], eMode: options.failEMode ? null : 0n } });
}
const usdc = market.primary, weth = market.reserves.find(r => r.symbol === 'WETH')!, cbbtc = market.reserves.find(r => r.symbol === 'cbBTC')!, gho = market.reserves.find(r => r.symbol === 'GHO')!;

describe('BUILD AAVE-V3-EXPANSION-001 Aave reserve discovery', () => {
  it.each([true, false])('reads the listed reserves, their identity and availability (multicall %s)', async multicall => {
    const reserves = new Map<string, Reserve>([
      [usdc.asset, { config: config(6, 100n << 116n), scaledSupply: 50n * 10n ** 6n, liquidityRate: 3n * 10n ** 25n }],
      [weth.asset, { config: config(18) }],
      [cbbtc.asset, { config: config(8, 1n << 57n) }],
      [gho.asset, { config: config(18) & ~(1n << 58n) }],
    ]);
    const unknown = '0x' + 'e'.repeat(40);
    const { rpc } = harness(reserves, { multicall, extraListed: [unknown] });
    const catalog = await discoverAaveReserves(rpc, 'eip155:8453', OWNER, Date.parse('2026-11-05T00:00:00Z'));
    expect(catalog).toMatchObject({ chain: 'eip155:8453', pool: market.pool, block: 100, unlisted: [unknown], account: { healthFactor: ((1n << 256n) - 1n).toString(), eMode: '0' } });
    const by = (symbol: string) => catalog.reserves.find(r => r.symbol === symbol)!;
    expect(by('USDC')).toMatchObject({ listed: true, verified: true, supplyCap: '100', supplied: '50000000', supply: { available: true }, borrow: { available: true },
      wallet: { balance: '7', supplied: '5', debt: '0', collateralEnabled: true } });
    expect(by('USDC').supplyApyPercent).toBeCloseTo(3.0454, 3);
    expect(by('WETH')).toMatchObject({ decimals: 18, verified: true, collateralEligible: true, supply: { available: true }, borrow: { available: true }, wallet: { collateralEnabled: false } });
    expect(by('cbBTC')).toMatchObject({ frozen: true, supply: { available: false, reason: 'RESERVE_FROZEN' }, borrow: { available: false, reason: 'RESERVE_FROZEN' } });
    expect(by('GHO')).toMatchObject({ borrowingEnabled: false, supply: { available: true }, borrow: { available: false, reason: 'BORROWING_DISABLED' } });
    // A registered reserve that this market's list does not return is never offered.
    expect(by('wstETH')).toMatchObject({ listed: false, verified: false, supply: { reason: 'NOT_LISTED_ON_CHAIN' } });
  });
  it('refuses a reserve whose on-chain identity differs from the registered profile, and caps that are reached', async () => {
    const reserves = new Map<string, Reserve>([[weth.asset, { config: config(18), aToken: '0x' + '9'.repeat(40) }],
      [usdc.asset, { config: config(6, (1n << 116n) | (1n << 80n)), scaledSupply: 10n ** 6n, debt: 10n ** 6n }]]);
    const catalog = await discoverAaveReserves(harness(reserves, { multicall: true }).rpc, 'eip155:8453');
    expect(catalog.reserves.find(r => r.symbol === 'WETH')).toMatchObject({ verified: false, supply: { reason: 'RESERVE_IDENTITY_MISMATCH' } });
    expect(catalog.reserves.find(r => r.symbol === 'USDC')).toMatchObject({ supply: { reason: 'SUPPLY_CAP_REACHED' }, borrow: { reason: 'BORROW_CAP_REACHED' } });
    expect(catalog.account).toBeUndefined();
  });
  it('reports an oracle source that differs from the snapshot and never guesses an unreadable account state', async () => {
    const reserves = new Map<string, Reserve>([[usdc.asset, { config: config(6) }], [weth.asset, { config: config(18), source: '0x' + '7'.repeat(40) }]]);
    const catalog = await discoverAaveReserves(harness(reserves, { multicall: true, failEMode: true }).rpc, 'eip155:8453', OWNER);
    expect(catalog.reserves.find(r => r.symbol === 'USDC')?.priceSourceMatches).toBe(true);
    expect(catalog.reserves.find(r => r.symbol === 'WETH')?.priceSourceMatches).toBe(false);
    // The E-Mode read failed: no account summary, and Borrow is not claimed available for this owner.
    expect(catalog.account).toBeUndefined();
    expect(catalog.reserves.find(r => r.symbol === 'USDC')).toMatchObject({ supply: { available: true }, borrow: { available: false, reason: 'ACCOUNT_STATE_UNKNOWN' } });
  });
  it('fails closed on another chain or market', async () => {
    const { rpc } = harness(new Map(), { multicall: true });
    await expect(discoverAaveReserves(async (m, p) => m === 'eth_chainId' ? '0x1' : rpc(m, p), 'eip155:8453')).rejects.toThrow('SUPPLY_WRONG_CHAIN');
    await expect(discoverAaveReserves(rpc, 'eip155:84532')).rejects.toThrow('AAVE_MARKET_UNSUPPORTED');
  });
  it('scripts the same Multicall3 deployment discovery batches through', () => {
    expect(MULTICALL3_ADDRESS).toBe(MULTICALL3);
  });
  it('reports APY as informational compounding of the current rate', () => {
    expect(aaveRateApyPercent(0n)).toBe(0);
    expect(aaveRateApyPercent(5n * 10n ** 25n)).toBeCloseTo(5.127, 2);
  });
});
