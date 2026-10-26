// SPDX-License-Identifier: AGPL-3.0-only
import { JUPITER_VERIFIED_TOKENS, parseJupiterVerifiedCatalog, type SolanaAssetCatalog } from '../domain/solana-asset-catalog.ts';

/** Fixed official source, no redirects, bounded streamed bytes/time, coalesced reads, no stale fallback. Catalog membership proves no route. */
export function createSolanaCatalogLoader(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  let cached: SolanaAssetCatalog | null = null, inflight: Promise<SolanaAssetCatalog> | null = null, loadedAt = 0;
  async function read(): Promise<SolanaAssetCatalog> {
    const response = await fetcher(JUPITER_VERIFIED_TOKENS, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
    const limit = 16000000;
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > limit || !response.body) throw new Error('SOLANA_TOKEN_CATALOG_UNAVAILABLE');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) throw new Error('SOLANA_TOKEN_CATALOG_TOO_LARGE');
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return parseJupiterVerifiedCatalog(new TextDecoder('utf-8', { fatal: true }).decode(bytes), new Date(now()).toISOString());
  }
  return async () => {
    if (cached && now() - loadedAt < 300000) return cached;
    inflight ??= read().then(value => { cached = value; loadedAt = now(); return value; }).finally(() => { inflight = null; });
    return inflight;
  };
}
export const loadSolanaCatalog = createSolanaCatalogLoader();
