// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { ROBINHOOD_CHAIN_MAINNET, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import { cloudFlowMode } from '../server/flow-runtime';
import { robinhoodCatalogFor, robinhoodMainnetMode } from '../server/robinhood-mainnet';

/**
 * BUILD-RH-002: the validated official Robinhood Chain asset catalog for authoring (Canvas pickers and search). Read only
 * where the deployment enables Robinhood Chain (`GRYLOO_ROBINHOOD_MAINNET=live`, or the loopback harness in tests); any
 * registry failure is returned as a closed code and the picker shows the catalog as unavailable. Never a recorded copy.
 */
export async function loadNetworkAssetCatalog(chain: string): Promise<{ readonly ok: true; readonly catalog: AssetCatalog } | { readonly ok: false; readonly code: string }> {
  if (chain !== ROBINHOOD_CHAIN_MAINNET.chain) return { ok: false, code: 'CATALOG_NETWORK_UNSUPPORTED' };
  const mode = (await cloudFlowMode('robinhood-swap')) ?? robinhoodMainnetMode(process.env);
  if (mode === 'off') return { ok: false, code: 'ROBINHOOD_MAINNET_NOT_ENABLED' };
  try { return { ok: true, catalog: await robinhoodCatalogFor(mode)(chain) }; }
  catch (cause) {
    const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'STOCK_REGISTRY_UNAVAILABLE';
    return { ok: false, code };
  }
}
