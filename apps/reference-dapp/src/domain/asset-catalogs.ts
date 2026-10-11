// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: the asset catalogs authoring reads (Canvas, Chat, MCP), one per network, through the generic asset registry.
 * Arbitrum and the base assets of each catalog network are code-pinned (Robinhood: ETH, WETH, USDG; BUILD-BASE-001 Base: ETH, USDC, WETH).
 * The rest of a catalog network comes only from its official source as validated by the server (`registerNetworkCatalog`): Robinhood
 * Stock Tokens from the official registry, Base tokens from the Uniswap Labs Default Token List. Before that, or after the source fails,
 * only the pinned assets resolve and authoring that needs another asset fails closed. Presentation only: Simulate re-validates every
 * identity against the official source and the chain.
 */
import { ARBITRUM_BASE_ASSETS, BASE_BASE_ASSETS, BASE_FEATURED_ASSETS, BASE_MAINNET, BASE_TOKEN_LIST, ROBINHOOD_BASE_ASSETS, ROBINHOOD_CHAIN_MAINNET, ROBINHOOD_FEATURED_STOCKS,
  catalogAsset, catalogAssetsByName, createAssetRegistry, featuredAssets, isBaseNetworkCatalog, searchAssets, type AssetCatalog, type AssetClass, type AssetReference,
  type CanonicalAsset } from '@defi-workflow-engine/action-registry';

export const ROBINHOOD_NETWORK = 'Robinhood Chain';
export const ROBINHOOD_CHAIN = ROBINHOOD_CHAIN_MAINNET.chain;
/** BUILD-BASE-001: Base mainnet, a catalog network like Robinhood Chain. */
export const BASE_NETWORK = BASE_MAINNET.name;
export const BASE_CHAIN = BASE_MAINNET.chain;
/** Networks whose full catalog comes from an official source registered by the server; every other network is code-pinned. */
export const OFFICIAL_CATALOG_CHAINS: readonly string[] = Object.freeze([ROBINHOOD_CHAIN, BASE_CHAIN]);
const pinned: Readonly<Record<string, AssetCatalog>> = Object.freeze({ [BASE_BASE_ASSETS.chain]: BASE_BASE_ASSETS,
  [ARBITRUM_BASE_ASSETS.chain]: ARBITRUM_BASE_ASSETS, [ROBINHOOD_BASE_ASSETS.chain]: ROBINHOOD_BASE_ASSETS });
const official = new Map<string, AssetCatalog>();
let version = 0;
const listeners = new Set<() => void>();
/** A server-validated official catalog for its own network; anything else (another network, a pinned-only or foreign catalog) is refused. */
function acceptable(catalog: AssetCatalog): boolean {
  if (catalog.format !== 'flofi.asset-catalog.v1') return false;
  if (catalog.chain === ROBINHOOD_CHAIN) return catalog.assets.some(asset => asset.assetClass === 'STOCK_TOKEN');
  if (catalog.chain === BASE_CHAIN) return isBaseNetworkCatalog(catalog) && catalog.provenance.some(item => item.provider === BASE_TOKEN_LIST.provider);
  return false;
}
/** Registers the server-validated official catalog of a catalog network (Robinhood: base assets + Stock Tokens; Base: pinned assets + token list). */
export function registerNetworkCatalog(catalog: AssetCatalog): void {
  if (!acceptable(catalog)) throw new Error('ASSET_CATALOG_INVALID');
  // Revalidate shape and uniqueness through the registry itself (it throws on duplicates or a second network catalog).
  createAssetRegistry([catalog]);
  official.set(catalog.chain, catalog); version += 1;
  for (const listener of listeners) listener();
}
export function subscribeNetworkCatalogs(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const networkCatalogsVersion = () => version;
/** The catalog of a network: its official catalog when registered, otherwise its code-pinned base assets. */
export function networkCatalog(chain: string): AssetCatalog | null {
  return official.get(chain) ?? pinned[chain] ?? null;
}
/** Whether a network's full catalog is available for authoring (an official-catalog network once registered; a pinned network always). */
export const officialCatalogLoaded = (chain = ROBINHOOD_CHAIN) => OFFICIAL_CATALOG_CHAINS.includes(chain) ? official.has(chain) : Boolean(pinned[chain]);
export function resolveNetworkAsset(chain: string, reference: AssetReference): CanonicalAsset | null {
  const catalog = networkCatalog(chain);
  return catalog ? catalogAsset(catalog, reference) : null;
}
/** What a written token reference names on one network: one asset (and how), several (ask), none, or the catalog is not loaded. */
export type AssetResolution = { readonly kind: 'FOUND'; readonly asset: CanonicalAsset; readonly by: 'SYMBOL' | 'NAME' }
  | { readonly kind: 'AMBIGUOUS'; readonly assets: readonly CanonicalAsset[] } | { readonly kind: 'UNKNOWN' } | { readonly kind: 'UNAVAILABLE' };
/** Words people add after a company or token name ("Tesla stock", "Apple shares"); removed only to retry a whole-name match. */
const NAME_SUFFIX = /\s+(?:stocks?|shares?|tokens?|stock\s+tokens?)$/i;
/**
 * BUILD-BASE-001: the shared resolver for a token a person wrote (natural-language Copilot; Chat and MCP pass symbols, the Canvas selects
 * from the same catalog), always within one network's current catalog — a symbol never reaches another network:
 *  1. the symbol, case-insensitively (`cbbtc` → cbBTC, `tsla` → TSLA);
 *  2. otherwise the whole display or catalog name of exactly one asset (`Tesla` → TSLA, `Coinbase Wrapped BTC` → cbBTC), also after a
 *     trailing "stock", "shares" or "token"; several assets sharing that name are AMBIGUOUS (the caller asks), never chosen.
 * A reference that matches nothing is UNKNOWN once the network's official catalog is loaded, UNAVAILABLE before (fail closed).
 */
export function resolveAssetReference(chain: string, reference: string): AssetResolution {
  const catalog = networkCatalog(chain), text = typeof reference === 'string' ? reference.trim() : '';
  if (!catalog) return { kind: 'UNAVAILABLE' };
  if (!text) return { kind: 'UNKNOWN' };
  const symbol = catalogAsset(catalog, { symbol: text });
  if (symbol) return { kind: 'FOUND', asset: symbol, by: 'SYMBOL' };
  for (const name of new Set([text, text.replace(NAME_SUFFIX, '')])) {
    const named = catalogAssetsByName(catalog, name);
    if (named.length === 1) return { kind: 'FOUND', asset: named[0]!, by: 'NAME' };
    if (named.length > 1) return { kind: 'AMBIGUOUS', assets: named };
  }
  return officialCatalogLoaded(chain) ? { kind: 'UNKNOWN' } : { kind: 'UNAVAILABLE' };
}
/** Featured Stock Tokens (shortcuts only): resolved from the official catalog, else the shortcut symbols themselves. */
export function featuredStockSymbols(): readonly string[] {
  const robinhood = official.get(ROBINHOOD_CHAIN);
  return robinhood ? featuredAssets(robinhood).map(asset => asset.symbol) : ROBINHOOD_FEATURED_STOCKS;
}
/** BUILD-BASE-001: the shortcuts of a network's pickers (featured assets; never the limit of its catalog). */
export function featuredNetworkSymbols(chain: string): readonly string[] {
  if (chain === ROBINHOOD_CHAIN) return featuredStockSymbols();
  if (chain === BASE_CHAIN) return BASE_FEATURED_ASSETS;
  const catalog = networkCatalog(chain);
  return catalog ? featuredAssets(catalog).map(asset => asset.symbol) : [];
}
/**
 * A network's code-pinned ERC-20s and its provider-declared shortcuts, independent of whichever catalog is loaded (for stable text such as
 * the Copilot model instructions). Never the limit of the catalog.
 */
export function declaredNetworkSymbols(chain: string): readonly string[] {
  const featured = chain === ROBINHOOD_CHAIN ? ROBINHOOD_FEATURED_STOCKS : chain === BASE_CHAIN ? BASE_FEATURED_ASSETS : [];
  return [...new Set([...(pinned[chain]?.assets ?? []).filter(asset => asset.kind === 'ERC20').map(asset => asset.symbol), ...featured])];
}
/** The canonical symbol of a network asset (`cbbtc` → `cbBTC`), or null when this network's current catalog does not resolve it. */
export const canonicalSymbol = (chain: string, symbol: string): string | null => resolveNetworkAsset(chain, { symbol })?.symbol ?? null;
export function searchNetworkAssets(chain: string, query: string, options: { readonly limit?: number; readonly assetClass?: AssetClass } = {}): readonly CanonicalAsset[] {
  const catalog = networkCatalog(chain);
  return catalog ? searchAssets(catalog, query, options) : [];
}
/** Test seam: forget the registered catalogs. */
export function resetNetworkCatalogs(): void { official.clear(); version += 1; for (const listener of listeners) listener(); }
