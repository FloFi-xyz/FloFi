// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { poolReader, POOL_READ_TIMEOUT_MS, type PoolReadActions } from './copilot-pool-reads';
import { ORCA_MAINNET_POOL, POOL_PRICE_MAX_AGE_MS, type PoolRef } from '../domain/pool-range';

const NOW = 1_800_000_000_000;
const UNI: PoolRef = { kind: 'UNISWAP_V3', chain: 'eip155:8453', pool: '0xd0b53d9277642d899df5c87a3966a349a798f224', tokenA: '0x1', tokenB: '0x2', fee: 500 };
const actions = (patch: Partial<PoolReadActions> = {}): PoolReadActions => ({
  orca: async () => ({ ok: true, value: { pool: ORCA_MAINNET_POOL.pool, price: '150.000000', tickCurrentIndex: -18_972, slot: 300 } }),
  catalog: async () => ({ ok: true, value: { sqrtPriceX96: '4339505179874779672736325', tick: -196_257, blockNumber: 22, pool: UNI.pool } }), ...patch });

describe('the web chat\'s pool reads (read-only, bound to the pool FloFi asked for)', () => {
  it('returns the Orca mainnet read and the catalog pool read with their slot/block and time', async () => {
    expect(await poolReader(actions(), () => NOW)(ORCA_MAINNET_POOL)).toEqual({ ref: ORCA_MAINNET_POOL, readAt: NOW, ok: true, price: '150.000000', tick: -18_972, at: 300 });
    expect(await poolReader(actions(), () => NOW)(UNI)).toEqual({ ref: UNI, readAt: NOW, ok: true, sqrtPrice: '4339505179874779672736325', tick: -196_257, at: 22 });
  });
  it('fails closed when the read names another pool, or no pool at all', async () => {
    const other = actions({ orca: async () => ({ ok: true, value: { pool: 'Other111111111111111111111111111111111111111', price: '1', tickCurrentIndex: 0, slot: 1 } }),
      catalog: async () => ({ ok: true, value: { sqrtPriceX96: '1', tick: 0, blockNumber: 1, pool: '0x0000000000000000000000000000000000000001' } }) });
    expect(await poolReader(other, () => NOW)(ORCA_MAINNET_POOL)).toMatchObject({ ok: false, code: 'COPILOT_POOL_IDENTITY_CHANGED' });
    expect(await poolReader(other, () => NOW)(UNI)).toMatchObject({ ok: false, code: 'COPILOT_POOL_IDENTITY_CHANGED' });
    const unbound = actions({ catalog: async () => ({ ok: true, value: { sqrtPriceX96: '1', tick: 0, blockNumber: 1 } }) });
    // A read naming no pool (an API older than this web build) is told apart from one naming another pool.
    expect(await poolReader(unbound, () => NOW)(UNI)).toMatchObject({ ok: false, code: 'COPILOT_POOL_IDENTITY_MISSING' });
    const upper = actions({ catalog: async () => ({ ok: true, value: { sqrtPriceX96: '1', tick: 0, blockNumber: 1, pool: UNI.pool.toUpperCase().replace('0X', '0x') } }) });
    expect(await poolReader(upper, () => NOW)(UNI)).toMatchObject({ ok: true });
  });
  it('a read that does not answer in time is an unavailable price, never a late one', async () => {
    let calls = 0;
    const hung = actions({ catalog: () => { calls += 1; return new Promise(() => undefined); } });
    expect(await poolReader(hung, () => NOW, 5)(UNI)).toEqual({ ref: UNI, readAt: NOW, ok: false, code: 'COPILOT_POOL_READ_TIMEOUT' });
    expect(calls).toBe(1);
    expect(POOL_READ_TIMEOUT_MS).toBeLessThan(POOL_PRICE_MAX_AGE_MS);
  });
  it('keeps the service\'s closed code, and a thrown read is an unavailable price', async () => {
    expect(await poolReader(actions({ catalog: async () => ({ ok: false, code: 'UNISWAP_CONTRACT_CODE_MISSING' }) }), () => NOW)(UNI))
      .toEqual({ ref: UNI, readAt: NOW, ok: false, code: 'UNISWAP_CONTRACT_CODE_MISSING' });
    expect(await poolReader(actions({ orca: async () => { throw new Error('network'); } }), () => NOW)(ORCA_MAINNET_POOL))
      .toMatchObject({ ok: false, code: 'COPILOT_POOL_PRICE_UNAVAILABLE' });
  });
});
