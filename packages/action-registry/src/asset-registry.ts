// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-RH-002: the generic canonical asset registry.
 *
 *   Network → AssetProvider → validated canonical catalog → asset registry → Canvas / Chat / MCP / workflow IR → capabilities
 *
 * A catalog is built only from an official source through a provider that validates every field it projects and fails
 * closed on anything malformed, duplicated or ambiguous. Nothing here fetches: providers parse bytes a server read from
 * the official endpoint (or a committed fixture in tests). Assets are identified by chain + address + decimals and, where
 * the issuer publishes one, an official id; a symbol alone never selects an asset across networks.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';

export type AssetKind = 'NATIVE' | 'ERC20';
/** `TOKEN` (BUILD-BASE-001): a listed ERC-20 of a curated token list; its listing proves nothing about liquidity or lending support. */
export type AssetClass = 'NATIVE' | 'WRAPPED_NATIVE' | 'STABLECOIN' | 'STOCK_TOKEN' | 'TOKEN';
/** Normalized tradability of the underlying equity; `UNSET` means the source has not set the field. */
export type TradingStatus = 'TRADABLE' | 'UNTRADABLE' | 'POSITION_CLOSING_ONLY' | 'POSITION_OPENING_ONLY' | 'UNSET';
export type StockTrading = {
  /** Live shape: per session (market, extended, overnight) × whole/fractional. Documented shape: fractional + all-day flags. */
  readonly format: 'SESSIONS' | 'UNDERLIER_FLAGS' | 'ABSENT';
  readonly sessions: readonly { readonly session: string; readonly whole: TradingStatus; readonly fractional: TradingStatus }[];
  /** A new position may be opened in at least one session. */
  readonly acquirable: boolean;
  /** An existing position may be closed in at least one session. */
  readonly disposable: boolean;
  /** Fractional trading is not allowed in any session (every onchain amount is fractional). */
  readonly fractionalRestricted: boolean;
};
export type StockTokenDetails = {
  /** The issuer's onchain `uid()`, identical across chains for one asset. */
  readonly officialId: string; readonly isin: string | null;
  /** ERC-8056 shares-per-token, an 18-decimal string, and the same value scaled by 1e18. */
  readonly multiplier: string; readonly multiplierWad: string;
  readonly pendingMultiplier: string | null; readonly pendingMultiplierWad: string | null; readonly pendingEffectiveTime: string | null;
  readonly trading: StockTrading;
};
export type CanonicalAsset = {
  /** CAIP-19: `eip155:<id>/erc20:<address>` or `eip155:<id>/slip44:60` for native ETH. */
  readonly id: string;
  readonly chain: string; readonly chainId: number; readonly network: string;
  readonly kind: AssetKind; readonly assetClass: AssetClass;
  readonly symbol: string; readonly name: string;
  /** Lowercase EVM address; null for the native asset. */
  readonly address: string | null; readonly decimals: number;
  readonly logoUrl: string | null;
  readonly source: { readonly provider: string; readonly url: string; readonly officialId: string | null };
  readonly stock: StockTokenDetails | null;
};
export type CatalogProvenance = {
  readonly provider: string; readonly source: string; readonly fetchedAt: string;
  /** SHA-256 of the exact official bytes the catalog was built from; null for static (code-pinned) sources. */
  readonly contentSha256: string | null;
  readonly officialRecords: number; readonly activeRecords: number;
};
export type AssetCatalog = {
  readonly format: 'flofi.asset-catalog.v1';
  readonly chain: string; readonly chainId: number; readonly network: string;
  readonly assets: readonly CanonicalAsset[];
  /** Ids of featured shortcuts, in display order. Featuring never limits the catalog. */
  readonly featured: readonly string[];
  readonly provenance: readonly CatalogProvenance[];
};
export interface AssetProvider<Input = unknown> {
  readonly id: string; readonly chain: string; readonly source: string;
  parse(input: Input, fetchedAt: string): AssetCatalog;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/**
 * Catalog symbol grammar. BUILD-BASE-001: lower-case letters are allowed (`cbBTC`, `USDbC`, `wstETH`); symbols stay unique
 * case-insensitively inside a catalog, so a symbol always resolves to exactly one asset of its network.
 */
export const ASSET_SYMBOL = /^[A-Za-z][A-Za-z0-9.]{0,15}$/;
const SYMBOL = ASSET_SYMBOL;
function fail(code: string): never { throw new Error(code); }
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};

/** The EIP-55 checksum encoding of an address. */
export function toChecksumAddress(value: string): string {
  if (!ADDRESS.test(value)) fail('ADDRESS_INVALID');
  const body = value.slice(2).toLowerCase(), hash = hex(keccak_256(new TextEncoder().encode(body)));
  return '0x' + Array.from(body, (char, index) => parseInt(hash[index]!, 16) >= 8 ? char.toUpperCase() : char).join('');
}
/** True only for the exact EIP-55 encoding (an address whose checksum uppercases no letter is legitimately all-lowercase). */
export function isChecksumAddress(value: string): boolean { return ADDRESS.test(value) && toChecksumAddress(value) === value; }
export const caip2ChainId = (chain: string): number => {
  const match = /^eip155:([1-9][0-9]{0,18})$/.exec(chain);
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) ? id : fail('ASSET_CHAIN_INVALID');
};
export const erc20AssetId = (chain: string, address: string) => `${chain}/erc20:${address.toLowerCase()}`;
export const nativeAssetId = (chain: string) => `${chain}/slip44:60`;
export function contentSha256(bytes: Uint8Array | string): string { return hex(sha256(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes)); }

/** An 18-decimal string strictly greater than zero, returned as an integer scaled by 1e18. */
export function parseMultiplier(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,17})\.[0-9]{18}$/.test(value)) fail('ASSET_MULTIPLIER_INVALID');
  const [whole, fraction] = (value as string).split('.') as [string, string];
  const wad = BigInt(whole) * 10n ** 18n + BigInt(fraction);
  return wad > 0n ? wad : fail('ASSET_MULTIPLIER_INVALID');
}
export function formatWad(wad: bigint): string {
  if (wad < 0n) fail('ASSET_MULTIPLIER_INVALID');
  return `${wad / 10n ** 18n}.${(wad % 10n ** 18n).toString().padStart(18, '0')}`;
}

/** Validates uniqueness of ids, addresses and symbols, and that every asset belongs to the catalog's chain. */
export function createAssetCatalog(input: { readonly chain: string; readonly network: string; readonly assets: readonly CanonicalAsset[];
  readonly featuredSymbols?: readonly string[]; readonly provenance: readonly CatalogProvenance[] }): AssetCatalog {
  const chainId = caip2ChainId(input.chain);
  if (!Array.isArray(input.assets) || input.assets.length < 1 || input.assets.length > 5000) fail('ASSET_CATALOG_INVALID');
  const ids = new Set<string>(), addresses = new Set<string>(), symbols = new Set<string>(), officialIds = new Set<string>();
  for (const asset of input.assets) {
    if (asset.chain !== input.chain || asset.chainId !== chainId || asset.network !== input.network) fail('ASSET_CHAIN_MISMATCH');
    if (!Number.isSafeInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36 || !SYMBOL.test(asset.symbol)) fail('ASSET_CATALOG_INVALID');
    const expectedId = asset.kind === 'NATIVE' ? nativeAssetId(asset.chain) : asset.address && /^0x[0-9a-f]{40}$/.test(asset.address) ? erc20AssetId(asset.chain, asset.address) : fail('ASSET_CATALOG_INVALID');
    if (asset.id !== expectedId || (asset.kind === 'NATIVE') !== (asset.address === null)) fail('ASSET_CATALOG_INVALID');
    if (asset.assetClass === 'STOCK_TOKEN' ? !asset.stock || asset.kind !== 'ERC20' : asset.stock !== null) fail('ASSET_CATALOG_INVALID');
    const symbol = asset.symbol.toUpperCase();
    if (ids.has(asset.id) || (asset.address && addresses.has(asset.address)) || symbols.has(symbol) ||
        (asset.source.officialId && officialIds.has(asset.source.officialId))) fail('ASSET_CATALOG_DUPLICATE');
    ids.add(asset.id); symbols.add(symbol);
    if (asset.address) addresses.add(asset.address);
    if (asset.source.officialId) officialIds.add(asset.source.officialId);
  }
  const featured = (input.featuredSymbols ?? []).map(symbol => input.assets.find(asset => asset.symbol === symbol)?.id).filter((id): id is string => Boolean(id));
  return deepFreeze({ format: 'flofi.asset-catalog.v1', chain: input.chain, chainId, network: input.network,
    assets: [...input.assets], featured, provenance: [...input.provenance] });
}
/** Merges catalogs of one network (for example base assets and Stock Tokens). Any collision fails closed. */
export function mergeAssetCatalogs(catalogs: readonly AssetCatalog[], featuredSymbols?: readonly string[]): AssetCatalog {
  const first = catalogs[0] ?? fail('ASSET_CATALOG_INVALID');
  if (catalogs.some(catalog => catalog.chain !== first.chain || catalog.network !== first.network)) fail('ASSET_CHAIN_MISMATCH');
  const featured = featuredSymbols ?? catalogs.flatMap(catalog => catalog.featured.map(id => catalog.assets.find(asset => asset.id === id)!.symbol));
  return createAssetCatalog({ chain: first.chain, network: first.network, assets: catalogs.flatMap(catalog => catalog.assets),
    featuredSymbols: featured, provenance: catalogs.flatMap(catalog => catalog.provenance) });
}

export type AssetReference = { readonly id: string } | { readonly address: string } | { readonly symbol: string } | { readonly officialId: string };
/** Exactly one asset or null; a symbol is matched case-insensitively and only within this catalog's network. */
export function catalogAsset(catalog: AssetCatalog, reference: AssetReference): CanonicalAsset | null {
  const matches = catalog.assets.filter(asset => 'id' in reference ? asset.id === reference.id
    : 'address' in reference ? asset.address !== null && asset.address === String(reference.address).toLowerCase()
    : 'officialId' in reference ? asset.source.officialId === reference.officialId
    : asset.symbol.toUpperCase() === String(reference.symbol).trim().toUpperCase());
  return matches.length === 1 ? matches[0]! : null;
}
export const featuredAssets = (catalog: AssetCatalog): readonly CanonicalAsset[] =>
  catalog.featured.map(id => catalog.assets.find(asset => asset.id === id)!);
/** Display name without the issuer suffix (" • Robinhood Token"). */
export const assetDisplayName = (asset: Pick<CanonicalAsset, 'name'>): string => asset.name.replace(/\s*[•·]\s*Robinhood Token$/u, '').trim();
const nameKey = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
/**
 * BUILD-BASE-001: the assets whose display name or full catalog name is exactly `name` (case- and spacing-insensitive), never a fragment:
 * "tesla" names TSLA ("Tesla • Robinhood Token"); "Coinbase BTC" names nothing. More than one result is an ambiguity the caller must ask
 * about; this never chooses.
 */
export function catalogAssetsByName(catalog: AssetCatalog, name: string): readonly CanonicalAsset[] {
  const wanted = typeof name === 'string' ? nameKey(name) : '';
  return wanted ? catalog.assets.filter(asset => nameKey(assetDisplayName(asset)) === wanted || nameKey(asset.name) === wanted) : [];
}

/**
 * Case-insensitive search by symbol and display name. Ranking: exact symbol, symbol prefix, name word prefix, then
 * substring of symbol or name; ties keep catalog order. Bounded: callers render at most `limit` results.
 */
export function searchAssets(catalog: AssetCatalog, query: string, options: { readonly limit?: number; readonly assetClass?: AssetClass } = {}): readonly CanonicalAsset[] {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
  const text = typeof query === 'string' ? query.normalize('NFKC').trim().toUpperCase().slice(0, 64) : '';
  const pool = catalog.assets.filter(asset => !options.assetClass || asset.assetClass === options.assetClass);
  if (!text) return pool.slice(0, limit);
  const rank = (asset: CanonicalAsset): number => {
    const symbol = asset.symbol.toUpperCase(), name = assetDisplayName(asset).toUpperCase();
    if (symbol === text) return 0;
    if (symbol.startsWith(text)) return 1;
    if (name.split(/[^A-Z0-9]+/).some(word => word.startsWith(text)) || name.startsWith(text)) return 2;
    if (symbol.includes(text) || name.includes(text)) return 3;
    return -1;
  };
  return pool.map((asset, index) => ({ asset, index, score: rank(asset) })).filter(entry => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index).slice(0, limit).map(entry => entry.asset);
}

/** The cross-network registry: one validated catalog per network. A second catalog for a network fails closed. */
export type AssetRegistry = { readonly catalogs: readonly AssetCatalog[]; readonly catalog: (chain: string) => AssetCatalog | null;
  readonly resolve: (chain: string, reference: AssetReference) => CanonicalAsset | null };
export function createAssetRegistry(catalogs: readonly AssetCatalog[]): AssetRegistry {
  if (new Set(catalogs.map(catalog => catalog.chain)).size !== catalogs.length) fail('ASSET_REGISTRY_DUPLICATE_NETWORK');
  const frozen = Object.freeze([...catalogs]);
  const catalog = (chain: string) => frozen.find(item => item.chain === chain) ?? null;
  return Object.freeze({ catalogs: frozen, catalog, resolve: (chain: string, reference: AssetReference) => {
    const found = catalog(chain);
    return found ? catalogAsset(found, reference) : null;
  } });
}

/** The IR asset of a canonical asset (chain + address + decimals, or chain + native id + decimals). */
export function workflowAsset(asset: CanonicalAsset): { chainId: string; address: string; decimals: number } | { chainId: string; nativeId: string; decimals: number } {
  return asset.address ? { chainId: asset.chain, address: asset.address, decimals: asset.decimals } : { chainId: asset.chain, nativeId: 'ETH', decimals: asset.decimals };
}
/** Exact decimal text (no exponent, no rounding) to native units of an asset. */
export function parseAssetAmount(text: unknown, decimals: number): string {
  if (typeof text !== 'string' || text.length === 0 || text.length > 80 || !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) fail('INVALID_AMOUNT');
  const [whole, fraction = ''] = (text as string).split('.') as [string, string?];
  if (fraction!.length > decimals) fail('AMOUNT_PRECISION');
  const units = BigInt(whole + fraction!.padEnd(decimals, '0'));
  if (units < 1n || units >= 1n << 256n) fail('AMOUNT_OUT_OF_RANGE');
  return units.toString();
}
export function formatAssetAmount(units: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(units)) return '--';
  if (decimals === 0) return units;
  const padded = units.padStart(decimals + 1, '0');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${padded.slice(0, -decimals)}.${fraction}` : padded.slice(0, -decimals);
}

// -------------------------------------------------------------------------------------------------------------------
// Static, code-pinned base assets (one provider per network). Base and Arbitrum carry only their bridge-relevant assets;
// their full catalogs are a later build and plug into the same registry.
// -------------------------------------------------------------------------------------------------------------------
type StaticAsset = { symbol: string; name: string; assetClass: AssetClass; address: string | null; decimals: number };
function staticCatalog(chain: string, network: string, provider: string, url: string, items: readonly StaticAsset[]): AssetCatalog {
  const chainId = caip2ChainId(chain);
  return createAssetCatalog({ chain, network, provenance: [{ provider, source: url, fetchedAt: '2026-10-11T00:00:00.000Z', contentSha256: null,
    officialRecords: items.length, activeRecords: items.length }], assets: items.map(item => ({
    id: item.address ? erc20AssetId(chain, item.address) : nativeAssetId(chain), chain, chainId, network, kind: item.address ? 'ERC20' as const : 'NATIVE' as const,
    assetClass: item.assetClass, symbol: item.symbol, name: item.name, address: item.address?.toLowerCase() ?? null, decimals: item.decimals,
    logoUrl: null, source: { provider, url, officialId: null }, stock: null })) });
}
export const ROBINHOOD_TOKEN_CONTRACTS_SOURCE = 'https://docs.robinhood.com/chain/contracts';
/** Robinhood Chain base assets from the official Token Contracts page (USDG reads 6 decimals onchain, WETH 18). */
export const ROBINHOOD_BASE_ASSETS = staticCatalog('eip155:4663', 'Robinhood Chain', 'robinhood.token-contracts', ROBINHOOD_TOKEN_CONTRACTS_SOURCE, [
  { symbol: 'ETH', name: 'Ether', assetClass: 'NATIVE', address: null, decimals: 18 },
  { symbol: 'WETH', name: 'Wrapped Ether', assetClass: 'WRAPPED_NATIVE', address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', decimals: 18 },
  { symbol: 'USDG', name: 'Global Dollar', assetClass: 'STABLECOIN', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 },
]);
/** Base mainnet: the pinned assets FloFi already uses (Circle USDC, OP Stack WETH). */
export const BASE_BASE_ASSETS = staticCatalog('eip155:8453', 'Base', 'flofi.pinned', 'https://developers.circle.com/stablecoins/usdc-contract-addresses', [
  { symbol: 'ETH', name: 'Ether', assetClass: 'NATIVE', address: null, decimals: 18 },
  { symbol: 'USDC', name: 'USD Coin', assetClass: 'STABLECOIN', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  { symbol: 'WETH', name: 'Wrapped Ether', assetClass: 'WRAPPED_NATIVE', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
]);
/** Arbitrum One: the pinned assets FloFi already uses (Circle USDC, canonical WETH). */
export const ARBITRUM_BASE_ASSETS = staticCatalog('eip155:42161', 'Arbitrum One', 'flofi.pinned', 'https://developers.circle.com/stablecoins/usdc-contract-addresses', [
  { symbol: 'ETH', name: 'Ether', assetClass: 'NATIVE', address: null, decimals: 18 },
  { symbol: 'USDC', name: 'USD Coin', assetClass: 'STABLECOIN', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },
  { symbol: 'WETH', name: 'Wrapped Ether', assetClass: 'WRAPPED_NATIVE', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18 },
]);
