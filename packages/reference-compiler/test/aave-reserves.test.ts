// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD AAVE-V3-EXPANSION-001: live Aave reserve discovery against a scripted read-only Base market (no network). */
import { describe, expect, it } from 'vitest';
import { AAVE_V3_MARKETS } from '@defi-workflow-engine/action-registry';
import { aaveRateApyPercent, discoverAaveReserves, MULTICALL3, supplyCall, supplySelector, supplyWord, type SupplyRpc } from '../src/index.js';

const market = AAVE_V3_MARKETS.find(m => m.chain === 'eip155:8453')!;
const OWNER = '0x' + '3'.repeat(40), RAY = 10n ** 27n;
type Reserve = { config: bigint; listed?: boolean; id?: number; aToken?: string; price?: bigint; liquidity?: bigint; scaledSupply?: bigint; debt?: bigint; liquidityRate?: bigint };
const config = (decimals: number, extra = 0n) => 7500n | (7800n << 16n) | (BigInt(decimals) << 48n) | (1n << 56n) | (1n << 58n) | extra;
function harness(reserves: Map<string, Reserve>, options: { multicall: boolean; extraListed?: string[] }) {
  const calls: string[] = [];
  const answer = (to: string, data: string): string | null => {
    const word = (v: bigint | string) => '0x' + supplyWord(v);
    if (to === market.provider && data === supplyCall('getPool()')) return word(market.pool);
    if (to === market.pool && data === supplyCall('getReservesList()')) {
      const listed = [...[...reserves].filter(([, r]) => r.listed !== false).map(([a]) => a), ...options.extraListed ?? []];
      return '0x' + supplyWord(32n) + supplyWord(BigInt(listed.length)) + listed.map(a => supplyWord(a)).join('');
    }
    for (const profile of market.reserves) {
      const r = reserves.get(profile.asset);
      if (!r) continue;
      if (to === market.pool && data === supplyCall('getReserveData(address)', profile.asset)) {
        const w = Array.from({ length: 15 }, () => 0n);
        w[0] = r.config; w[1] = RAY; w[2] = r.liquidityRate ?? 0n; w[3] = RAY; w[4] = 0n; w[7] = BigInt(r.id ?? profile.reserveId); w[8] = BigInt(r.aToken ?? profile.aToken); w[10] = BigInt(profile.variableDebtToken);
        return '0x' + w.map(v => supplyWord(v)).join('');
      }
      if (to === market.pool && data === supplyCall('getReserveNormalizedIncome(address)', profile.asset)) return word(RAY);
      if (to === profile.aToken && data === supplyCall('scaledTotalSupply()')) return word(r.scaledSupply ?? 0n);
      if (to === profile.variableDebtToken && data === supplyCall('totalSupply()')) return word(r.debt ?? 0n);
      if (to === profile.asset && data === supplyCall('balanceOf(address)', profile.aToken)) return word(r.liquidity ?? 10n ** 24n);
      if (to === market.oracle && data === supplyCall('getAssetPrice(address)', profile.asset)) return word(r.price ?? 100000000n);
      if (to === profile.asset && data === supplyCall('balanceOf(address)', OWNER)) return word(7n);
      if (to === profile.aToken && data === supplyCall('balanceOf(address)', OWNER)) return word(5n);
      if (to === profile.variableDebtToken && data === supplyCall('balanceOf(address)', OWNER)) return word(0n);
    }
    if (to === market.pool && data === supplyCall('getUserAccountData(address)', OWNER)) return '0x' + [100n, 0n, 75n, 7800n, 7500n, (1n << 256n) - 1n].map(v => supplyWord(v)).join('');
    if (to === market.pool && data === supplyCall('getUserConfiguration(address)', OWNER)) return word(2n << 8n);
    if (to === market.pool && data === supplyCall('getUserEMode(address)', OWNER)) return word(0n);
    return null;
  };
  const rpc: SupplyRpc = async (method, params) => {
    calls.push(method);
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: '0x' + 'a'.repeat(64) };
    if (method === 'eth_getCode') return options.multicall ? '0x60806040' : '0x';
    if (method !== 'eth_call') throw new Error('unexpected ' + method);
    const { to, data } = params[0] as { to: string; data: string };
    if (to === MULTICALL3) {
      if (!options.multicall || !data.startsWith(supplySelector('aggregate3((address,bool,bytes)[])'))) throw new Error('multicall unavailable');
      // Decode aggregate3((address,bool,bytes)[]) exactly as ABI-encoded, answer each call, encode (bool,bytes)[].
      const hex = data.slice(10), at = (o: number) => BigInt('0x' + hex.slice(o * 2, o * 2 + 64));
      const base = Number(at(0)), n = Number(at(base)), items = base + 32;
      const answers = Array.from({ length: n }, (_, i) => {
        const t = items + Number(at(items + 32 * i)), target = '0x' + hex.slice(t * 2 + 24, t * 2 + 64), bytes = t + Number(at(t + 64)), size = Number(at(bytes));
        return answer(target, '0x' + hex.slice((bytes + 32) * 2, (bytes + 32 + size) * 2));
      });
      const tuples = answers.map(a => { const d = (a ?? '0x').slice(2); return supplyWord(a ? 1n : 0n) + supplyWord(64n) + supplyWord(BigInt(d.length / 2)) + d.padEnd(Math.ceil(d.length / 64) * 64, '0'); });
      let offset = 32n * BigInt(tuples.length);
      const offsets = tuples.map(t => { const o = offset; offset += BigInt(t.length / 2); return supplyWord(o); });
      return '0x' + supplyWord(32n) + supplyWord(BigInt(n)) + offsets.join('') + tuples.join('');
    }
    const result = answer(to, data);
    if (result === null) throw new Error('execution reverted');
    return result;
  };
  return { rpc, calls };
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
  it('fails closed on another chain or market', async () => {
    const { rpc } = harness(new Map(), { multicall: true });
    await expect(discoverAaveReserves(async (m, p) => m === 'eth_chainId' ? '0x1' : rpc(m, p), 'eip155:8453')).rejects.toThrow('SUPPLY_WRONG_CHAIN');
    await expect(discoverAaveReserves(rpc, 'eip155:84532')).rejects.toThrow('AAVE_MARKET_UNSUPPORTED');
  });
  it('reports APY as informational compounding of the current rate', () => {
    expect(aaveRateApyPercent(0n)).toBe(0);
    expect(aaveRateApyPercent(5n * 10n ** 25n)).toBeCloseTo(5.127, 2);
  });
});
