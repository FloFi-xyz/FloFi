// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: the generic visual identity of networks and assets, one resolver for every surface (Canvas cards, pickers, asset search,
 * Simulate/Review, the timeline). Presentation only: identity for amounts and execution is always chain + address + decimals.
 *
 * - A network shows its local, reviewed mark from the network registry, else a monogram.
 * - An asset bound to a network by its address (or, on a catalog network, resolved to its canonical asset by symbol within that network's
 *   catalog only) is keyed by `chain|address` and shows, in order (AAVE-V3-CARD-CATALOG-FIX-001):
 *   1. FloFi's reviewed local mark for a code-pinned asset of any pinned catalog (Ethereum, Base, Arbitrum One, Robinhood Chain);
 *   2. the network catalog asset's provider `logoUrl` when the provider's logo rule accepts it for that exact asset (`trustedAssetLogo`:
 *      Robinhood Stock Tokens, Uniswap list tokens), rendered as an image only, with the monogram as its fallback if it fails to load;
 *   3. for a registered Aave V3 reserve (chain + underlying address in `AAVE_V3_LENDING_PROFILES`), the reviewed local mark of its
 *      registered label. The label table is applied ONLY to registered reserve addresses: another token with the same symbol never gets it;
 *   4. otherwise a deterministic monogram generated locally and seeded by `chain|address`, so it is identical before and after the
 *      network's catalog loads.
 *   A logo is never looked up by symbol across networks, so two assets with the same symbol on different chains never share an image.
 * - On a network without an official catalog (or with no network context) the existing reviewed local symbol marks are unchanged.
 * Every image mark has the same deterministic monogram (`AssetIdentity.fallback`) to show if the file cannot be loaded.
 * Presentation only: nothing here enters the workflow IR, a hash, a Manifest, a Review or execution.
 */
import { AAVE_V3_LENDING_PROFILES, ROBINHOOD_BASE_ASSETS, TOKEN_LIST_NETWORKS, trustedAssetLogo, type AssetCatalog,
  type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { resolveNetworkAsset } from './asset-catalogs';
import { networkIdentity, type NetworkIdentity } from './network-registry';

export type MonogramMark = { readonly kind: 'monogram'; readonly text: string; readonly hue: number };
/** `image`: a reviewed local mark. `logo`: a provider logo its rule accepted for this exact asset, with the monogram shown if it fails to load. */
export type VisualMark = { readonly kind: 'image'; readonly src: string } | { readonly kind: 'logo'; readonly src: string; readonly fallback: MonogramMark } | MonogramMark;

/** The ETH token mark (ETH and WETH): crisp and square at 12-22px. The Ethereum network badge uses its own mark (`network-registry.ts`). */
export const ETH_TOKEN_MARK = '/brand/crypto/tokens/eth.svg';
const USDC_MARK = '/brand/crypto/usdc.png', USDT_MARK = '/brand/crypto/usdt.svg', SOLANA_MARK = '/brand/crypto/solana.svg';
/** Local brand marks FloFi ships with recorded sources (`public/brand/crypto/sources.md`), by the symbol of a code-pinned asset. */
const LOCAL_TOKEN_MARKS: Readonly<Record<string, string>> = Object.freeze({
  USDC: USDC_MARK, devUSDC: USDC_MARK, ETH: ETH_TOKEN_MARK, WETH: ETH_TOKEN_MARK, SOL: SOLANA_MARK, WSOL: SOLANA_MARK, USDT: USDT_MARK,
});
/** Reviewed local marks that are a glyph on a transparent background rather than a full disc: drawn inset so a round clip never cuts them. */
export const GLYPH_MARKS: ReadonlySet<string> = new Set([SOLANA_MARK]);
/**
 * Reviewed CC0 marks (cryptocurrency-icons 0.18.1, `sources.md`) by a registered Aave V3 reserve's label. Only ever applied to a reserve
 * registered at that exact chain + underlying address; reserves without a reviewed mark keep their monogram.
 */
const RESERVE_LABEL_MARKS: Readonly<Record<string, string>> = Object.freeze({
  USDC: USDC_MARK, USDT: USDT_MARK, WETH: ETH_TOKEN_MARK, DAI: '/brand/crypto/tokens/dai.svg', LINK: '/brand/crypto/tokens/link.svg',
  AAVE: '/brand/crypto/tokens/aave.svg', WBTC: '/brand/crypto/tokens/wbtc.svg', UNI: '/brand/crypto/tokens/uni.svg', CRV: '/brand/crypto/tokens/crv.svg',
  MKR: '/brand/crypto/tokens/mkr.svg', SNX: '/brand/crypto/tokens/snx.svg', BAL: '/brand/crypto/tokens/bal.svg', '1INCH': '/brand/crypto/tokens/1inch.svg',
  KNC: '/brand/crypto/tokens/knc.svg',
});
/** Every code-pinned catalog: each curated token-list network's pinned assets (Base, Arbitrum One, Ethereum) and Robinhood Chain's. */
export const PINNED_ASSET_CATALOGS: readonly AssetCatalog[] = Object.freeze([...new Map(
  [...TOKEN_LIST_NETWORKS.map(profile => profile.pinned), ROBINHOOD_BASE_ASSETS].map(catalog => [catalog.chain, catalog] as const)).values()]);
const assetKey = (chain: string, address: string | null) => `${chain}|${address ?? 'native'}`;
/** Code-pinned assets of every pinned catalog: their local mark, keyed by `chain|address` (native assets by `chain|native`). */
const PINNED_MARKS: ReadonlyMap<string, string> = new Map(PINNED_ASSET_CATALOGS.flatMap(catalog => catalog.assets.flatMap(asset => {
  const src = LOCAL_TOKEN_MARKS[asset.symbol];
  return src ? [[assetKey(catalog.chain, asset.address), src] as const] : [];
})));
/** Registered Aave V3 reserves with a reviewed mark, keyed by `chain|underlying` (lowercase). Never consulted by symbol. */
const RESERVE_MARKS: ReadonlyMap<string, string> = new Map(AAVE_V3_LENDING_PROFILES.flatMap(profile => {
  const src = RESERVE_LABEL_MARKS[profile.symbol];
  return src ? [[assetKey(profile.chain, profile.asset.toLowerCase()), src] as const] : [];
}));

/** FNV-1a: a stable 32-bit hash; only used to pick a hue, never for identity. */
function hue(text: string): number {
  let h = 0x811c9dc5;
  for (const character of text) { h ^= character.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h % 360;
}
/** One or two letters of a symbol or name: "cbBTC" → "CB", "TSLA" → "TS", "Base" → "BA"; never empty. */
export function monogramText(label: string): string {
  const letters = [...label].filter(character => /[A-Za-z0-9]/.test(character));
  return (letters.slice(0, 2).join('') || '?').toUpperCase();
}
const monogram = (label: string, seed: string): MonogramMark => Object.freeze({ kind: 'monogram', text: monogramText(label), hue: hue(seed) });
const image = (src: string): VisualMark => Object.freeze({ kind: 'image', src });

/** The monogram of a network: its mark when it has none, and the fallback of its mark if the file cannot be loaded. */
export function networkFallback(value: string | null | undefined): MonogramMark {
  const network = networkIdentity(value);
  return monogram(network?.name ?? value ?? '?', `network|${network?.chain ?? value ?? ''}`);
}
export function networkMark(value: string | null | undefined): VisualMark {
  const network = networkIdentity(value);
  return network?.mark ? image(network.mark) : networkFallback(value);
}
export type AssetIdentityInput = { readonly symbol: string;
  /** CAIP-2 chain or a network display name; unknown or absent means "no network context". */ readonly network?: string | null | undefined;
  /** The exact token address when the caller has it (an Aave reserve's underlying, a catalog asset); otherwise the network's current
   * catalog resolves the symbol. An address without a network has no identity and is ignored. */ readonly address?: string | null | undefined };
export type AssetIdentity = { readonly symbol: string; readonly mark: VisualMark; readonly network: NetworkIdentity | null;
  /** The deterministic monogram of this identity: the mark itself when there is no image, the fallback when an image cannot be loaded. */
  readonly fallback: MonogramMark };
/** An address as identity keys use it: an EVM address in lowercase, any other address (a case-sensitive Solana mint) exactly as given. */
const addressOn = (network: NetworkIdentity, address: string) => network.chain.startsWith('eip155:') ? address.trim().toLowerCase() : address.trim();
/**
 * The mark of an asset bound to one network by its address (`null`: the network's native asset). `label` only names the monogram; it
 * selects an image solely through the legacy local symbol marks of a network without an official catalog.
 */
function boundMark(network: NetworkIdentity, label: string, address: string | null, asset: CanonicalAsset | null): Pick<AssetIdentity, 'mark' | 'fallback'> {
  const key = assetKey(network.chain, address), fallback = monogram(label, key);
  // Reviewed local marks first (code-pinned assets, then registered Aave reserves by chain + address): crisp, shipped with their sources and
  // stable — a reserve's icon never switches to a remote logo when the token list loads. A provider logo is used only where FloFi has none.
  const reviewed = PINNED_MARKS.get(key) ?? (address ? RESERVE_MARKS.get(key) : undefined);
  if (reviewed) return { mark: image(reviewed), fallback };
  const logo = asset ? trustedAssetLogo(asset) : null;
  if (logo) return { mark: Object.freeze({ kind: 'logo', src: logo, fallback }), fallback };
  const local = network.catalog ? undefined : LOCAL_TOKEN_MARKS[label];
  return { mark: local ? image(local) : fallback, fallback };
}
export function assetIdentity(input: AssetIdentityInput): AssetIdentity {
  const network = networkIdentity(input.network ?? null), symbol = input.symbol;
  if (network && input.address) {
    // Exact identity: the monogram text is the caller's label and the seed is chain + address, so it never changes when the catalog loads.
    const address = addressOn(network, input.address);
    return { symbol, network, ...boundMark(network, symbol, address, resolveNetworkAsset(network.chain, { address })) };
  }
  if (network) {
    const asset = resolveNetworkAsset(network.chain, { symbol });
    if (asset) return { symbol, network, ...boundMark(network, asset.symbol, asset.address, asset) };
    // A catalog network shows no local mark for a symbol its catalog does not resolve: a generated monogram.
    if (network.catalog) { const fallback = monogram(symbol, `${network.chain}|${symbol.toUpperCase()}`); return { symbol, network, mark: fallback, fallback }; }
  }
  const local = LOCAL_TOKEN_MARKS[symbol], fallback = monogram(symbol, `${network?.chain ?? ''}|${symbol.toUpperCase()}`);
  return { symbol, network, mark: local ? image(local) : fallback, fallback };
}
