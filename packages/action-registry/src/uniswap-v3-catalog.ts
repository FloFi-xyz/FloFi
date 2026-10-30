// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-BASE-001: Uniswap v3 on a network whose assets come from an official catalog (Robinhood Chain since BUILD-RH-002, Base since
 * BUILD-BASE-001). A pool is never authored or listed: it is the CREATE2 address of (pinned factory, token0, token1, fee) under the
 * canonical v3 init-code hash, and its identity, code and live state are re-verified at simulation. One builder serves every network;
 * a network only contributes its verified deployment constants.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { UniswapPoolProfile, UniswapPoolToken } from './uniswap-liquidity-profiles.js';

/** The verified Uniswap v3 deployment of one catalog network, as the concentrated-liquidity runtime consumes it. */
export type UniswapCatalogLiquidity = {
  readonly network: string; readonly chain: string; readonly chainId: number; readonly chainHex: string;
  readonly providerLabel: string; readonly rpc: string; readonly explorer: string; readonly officialSource: string;
  readonly factory: string; readonly positionManager: string; readonly weth: string; readonly poolInitCodeHash: string;
  readonly feeTiers: readonly { readonly fee: number; readonly tickSpacing: number }[];
  readonly codeSha256: { readonly factory: string; readonly positionManager: string };
  /** OP Stack GasPriceOracle (L1 data fee bound), or null where receipts carry no `l1Fee` (Arbitrum Nitro). */
  readonly gasPriceOracle: string | null;
  readonly maximumSlippageBps: number; readonly defaultSlippageBps: number; readonly reviewTtlSeconds: number; readonly mintDeadlineSeconds: number;
};
/** ERC-20 deposit encoding limit. Wallet balances and live pool liquidity determine actual availability. */
export function catalogLiquidityMaximumUnits(decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('UNISWAP_TOKEN_UNSUPPORTED');
  return (2n ** 256n - 1n).toString();
}
/**
 * A Uniswap v3 pool on a catalog network as a liquidity runtime: the CREATE2 pool of the pinned factory for (tokenA, tokenB, fee), tokens
 * in pool order. Identity, code and live state are verified at simulation; an unknown fee tier or identical tokens fail closed.
 */
export function catalogLiquidityPool(deployment: UniswapCatalogLiquidity, tokenA: Omit<UniswapPoolToken, 'maximumAmount'>, tokenB: Omit<UniswapPoolToken, 'maximumAmount'>,
  fee: number): UniswapPoolProfile {
  const tier = deployment.feeTiers.find(item => item.fee === fee);
  if (!tier) throw new Error('UNISWAP_FEE_TIER_UNSUPPORTED');
  const side = (token: Omit<UniswapPoolToken, 'maximumAmount'>): UniswapPoolToken => {
    if (!/^0x[0-9a-f]{40}$/.test(token.address) || !Number.isSafeInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) throw new Error('UNISWAP_TOKEN_UNSUPPORTED');
    return Object.freeze({ symbol: token.symbol, address: token.address, decimals: token.decimals, maximumAmount: catalogLiquidityMaximumUnits(token.decimals) });
  };
  if (tokenA.address === tokenB.address) throw new Error('UNISWAP_TOKEN_UNSUPPORTED');
  const [token0, token1] = tokenA.address < tokenB.address ? [side(tokenA), side(tokenB)] : [side(tokenB), side(tokenA)];
  const P = deployment;
  return Object.freeze({ network: P.network, chain: P.chain, chainId: P.chainId, chainHex: P.chainHex, protocol: 'uniswap-v3', adapterId: 'uniswap.v3',
    providerLabel: P.providerLabel, rpc: P.rpc, explorer: P.explorer, officialSource: P.officialSource, factory: P.factory, positionManager: P.positionManager,
    pool: uniswapV3PoolAddress(P.factory, P.poolInitCodeHash, token0.address, token1.address, fee), gasPriceOracle: P.gasPriceOracle, token0, token1,
    codeSha256: Object.freeze({ factory: P.codeSha256.factory, positionManager: P.codeSha256.positionManager, pool: null }),
    feeTier: fee, tickSpacing: tier.tickSpacing, maximumSlippageBps: P.maximumSlippageBps, defaultSlippageBps: P.defaultSlippageBps,
    reviewTtlSeconds: P.reviewTtlSeconds, mintDeadlineSeconds: P.mintDeadlineSeconds, weth: P.weth,
    poolInitCodeHash: P.poolInitCodeHash, environment: 'MAINNET' });
}
/**
 * The CREATE2 address of a Uniswap v3 pool: keccak256(0xff ‖ factory ‖ keccak256(abi.encode(token0, token1, fee)) ‖ initCodeHash).
 * Computed locally, so a pool is proven by the factory's own derivation rather than by an RPC answer.
 */
export function uniswapV3PoolAddress(factory: string, initCodeHash: string, tokenA: string, tokenB: string, fee: number): string {
  const word = (hex: string) => hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  if (![factory, tokenA, tokenB].every(value => /^0x[0-9a-fA-F]{40}$/.test(value)) || !/^0x[0-9a-f]{64}$/.test(initCodeHash) ||
      !Number.isSafeInteger(fee) || fee < 0 || fee >= 1 << 24 || tokenA.toLowerCase() === tokenB.toLowerCase()) throw new Error('POOL_IDENTITY_INVALID');
  const [token0, token1] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map(pair => parseInt(pair, 16)));
  const salt = keccak_256(bytes(word(token0!) + word(token1!) + fee.toString(16).padStart(64, '0')));
  const hash = keccak_256(bytes('ff' + factory.toLowerCase().slice(2) + Array.from(salt, b => b.toString(16).padStart(2, '0')).join('') + initCodeHash.slice(2)));
  return '0x' + Array.from(hash.slice(12), b => b.toString(16).padStart(2, '0')).join('');
}
