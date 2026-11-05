// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Base mainnet loopback e2e harness (apps/reference-dapp/e2e/base-mainnet-serve.ts + base-mainnet-aave.ts) answers live Aave V3 reserve
 * discovery for eip155:8453 with its MOCKED market: run in-process on an ephemeral loopback port (never 8562, never a public network).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AAVE_V3_MARKETS } from '@defi-workflow-engine/action-registry';
import { discoverAaveReserves, MULTICALL3, supplyCall, type AaveMarketCatalog, type AaveReserveStatus, type SupplyRpc } from '../src/index.js';
import { createBaseMainnetHarness } from '../../../apps/reference-dapp/e2e/base-mainnet-serve.ts';
import { BASE_AAVE_BORROWING_DISABLED, BASE_AAVE_FROZEN } from '../../../apps/reference-dapp/e2e/base-mainnet-aave.ts';
import { createSupplyService } from '../../../apps/reference-dapp/src/server/supply-service.ts';
import { decodeAggregate3, encodeAggregate3 } from '../../../apps/reference-dapp/src/server/wallet-portfolio.ts';

const CHAIN = 'eip155:8453', market = AAVE_V3_MARKETS.find(item => item.chain === CHAIN)!;
const OWNER = '0x1111111111111111111111111111111111111111', OTHER = '0x' + 'ab'.repeat(20);
const profile = (symbol: string) => market.reserves.find(item => item.symbol === symbol)!;

type Harness = { readonly rpc: SupplyRpc; post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  get(path: string): Promise<Record<string, unknown>>; close(): Promise<void> };
async function start(): Promise<Harness> {
  const server = createBaseMainnetHarness();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    // The app's read client in miniature (src/server/supply-rpc.ts): one JSON-RPC POST; an HTTP failure or an error answer is a failed read.
    rpc: async (method, params) => {
      const response = await fetch(origin + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!response.ok) throw new Error('SUPPLY_RPC_UNAVAILABLE');
      const value = await response.json() as { result?: unknown; error?: { message?: string } };
      if (value.error || !('result' in value)) throw new Error(value.error?.message ?? 'SUPPLY_RPC_RESPONSE_INVALID');
      return value.result;
    },
    post: async (path, body) => {
      const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    },
    get: async path => await (await fetch(origin + path)).json() as Record<string, unknown>,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
const reserve = (catalog: AaveMarketCatalog, symbol: string): AaveReserveStatus => catalog.reserves.find(item => item.symbol === symbol)!;

describe('Base mainnet loopback harness: MOCKED Aave V3 market', () => {
  let h: Harness;
  beforeEach(async () => { h = await start(); });
  afterEach(async () => { await h.close(); });

  it('stays closed until the chain is started: /rpc answers 503 and the Aave control refuses with 409', async () => {
    await expect(discoverAaveReserves(h.rpc, CHAIN, OWNER)).rejects.toThrow('SUPPLY_RPC_UNAVAILABLE');
    expect((await h.post('/__harness/aave', { reset: true })).status).toBe(409);
    expect((await h.post('/__harness/chain', { action: 'reset' })).status).toBe(200);
    expect((await discoverAaveReserves(h.rpc, CHAIN)).reserves).toHaveLength(market.reserves.length);
  });

  it('serves every registered Base reserve verified and complete, with the default MOCKED account for any owner', async () => {
    await h.post('/__harness/chain', { action: 'reset' });
    for (const owner of [OWNER, OTHER]) {
      const catalog = await discoverAaveReserves(h.rpc, CHAIN, owner);
      expect(catalog).toMatchObject({ chain: CHAIN, pool: market.pool, unlisted: [] });
      expect(catalog.reserves.map(item => item.asset)).toEqual(market.reserves.map(item => item.asset));
      for (const item of catalog.reserves) {
        const unit = 10n ** BigInt(item.decimals);
        expect(item, item.symbol).toMatchObject({ listed: true, verified: true, complete: true, active: true, paused: false, priceSourceMatches: true });
        expect(BigInt(item.price), item.symbol).toBeGreaterThan(0n);
        expect(BigInt(item.availableLiquidity), item.symbol).toBeGreaterThan(0n);
        expect(item.supplyApyPercent, item.symbol).toBeGreaterThan(0);
        expect(item.borrowApyPercent, item.symbol).toBeGreaterThan(0);
        expect(BigInt(item.supplied), item.symbol).toBeLessThan(BigInt(item.supplyCap) * unit);
        expect(BigInt(item.borrowed), item.symbol).toBeLessThan(BigInt(item.borrowCap) * unit);
        if (item.symbol === BASE_AAVE_FROZEN) expect(item).toMatchObject({ frozen: true, supply: { available: false, reason: 'RESERVE_FROZEN' }, borrow: { available: false, reason: 'RESERVE_FROZEN' } });
        else if (item.symbol === BASE_AAVE_BORROWING_DISABLED) expect(item).toMatchObject({ frozen: false, borrowingEnabled: false, supply: { available: true, reason: null },
          borrow: { available: false, reason: 'BORROWING_DISABLED' } });
        else expect(item, item.symbol).toMatchObject({ frozen: false, borrowingEnabled: true, supply: { available: true, reason: null }, borrow: { available: true, reason: null } });
        if (item.symbol !== 'USDC' && item.symbol !== 'WETH') expect(item.wallet, item.symbol).toEqual({ balance: '0', supplied: '0', debt: '0', collateralEnabled: false });
      }
      expect(reserve(catalog, 'USDC').wallet).toEqual({ balance: '250000000', supplied: '100000000', debt: '0', collateralEnabled: true });
      expect(reserve(catalog, 'WETH').wallet).toEqual({ balance: '400000000000000000', supplied: '0', debt: '10000000000000000', collateralEnabled: false });
      // Aave's own aggregates of that account (E-Mode 0): $100 collateral, $25 debt, $50 still borrowable, health factor 3.12.
      expect(catalog.account).toEqual({ collateralBase: '10000000000', debtBase: '2500000000', availableBorrowBase: '5000000000', liquidationThresholdBps: '7800',
        ltvBps: '7500', healthFactor: '3120000000000000000', eMode: '0' });
    }
    const anonymous = await discoverAaveReserves(h.rpc, CHAIN);
    expect(anonymous.account).toBeUndefined();
    expect(anonymous.reserves.every(item => item.wallet === undefined && item.complete === true)).toBe(true);
    const served = (await h.get('/__harness/aave')).result as { provenance: string; reads: number };
    expect(served.provenance).toBe('MOCKED');
    expect(served.reads).toBeGreaterThan(0);
  });

  it('is what the Base lending server action serves, labelled MOCKED', async () => {
    await h.post('/__harness/chain', { action: 'reset' });
    const journalDir = await mkdtemp(join(tmpdir(), 'base-aave-harness-'));
    try {
      // The service `supplyReserves` uses for Base in harness mode (src/app/supply-action.ts `catalog`), reading this harness.
      const service = createSupplyService({ journalDir, idPrefix: 'baave', provenance: 'MOCKED', executionEnabled: false,
        rpc: async () => { throw new Error('SUPPLY_NETWORK_UNAVAILABLE'); }, rpcs: { [CHAIN]: h.rpc } });
      const catalog = await service.reserves(CHAIN, OWNER);
      expect(catalog.provenance).toBe('MOCKED');
      expect(catalog.reserves.filter(item => item.complete === true && item.verified)).toHaveLength(market.reserves.length);
      expect(reserve(catalog, 'USDC').wallet?.balance).toBe('250000000');
    } finally { await rm(journalDir, { recursive: true, force: true }); }
  });

  it('lets a spec vary the market and the account; invalid patches change nothing; reset and a chain reset restore the defaults', async () => {
    await h.post('/__harness/chain', { action: 'reset' });
    const defaults = (await h.get('/__harness/aave')).result as { reserves: unknown[] };
    for (const bad of [{ reserves: { WETH: { frozen: 'yes' } } }, { reserves: { USDC: { walletBalance: '1.0000001' } } }, { reserves: { NOPE: { frozen: true } } },
      { reserves: { USDC: { bogus: 1 } } }, { reset: false }, { account: { eMode: 1.5 } }, { account: { owner: OWNER } }, { extra: 1 }, [],
      { reserves: { USDC: { frozen: true }, WETH: { frozen: 'no' } } }]) {
      expect((await h.post('/__harness/aave', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(((await h.get('/__harness/aave')).result as { reserves: unknown[] }).reserves).toEqual(defaults.reserves);

    const patch = await h.post('/__harness/aave', { reserves: { WETH: { frozen: true }, EURC: { borrowingEnabled: false, walletBalance: '12.5' },
      USDC: { walletBalance: '0', supplied: '0' }, GHO: { priceUsd: '0' }, AAVE: { liquidity: '0' }, wstETH: { supplyCap: 1 }, LBTC: { listed: false } }, account: { eMode: 1 } });
    expect(patch.status).toBe(200);
    const varied = await discoverAaveReserves(h.rpc, CHAIN, OWNER);
    expect(reserve(varied, 'WETH')).toMatchObject({ supply: { reason: 'RESERVE_FROZEN' }, borrow: { reason: 'RESERVE_FROZEN' }, wallet: { debt: '10000000000000000' } });
    expect(reserve(varied, 'EURC')).toMatchObject({ supply: { reason: null }, borrow: { reason: 'BORROWING_DISABLED' }, wallet: { balance: '12500000' } });
    expect(reserve(varied, 'USDC')).toMatchObject({ supply: { reason: null }, borrow: { reason: 'ACCOUNT_EMODE_UNSUPPORTED' },
      wallet: { balance: '0', supplied: '0', collateralEnabled: false } });
    expect(reserve(varied, 'GHO').borrow.reason).toBe('ORACLE_UNAVAILABLE');
    expect(reserve(varied, 'AAVE').borrow.reason).toBe('NO_LIQUIDITY');
    expect(reserve(varied, 'wstETH').supply.reason).toBe('SUPPLY_CAP_REACHED');
    expect(reserve(varied, 'LBTC')).toMatchObject({ listed: false, supply: { reason: 'NOT_LISTED_ON_CHAIN' } });
    expect(varied.account).toMatchObject({ eMode: '1', collateralBase: '0', availableBorrowBase: '0', healthFactor: '0' });

    // An account whose state cannot be read: no aggregates, and Borrow is never claimed available.
    await h.post('/__harness/aave', { reset: true, account: { eMode: null } });
    const unknown = await discoverAaveReserves(h.rpc, CHAIN, OWNER);
    expect(unknown.account).toBeUndefined();
    expect(reserve(unknown, 'USDC')).toMatchObject({ supply: { reason: null }, borrow: { reason: 'ACCOUNT_STATE_UNKNOWN' }, wallet: { balance: '250000000' } });

    expect(((await h.post('/__harness/aave', { reset: true })).body.result as { reserves: unknown[] }).reserves).toEqual(defaults.reserves);
    await h.post('/__harness/aave', { reserves: { USDC: { frozen: true } } });
    await h.post('/__harness/chain', { action: 'reset' });
    expect(reserve(await discoverAaveReserves(h.rpc, CHAIN, OWNER), 'USDC').supply.reason).toBeNull();
  });

  it('leaves the chain ledger to every other read: direct balanceOf and a non-Aave Multicall3 batch (the dashboard portfolio) see the chain', async () => {
    await h.post('/__harness/chain', { action: 'reset', owner: OWNER, wei: '1000' });
    const usdc = profile('USDC').asset, weth = profile('WETH').asset;
    expect(await h.rpc('eth_getCode', [MULTICALL3, 'latest'])).not.toBe('0x');
    expect(BigInt(await h.rpc('eth_call', [{ to: usdc, data: supplyCall('balanceOf(address)', OWNER) }, 'latest']) as string)).toBe(0n);
    // The portfolio's own encoder and decoder (src/server/wallet-portfolio.ts): native balance plus listed-token balances in one aggregate3.
    const calls = [{ target: MULTICALL3, data: '0x4d2301cc' + OWNER.slice(2).padStart(64, '0') },
      ...[usdc, weth].map(target => ({ target, data: supplyCall('balanceOf(address)', OWNER) }))];
    const results = decodeAggregate3(await h.rpc('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, 'latest']), calls.length);
    expect(results.map(result => result.success && BigInt(result.data))).toEqual([1000n, 0n, 0n]);
    expect((await h.get('/__harness/aave')).result).toMatchObject({ reads: 0 });
  });
});
