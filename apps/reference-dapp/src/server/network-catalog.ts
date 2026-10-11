// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: the server-side loader of an official asset catalog, shared by every catalog network — the Robinhood Stock Token
 * registry (BUILD-RH-002) and the Base token list (BUILD-BASE-001). It reads one pinned HTTPS URL without following redirects,
 * size-capped and time-bounded, and turns the exact bytes into a validated catalog with the network's own provider. Each call returns a
 * catalog no older than `ttlMs`; concurrent callers share one read. Any failure — HTTP, size, redirect, malformed payload, duplicate or
 * ambiguous asset — fails closed with the network's code and is never replaced by an older or recorded catalog.
 */
import type { AssetCatalog } from '@defi-workflow-engine/action-registry';

export type RegistryFetch = (url: string, init: RequestInit) => Promise<Response>;
export type OfficialCatalogSource = {
  /** The catalog network (CAIP-2); any other chain is refused. */ readonly chain: string;
  /** The pinned official endpoint (or the loopback MOCKED harness). */ readonly url: string;
  readonly maximumBytes: number; readonly userAgent: string;
  /** The closed code of any read failure (for example STOCK_REGISTRY_UNAVAILABLE). */ readonly unavailableCode: string;
  /** The network's provider: exact bytes and the read time → validated catalog (it throws on anything malformed). */
  readonly parse: (text: string, fetchedAt: string) => AssetCatalog;
};
export function createOfficialCatalogLoader(source: OfficialCatalogSource, options: { readonly fetcher?: RegistryFetch; readonly now?: () => Date;
  readonly ttlMs?: number } = {}): (chain: string) => Promise<AssetCatalog> {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init)), now = options.now ?? (() => new Date()), ttlMs = options.ttlMs ?? 30_000;
  let cached: { catalog: AssetCatalog; at: number } | null = null, inflight: Promise<AssetCatalog> | null = null;
  async function read(): Promise<AssetCatalog> {
    let response: Response;
    try { response = await fetcher(source.url, { method: 'GET', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', 'user-agent': source.userAgent } }); }
    catch { throw new Error(source.unavailableCode); }
    if (response.status !== 200) throw new Error(source.unavailableCode);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > source.maximumBytes) throw new Error(source.unavailableCode);
    const text = await response.text();
    if (text.length > source.maximumBytes) throw new Error(source.unavailableCode);
    const catalog = source.parse(text, now().toISOString());
    if (catalog.chain !== source.chain) throw new Error('CATALOG_NETWORK_MISMATCH');
    return catalog;
  }
  return async chain => {
    if (chain !== source.chain) throw new Error('CATALOG_NETWORK_UNSUPPORTED');
    if (cached && now().getTime() - cached.at < ttlMs) return cached.catalog;
    inflight ??= read().then(catalog => { cached = { catalog, at: now().getTime() }; return catalog; }).finally(() => { inflight = null; });
    return inflight;
  };
}
