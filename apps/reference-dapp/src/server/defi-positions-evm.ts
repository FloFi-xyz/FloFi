// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { UNISWAP_V3_ARBITRUM_LIQUIDITY, UNISWAP_V3_BASE_LIQUIDITY, UNISWAP_V3_ETHEREUM_LIQUIDITY, UNISWAP_V3_ROBINHOOD_CATALOG,
  type CanonicalAsset, type UniswapCatalogLiquidity } from '@defi-workflow-engine/action-registry';
import { decodeUniswapPosition, rpcHash, rpcHex, rpcRecord, sqrtRatioAtTick, supplyCall, UNISWAP_Q96,
  type AaveMarketCatalog } from '@defi-workflow-engine/reference-compiler';
import { type DefiPosition, type PositionAsset, type PositionScan } from '../domain/defi-positions';
import { shortAddress } from '../domain/wallet-portfolio';
import { type CatalogNetworkId } from './catalog-networks';
import { type Rpc } from './public-testnet-service';
import { decodeAggregate3, encodeAggregate3, MULTICALL3 } from './wallet-portfolio';

export const POSITION_EVM_METHODS = ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'] as const;
export const UNISWAP_POSITION_LIMIT = 20;
export const UNISWAP_POSITION_DEPLOYMENTS: Readonly<Record<CatalogNetworkId, UniswapCatalogLiquidity>> = {
  ethereum: UNISWAP_V3_ETHEREUM_LIQUIDITY,
  base: UNISWAP_V3_BASE_LIQUIDITY,
  'arbitrum-one': UNISWAP_V3_ARBITRUM_LIQUIDITY,
  robinhood: UNISWAP_V3_ROBINHOOD_CATALOG,
};
type ScanData = Pick<PositionScan, 'status' | 'positions' | 'observedAt' | 'risk'>;
type AssetInput = Omit<PositionAsset, 'valuation'>;
export type ValuePositionAsset = (asset: AssetInput) => PositionAsset;
const BIGNUM = /^(0|[1-9][0-9]{0,77})$/;
const isPositive = (value: string) => BIGNUM.test(value) && BigInt(value) > 0n;

export function aavePositions(catalog: AaveMarketCatalog, value: ValuePositionAsset): ScanData {
  const positions: DefiPosition[] = [];
  let read = 0, incomplete = catalog.unlisted.length > 0 || !catalog.account;
  for (const reserve of catalog.reserves) {
    // A dropped or mismatched reserve cannot be established as an empty balance.
    if (!reserve.listed || !reserve.verified || !reserve.wallet ||
        !BIGNUM.test(reserve.wallet.supplied) || !BIGNUM.test(reserve.wallet.debt)) {
      incomplete = true;
      continue;
    }
    read++;
    const { symbol, decimals } = reserve;
    if (isPositive(reserve.wallet.supplied)) positions.push({
      id: `${reserve.asset}:supply`, type: 'SUPPLIED', collateralEnabled: reserve.wallet.collateralEnabled,
      assets: [value({ address: reserve.asset, symbol, decimals, units: reserve.wallet.supplied })],
    });
    if (isPositive(reserve.wallet.debt)) positions.push({
      id: `${reserve.asset}:debt`, type: 'VARIABLE_DEBT',
      assets: [value({ address: reserve.asset, symbol, decimals, units: reserve.wallet.debt })],
    });
  }
  const summary = catalog.account;
  if (summary && isPositive(summary.debtBase) && !positions.some(position => position.type === 'VARIABLE_DEBT')) incomplete = true;
  const risk = summary && isPositive(summary.debtBase) && BIGNUM.test(summary.healthFactor) && /^[0-9]{1,5}$/.test(summary.liquidationThresholdBps)
    ? { healthFactor: summary.healthFactor, liquidationThresholdBps: summary.liquidationThresholdBps } : undefined;
  return { status: read ? incomplete ? 'PARTIAL' : 'COMPLETE' : 'UNAVAILABLE',
    observedAt: read ? catalog.observedAt : null, positions, ...risk && { risk } };
}

const WORD = /^[0-9a-f]{64}$/;
const rawWord = (hex: unknown) => {
  const raw = rpcHex(hex).slice(2);
  if (!WORD.test(raw)) throw new Error('POSITION_RPC_INVALID');
  return raw;
};
const uint = (hex: unknown) => BigInt(`0x${rawWord(hex)}`);
function address(hex: unknown): string {
  const raw = rawWord(hex);
  if (!raw.startsWith('0'.repeat(24))) throw new Error('POSITION_RPC_INVALID');
  return `0x${raw.slice(24)}`;
}
const emptyAddress = `0x${'0'.repeat(40)}`;
type ContractCall = { readonly target: string; readonly data: string };
const call = (target: string, signature: string, ...args: (string | bigint)[]): ContractCall => ({ target, data: supplyCall(signature, ...args) });

async function callsAt(rpc: Rpc, entries: readonly ContractCall[], at: string, batched: boolean): Promise<(string | null)[]> {
  if (batched) {
    const packed = await rpc('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(entries) }, at]);
    return decodeAggregate3(packed, entries.length).map(result => result.success ? result.data.toLowerCase() : null);
  }
  const result: (string | null)[] = [];
  for (let i = 0; i < entries.length; i += 4) {
    result.push(...await Promise.all(entries.slice(i, i + 4).map(entry =>
      rpc('eth_call', [{ to: entry.target, data: entry.data }, at]).then(rpcHex).catch(() => null))));
  }
  return result;
}

function codeMatches(code: unknown, digest: string) {
  return createHash('sha256').update(Buffer.from(rpcHex(code).slice(2), 'hex')).digest('hex') === digest;
}

function uniswapAmounts(slot0: unknown, lower: number, upper: number, liquidity: bigint): [bigint, bigint] {
  const raw = rpcHex(slot0).slice(2);
  if (raw.length !== 7 * 64 || lower >= upper || liquidity >= 1n << 128n) throw new Error('POSITION_POOL_INVALID');
  const spot = BigInt(`0x${raw.slice(0, 64)}`);
  if (spot < sqrtRatioAtTick(-887_272) || spot >= sqrtRatioAtTick(887_272)) throw new Error('POSITION_POOL_INVALID');
  const lo = sqrtRatioAtTick(lower), hi = sqrtRatioAtTick(upper);
  const between = spot <= lo ? lo : spot >= hi ? hi : spot;
  return [liquidity * UNISWAP_Q96 * (hi - between) / hi / between, liquidity * (between - lo) / UNISWAP_Q96];
}

/** Directly held NFTs on a pinned position manager. Factory, ownership and pool state are read at one canonical block. */
export async function uniswapPositions(rpc: Rpc, profile: UniswapCatalogLiquidity, owner: string, now: Date,
  catalogAssets: readonly CanonicalAsset[], value: ValuePositionAsset, verifyCode = true): Promise<ScanData> {
  const { chainId, factory, positionManager: manager } = profile;
  if (BigInt(rpcHex(await rpc('eth_chainId', []))) !== BigInt(chainId)) throw new Error('POSITION_CHAIN_INVALID');
  const block = rpcRecord(await rpc('eth_getBlockByNumber', ['latest', false])), at = rpcHex(block.number), hash = rpcHash(block.hash);
  const canonical = async () => {
    const current = rpcRecord(await rpc('eth_getBlockByNumber', [at, false]));
    if (rpcHash(current.hash) !== hash) throw new Error('POSITION_BLOCK_CHANGED');
  };
  const [managerCode, factoryCode, multicall] = await Promise.all([manager, factory, MULTICALL3].map(to => rpc('eth_getCode', [to, at])));
  if (verifyCode && (!codeMatches(managerCode, profile.codeSha256.positionManager) || !codeMatches(factoryCode, profile.codeSha256.factory)))
    throw new Error('POSITION_DEPLOYMENT_CHANGED');
  const batched = typeof multicall === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(multicall);
  const read = (entries: readonly ContractCall[]) => callsAt(rpc, entries, at, batched);
  const [managerFactory, balance] = await read([call(manager, 'factory()'), call(manager, 'balanceOf(address)', owner)]);
  if (address(managerFactory) !== factory) throw new Error('POSITION_FACTORY_MISMATCH');
  const count = uint(balance);
  const size = Number(count > BigInt(UNISWAP_POSITION_LIMIT) ? BigInt(UNISWAP_POSITION_LIMIT) : count);
  if (size === 0) {
    await canonical();
    return { status: 'COMPLETE', positions: [], observedAt: now.toISOString() };
  }
  let incomplete = BigInt(size) < count;
  const ids = new Set<bigint>();
  for (const encoded of await read(Array.from({ length: size }, (_, i) => call(manager, 'tokenOfOwnerByIndex(address,uint256)', owner, BigInt(i))))) {
    try {
      const id = uint(encoded);
      if (!id || ids.has(id)) incomplete = true;
      else ids.add(id);
    } catch { incomplete = true; }
  }
  if (!ids.size) throw new Error('POSITION_ENUMERATION_UNAVAILABLE');
  const results = await read([...ids].flatMap(id => [call(manager, 'ownerOf(uint256)', id), call(manager, 'positions(uint256)', id)]));
  const owned = [...ids].flatMap((id, i) => {
    try {
      if (address(results[2 * i]) !== owner) throw new Error('POSITION_OWNER_MISMATCH');
      const position = decodeUniswapPosition(rpcHex(results[2 * i + 1]));
      if (position.token0 === emptyAddress || position.token1 === emptyAddress || position.token0 >= position.token1 ||
          !Number.isSafeInteger(position.fee) || position.fee < 0 || position.fee >= 1_000_000 || position.tickLower >= position.tickUpper ||
          position.liquidity >= (1n << 128n) || position.tokensOwed0 >= (1n << 128n) || position.tokensOwed1 >= (1n << 128n))
        throw new Error('POSITION_DATA_INVALID');
      return [{ id, ...position }];
    } catch {
      incomplete = true;
      return [];
    }
  });
  if (!owned.length) throw new Error('POSITION_DATA_UNAVAILABLE');
  const positions = owned.filter(position => position.liquidity > 0n || position.tokensOwed0 > 0n || position.tokensOwed1 > 0n);
  if (!positions.length) {
    await canonical();
    return { status: incomplete ? 'PARTIAL' : 'COMPLETE', positions: [], observedAt: now.toISOString() };
  }
  const tokens = [...new Set(positions.flatMap(position => [position.token0, position.token1]))];
  const [pools, sizes] = await Promise.all([
    read(positions.map(position => call(factory, 'getPool(address,address,uint24)', position.token0, position.token1, BigInt(position.fee)))),
    read(tokens.map(token => call(token, 'decimals()'))),
  ]);
  const decimals = new Map(tokens.flatMap((token, i) => {
    try {
      const n = uint(sizes[i]);
      return n <= 36n ? [[token, Number(n)] as const] : [];
    } catch { return []; }
  }));
  const poolReads = pools.map(encoded => {
    try {
      const pool = address(encoded);
      return pool === emptyAddress ? null : pool;
    } catch { return null; }
  });
  const uniquePools = [...new Set(poolReads.filter((pool): pool is string => pool !== null))];
  const poolValues = uniquePools.length ? await read(uniquePools.map(pool => call(pool, 'slot0()'))) : [];
  const slots = new Map(uniquePools.map((pool, i) => [pool, poolValues[i]]));
  const metadata = new Map(catalogAssets.map(asset => [asset.address, asset] as const));
  const entries = positions.map((position, i): DefiPosition => {
    let amounts: [bigint, bigint] | null = null;
    try {
      const pool = poolReads[i];
      if (!pool) throw new Error('POSITION_POOL_INVALID');
      amounts = uniswapAmounts(slots.get(pool), position.tickLower, position.tickUpper, position.liquidity);
    } catch { incomplete = true; }
    const assets = [position.token0, position.token1].map((token, j) => {
      const scale = decimals.get(token);
      if (scale === undefined) incomplete = true;
      const known = metadata.get(token);
      const symbol = known && known.decimals === scale ? known.symbol : shortAddress(token);
      const owed = j === 0 ? position.tokensOwed0 : position.tokensOwed1;
      return value({ address: token, symbol, decimals: scale ?? 0, units: scale === undefined || !amounts ? null : amounts[j]!.toString(),
        ...scale !== undefined && owed > 0n && { recordedOwedUnits: owed.toString() } });
    });
    return { id: position.id.toString(), type: 'LIQUIDITY', assets };
  });
  await canonical();
  return { status: incomplete ? 'PARTIAL' : 'COMPLETE', positions: entries, observedAt: now.toISOString() };
}
