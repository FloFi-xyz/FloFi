// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: the generic visual identity of networks and assets, one resolver for every surface (Canvas cards, pickers, asset search,
 * Simulate/Review, the timeline). Presentation only: identity for amounts and execution is always chain + address + decimals.
 *
 * - A network shows its local, reviewed mark from the network registry, else a monogram.
 * - An asset of a catalog network is resolved to its canonical asset (chain + address, or its symbol in that network's catalog only) and
 *   shows, in order: FloFi's reviewed local mark for a code-pinned asset; its provider's `logoUrl` when the provider's logo rule accepts it
 *   for that exact asset (`trustedAssetLogo`: Robinhood Stock Tokens, Base list tokens), rendered as an image only, with the monogram as
 *   its fallback if it fails to load; otherwise a deterministic monogram generated locally from the canonical identity. A logo is never
 *   looked up by symbol across networks, so two assets with the same symbol on different chains never share an image.
 * - On a network without an official catalog (or with no network context) the existing reviewed local symbol marks are unchanged.
 * Presentation only: nothing here enters the workflow IR, a hash, a Manifest, a Review or execution.
 */
import { ARBITRUM_BASE_ASSETS, BASE_BASE_ASSETS, ROBINHOOD_BASE_ASSETS, trustedAssetLogo, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import { resolveNetworkAsset } from './asset-catalogs';
import { networkIdentity, type NetworkIdentity } from './network-registry';

export type MonogramMark = { readonly kind: 'monogram'; readonly text: string; readonly hue: number };
/** `image`: a reviewed local mark. `logo`: a provider logo its rule accepted for this exact asset, with the monogram shown if it fails to load. */
export type VisualMark = { readonly kind: 'image'; readonly src: string } | { readonly kind: 'logo'; readonly src: string; readonly fallback: MonogramMark } | MonogramMark;
/** Local brand marks FloFi ships with recorded sources (`public/brand/crypto/sources.md`). */
const LOCAL_TOKEN_MARKS: Readonly<Record<string, string>> = Object.freeze({
  USDC: '/brand/crypto/usdc.png', devUSDC: '/brand/crypto/usdc.png', ETH: '/brand/crypto/ethereum.svg', WETH: '/brand/crypto/ethereum.svg',
  SOL: '/brand/crypto/solana.svg', WSOL: '/brand/crypto/solana.svg', USDT: '/brand/crypto/usdt.svg',
});
/** Code-pinned assets of every network with a pinned catalog: their local mark, keyed by `chain|address` (native assets by `chain|native`). */
const PINNED_MARKS: ReadonlyMap<string, string> = new Map((([BASE_BASE_ASSETS, ARBITRUM_BASE_ASSETS, ROBINHOOD_BASE_ASSETS] as readonly AssetCatalog[])
  .flatMap(catalog => catalog.assets.flatMap(asset => LOCAL_TOKEN_MARKS[asset.symbol] ? [[`${catalog.chain}|${asset.address ?? 'native'}`, LOCAL_TOKEN_MARKS[asset.symbol]!] as const] : []))));

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

export function networkMark(value: string | null | undefined): VisualMark {
  const network = networkIdentity(value);
  if (network?.mark) return Object.freeze({ kind: 'image', src: network.mark });
  return monogram(network?.name ?? value ?? '?', `network|${network?.chain ?? value ?? ''}`);
}
export type AssetIdentityInput = { readonly symbol: string;
  /** CAIP-2 chain or a network display name; unknown or absent means "no network context". */ readonly network?: string | null | undefined;
  /** The canonical address when the caller has it; otherwise the network's current catalog resolves the symbol. */ readonly address?: string | null | undefined };
export type AssetIdentity = { readonly symbol: string; readonly mark: VisualMark; readonly network: NetworkIdentity | null };
export function assetIdentity(input: AssetIdentityInput): AssetIdentity {
  const network = networkIdentity(input.network ?? null), symbol = input.symbol;
  if (network) {
    const asset = resolveNetworkAsset(network.chain, input.address ? { address: input.address.toLowerCase() } : { symbol });
    const key = asset ? `${network.chain}|${asset.address ?? 'native'}` : null, pinned = key ? PINNED_MARKS.get(key) : undefined;
    if (pinned) return { symbol, network, mark: Object.freeze({ kind: 'image', src: pinned }) };
    // A catalog network shows no local mark but its pinned assets; a resolved asset may show its provider's trusted logo, and every other
    // asset (or an unresolved one) is a generated monogram.
    if (network.catalog || asset) {
      const fallback = monogram(asset?.symbol ?? symbol, `${network.chain}|${asset?.address ?? symbol.toUpperCase()}`), logo = asset ? trustedAssetLogo(asset) : null;
      return { symbol, network, mark: logo ? Object.freeze({ kind: 'logo', src: logo, fallback }) : fallback };
    }
  }
  const local = LOCAL_TOKEN_MARKS[symbol];
  return { symbol, network, mark: local ? Object.freeze({ kind: 'image', src: local }) : monogram(symbol, `${network?.chain ?? ''}|${symbol.toUpperCase()}`) };
}
