// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { catalogPoolOn, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as ORCA, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import { base58Encode, encodeMockedWhirlpool, encodeUniswapCollect, orcaPositionAddress, orcaPositionTokenAccount, publicKeyBytes, supplyCall, supplyWord,
  UNISWAP_MAX_UINT128, UNISWAP_Q96, type AaveMarketCatalog, type AaveReserveStatus, type SolanaRpc } from '@defi-workflow-engine/reference-compiler';
import { liquidityPositionKey, liquidityPositionRefValid } from '../domain/liquidity-positions';
import type { PriceObservation } from '../automations/price-source';
import { valuePositionAmounts } from './defi-positions';
import { aavePositions, uniswapPositions, UNISWAP_POSITION_DEPLOYMENTS, type ValuePositionAsset } from './defi-positions-evm';
import { orcaPositions } from './defi-positions-solana';
import type { Rpc } from './public-testnet-service';

const OWNER = '0x' + '1'.repeat(40), OTHER = '0x' + '2'.repeat(40), HASH = '0x' + '4'.repeat(64);
const NOW = new Date('2026-11-18T12:00:00Z');
const unvalued: ValuePositionAsset = input => ({ ...input, valuation: null });
const reserve = { asset: '0x' + '5'.repeat(40), aToken: '0x' + '6'.repeat(40), variableDebtToken: '0x' + '8'.repeat(40),
  symbol: 'USDC', decimals: 6, listed: true, verified: true, wallet: { balance: '1000000', supplied: '2000000', debt: '3000000', collateralEnabled: true } } as AaveReserveStatus;
function market(reserves: readonly AaveReserveStatus[], unlisted: readonly string[] = []): AaveMarketCatalog {
  return { chain: 'eip155:8453', network: 'Base', block: 100, blockHash: HASH, observedAt: NOW.toISOString(), pool: OWNER,
    account: { collateralBase: '200000000', debtBase: '300000000', healthFactor: '1100000000000000000', liquidationThresholdBps: '8500',
      eMode: '0', availableBorrowBase: '0', ltvBps: '8000' }, reserves, unlisted };
}

describe('read-only DeFi positions', () => {
  it('reports Aave underlying supply and variable debt separately, without adding the receipt token or liquid balance', () => {
    const result = aavePositions(market([reserve]), unvalued);
    expect(result).toMatchObject({ status: 'COMPLETE', risk: { healthFactor: '1100000000000000000', liquidationThresholdBps: '8500' } });
    expect(result.positions.map(p => [p.type, p.assets[0]!.address, p.assets[0]!.units])).toEqual([
      ['SUPPLIED', reserve.asset, '2000000'], ['VARIABLE_DEBT', reserve.asset, '3000000'],
    ]);
    expect(result.positions[0]!.collateralEnabled).toBe(true);
    expect(JSON.stringify(result)).not.toContain(reserve.aToken);
  });

  it('reports missing and mismatched reserve data as partial or unavailable, rather than empty', () => {
    const unknown = { ...reserve, verified: false };
    expect(aavePositions(market([reserve], [OTHER]), unvalued).status).toBe('PARTIAL');
    expect(aavePositions(market([reserve, unknown]), unvalued)).toMatchObject({ status: 'PARTIAL', positions: [{ type: 'SUPPLIED' }, { type: 'VARIABLE_DEBT' }] });
    expect(aavePositions(market([unknown]), unvalued)).toMatchObject({ status: 'UNAVAILABLE', positions: [], observedAt: null });
    expect(aavePositions(market([{ ...reserve, wallet: { balance: '0', supplied: '0', debt: '0', collateralEnabled: false } }]), unvalued).status).toBe('PARTIAL');
  });

  it('uses exact cents from a fresh verified observation and rejects stale, absent and fixture prices', () => {
    const asset = { address: reserve.asset, symbol: 'USDC', decimals: 6, units: '2000000' };
    const observation: PriceObservation = { asset: 'USDC', priceUsd: '1.001', source: 'CHAINLINK', evidence: 'PUBLIC_READ_ONLY',
      observedAt: '2026-11-18T11:59:59.000Z', receivedAt: NOW.toISOString(), provenance: {} };
    expect(valuePositionAmounts(asset, observation, 60_000, NOW).valuation).toEqual({
      usd: '2.00', observedAt: observation.observedAt, expiresAt: '2026-11-18T12:00:59.000Z',
    });
    expect(valuePositionAmounts(asset, observation, 500, NOW).valuation).toBeNull();
    expect(valuePositionAmounts(asset, undefined, 60_000, NOW).valuation).toBeNull();
    expect(valuePositionAmounts(asset, { ...observation, source: 'FIXTURE', evidence: 'MOCKED' }, 60_000, NOW).valuation).toBeNull();
  });
});

const positionCode = '6001', factoryCode = '6002';
const digest = (code: string) => createHash('sha256').update(Buffer.from(code, 'hex')).digest('hex');
const uniswap = { ...UNISWAP_POSITION_DEPLOYMENTS.base, codeSha256: { positionManager: digest(positionCode), factory: digest(factoryCode) } };
const TOKEN0 = '0x' + 'a'.repeat(40), TOKEN1 = '0x' + 'b'.repeat(40), POOL = '0x' + 'c'.repeat(40);
const words = (...values: (string | bigint)[]) => '0x' + values.map(supplyWord).join('');
const int = (value: bigint) => value & ((1n << 256n) - 1n);
const nft = words(0n, 0n, TOKEN0, TOKEN1, 3000n, int(-60n), 60n, 1_000_000_000n, 0n, 0n, 123n, 0n);
const VERIFIED_POOL = catalogPoolOn('eip155:8453', { symbol: 'AAA', address: TOKEN0, decimals: 6 }, { symbol: 'BBB', address: TOKEN1, decimals: 6 }, 3000).pool;
const catalogOf = (assets: readonly [string, string][]): AssetCatalog => ({ chain: 'eip155:8453', assets: assets.map(([symbol, address]) =>
  ({ kind: 'ERC20', symbol, address, decimals: 6 })) } as unknown as AssetCatalog);
function uniswapFixture(options: { owner?: string; count?: bigint; reorg?: boolean; badPool?: boolean; badCode?: boolean; pool?: string; collect?: 'OK' | 'FAIL' } = {}): Rpc {
  return async (method, params) => {
    const at = '0x64';
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getBlockByNumber') return { number: at, hash: options.reorg && params[0] === at ? '0x' + '9'.repeat(64) : HASH };
    if (method === 'eth_getCode') {
      if (params[0] === uniswap.positionManager) return options.badCode ? '0x6003' : '0x' + positionCode;
      if (params[0] === uniswap.factory) return '0x' + factoryCode;
      return '0x';
    }
    if (method === 'eth_call') {
      expect(params[1]).toBe(at);
      const query = params[0] as { to: string; data: string; from?: string };
      // The owner's static collect: owed tokens (123) plus fees not yet checkpointed (77) of token0, 9 of token1.
      if (query.to === uniswap.positionManager && query.data === encodeUniswapCollect({ tokenId: 7n, recipient: OWNER, amount0Max: UNISWAP_MAX_UINT128,
        amount1Max: UNISWAP_MAX_UINT128 })) {
        if (options.collect !== 'OK' || query.from !== OWNER) throw new Error('FIXTURE_REVERT');
        return words(200n, 9n);
      }
      if (query.to === uniswap.positionManager) {
        if (query.data === supplyCall('factory()')) return words(uniswap.factory);
        if (query.data === supplyCall('balanceOf(address)', OWNER)) return words(options.count ?? 1n);
        if (query.data === supplyCall('tokenOfOwnerByIndex(address,uint256)', OWNER, 0n)) return words(7n);
        if (query.data === supplyCall('ownerOf(uint256)', 7n)) return words(options.owner ?? OWNER);
        if (query.data === supplyCall('positions(uint256)', 7n)) return nft;
      }
      if (query.to === uniswap.factory && query.data === supplyCall('getPool(address,address,uint24)', TOKEN0, TOKEN1, 3000n))
        return words(options.badPool ? 0n : options.pool ?? POOL);
      if ([TOKEN0, TOKEN1].includes(query.to) && query.data === supplyCall('decimals()')) return words(6n);
      if ([POOL, VERIFIED_POOL].includes(query.to) && query.data === supplyCall('slot0()')) return words(UNISWAP_Q96, 0n, 0n, 1n, 1n, 0n, 1n);
    }
    throw new Error('FIXTURE_READ_UNAVAILABLE');
  };
}

describe('BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 position management view (Uniswap)', () => {
  const scan = (rpc: Rpc, catalog: AssetCatalog | null) => uniswapPositions(rpc, uniswap, OWNER, NOW, [], unvalued, true, { network: 'Base', catalog });
  it('binds network, manager, verified pool, token id and owner, and reports exactly what collect would pay (owed tokens apart from fresh fees)', async () => {
    const result = await scan(uniswapFixture({ pool: VERIFIED_POOL, collect: 'OK' }), catalogOf([['AAA', TOKEN0], ['BBB', TOKEN1]]));
    const view = result.positions[0]!.liquidity!;
    expect(view.ref).toEqual({ protocol: 'UNISWAP_V3', chain: 'eip155:8453', network: 'Base', manager: uniswap.positionManager, pool: VERIFIED_POOL, positionId: '7', owner: OWNER });
    expect(liquidityPositionRefValid(view.ref)).toBe(true);
    expect(view).toMatchObject({ token0: { symbol: 'AAA', decimals: 6 }, token1: { symbol: 'BBB' }, feeTier: 3000, tickLower: -60, tickUpper: 60,
      liquidity: '1000000000', principal: ['2995354', '2995354'], recordedOwed: ['123', '0'], collectable: ['200', '9'], status: 'OPEN', rangeState: 'IN_RANGE',
      manageable: { ok: true }, operations: ['COLLECT', 'DECREASE', 'EXIT'], observedAtHeight: 100, price: { base: 'BBB', quote: 'AAA' } });
    expect(view.currentPrice).not.toBeNull();
  });
  it('shows a position it cannot manage, but offers nothing for it: a pool it cannot verify, or a catalog it could not read now', async () => {
    const unverified = await scan(uniswapFixture({ collect: 'OK' }), catalogOf([['AAA', TOKEN0], ['BBB', TOKEN1]]));
    expect(unverified.positions[0]!.liquidity).toMatchObject({ manageable: { ok: false, reason: 'POOL_NOT_VERIFIED' }, operations: [] });
    const noCatalog = await scan(uniswapFixture({ pool: VERIFIED_POOL, collect: 'OK' }), null);
    expect(noCatalog.positions[0]!.liquidity).toMatchObject({ manageable: { ok: false, reason: 'POOL_NOT_VERIFIED' }, operations: [] });
    const notListed = await scan(uniswapFixture({ pool: VERIFIED_POOL, collect: 'OK' }), catalogOf([['AAA', TOKEN0]]));
    expect(notListed.positions[0]!.liquidity!.manageable).toEqual({ ok: false, reason: 'POOL_NOT_VERIFIED' });
  });
  it('reports collectable amounts as unavailable (null), never zero, when the static collect cannot be read', async () => {
    const result = await scan(uniswapFixture({ pool: VERIFIED_POOL, collect: 'FAIL' }), catalogOf([['AAA', TOKEN0], ['BBB', TOKEN1]]));
    expect(result.positions[0]!.liquidity).toMatchObject({ collectable: null, recordedOwed: ['123', '0'], operations: ['COLLECT', 'DECREASE', 'EXIT'] });
  });
  it('keys a position by chain and manager: the same token id on two networks is two positions', () => {
    const base = { protocol: 'UNISWAP_V3' as const, network: 'Base', manager: uniswap.positionManager, pool: VERIFIED_POOL, positionId: '7', owner: OWNER, chain: 'eip155:8453' };
    const arbitrum = { ...base, network: 'Arbitrum One', chain: 'eip155:42161', manager: UNISWAP_POSITION_DEPLOYMENTS['arbitrum-one'].positionManager };
    expect(liquidityPositionKey(base)).not.toBe(liquidityPositionKey(arbitrum));
    expect(liquidityPositionRefValid({ ...base, positionId: '07' })).toBe(false);
    expect(liquidityPositionRefValid({ ...base, extra: true })).toBe(false);
  });
});

describe('Uniswap wallet-held positions', () => {
  const scan = (rpc: Rpc) => uniswapPositions(rpc, uniswap, OWNER, NOW, [], unvalued);
  it('enumerates a directly held NFT at one block and separates pool principal from checkpointed owed tokens', async () => {
    const result = await scan(uniswapFixture());
    expect(result).toMatchObject({ status: 'COMPLETE', positions: [{ id: '7', type: 'LIQUIDITY',
      assets: [{ address: TOKEN0, decimals: 6, units: '2995354', recordedOwedUnits: '123' }, { address: TOKEN1, decimals: 6, units: '2995354' }] }] });
  });
  it('distinguishes truly empty wallets, partial enumeration and unreadable pool data', async () => {
    expect(await scan(uniswapFixture({ count: 0n }))).toMatchObject({ status: 'COMPLETE', positions: [] });
    expect(await scan(uniswapFixture({ count: 100n }))).toMatchObject({ status: 'PARTIAL', positions: [{ id: '7' }] });
    expect(await scan(uniswapFixture({ badPool: true }))).toMatchObject({ status: 'PARTIAL', positions: [{ assets: [{ units: null }, { units: null }] }] });
  });
  it('rejects a different owner, a changed deployment or a reorg', async () => {
    await expect(scan(uniswapFixture({ owner: OTHER }))).rejects.toThrow('POSITION_DATA_UNAVAILABLE');
    await expect(scan(uniswapFixture({ badCode: true }))).rejects.toThrow('POSITION_DEPLOYMENT_CHANGED');
    await expect(scan(uniswapFixture({ reorg: true }))).rejects.toThrow('POSITION_BLOCK_CHANGED');
  });
});

const solanaKey = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const SOL_OWNER = solanaKey(1), MINT = solanaKey(2), LEGACY_ATA = solanaKey(3), SOL_OTHER = solanaKey(4);
const raw = (owner: string, data: Uint8Array) => ({ owner, lamports: 1, data: [Buffer.from(data).toString('base64'), 'base64'] });
function tokenAccount(owner: string, delegate = false) {
  const data = new Uint8Array(165);
  if (delegate) { new DataView(data.buffer).setUint32(72, 1, true); data.set(publicKeyBytes(solanaKey(9)), 76); }
  data.set(publicKeyBytes(MINT), 0);
  data.set(publicKeyBytes(owner), 32);
  new DataView(data.buffer).setBigUint64(64, 1n, true);
  data[108] = 1;
  return raw(ORCA.programs.token2022, data);
}
function orcaFixture(options: { fail?: 'all' | 'one'; empty?: boolean; transferred?: boolean; oldSlot?: boolean; ata?: string; delegate?: boolean } = {}): SolanaRpc {
  const ATA = options.ata ?? LEGACY_ATA;
  return async (method, params) => {
    if (method === 'getGenesisHash') return ORCA.genesisHash;
    if (method === 'getTokenAccountsByOwner') {
      const program = (params[1] as { programId: string }).programId;
      if (options.fail === 'all' || options.fail === 'one' && program === ORCA.programs.token) throw new Error('RPC_UNAVAILABLE');
      return { context: { slot: 10 }, value: options.empty || program === ORCA.programs.token ? [] : [{ pubkey: ATA, account: tokenAccount(SOL_OWNER, options.delegate) }] };
    }
    if (method === 'getMultipleAccounts') {
      expect(params).toEqual([[ORCA.pool.address, ATA, orcaPositionAddress(MINT)], { encoding: 'base64', commitment: 'confirmed', minContextSlot: 10 }]);
      const data = new Uint8Array(216), view = new DataView(data.buffer);
      data.set(Buffer.from(ORCA.positionDiscriminator, 'hex'), 0);
      data.set(publicKeyBytes(ORCA.pool.address), 8);
      data.set(publicKeyBytes(MINT), 40);
      view.setBigUint64(72, 1_000_000_000n, true);
      view.setInt32(88, -39104, true);
      view.setInt32(92, -36992, true);
      view.setBigUint64(112, 123n, true);
      return { context: { slot: options.oldSlot ? 9 : 11 }, value: [
        raw(ORCA.programs.whirlpool, encodeMockedWhirlpool(ORCA.whirlpoolsConfig, { pool: ORCA.pool, feeRate: ORCA.feeTier })),
        tokenAccount(options.transferred ? SOL_OTHER : SOL_OWNER, options.delegate), raw(ORCA.programs.whirlpool, data),
      ] };
    }
    throw new Error('FIXTURE_METHOD_DENIED');
  };
}

describe('Orca direct standalone position discovery', () => {
  const scan = (rpc: SolanaRpc) => orcaPositions(rpc, SOL_OWNER, NOW, unvalued);
  it('BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: offers management only for the owner\'s own Token-2022 position account with no delegate', async () => {
    const own = orcaPositionTokenAccount(SOL_OWNER, MINT);
    const managed = (await scan(orcaFixture({ ata: own }))).positions[0]!.liquidity!;
    expect(managed).toMatchObject({ ref: { protocol: 'ORCA', chain: ORCA.chain, network: ORCA.network, manager: ORCA.programs.whirlpool, pool: ORCA.pool.address,
      positionId: MINT, owner: SOL_OWNER }, manageable: { ok: true }, recordedOwed: ['123', '0'], collectable: null, status: 'OPEN',
      operations: ['COLLECT', 'DECREASE', 'EXIT'], tickLower: -39104, tickUpper: -36992, price: { base: 'SOL', quote: 'USDC' }, observedAtHeight: 11 });
    expect(liquidityPositionRefValid(managed.ref)).toBe(true);
    expect((await scan(orcaFixture())).positions[0]!.liquidity).toMatchObject({ manageable: { ok: false, reason: 'LEGACY_POSITION_TOKEN' }, operations: [] });
    expect((await scan(orcaFixture({ ata: own, delegate: true }))).positions[0]!.liquidity).toMatchObject({ manageable: { ok: false, reason: 'DELEGATED_POSITION_TOKEN' } });
  });
  it('checks ownership and the registered pool at one confirmed slot, returning principal and recorded fees separately', async () => {
    const result = await scan(orcaFixture());
    expect(result).toMatchObject({ status: 'COMPLETE', positions: [{ type: 'LIQUIDITY', id: MINT, assets: [
      { address: ORCA.token0.mint, recordedOwedUnits: '123' }, { address: ORCA.token1.mint },
    ] }] });
    expect(result.positions[0]!.assets.every(asset => asset.units !== null && BigInt(asset.units) > 0n)).toBe(true);
  });
  it('distinguishes empty, partial, and unavailable and never shows a position transferred to someone else', async () => {
    expect(await scan(orcaFixture({ empty: true }))).toMatchObject({ status: 'COMPLETE', positions: [] });
    expect(await scan(orcaFixture({ empty: true, fail: 'one' }))).toMatchObject({ status: 'PARTIAL', positions: [] });
    expect(await scan(orcaFixture({ transferred: true }))).toMatchObject({ status: 'PARTIAL', positions: [] });
    await expect(scan(orcaFixture({ fail: 'all' }))).rejects.toThrow('POSITION_SOLANA_RPC_INVALID');
    await expect(scan(orcaFixture({ oldSlot: true }))).rejects.toThrow('POSITION_SOLANA_RPC_INVALID');
  });
});
