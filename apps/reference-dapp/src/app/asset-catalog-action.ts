// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import type { AssetCatalog } from '@defi-workflow-engine/action-registry';
import { cloudFlowMode } from '../server/flow-runtime';
import { catalogNetworkOfChain } from '../server/catalog-networks';

/**
 * BUILD-RH-002: the validated official asset catalog of a catalog network for authoring (Canvas pickers and search): Robinhood Chain's
 * Stock Token registry and the existing Uniswap list projections. Public metadata reads are independent of execution gates;
 * the loopback test harness still uses its own catalog. Any failure shows unavailable, never a recorded copy.
 */
export async function loadNetworkAssetCatalog(chain: string): Promise<{ readonly ok: true; readonly catalog: AssetCatalog } | { readonly ok: false; readonly code: string }> {
  const network = catalogNetworkOfChain(chain);
  if (!network || network.chain !== chain) return { ok: false, code: 'CATALOG_NETWORK_UNSUPPORTED' };
  // The network's swap flow carries its deployment gate (the catalog is read only where the network is enabled).
  const mode = (await cloudFlowMode(network.flows.swap)) ?? network.mode(process.env);
  // Public metadata is independent of the swap execution gate (Bridge uses these catalogs too).
  const catalogMode = mode === 'harness' ? 'harness' : 'live';
  try { return { ok: true, catalog: await network.catalogFor(catalogMode)(chain) }; }
  catch (cause) {
    const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : network.catalogUnavailableCode;
    return { ok: false, code };
  }
}
