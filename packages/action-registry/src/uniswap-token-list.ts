// SPDX-License-Identifier: Apache-2.0
/**
 * The Uniswap Labs curated source already contains multiple chains. One parser projects only a profile's chain, merges its existing
 * pins and applies its reviewed logo/exclusion policy. Source bytes are runtime input, never redistributed (GPL-3.0).
 * Listing is an inclusion policy, never financial authority. Runtime must re-read code and decimals before Simulate.
 */
import { ASSET_SYMBOL, contentSha256, createAssetCatalog, erc20AssetId, isChecksumAddress, mergeAssetCatalogs,
  type AssetCatalog, type AssetProvider, type CanonicalAsset } from './asset-registry.js';
import { acceptAssetLogo, type AssetLogoRule } from './asset-logos.js';

export const UNISWAP_TOKEN_LIST = Object.freeze({
  url: 'https://tokens.uniswap.org', docs: 'https://github.com/Uniswap/default-token-list', name: 'Uniswap Labs Default',
  provider: 'uniswap.default-token-list', host: 'tokens.uniswap.org', maximumBytes: 4_000_000, maximumTokens: 20_000,
});
export type TokenListNetwork = {
  readonly pinned: AssetCatalog; readonly featured: readonly string[]; readonly logos: AssetLogoRule;
  /** Keeps existing provider error codes stable across the shared refactor. */ readonly errorPrefix: string;
  /** Reviewed chain-bound exclusions, such as a known on-chain decimals mismatch. Never repaired by symbol. */
  readonly excludedAddresses?: readonly string[];
  /** Provider-specific grammar; existing providers keep ASSET_SYMBOL for compatibility. */
  readonly symbolPattern?: RegExp;
  /** Reviewed ambiguous symbols: exclude every matching identity, never choose a winner or rename a token. */
  readonly excludedAmbiguousSymbols?: readonly string[];
};
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasControlCharacter = (text: string) => Array.from(text).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const versionPart = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

/** One chain-bound provider; malformed/duplicate target-chain records fail the entire projection closed. No stale fallback. */
export function uniswapTokenListProvider(profile: TokenListNetwork): AssetProvider<string> {
  const source = UNISWAP_TOKEN_LIST, pinned = profile.pinned;
  const fail = (suffix: string): never => { throw new Error(`${profile.errorPrefix}_${suffix}`); };
  return Object.freeze({ id: source.provider, chain: pinned.chain, source: source.url, parse(text: string, fetchedAt: string): AssetCatalog {
    if (typeof text !== 'string' || text.length < 2 || text.length > source.maximumBytes) fail('UNAVAILABLE');
    if (!Number.isFinite(Date.parse(fetchedAt))) fail('FETCH_TIME_INVALID');
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return fail('MALFORMED'); }
    if (!isRecord(payload) || payload.name !== source.name || typeof payload.timestamp !== 'string' || !Number.isFinite(Date.parse(payload.timestamp)) ||
        !isRecord(payload.version) || !versionPart(payload.version.major) || !versionPart(payload.version.minor) || !versionPart(payload.version.patch) ||
        !Array.isArray(payload.tokens) || payload.tokens.length < 1 || payload.tokens.length > source.maximumTokens) return fail('MALFORMED');
    const records: { address: string; symbol: string; name: string; decimals: number; included: boolean; logoUrl: string | null }[] = [];
    for (const raw of payload.tokens as unknown[]) {
      if (!isRecord(raw) || !Number.isSafeInteger(raw.chainId)) return fail('MALFORMED');
      if (raw.chainId !== pinned.chainId) continue;
      const { address, symbol, name, decimals } = raw;
      if (typeof address !== 'string' || !isChecksumAddress(address)) return fail('ADDRESS_INVALID');
      if (typeof decimals !== 'number' || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) return fail('DECIMALS_INVALID');
      if (typeof name !== 'string' || name.trim().length < 1 || name.length > 160 || hasControlCharacter(name)) return fail('NAME_INVALID');
      if (typeof symbol !== 'string' || symbol.length < 1 || symbol.length > 32 || hasControlCharacter(symbol)) return fail('SYMBOL_INVALID');
      const lower = address.toLowerCase();
      records.push({ address: lower, symbol, name: name.trim(), decimals,
        included: (profile.symbolPattern ?? ASSET_SYMBOL).test(symbol) && !profile.excludedAddresses?.includes(lower) &&
          !profile.excludedAmbiguousSymbols?.includes(symbol.toUpperCase()), logoUrl: acceptAssetLogo(raw.logoURI, profile.logos, lower) });
    }
    // Excluded twins still make an identity ambiguous. Check all records before filtering.
    for (const key of ['address', 'symbol'] as const) {
      const values = records.filter(record => key !== 'symbol' || !profile.excludedAmbiguousSymbols?.includes(record.symbol.toUpperCase()))
        .map(record => key === 'symbol' ? record.symbol.toUpperCase() : record.address);
      if (new Set(values).size !== values.length) fail('DUPLICATE_ASSET');
    }
    for (const record of records) {
      const sameAddress = pinned.assets.find(asset => asset.address === record.address);
      const sameSymbol = pinned.assets.find(asset => asset.symbol.toUpperCase() === record.symbol.toUpperCase());
      if ((sameAddress && (sameAddress.symbol !== record.symbol || sameAddress.decimals !== record.decimals)) || (sameSymbol && sameSymbol.address !== record.address))
        fail('PINNED_ASSET_MISMATCH');
    }
    const listed = records.filter(record => record.included && !pinned.assets.some(asset => asset.address === record.address));
    if (!listed.length) fail('EMPTY');
    const assets: CanonicalAsset[] = listed.map(record => ({ id: erc20AssetId(pinned.chain, record.address), chain: pinned.chain, chainId: pinned.chainId,
      network: pinned.network, kind: 'ERC20', assetClass: 'TOKEN', symbol: record.symbol, name: record.name, address: record.address,
      decimals: record.decimals, logoUrl: record.logoUrl, source: { provider: source.provider, url: source.url, officialId: null }, stock: null }));
    const list = createAssetCatalog({ chain: pinned.chain, network: pinned.network, assets, provenance: [{ provider: source.provider, source: source.url,
      fetchedAt: new Date(Date.parse(fetchedAt)).toISOString(), contentSha256: contentSha256(text), officialRecords: records.length,
      activeRecords: records.filter(record => record.included).length }] });
    return mergeAssetCatalogs([pinned, list], profile.featured);
  } });
}
/** Membership shape check; registration still revalidates chain binding, decimals and uniqueness with createAssetCatalog. */
export function isTokenListNetworkCatalog(catalog: AssetCatalog, profile: TokenListNetwork): boolean {
  return catalog.format === 'flofi.asset-catalog.v1' && catalog.chain === profile.pinned.chain && catalog.chainId === profile.pinned.chainId && catalog.network === profile.pinned.network &&
    profile.pinned.assets.every(pinned => catalog.assets.some(asset => asset.id === pinned.id && asset.decimals === pinned.decimals && asset.symbol === pinned.symbol)) &&
    catalog.assets.every(asset => asset.assetClass !== 'STOCK_TOKEN' && asset.stock === null && !profile.excludedAddresses?.includes(asset.address ?? '') &&
      !profile.excludedAmbiguousSymbols?.includes(asset.symbol.toUpperCase()) &&
      (profile.pinned.assets.some(pinned => pinned.id === asset.id) || (asset.source.provider === UNISWAP_TOKEN_LIST.provider && asset.source.url === UNISWAP_TOKEN_LIST.url)));
}
