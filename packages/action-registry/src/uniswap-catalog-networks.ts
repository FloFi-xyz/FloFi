// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-BASE-001: the catalog networks' Uniswap v3 deployments, by chain. A concentrated-liquidity node on one of these chains names its
 * own pair and standard fee tier; its pool is derived (CREATE2) from that network's pinned factory, never chosen across networks.
 */
import { UNISWAP_V3_BASE_LIQUIDITY } from './uniswap-v3-base.js';
import { UNISWAP_V3_ETHEREUM_LIQUIDITY } from './uniswap-v3-ethereum.js';
import { UNISWAP_V3_ARBITRUM_LIQUIDITY } from './uniswap-v3-arbitrum.js';
import { UNISWAP_V3_ROBINHOOD_CATALOG } from './uniswap-v3-robinhood.js';
import { catalogLiquidityPool, type UniswapCatalogLiquidity } from './uniswap-v3-catalog.js';
import type { UniswapPoolProfile, UniswapPoolToken } from './uniswap-liquidity-profiles.js';

export const UNISWAP_CATALOG_DEPLOYMENTS: readonly UniswapCatalogLiquidity[] = Object.freeze([UNISWAP_V3_ROBINHOOD_CATALOG, UNISWAP_V3_BASE_LIQUIDITY, UNISWAP_V3_ARBITRUM_LIQUIDITY, UNISWAP_V3_ETHEREUM_LIQUIDITY]);
/** The catalog-pool deployment of a CAIP-2 chain or numeric chain id; null for a chain whose pools are fixed profiles (testnets). */
export function uniswapCatalogDeployment(chain: string | number | null | undefined): UniswapCatalogLiquidity | null {
  return UNISWAP_CATALOG_DEPLOYMENTS.find(deployment => deployment.chain === chain || deployment.chainId === chain) ?? null;
}
/** The pool of (tokenA, tokenB, fee) on a catalog network; any other chain fails closed. */
export function catalogPoolOn(chain: string | number, tokenA: Omit<UniswapPoolToken, 'maximumAmount'>, tokenB: Omit<UniswapPoolToken, 'maximumAmount'>, fee: number): UniswapPoolProfile {
  const deployment = uniswapCatalogDeployment(chain);
  if (!deployment) throw new Error('UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED');
  return catalogLiquidityPool(deployment, tokenA, tokenB, fee);
}
