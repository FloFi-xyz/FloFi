// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD AAVE-V3-EXPANSION-001: live discovery of an Aave V3 market's reserves, read-only.
 *
 * Reads the market's actual `Pool.getReservesList()` at one block and, for every listed reserve, `getReserveData`, the normalized income,
 * supply/borrow usage, available liquidity and the AaveOracle price (optionally the owner's wallet, aToken and debt balances and account
 * aggregates). Each listed reserve is matched to its registered profile (chain + Pool + underlying + decimals, reserve id, aToken and
 * variable-debt token); a reserve the registry does not list, or whose on-chain identity differs, is reported but never offered as usable.
 * The result is display information for pickers: availability reasons are computed from the same configuration bits the lending engine
 * checks, and APY is the current variable rate compounded per second — informational, never a promise. Simulate and every financial
 * preflight re-read the chain; nothing here authorizes or prepares a transaction.
 */
import { AAVE_V3_ADDRESS_BOOK, AAVE_V3_MARKETS, type AaveLendingProfile } from '@defi-workflow-engine/action-registry';
import { supplyAddress } from '@defi-workflow-engine/workflow-contracts';
import { reserveFlags } from './borrow.js';
import { rpcHash, rpcHex, rpcRecord, rpcUint, supplyCall, supplySelector, supplyWord, type SupplyRpc } from './supply.js';

export type AaveReserveAvailability = { readonly available: boolean; readonly reason: AaveReserveReason | null };
export type AaveReserveReason = 'RESERVE_INACTIVE' | 'RESERVE_PAUSED' | 'RESERVE_FROZEN' | 'SUPPLY_CAP_REACHED' | 'BORROWING_DISABLED' | 'BORROW_CAP_REACHED'
  | 'NO_LIQUIDITY' | 'ORACLE_UNAVAILABLE' | 'ISOLATED_RESERVE_UNSUPPORTED' | 'RESERVE_IDENTITY_MISMATCH' | 'NOT_LISTED_ON_CHAIN' | 'ACCOUNT_EMODE_UNSUPPORTED'
  | 'ACCOUNT_STATE_UNKNOWN';
export type AaveReserveStatus = {
  readonly reserveId: number; readonly asset: string; readonly symbol: string; readonly decimals: number; readonly aToken: string; readonly variableDebtToken: string;
  readonly listed: boolean; readonly verified: boolean; readonly active: boolean; readonly frozen: boolean; readonly paused: boolean; readonly borrowingEnabled: boolean;
  /** LTV and liquidation threshold in basis points; a reserve with LTV 0 adds no borrowing power. */ readonly ltvBps: number; readonly liquidationThresholdBps: number;
  readonly collateralEligible: boolean; readonly isolated: boolean; readonly siloed: boolean;
  /** Caps in whole tokens (0 = no cap) and current usage in the reserve's units. */
  readonly supplyCap: string; readonly borrowCap: string; readonly supplied: string; readonly borrowed: string; readonly availableLiquidity: string;
  /** Oracle price in the market's base currency (8 decimals); 0 when the oracle did not answer. */ readonly price: string;
  /** Whether the AaveOracle's source for this asset is still the one in the pinned snapshot (null when it could not be read). Informational. */
  readonly priceSourceMatches: boolean | null;
  /** Current variable rates as APY in percent (informational, variable). */ readonly supplyApyPercent: number; readonly borrowApyPercent: number;
  readonly supply: AaveReserveAvailability; readonly borrow: AaveReserveAvailability;
  /** False when a reserve read failed: its zero-valued facts are then unknown, never live values (shown as unavailable; Simulate checks on chain). */
  readonly complete?: boolean;
  /** The owner's balances (omitted when they could not be read); `collateralEnabled` is null when the account configuration could not be read (never guessed). */
  readonly wallet?: { readonly balance: string; readonly supplied: string; readonly debt: string; readonly collateralEnabled: boolean | null };
};
export type AaveAccountSummary = { readonly collateralBase: string; readonly debtBase: string; readonly availableBorrowBase: string; readonly healthFactor: string;
  readonly ltvBps: string; readonly liquidationThresholdBps: string; readonly eMode: string };
export type AaveMarketCatalog = { readonly chain: string; readonly network: string; readonly pool: string; readonly block: number; readonly blockHash: string;
  readonly observedAt: string; readonly reserves: readonly AaveReserveStatus[]; readonly unlisted: readonly string[]; readonly account?: AaveAccountSummary;
  /** Where the reads came from; set by the serving runtime (MOCKED for the loopback harness, never shown as a live market). */
  readonly provenance?: 'PUBLIC_MAINNET' | 'MOCKED' };

const RAY = 10n ** 27n, SECONDS_PER_YEAR = 31_536_000;
/** Multicall3: the same verified deployment on Ethereum, Base and Arbitrum One. Used only to batch read-only eth_call. */
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
type Call = { readonly to: string; readonly data: string };

/** The current variable rate (ray, per year) as an APY in percent, compounded per second. Display only. */
export function aaveRateApyPercent(rate: bigint): number {
  if (rate <= 0n) return 0;
  const apr = Number(rate * 1_000_000_000n / RAY) / 1e9;
  return Math.round((Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1) * 1e6) / 1e4;
}
function encodeAggregate3(calls: readonly Call[]): string {
  const tuples = calls.map(call => {
    const data = call.data.slice(2), padded = data.padEnd(Math.ceil(data.length / 64) * 64, '0');
    return supplyWord(call.to) + supplyWord(1n) + supplyWord(96n) + supplyWord(BigInt(data.length / 2)) + padded;
  });
  let offset = 32n * BigInt(tuples.length);
  const offsets = tuples.map(tuple => { const at = offset; offset += BigInt(tuple.length / 2); return supplyWord(at); });
  return supplySelector('aggregate3((address,bool,bytes)[])') + supplyWord(32n) + supplyWord(BigInt(tuples.length)) + offsets.join('') + tuples.join('');
}
function decodeAggregate3(value: unknown, count: number): (string | null)[] {
  const hex = rpcHex(value).slice(2), word = (at: number) => { if (at < 0 || at * 2 + 64 > hex.length) throw new Error('AAVE_DISCOVERY_RPC_INVALID'); return BigInt('0x' + hex.slice(at * 2, at * 2 + 64)); };
  const array = Number(word(0)), length = Number(word(array));
  if (length !== count) throw new Error('AAVE_DISCOVERY_RPC_INVALID');
  const base = array + 32;
  return Array.from({ length }, (_, i) => {
    const tuple = base + Number(word(base + 32 * i)), success = word(tuple) === 1n, bytesAt = tuple + Number(word(tuple + 32)), size = Number(word(bytesAt));
    if (!Number.isSafeInteger(size) || size > 65_536 || (bytesAt + 32 + size) * 2 > hex.length) throw new Error('AAVE_DISCOVERY_RPC_INVALID');
    return success ? '0x' + hex.slice((bytesAt + 32) * 2, (bytesAt + 32 + size) * 2) : null;
  });
}
/** Read-only calls at one block, batched through Multicall3 when it is deployed there; otherwise one bounded eth_call each. */
async function readCalls(rpc: SupplyRpc, calls: readonly Call[], tag: string, batched: boolean): Promise<(string | null)[]> {
  if (!batched) {
    const out: (string | null)[] = [];
    for (let i = 0; i < calls.length; i += 8) out.push(...await Promise.all(calls.slice(i, i + 8).map(call => rpc('eth_call', [call, tag]).then(rpcHex, () => null))));
    return out;
  }
  const out: (string | null)[] = [];
  for (let i = 0; i < calls.length; i += 120) {
    const chunk = calls.slice(i, i + 120);
    out.push(...decodeAggregate3(await rpc('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(chunk) }, tag]), chunk.length));
  }
  return out;
}
const uint = (value: string | null): bigint | null => value && /^0x[0-9a-f]{1,64}$/i.test(value) ? BigInt(value) : value && /^0x[0-9a-f]{64}$/i.test(value.slice(0, 66)) ? BigInt(value.slice(0, 66)) : null;
const address = (value: string | null): string | null => { const n = uint(value); return n === null || n >> 160n ? null : '0x' + n.toString(16).padStart(40, '0'); };
function reasonFor(kind: 'supply' | 'borrow', status: Omit<AaveReserveStatus, 'supply' | 'borrow' | 'wallet'>, eMode: bigint | null): AaveReserveReason | null {
  if (!status.listed) return 'NOT_LISTED_ON_CHAIN';
  if (!status.verified) return 'RESERVE_IDENTITY_MISMATCH';
  if (!status.active) return 'RESERVE_INACTIVE';
  if (status.paused) return 'RESERVE_PAUSED';
  if (status.frozen) return 'RESERVE_FROZEN';
  const unit = 10n ** BigInt(status.decimals);
  if (kind === 'supply') return BigInt(status.supplyCap) && BigInt(status.supplied) >= BigInt(status.supplyCap) * unit ? 'SUPPLY_CAP_REACHED' : null;
  if (!status.borrowingEnabled) return 'BORROWING_DISABLED';
  if (status.isolated) return 'ISOLATED_RESERVE_UNSUPPORTED';
  if (BigInt(status.borrowCap) && BigInt(status.borrowed) >= BigInt(status.borrowCap) * unit) return 'BORROW_CAP_REACHED';
  if (BigInt(status.availableLiquidity) === 0n) return 'NO_LIQUIDITY';
  if (BigInt(status.price) === 0n) return 'ORACLE_UNAVAILABLE';
  if (eMode === null) return 'ACCOUNT_STATE_UNKNOWN';
  if (eMode !== 0n) return 'ACCOUNT_EMODE_UNSUPPORTED';
  return null;
}

/** The live reserve catalog of a registered mainnet market (`chain`), optionally with one owner's balances and account aggregates. */
export async function discoverAaveReserves(rpc: SupplyRpc, chain: string, accountInput?: string, now = Date.now()): Promise<AaveMarketCatalog> {
  const market = AAVE_V3_MARKETS.find(item => item.chain === chain);
  if (!market) throw new Error('AAVE_MARKET_UNSUPPORTED');
  const account = accountInput ? supplyAddress(accountInput) : null;
  if (rpcUint(await rpc('eth_chainId', [])) !== BigInt(market.chainId)) throw new Error('SUPPLY_WRONG_CHAIN');
  const block = rpcRecord(await rpc('eth_getBlockByNumber', ['latest', false])), tag = rpcHex(block.number), blockHash = rpcHash(block.hash);
  const [poolOfProvider, list, multicallCode] = await Promise.all([rpc('eth_call', [{ to: market.provider, data: supplyCall('getPool()') }, tag]),
    rpc('eth_call', [{ to: market.pool, data: supplyCall('getReservesList()') }, tag]), rpc('eth_getCode', [MULTICALL3, tag])]);
  if (rpcUint(poolOfProvider) !== BigInt(market.pool)) throw new Error('SUPPLY_DEPLOYMENT_MISMATCH');
  const listHex = rpcHex(list).slice(2), words = listHex.match(/.{64}/g) ?? [];
  const count = words.length >= 2 ? Number(BigInt('0x' + words[1]!)) : -1;
  if (count < 0 || count > 256 || words.length !== count + 2) throw new Error('AAVE_DISCOVERY_RPC_INVALID');
  const listed = words.slice(2).map(word => '0x' + word.slice(24).toLowerCase());
  const profiles = market.reserves, byAsset = new Map(profiles.map(profile => [profile.asset, profile]));
  // An address without code answers "0x": then each read is its own bounded eth_call.
  const batched = typeof multicallCode === 'string' && /^0x[0-9a-fA-F]{4,}$/.test(multicallCode);
  const calls: Call[] = [];
  const plan = profiles.map(profile => {
    const start = calls.length;
    calls.push({ to: market.pool, data: supplyCall('getReserveData(address)', profile.asset) }, { to: market.pool, data: supplyCall('getReserveNormalizedIncome(address)', profile.asset) },
      { to: profile.aToken, data: supplyCall('scaledTotalSupply()') }, { to: profile.variableDebtToken, data: supplyCall('totalSupply()') },
      { to: profile.asset, data: supplyCall('balanceOf(address)', profile.aToken) }, { to: market.oracle, data: supplyCall('getAssetPrice(address)', profile.asset) },
      { to: market.oracle, data: supplyCall('getSourceOfAsset(address)', profile.asset) },
      ...account ? [{ to: profile.asset, data: supplyCall('balanceOf(address)', account) }, { to: profile.aToken, data: supplyCall('balanceOf(address)', account) },
        { to: profile.variableDebtToken, data: supplyCall('balanceOf(address)', account) }] : []);
    return { profile, start };
  });
  const accountStart = calls.length;
  if (account) calls.push({ to: market.pool, data: supplyCall('getUserAccountData(address)', account) }, { to: market.pool, data: supplyCall('getUserConfiguration(address)', account) },
    { to: market.pool, data: supplyCall('getUserEMode(address)', account) });
  const results = await readCalls(rpc, calls, tag, batched);
  // Without an owner the account is not part of the answer (E-Mode 0); with one, a read that failed stays unknown — never guessed as 0.
  let accountSummary: AaveAccountSummary | undefined, userConfiguration: bigint | null = 0n, eMode: bigint | null = 0n;
  if (account) {
    const data = results[accountStart], words6 = data && data.length === 2 + 6 * 64 ? data.slice(2).match(/.{64}/g)!.map(w => BigInt('0x' + w)) : null;
    userConfiguration = uint(results[accountStart + 1] ?? null); eMode = uint(results[accountStart + 2] ?? null);
    if (words6 && eMode !== null) accountSummary = { collateralBase: words6[0]!.toString(), debtBase: words6[1]!.toString(), availableBorrowBase: words6[2]!.toString(),
      liquidationThresholdBps: words6[3]!.toString(), ltvBps: words6[4]!.toString(), healthFactor: words6[5]!.toString(), eMode: eMode.toString() };
  }
  const book = AAVE_V3_ADDRESS_BOOK.find(item => item.chain === market.chain);
  const reserves = plan.map(({ profile, start }): AaveReserveStatus => statusOf(profile, listed.includes(profile.asset), results.slice(start, start + (account ? 10 : 7)), account !== null,
    userConfiguration, eMode, book?.reserves.find(reserve => reserve.underlying === profile.asset)?.oracle ?? null));
  const verifiedBlock = rpcRecord(await rpc('eth_getBlockByNumber', [tag, false]));
  if (rpcHash(verifiedBlock.hash) !== blockHash) throw new Error('SUPPLY_REORG');
  return { chain: market.chain, network: market.network, pool: market.pool, block: Number(BigInt(tag)), blockHash, observedAt: new Date(now).toISOString(), reserves,
    unlisted: listed.filter(asset => !byAsset.has(asset)), ...accountSummary ? { account: accountSummary } : {} };
}
function statusOf(profile: AaveLendingProfile, listed: boolean, r: readonly (string | null)[], withAccount: boolean, userConfiguration: bigint | null, eMode: bigint | null,
  snapshotSource: string | null): AaveReserveStatus {
  const data = r[0], reserve = data && data.length === 2 + 15 * 64 ? data.slice(2).match(/.{64}/g)!.map(w => BigInt('0x' + w)) : null;
  const config = reserve?.[0] ?? 0n, flags = reserveFlags(config);
  const verified = Boolean(reserve && listed && reserve[7] === BigInt(profile.reserveId) && address('0x' + reserve[8]!.toString(16).padStart(64, '0')) === profile.aToken &&
    address('0x' + reserve[10]!.toString(16).padStart(64, '0')) === profile.variableDebtToken && flags.decimals === BigInt(profile.decimals));
  const income = uint(r[1] ?? null) ?? 0n, scaledSupply = uint(r[2] ?? null) ?? 0n, accrued = reserve?.[12] ?? 0n;
  const supplied = income >= RAY ? ((scaledSupply + accrued) * income + RAY / 2n) / RAY : 0n;
  const base = {
    reserveId: profile.reserveId, asset: profile.asset, symbol: profile.symbol, decimals: profile.decimals, aToken: profile.aToken, variableDebtToken: profile.variableDebtToken,
    listed, verified, active: flags.active, frozen: flags.frozen, paused: flags.paused, borrowingEnabled: flags.borrowing,
    ltvBps: Number(flags.ltv), liquidationThresholdBps: Number(flags.liquidationThreshold), collateralEligible: flags.ltv > 0n && flags.liquidationThreshold > 0n,
    isolated: flags.debtCeiling !== 0n, siloed: flags.siloed, supplyCap: flags.supplyCap.toString(), borrowCap: flags.borrowCap.toString(), supplied: supplied.toString(),
    borrowed: (uint(r[3] ?? null) ?? 0n).toString(), availableLiquidity: (uint(r[4] ?? null) ?? 0n).toString(), price: (uint(r[5] ?? null) ?? 0n).toString(),
    supplyApyPercent: aaveRateApyPercent(reserve?.[2] ?? 0n), borrowApyPercent: aaveRateApyPercent(reserve?.[4] ?? 0n),
    priceSourceMatches: snapshotSource && address(r[6] ?? null) ? address(r[6] ?? null) === snapshotSource : null,
  };
  const complete = Boolean(reserve) && r.slice(1, 6).every(value => value !== null);
  return { ...base, complete, supply: { available: reasonFor('supply', base, 0n) === null, reason: reasonFor('supply', base, 0n) },
    borrow: { available: reasonFor('borrow', base, eMode) === null, reason: reasonFor('borrow', base, eMode) },
    ...withAccount && r.slice(7, 10).every(value => value !== null) ? { wallet: { balance: (uint(r[7] ?? null) ?? 0n).toString(), supplied: (uint(r[8] ?? null) ?? 0n).toString(), debt: (uint(r[9] ?? null) ?? 0n).toString(),
      collateralEnabled: userConfiguration === null ? null : Boolean((userConfiguration >> (2n * BigInt(profile.reserveId) + 1n)) & 1n) } } : {} };
}
