// SPDX-License-Identifier: Apache-2.0
import { ETHEREUM_MAINNET } from './ethereum-chain.js';
import { CATALOG_ASSET_SYMBOL, ETHEREUM_BASE_ASSETS, type AssetCatalog } from './asset-registry.js';
import type { AssetLogoRule } from './asset-logos.js';
import { UNISWAP_TOKEN_LIST, uniswapTokenListProvider, type TokenListNetwork } from './uniswap-token-list.js';

export const ETHEREUM_TOKEN_LIST = UNISWAP_TOKEN_LIST;
export const ETHEREUM_TOKEN_LIST_LOGOS: AssetLogoRule = Object.freeze({ kind: 'PREFIXED', provider: ETHEREUM_TOKEN_LIST.provider, chain: ETHEREUM_MAINNET.chain,
  prefixes: Object.freeze(['https://coin-images.coingecko.com/coins/images/', 'https://assets.coingecko.com/coins/images/',
    'https://raw.githubusercontent.com/trustwallet/assets/', 'https://s2.coinmarketcap.com/static/img/coins/']), cacheBusterQuery: true });
export const ETHEREUM_TOKEN_LIST_NETWORK: TokenListNetwork = Object.freeze({ pinned: ETHEREUM_BASE_ASSETS,
  featured: Object.freeze(['USDC', 'WETH']), logos: ETHEREUM_TOKEN_LIST_LOGOS, errorPrefix: 'ETHEREUM_TOKEN_LIST', symbolPattern: CATALOG_ASSET_SYMBOL,
  // The current source names both Litentry and Lighter LIT. Neither ambiguous identity is eligible for symbol-based authoring.
  excludedAmbiguousSymbols: Object.freeze(['LIT']) });
export const ethereumTokenListProvider = uniswapTokenListProvider(ETHEREUM_TOKEN_LIST_NETWORK);
export function parseEthereumTokenList(text: string, fetchedAt: string): AssetCatalog { return ethereumTokenListProvider.parse(text, fetchedAt); }
