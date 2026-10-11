// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import type { AssetCatalog } from '@defi-workflow-engine/action-registry';
import { cloudFlowMode } from '../server/flow-runtime';
import { catalogNetworkOfChain } from '../server/catalog-networks';

/**
 * BUILD-RH-002: the validated official asset catalog of a catalog network for authoring (Canvas pickers and search): Robinhood Chain's
 * Stock Token registry, and (BUILD-BASE-001) Base's token list. Read only where the deployment enables that network
 * (`GRYLOO_ROBINHOOD_MAINNET=live`, `GRYLOO_BASE_MAINNET=live`, or the loopback harness in tests); any failure is returned as a closed
 * code and the picker shows the catalog as unavailable. Never a recorded copy.
 */
export async function loadNetworkAssetCatalog(chain: string): Promise<{ readonly ok: true; readonly catalog: AssetCatalog } | { readonly ok: false; readonly code: string }> {
  const network = catalogNetworkOfChain(chain);
  if (!network || network.chain !== chain) return { ok: false, code: 'CATALOG_NETWORK_UNSUPPORTED' };
  // The network's swap flow carries its deployment gate (the catalog is read only where the network is enabled).
  const mode = (await cloudFlowMode(network.flows.swap)) ?? network.mode(process.env);
  if (mode === 'off') return { ok: false, code: network.disabledCode };
  try { return { ok: true, catalog: await network.catalogFor(mode)(chain) }; }
  catch (cause) {
    const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : network.catalogUnavailableCode;
    return { ok: false, code };
  }
}
