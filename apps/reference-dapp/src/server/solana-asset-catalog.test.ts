// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { parseJupiterVerifiedCatalog, searchSolanaCatalog, JUPITER_VERIFIED_TOKENS } from '../domain/solana-asset-catalog';
import { createSolanaCatalogLoader } from './solana-asset-catalog';
const row = { id: SOLANA_MAINNET_TOKENS.USDC.mint, symbol: 'USDC', name: 'USD Coin', decimals: 6, isVerified: true, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
const at = '2026-10-26T12:00:00.000Z';
describe('Jupiter verified Solana catalog', () => {
  it('binds metadata to mints, filters unverified/suspicious rows, searches names and never infers routes', () => {
    const catalog = parseJupiterVerifiedCatalog(JSON.stringify([row, { ...row, isVerified: false }, { ...row, audit: { isSus: false } }]), at);
    expect(catalog.assets.map(t => t.symbol)).toEqual(['SOL', 'USDC']);
    expect(searchSolanaCatalog(catalog.assets, 'USD Coin')[0]).toMatchObject({ mint: row.id, decimals: 6 });
    expect(JSON.stringify(catalog)).not.toContain('usdPrice');
    expect(catalog.source).toBe(JUPITER_VERIFIED_TOKENS);
  });
  it('refuses malformed mints, decimals, duplicates and unsafe image sources', () => {
    for (const patch of [{ id: 'invalid' }, { decimals: 7 }, { tokenProgram: 'wrong' }]) expect(() => parseJupiterVerifiedCatalog(JSON.stringify([{ ...row, ...patch }]), at)).toThrow();
    expect(() => parseJupiterVerifiedCatalog(JSON.stringify([row, row]), at)).toThrow();
    expect(parseJupiterVerifiedCatalog(JSON.stringify([{ ...row, icon: 'http://127.0.0.1/secret' }]), at).assets[1]!.logoUrl).toBeNull();
  });
  it('coalesces reads, uses a pinned URL without redirects, and fails closed after expiry', async () => {
    let now = Date.parse(at);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify([row]))).mockRejectedValue(new Error('offline'));
    const load = createSolanaCatalogLoader(fetcher, () => now);
    const [a, b] = await Promise.all([load(), load()]);
    expect(a).toBe(b); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(JUPITER_VERIFIED_TOKENS, expect.objectContaining({ method: 'GET', redirect: 'error' }));
    now += 300001;
    await expect(load()).rejects.toThrow('offline');
  });
  it('rejects oversized responses and HTTP failures', async () => {
    for (const response of [new Response('[]', { status: 429 }), new Response('[]', { headers: { 'content-length': '16000001' } })]) {
      await expect(createSolanaCatalogLoader(vi.fn<typeof fetch>().mockResolvedValue(response))()).rejects.toThrow();
    }
  });
});
