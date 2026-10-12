// SPDX-License-Identifier: Apache-2.0
/** BUILD-ARB-001 Phase 1: a profile of the existing curated provider, not another asset engine. */
import { ARBITRUM_ONE } from './arbitrum-chain.js';
import { ARBITRUM_BASE_ASSETS, type AssetCatalog } from './asset-registry.js';
import type { AssetLogoRule } from './asset-logos.js';
import { UNISWAP_TOKEN_LIST, isTokenListNetworkCatalog, uniswapTokenListProvider, type TokenListNetwork } from './uniswap-token-list.js';

export const ARBITRUM_TOKEN_LIST = UNISWAP_TOKEN_LIST;
/** Reuse the existing strict PREFIXED model and reviewed common image hosts. Other upstream logos fall back locally. */
export const ARBITRUM_TOKEN_LIST_LOGOS: AssetLogoRule = Object.freeze({ kind: 'PREFIXED', provider: ARBITRUM_TOKEN_LIST.provider, chain: ARBITRUM_ONE.chain,
  prefixes: Object.freeze(['https://coin-images.coingecko.com/coins/images/', 'https://assets.coingecko.com/coins/images/',
    'https://raw.githubusercontent.com/trustwallet/assets/', 'https://s2.coinmarketcap.com/static/img/coins/']), cacheBusterQuery: true });
export const ARBITRUM_FEATURED_ASSETS = Object.freeze(['USDC', 'WETH'] as const);
/** FLUX: list declares 18; decimals() returned 8 at Arbitrum block 513935282 (2026-10-11). Exclude; never silently correct amounts. */
export const ARBITRUM_TOKEN_LIST_NETWORK: TokenListNetwork = Object.freeze({ pinned: ARBITRUM_BASE_ASSETS, featured: ARBITRUM_FEATURED_ASSETS,
  logos: ARBITRUM_TOKEN_LIST_LOGOS, errorPrefix: 'ARBITRUM_TOKEN_LIST', excludedAddresses: Object.freeze(['0x63806c056fa458c548fb416b15e358a9d685710a']) });
export const arbitrumTokenListProvider = uniswapTokenListProvider(ARBITRUM_TOKEN_LIST_NETWORK);
export function parseArbitrumTokenList(text: string, fetchedAt: string): AssetCatalog { return arbitrumTokenListProvider.parse(text, fetchedAt); }
export function isArbitrumNetworkCatalog(catalog: AssetCatalog): boolean { return isTokenListNetworkCatalog(catalog, ARBITRUM_TOKEN_LIST_NETWORK); }
