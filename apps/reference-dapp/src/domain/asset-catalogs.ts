// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: the asset catalogs authoring reads (Canvas, Chat, MCP), one per network, through the generic asset registry.
 * Base, Arbitrum and the Robinhood base assets (ETH, WETH, USDG) are code-pinned. Robinhood Stock Tokens come only from the
 * official registry as validated by the server (`registerNetworkCatalog`); before that, or after the registry fails, no
 * Stock Token resolves and authoring that needs one fails closed. Presentation only: Simulate re-validates every identity
 * against the official registry and the chain.
 */
import { ARBITRUM_BASE_ASSETS, BASE_BASE_ASSETS, ROBINHOOD_BASE_ASSETS, ROBINHOOD_CHAIN_MAINNET, ROBINHOOD_FEATURED_STOCKS, catalogAsset, createAssetRegistry,
  featuredAssets, searchAssets, type AssetCatalog, type AssetClass, type AssetReference, type CanonicalAsset } from '@defi-workflow-engine/action-registry';

export const ROBINHOOD_NETWORK = 'Robinhood Chain';
export const ROBINHOOD_CHAIN = ROBINHOOD_CHAIN_MAINNET.chain;
const pinned: Readonly<Record<string, AssetCatalog>> = Object.freeze({ [BASE_BASE_ASSETS.chain]: BASE_BASE_ASSETS,
  [ARBITRUM_BASE_ASSETS.chain]: ARBITRUM_BASE_ASSETS, [ROBINHOOD_BASE_ASSETS.chain]: ROBINHOOD_BASE_ASSETS });
let official: AssetCatalog | null = null, version = 0;
const listeners = new Set<() => void>();
/** Registers the server-validated official Robinhood Chain catalog (base assets + Stock Tokens); anything else is refused. */
export function registerNetworkCatalog(catalog: AssetCatalog): void {
  if (catalog.format !== 'flofi.asset-catalog.v1' || catalog.chain !== ROBINHOOD_CHAIN || !catalog.assets.some(asset => asset.assetClass === 'STOCK_TOKEN'))
    throw new Error('ASSET_CATALOG_INVALID');
  // Revalidate shape and uniqueness through the registry itself (it throws on duplicates or a second network catalog).
  createAssetRegistry([catalog]);
  official = catalog; version += 1;
  for (const listener of listeners) listener();
}
export function subscribeNetworkCatalogs(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const networkCatalogsVersion = () => version;
/** The catalog of a network: the official Robinhood catalog when registered, otherwise its code-pinned base assets. */
export function networkCatalog(chain: string): AssetCatalog | null {
  if (chain === ROBINHOOD_CHAIN && official) return official;
  return pinned[chain] ?? null;
}
export const officialCatalogLoaded = (chain = ROBINHOOD_CHAIN) => chain === ROBINHOOD_CHAIN ? official !== null : Boolean(pinned[chain]);
export function resolveNetworkAsset(chain: string, reference: AssetReference): CanonicalAsset | null {
  const catalog = networkCatalog(chain);
  return catalog ? catalogAsset(catalog, reference) : null;
}
/** Featured Stock Tokens (shortcuts only): resolved from the official catalog, else the shortcut symbols themselves. */
export function featuredStockSymbols(): readonly string[] {
  return official ? featuredAssets(official).map(asset => asset.symbol) : ROBINHOOD_FEATURED_STOCKS;
}
export function searchNetworkAssets(chain: string, query: string, options: { readonly limit?: number; readonly assetClass?: AssetClass } = {}): readonly CanonicalAsset[] {
  const catalog = networkCatalog(chain);
  return catalog ? searchAssets(catalog, query, options) : [];
}
/** Test seam: forget the registered catalog. */
export function resetNetworkCatalogs(): void { official = null; version += 1; for (const listener of listeners) listener(); }
