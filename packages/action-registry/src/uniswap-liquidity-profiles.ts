// SPDX-License-Identifier: Apache-2.0
import { UNISWAP_V3_BASE_SEPOLIA_LIQUIDITY } from './uniswap-v3-base-sepolia.js';
import { UNISWAP_V3_ETHEREUM_SEPOLIA_LIQUIDITY } from './uniswap-v3-ethereum-sepolia.js';
/** The public Uniswap v3 concentrated-liquidity runtimes: Base Sepolia USDC/WETH 0.05% and Ethereum Sepolia USDC/WETH 0.3%. */
export type UniswapLiquidityProfile = typeof UNISWAP_V3_BASE_SEPOLIA_LIQUIDITY | typeof UNISWAP_V3_ETHEREUM_SEPOLIA_LIQUIDITY;
export const UNISWAP_LIQUIDITY_PROFILES: readonly UniswapLiquidityProfile[] = Object.freeze([UNISWAP_V3_BASE_SEPOLIA_LIQUIDITY, UNISWAP_V3_ETHEREUM_SEPOLIA_LIQUIDITY]);
/** The liquidity profile of a CAIP-2 chain or numeric chain id; null for any other chain (Mainnet included). */
export function uniswapLiquidityProfile(chain: string | number | null | undefined): UniswapLiquidityProfile | null {
  return UNISWAP_LIQUIDITY_PROFILES.find(profile => profile.chain === chain || profile.chainId === chain) ?? null;
}
/** One side of a Uniswap v3 pool runtime. */
export type UniswapPoolToken = { readonly symbol: string; readonly address: string; readonly decimals: number; readonly maximumAmount: string };
/**
 * The structural runtime of one Uniswap v3 pool, as the liquidity service consumes it: a fixed testnet profile above, or
 * (BUILD-RH-002) a Robinhood Chain pool chosen per pair and fee tier. `codeSha256.pool` is null when the pool is proven by its
 * CREATE2 derivation from the pinned factory and init-code hash (a v3 pool's runtime code embeds its own immutables, so no single
 * code pin covers every pool). `weth` is the wrapped native token the Position Manager reports (token1 of the USDC/WETH profiles).
 */
export type UniswapPoolProfile = {
  readonly network: string; readonly chain: string; readonly chainId: number; readonly chainHex: string; readonly protocol: 'uniswap-v3'; readonly adapterId: 'uniswap.v3';
  readonly providerLabel: string; readonly rpc: string; readonly explorer: string; readonly officialSource: string; readonly factory: string;
  readonly positionManager: string; readonly pool: string; readonly gasPriceOracle: string | null; readonly token0: UniswapPoolToken; readonly token1: UniswapPoolToken;
  readonly codeSha256: { readonly factory: string; readonly positionManager: string; readonly pool: string | null };
  readonly feeTier: number; readonly tickSpacing: number; readonly maximumSlippageBps: number; readonly defaultSlippageBps: number;
  readonly reviewTtlSeconds: number; readonly mintDeadlineSeconds: number;
  readonly weth?: string; readonly poolInitCodeHash?: string; readonly environment?: 'MAINNET' | 'PUBLIC_TESTNET';
};
