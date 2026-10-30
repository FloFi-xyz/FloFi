// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001: how FloFi reads a token a person wrote, on one network, as a structured result every surface (the Copilot
 * engine, its read-only tools, MCP planning) shares. It wraps the existing resolvers — the validated official catalog of a catalog network
 * (`resolveAssetReference`) and the universal router's per-network references (`resolveUniversalAsset`) — and adds what they do not decide:
 *
 *  - a currency is not a token: "USD", "dollars", "dólar" (and EUR, BRL) are a FIAT reference with the network's own stablecoins of that
 *    currency as candidates, read from the same registries. FloFi asks; it never turns USD into USDC on its own;
 *  - native ETH and WETH stay two assets (`native` says which);
 *  - EVM symbols are matched case-insensitively within one catalog (`usdc`, `UsDc`, `cbbtc` resolve to the catalog's own spelling); a Solana
 *    mint or an EVM address is never lower-cased by this module (the underlying resolvers keep their own canonical forms).
 *
 * Pure and read-only: a FOUND identity is display/authoring evidence only — Simulate re-validates every identity against its official source.
 */
import { SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { UNIVERSAL_NETWORKS, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
import { networkCatalog, resolveAssetReference } from '../asset-catalogs';
import { networkIdentity } from '../network-registry';
import { resolveUniversalAsset } from '../universal-bridge-authoring';

export type ResolvedIdentity = { readonly symbol: string; readonly chain: string; readonly address: string | null; readonly decimals: number; readonly native: boolean };
export type AssetLookup =
  | { readonly kind: 'FOUND'; readonly identity: ResolvedIdentity; readonly by: 'SYMBOL' | 'NAME' | 'ADDRESS' }
  | { readonly kind: 'AMBIGUOUS'; readonly candidates: readonly string[] }
  | { readonly kind: 'FIAT'; readonly currency: FiatCurrency; readonly candidates: readonly string[] }
  | { readonly kind: 'UNKNOWN' } | { readonly kind: 'CATALOG_UNAVAILABLE' } | { readonly kind: 'NETWORK_UNKNOWN' } | { readonly kind: 'INVALID_REFERENCE' };

export const FIAT_CURRENCIES = ['USD', 'EUR', 'BRL'] as const;
export type FiatCurrency = (typeof FIAT_CURRENCIES)[number];
// Whole references only: "usd", "US$", "$", "dollars", "dólar(es)", "euro(s)", "reais", "R$". A token symbol such as USDC never matches.
const FIAT: readonly [FiatCurrency, RegExp][] = [
  ['USD', /^(?:usd|us\$|\$|us\s+dollars?|dollars?|d[oó]lar(?:es)?(?:\s+americanos?)?)$/iu],
  ['EUR', /^(?:eur|€|euros?)$/iu],
  ['BRL', /^(?:brl|r\$|reais|real(?:\s+brasileiro)?)$/iu],
];
/** The fiat currency a whole token reference names, or null. */
export function fiatReference(reference: string | null | undefined): FiatCurrency | null {
  const text = typeof reference === 'string' ? reference.trim() : '';
  return FIAT.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}
/** Stablecoin symbols of a currency, by the catalog's own symbols (USD → USDC, USDT, USDbC, …); never a list FloFi maintains. */
const ofCurrency = (currency: FiatCurrency) => (symbol: string) => symbol.toUpperCase().startsWith(currency) && symbol.length > currency.length;
/**
 * The stablecoins of `currency` a network's registries know: the validated catalog's ERC-20s (pinned and featured ones first), Solana's
 * registered SPL tokens, at most four. Empty when the network has none — the caller then says so instead of guessing.
 */
export function fiatCandidates(network: string, currency: FiatCurrency): readonly string[] {
  const identity = networkIdentity(network);
  if (!identity) return [];
  if (identity.chain.startsWith('solana:'))
    return identity.environment === 'MAINNET' ? Object.values(SOLANA_MAINNET_TOKENS).map(token => token.symbol).filter(ofCurrency(currency)).slice(0, 4) : [];
  const catalog = networkCatalog(identity.chain);
  if (!catalog) return [];
  const featured = new Set(catalog.featured);
  const symbols = [...catalog.assets].filter(asset => asset.kind === 'ERC20' && ofCurrency(currency)(asset.symbol))
    .sort((a, b) => Number(featured.has(b.id)) - Number(featured.has(a.id)) || a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol))
    .map(asset => asset.symbol);
  return [...new Set(symbols)].slice(0, 4);
}

const universalKey = (chain: string): UniversalNetworkKey | null =>
  (Object.values(UNIVERSAL_NETWORKS).find(network => network.chain === chain)?.key ?? null) as UniversalNetworkKey | null;
/**
 * One written reference on one network (registry key, CAIP-2 chain or name). Catalog networks resolve through the official catalog; Solana and
 * the other universal networks through the universal router's references. Errors become kinds; nothing throws.
 */
export function lookupAsset(network: string, reference: string): AssetLookup {
  const identity = networkIdentity(network), text = typeof reference === 'string' ? reference.trim() : '';
  if (!identity) return { kind: 'NETWORK_UNKNOWN' };
  if (!text || text.length > 160) return { kind: 'INVALID_REFERENCE' };
  const currency = fiatReference(text);
  if (currency) return { kind: 'FIAT', currency, candidates: fiatCandidates(identity.key, currency) };
  if (identity.catalog) {
    const found = resolveAssetReference(identity.chain, text);
    switch (found.kind) {
      case 'FOUND': return { kind: 'FOUND', by: found.by, identity: { symbol: found.asset.symbol, chain: identity.chain, address: found.asset.address,
        decimals: found.asset.decimals, native: found.asset.address === null } };
      case 'AMBIGUOUS': return { kind: 'AMBIGUOUS', candidates: [...new Set(found.assets.map(asset => asset.symbol))].slice(0, 4) };
      case 'UNAVAILABLE': return { kind: 'CATALOG_UNAVAILABLE' };
      case 'UNKNOWN': return { kind: 'UNKNOWN' };
      default: return { kind: 'INVALID_REFERENCE' };
    }
  }
  const key = universalKey(identity.chain);
  if (!key) return { kind: 'UNKNOWN' };
  try {
    const resolved = resolveUniversalAsset(key, text);
    return { kind: 'FOUND', by: /^[^@\s]+@\d{1,2}$/.test(text) ? 'ADDRESS' : 'SYMBOL', identity: { symbol: resolved.symbol, chain: identity.chain,
      address: resolved.asset.kind === 'NATIVE' ? null : resolved.asset.address, decimals: resolved.asset.decimals, native: resolved.asset.kind === 'NATIVE' } };
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : '';
    return /ADDRESS_INVALID|DECIMALS_MISMATCH/.test(code) ? { kind: 'INVALID_REFERENCE' } : { kind: 'UNKNOWN' };
  }
}
