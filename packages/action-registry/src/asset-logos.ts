// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-BASE-001: when `CanonicalAsset.logoUrl` may be shown. A logo is presentation metadata only: it never enters the workflow IR, a
 * hash, a Manifest, a Review or an execution path, and identity stays chain + address + decimals.
 *
 * Each asset provider declares one rule for its own network. A provider value is kept only when it passes that rule; anything else is
 * dropped to null at parse time (never followed, never a reason to fail the catalog), and `trustedAssetLogo` re-checks the rule wherever a
 * logo is rendered, so a hand-built or altered asset object cannot introduce another URL. Rules:
 *  - ADDRESS_DERIVED: the URL is the issuer's own CDN path for this exact address (Robinhood Stock Tokens).
 *  - PREFIXED: the provider's value under one of a few reviewed HTTPS image prefixes, in a strict URL grammar: no credentials, port or
 *    fragment, no dot segments or encoded tricks (the URL must already be in its normalized form), and at most a numeric cache-buster query.
 * A logo is never looked up by symbol, and a URL accepted for one asset says nothing about another asset or chain.
 */
import type { CanonicalAsset } from './asset-registry.js';

export type AssetLogoRule = { readonly provider: string; readonly chain: string } & (
  { readonly kind: 'ADDRESS_DERIVED'; readonly prefix: string; readonly suffix: string } |
  { readonly kind: 'PREFIXED'; readonly prefixes: readonly string[]; readonly cacheBusterQuery: boolean });

const MAXIMUM_LOGO_URL = 512;
const PATH = /^[A-Za-z0-9._~%()/-]+$/;
/** The value when `rule` accepts it for the asset at `address` (lowercase, null for a native asset); otherwise null. */
export function acceptAssetLogo(value: unknown, rule: AssetLogoRule, address: string | null): string | null {
  if (typeof value !== 'string' || value.length > MAXIMUM_LOGO_URL) return null;
  if (rule.kind === 'ADDRESS_DERIVED') return address !== null && value === `${rule.prefix}${address}${rule.suffix}` ? value : null;
  const prefix = rule.prefixes.find(candidate => value.startsWith(candidate));
  if (!prefix) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.href !== value || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
  if (url.search && !(rule.cacheBusterQuery && /^\?[0-9]{1,13}$/.test(url.search))) return null;
  const path = value.slice(prefix.length, value.length - url.search.length);
  if (!PATH.test(path) || path.includes('//') || path.split('/').some(segment => segment === '.' || segment === '..') || /%2e|%2f|%5c/i.test(path)) return null;
  return value;
}
/** The asset's logo when its own provider's rule (for the asset's chain) accepts it; null for every other asset or rule. */
export function trustedLogoUnder(rules: readonly AssetLogoRule[], asset: Pick<CanonicalAsset, 'chain' | 'address' | 'logoUrl' | 'source'>): string | null {
  const rule = rules.find(candidate => candidate.provider === asset.source.provider && candidate.chain === asset.chain);
  return rule ? acceptAssetLogo(asset.logoUrl, rule, asset.address) : null;
}
