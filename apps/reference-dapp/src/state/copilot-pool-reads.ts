// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-P1 pool conversational reliability: one read of a mainnet pool's current price, as the web chat makes it when FloFi asks for one (Orca SOL/USDC
 * on Solana mainnet-beta; a catalog network's Uniswap v3 pool by its pair and fee tier). It calls only the existing read-only, access-gated server
 * actions it is given, never signs or sends anything, keeps nothing across turns, and binds the answer to the pool FloFi asked for: a read whose
 * pool is missing or different is a failed read (fail closed). A failure keeps its closed code so FloFi can say what could not be confirmed.
 */
import type { PoolPriceRead, PoolRef } from '../domain/pool-range';

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };
export type PoolReadActions = {
  readonly orca: () => Promise<Result<{ readonly pool: string; readonly price: string; readonly tickCurrentIndex: number; readonly slot: number }>>;
  readonly catalog: (chain: string, pair: { tokenA: string; tokenB: string; fee: number }) =>
    Promise<Result<{ readonly sqrtPriceX96: string; readonly tick: number; readonly blockNumber: number; readonly pool?: string }>>;
};
export function poolReader(actions: PoolReadActions, now: () => number = Date.now): (ref: PoolRef) => Promise<PoolPriceRead> {
  return async ref => {
    const readAt = now(), failed = (code: string): PoolPriceRead => ({ ref, readAt, ok: false, code });
    try {
      if (ref.kind === 'ORCA') {
        const result = await actions.orca();
        if (!result.ok) return failed(result.code);
        if (result.value.pool !== ref.pool) return failed('COPILOT_POOL_IDENTITY_CHANGED');
        return { ref, readAt, ok: true, price: result.value.price, tick: result.value.tickCurrentIndex, at: result.value.slot };
      }
      const result = await actions.catalog(ref.chain, { tokenA: ref.tokenA, tokenB: ref.tokenB, fee: ref.fee });
      if (!result.ok) return failed(result.code);
      if (typeof result.value.pool !== 'string' || result.value.pool.toLowerCase() !== ref.pool.toLowerCase()) return failed('COPILOT_POOL_IDENTITY_CHANGED');
      return { ref, readAt, ok: true, sqrtPrice: result.value.sqrtPriceX96, tick: result.value.tick, at: result.value.blockNumber };
    } catch { return failed('COPILOT_POOL_PRICE_UNAVAILABLE'); }
  };
}
