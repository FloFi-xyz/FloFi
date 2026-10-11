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
import { ASSET_SYMBOL, BASE_BASE_ASSETS, contentSha256, createAssetCatalog, erc20AssetId, isChecksumAddress, mergeAssetCatalogs,
  type AssetCatalog, type AssetProvider, type CanonicalAsset } from './asset-registry.js';
import { BASE_MAINNET } from './base-chain.js';
import { acceptAssetLogo, type AssetLogoRule } from './asset-logos.js';

export const BASE_TOKEN_LIST = Object.freeze({
  url: 'https://tokens.uniswap.org', docs: 'https://github.com/Uniswap/default-token-list', name: 'Uniswap Labs Default',
  provider: 'uniswap.default-token-list', host: 'tokens.uniswap.org', maximumBytes: 4_000_000, maximumTokens: 20_000,
});
/**
 * The image prefixes a Base list `logoURI` may use (CoinGecko's image CDNs, the Superchain token list data, Trust Wallet's asset repository,
 * CoinMarketCap's coin images and Basescan's token images). CoinGecko appends a numeric cache-buster query. Presentation only.
 */
export const BASE_TOKEN_LIST_LOGOS: AssetLogoRule = Object.freeze({ kind: 'PREFIXED', provider: BASE_TOKEN_LIST.provider, chain: BASE_MAINNET.chain,
  prefixes: Object.freeze(['https://coin-images.coingecko.com/coins/images/', 'https://assets.coingecko.com/coins/images/',
    'https://ethereum-optimism.github.io/data/', 'https://raw.githubusercontent.com/trustwallet/assets/', 'https://s2.coinmarketcap.com/static/img/coins/',
    'https://basescan.org/token/images/']), cacheBusterQuery: true });
/** Shortcuts on the Base pickers. They never limit the catalog; search exposes every validated asset. */
export const BASE_FEATURED_ASSETS = Object.freeze(['USDC', 'WETH'] as const);

function fail(code: string): never { throw new Error(code); }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasControlCharacter = (text: string) => Array.from(text).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const VERSION_PART = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

type BaseRecord = { address: string; symbol: string; name: string; decimals: number; included: boolean; logoUrl: string | null };
function parseRecord(raw: Record<string, unknown>): BaseRecord {
  const { address, symbol, name, decimals } = raw;
  if (typeof address !== 'string' || !isChecksumAddress(address)) fail('BASE_TOKEN_LIST_ADDRESS_INVALID');
  if (!Number.isSafeInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 36) fail('BASE_TOKEN_LIST_DECIMALS_INVALID');
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 160 || hasControlCharacter(name)) fail('BASE_TOKEN_LIST_NAME_INVALID');
  if (typeof symbol !== 'string' || symbol.length < 1 || symbol.length > 32 || hasControlCharacter(symbol)) fail('BASE_TOKEN_LIST_SYMBOL_INVALID');
  const lower = (address as string).toLowerCase();
  return { address: lower, symbol: symbol as string, name: (name as string).trim(), decimals: decimals as number,
    included: ASSET_SYMBOL.test(symbol as string), logoUrl: acceptAssetLogo(raw.logoURI, BASE_TOKEN_LIST_LOGOS, lower) };
}

/**
 * Parses the official list bytes into the Base catalog (pinned assets + validated list entries). Anything malformed, duplicated or
 * ambiguous fails the whole catalog closed; nothing older or recorded is substituted.
 */
export function parseBaseTokenList(text: string, fetchedAt: string): AssetCatalog {
  if (typeof text !== 'string' || text.length < 2 || text.length > BASE_TOKEN_LIST.maximumBytes) fail('BASE_TOKEN_LIST_UNAVAILABLE');
  if (!Number.isFinite(Date.parse(fetchedAt))) fail('BASE_TOKEN_LIST_FETCH_TIME_INVALID');
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return fail('BASE_TOKEN_LIST_MALFORMED'); }
  if (!isRecord(payload) || payload.name !== BASE_TOKEN_LIST.name || typeof payload.timestamp !== 'string' || !Number.isFinite(Date.parse(payload.timestamp)) ||
      !isRecord(payload.version) || !VERSION_PART(payload.version.major) || !VERSION_PART(payload.version.minor) || !VERSION_PART(payload.version.patch) ||
      !Array.isArray(payload.tokens) || payload.tokens.length < 1 || payload.tokens.length > BASE_TOKEN_LIST.maximumTokens) fail('BASE_TOKEN_LIST_MALFORMED');
  const records: BaseRecord[] = [];
  for (const raw of payload.tokens as unknown[]) {
    if (!isRecord(raw) || !Number.isSafeInteger(raw.chainId)) fail('BASE_TOKEN_LIST_MALFORMED');
    if (raw.chainId === BASE_MAINNET.chainId) records.push(parseRecord(raw));
  }
  // Uniqueness over every Base record, included or not: an excluded twin would still make an address or symbol ambiguous.
  for (const key of ['address', 'symbol'] as const) {
    const values = records.map(record => key === 'symbol' ? record.symbol.toUpperCase() : record.address);
    if (new Set(values).size !== values.length) fail('BASE_TOKEN_LIST_DUPLICATE_ASSET');
  }
  // A pinned asset must be listed with exactly its pinned identity; its symbol may never name another contract.
  const pinned = BASE_BASE_ASSETS.assets;
  for (const record of records) {
    const sameAddress = pinned.find(asset => asset.address === record.address);
    const sameSymbol = pinned.find(asset => asset.symbol.toUpperCase() === record.symbol.toUpperCase());
    if ((sameAddress && (sameAddress.symbol !== record.symbol || sameAddress.decimals !== record.decimals)) || (sameSymbol && sameSymbol.address !== record.address))
      fail('BASE_TOKEN_LIST_PINNED_ASSET_MISMATCH');
  }
  const listed = records.filter(record => record.included && !pinned.some(asset => asset.address === record.address));
  if (!listed.length) fail('BASE_TOKEN_LIST_EMPTY');
  const chain = BASE_MAINNET.chain;
  const assets: CanonicalAsset[] = listed.map(record => ({ id: erc20AssetId(chain, record.address), chain, chainId: BASE_MAINNET.chainId, network: BASE_MAINNET.name,
    kind: 'ERC20', assetClass: 'TOKEN', symbol: record.symbol, name: record.name, address: record.address, decimals: record.decimals, logoUrl: record.logoUrl,
    source: { provider: BASE_TOKEN_LIST.provider, url: BASE_TOKEN_LIST.url, officialId: null }, stock: null }));
  const list = createAssetCatalog({ chain, network: BASE_MAINNET.name, assets, provenance: [{ provider: BASE_TOKEN_LIST.provider, source: BASE_TOKEN_LIST.url,
    fetchedAt: new Date(Date.parse(fetchedAt)).toISOString(), contentSha256: contentSha256(text), officialRecords: records.length,
    activeRecords: records.filter(record => record.included).length }] });
  return mergeAssetCatalogs([BASE_BASE_ASSETS, list], BASE_FEATURED_ASSETS);
}
export const baseTokenListProvider: AssetProvider<string> = Object.freeze({
  id: BASE_TOKEN_LIST.provider, chain: BASE_MAINNET.chain, source: BASE_TOKEN_LIST.url, parse: parseBaseTokenList,
});
/** True for the Base catalog FloFi builds: the pinned assets plus a validated list projection (and nothing of another network). */
export function isBaseNetworkCatalog(catalog: AssetCatalog): boolean {
  return catalog.format === 'flofi.asset-catalog.v1' && catalog.chain === BASE_MAINNET.chain &&
    BASE_BASE_ASSETS.assets.every(pinned => catalog.assets.some(asset => asset.id === pinned.id && asset.decimals === pinned.decimals && asset.symbol === pinned.symbol)) &&
    catalog.assets.every(asset => asset.assetClass !== 'STOCK_TOKEN' && asset.stock === null);
}
