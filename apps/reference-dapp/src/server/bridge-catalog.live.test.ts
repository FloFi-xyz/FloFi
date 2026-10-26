// SPDX-License-Identifier: AGPL-3.0-only
/** Explicit read-only public mainnet metadata check; excluded from the deterministic unit suite. */
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CATALOG_NETWORKS } from './catalog-networks';
import { loadSolanaCatalog } from './solana-asset-catalog';
import { createUniversalDiscovery } from './universal-router/discovery';
import { createUniversalHttp } from './universal-router/http';
import { parseDiscoveryRequest } from './universal-router/requests';
import { resolveNetworkAsset, registerNetworkCatalog } from '../domain/asset-catalogs';
import { createUniversalBridgeFromInput, universalBridgeDetails } from '../domain/universal-bridge-authoring';

describe('five mainnet catalogs (live, no wallet or transaction)', () => {
  it('loads the real validated network-specific lists and binds a non-stable Arbitrum asset canonically', async () => {
    const evidence: Record<string, unknown> = { observedAt: new Date().toISOString(), mode: 'READ_ONLY_MAINNET_METADATA' };
    const results = await Promise.allSettled(Object.values(CATALOG_NETWORKS).map(async network => {
      const catalog = await network.catalogFor('live')(network.chain);
      registerNetworkCatalog(catalog);
      evidence[network.id] = { chain: catalog.chain, count: catalog.assets.length, provenance: catalog.provenance,
        sample: catalog.assets.slice(0, 8).map(a => ({ symbol: a.symbol, address: a.address, decimals: a.decimals })) };
      expect(catalog.assets.length).toBeGreaterThan(3);
    }));
    const solana = await loadSolanaCatalog().then(catalog => {
      evidence.solana = { count: catalog.assets.length, fetchedAt: catalog.fetchedAt, source: catalog.source, contentSha256: catalog.contentSha256, sample: catalog.assets.slice(0, 8) };
      expect(catalog.assets.length).toBeGreaterThan(3);
    }).catch(cause => { evidence.solana = { unavailable: String(cause) }; });
    void solana;
    results.forEach((result, i) => { if (result.status === 'rejected') evidence[Object.keys(CATALOG_NETWORKS)[i]!] = { unavailable: String(result.reason) }; });
    const weth = resolveNetworkAsset('eip155:42161', { symbol: 'WETH' });
    if (weth) {
      const node = createUniversalBridgeFromInput('node-002', { source: 'arbitrum-one', destination: 'robinhood', inputAsset: `${weth.address}@${weth.decimals}`, outputAsset: 'ETH', amount: '0.01', recipient: '', slippage: '100', routing: 'BEST' });
      evidence.canonical = universalBridgeDetails(node)?.fields;
      const request = parseDiscoveryRequest({ source: 'arbitrum-one', destination: 'robinhood', inputToken: { kind: 'TOKEN', address: weth.address, decimals: weth.decimals, symbol: weth.symbol }, outputToken: { kind: 'NATIVE' }, amount: '10000000000000000', slippageBps: 100 });
      evidence.selectedAssetDiscovery = await createUniversalDiscovery({ http: createUniversalHttp() }).discover(request, request.providers);
    }
    await writeFile(process.env.FLOFI_CATALOG_EVIDENCE ?? '/tmp/flofi-bridge-catalogs-live.json', JSON.stringify(evidence, null, 2) + '\n');
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    expect(evidence.solana).not.toHaveProperty('unavailable');
  }, 90000);
});
