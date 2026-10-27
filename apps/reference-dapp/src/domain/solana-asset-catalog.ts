// SPDX-License-Identifier: AGPL-3.0-only
import { isSolanaPublicKey } from '@defi-workflow-engine/workflow-contracts';
import { SOLANA_MAINNET_TOKENS, contentSha256 } from '@defi-workflow-engine/action-registry';

export const JUPITER_VERIFIED_TOKENS = 'https://api.jup.ag/tokens/v2/tag?query=verified';
export type SolanaCatalogAsset = { readonly symbol: string; readonly name: string; readonly mint: string; readonly decimals: number;
  readonly native: boolean; readonly logoUrl: string | null };
export type SolanaAssetCatalog = { readonly assets: readonly SolanaCatalogAsset[]; readonly fetchedAt: string; readonly source: string; readonly contentSha256: string; readonly excludedRecords: number };
function fail(): never { throw new Error('SOLANA_TOKEN_CATALOG_INVALID'); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function parseJupiterVerifiedCatalog(text: string, fetchedAt: string): SolanaAssetCatalog {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw) || !raw.length || raw.length > 20000) fail();
  const seen = new Set<string>();
  let excludedRecords = 0;
  const assets: SolanaCatalogAsset[] = [{ symbol: 'SOL', name: 'Solana', mint: SOLANA_MAINNET_TOKENS.SOL.mint, decimals: 9, native: true, logoUrl: null }];
  for (const row of raw as unknown[]) {
    if (!object(row)) fail();
    if (row.isVerified !== true || (object(row.audit) && 'isSus' in row.audit)) continue;
    if (!isSolanaPublicKey(row.id) || !Number.isSafeInteger(row.decimals) || (row.decimals as number) < 0 || (row.decimals as number) > 18 ||
      !['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(String(row.tokenProgram))) fail();
    // Some verified records have no display metadata yet. Exclude unrepresentable metadata, with an explicit count; never invent it.
    if (typeof row.symbol !== 'string' || !/^[A-Za-z0-9$][A-Za-z0-9.$!*_+-]{0,31}$/.test(row.symbol) ||
      typeof row.name !== 'string' || !row.name.trim() || row.name.length > 160 || [...row.name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
      excludedRecords++; continue;
    }
    const mint = row.id as string;
    if (seen.has(mint)) fail();
    seen.add(mint);
    const known = Object.values(SOLANA_MAINNET_TOKENS).find(t => t.mint === mint);
    if (known && known.decimals !== row.decimals) fail();
    // Metadata images are display-only, never fetched by the server, and only from Jupiter's image proxy.
    let logoUrl: string | null = null;
    try { const url = new URL(String(row.icon)); if (url.protocol === 'https:' && url.hostname === 'img.jup.ag' && !url.username && !url.password && !url.port) logoUrl = url.href; } catch { /* deterministic local mark */ }
    assets.push({ mint, symbol: row.symbol as string, name: row.name as string, decimals: row.decimals as number, native: false, logoUrl });
  }
  if (assets.length < 2) fail();
  return { assets, fetchedAt, source: JUPITER_VERIFIED_TOKENS, contentSha256: contentSha256(text), excludedRecords };
}
export function searchSolanaCatalog(assets: readonly SolanaCatalogAsset[], query: string): readonly SolanaCatalogAsset[] {
  const q = query.trim().toLowerCase();
  return q ? assets.filter(t => [t.symbol, t.name, t.mint].some(value => value.toLowerCase().includes(q))) : assets;
}

// Validated metadata lookup. Canonical authoring carries mint@decimals; simulation re-reads mint identity on chain.
let displayCatalogLoaded = false;
export const solanaDisplayCatalogLoaded = () => displayCatalogLoaded;
const displayAssets = new Map<string, SolanaCatalogAsset>();
export function registerSolanaDisplayCatalog(catalog: SolanaAssetCatalog): void { displayCatalogLoaded = true; displayAssets.clear(); for (const asset of catalog.assets) if (!asset.native) displayAssets.set(asset.mint, asset); }
export const solanaDisplayAsset = (mint: string): SolanaCatalogAsset | undefined => displayAssets.get(mint);

/** Exact validated catalog identity; duplicate symbols or names require an explicit mint. */
export function resolveSolanaCatalogAsset(reference: string): SolanaCatalogAsset | null {
  const text = reference.trim().toLowerCase();
  const matches = [...displayAssets.values()].filter(a => a.mint === reference || a.symbol.toLowerCase() === text || a.name.toLowerCase() === text);
  if (matches.length > 1) throw new Error('UNIVERSAL_ASSET_AMBIGUOUS');
  return matches[0] ?? null;
}
export function clearSolanaDisplayCatalog(): void { displayCatalogLoaded = false; displayAssets.clear(); }
