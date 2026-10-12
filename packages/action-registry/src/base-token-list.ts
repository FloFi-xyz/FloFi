// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-BASE-001: the Base mainnet asset provider.
 *
 * Source: the Uniswap Labs Default Token List, `GET https://tokens.uniswap.org` (https://github.com/Uniswap/default-token-list), the
 * curated list of the Uniswap interface on Base — FloFi's swap and liquidity venue there. On 2026-10-11 it listed 159 Base (8453)
 * entries; every one had code on chain, and two (FLUX, WMTX) declared decimals that differ from their contract's `decimals()`. Listing
 * is therefore an inclusion policy, never authority: Simulate re-reads every identity and `decimals()` on chain and fails closed.
 *
 * The catalog is the code-pinned Base assets (ETH, Circle USDC, OP Stack WETH — bound exactly by the Router, Aave and the BUILD-002
 * reference swap) plus every Base list entry that passes the inclusion policy:
 *  - an EIP-55 checksummed address, integer decimals 0–36, a 1–160 character name without control characters;
 *  - a symbol in FloFi's catalog grammar (1–16 characters, a letter first); any other symbol is counted and excluded, never renamed.
 * A malformed Base record, a duplicate address or (case-insensitive) symbol, or a pinned asset listed with another identity fails the
 * whole catalog closed. Entries of other chains are not Base assets and are not projected. A `logoURI` is kept as presentation metadata
 * only under the reviewed image prefixes of `BASE_TOKEN_LIST_LOGOS` (the hosts the list used on 2026-10-11); any other value is dropped,
 * never followed, and never fails the catalog. The list is GPL-3.0: FloFi reads it at runtime and never commits or redistributes it (tests
 * use a FloFi-authored fixture).
 */
import { BASE_BASE_ASSETS, type AssetCatalog } from './asset-registry.js';
import { BASE_MAINNET } from './base-chain.js';
import { type AssetLogoRule } from './asset-logos.js';
import { UNISWAP_TOKEN_LIST, isTokenListNetworkCatalog, uniswapTokenListProvider, type TokenListNetwork } from './uniswap-token-list.js';

export const BASE_TOKEN_LIST = UNISWAP_TOKEN_LIST;
/** Existing reviewed Base logo policy; unchanged by BUILD-ARB-001's shared parser extraction. */
export const BASE_TOKEN_LIST_LOGOS: AssetLogoRule = Object.freeze({ kind: 'PREFIXED', provider: BASE_TOKEN_LIST.provider, chain: BASE_MAINNET.chain,
  prefixes: Object.freeze(['https://coin-images.coingecko.com/coins/images/', 'https://assets.coingecko.com/coins/images/',
    'https://ethereum-optimism.github.io/data/', 'https://raw.githubusercontent.com/trustwallet/assets/', 'https://s2.coinmarketcap.com/static/img/coins/',
    'https://basescan.org/token/images/']), cacheBusterQuery: true });
/** Shortcuts only, never a catalog limit. */
export const BASE_FEATURED_ASSETS = Object.freeze(['USDC', 'WETH'] as const);
export const BASE_TOKEN_LIST_NETWORK: TokenListNetwork = Object.freeze({ pinned: BASE_BASE_ASSETS, featured: BASE_FEATURED_ASSETS,
  logos: BASE_TOKEN_LIST_LOGOS, errorPrefix: 'BASE_TOKEN_LIST' });
export const baseTokenListProvider = uniswapTokenListProvider(BASE_TOKEN_LIST_NETWORK);
export function parseBaseTokenList(text: string, fetchedAt: string): AssetCatalog { return baseTokenListProvider.parse(text, fetchedAt); }
export function isBaseNetworkCatalog(catalog: AssetCatalog): boolean { return isTokenListNetworkCatalog(catalog, BASE_TOKEN_LIST_NETWORK); }
