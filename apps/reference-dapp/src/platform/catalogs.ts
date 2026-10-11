// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: the official asset catalogs a strategy needs, registered before it is composed outside the browser (MCP).
 *
 * Composition is pure and synchronous: an asset beyond a catalog network's pinned ones (a Robinhood Chain Stock Token; BUILD-BASE-001 a
 * listed Base token such as cbBTC) resolves only in that network's validated official catalog registered in this process
 * (`registerNetworkCatalog`). Before composing a strategy that names such a network, a surface awaits this with the deployment's own
 * loader (`robinhoodAuthoringCatalog`, `baseAuthoringCatalog`): it reads and validates the source where the deployment enables that network
 * and fails otherwise. On any failure nothing is registered and such a symbol is refused at composition (ASSET_CATALOG_UNAVAILABLE); the
 * pinned assets (USDG/WETH on Robinhood, ETH/USDC/WETH on Base) always resolve. Never a recorded copy.
 */
import type { AssetCatalog } from '@defi-workflow-engine/action-registry';
import { registerNetworkCatalog } from '../domain/asset-catalogs';
import { catalogNetworksNamed } from '../domain/network-registry';

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export type CatalogNetworkId = 'robinhood' | 'base';
/** Whether a v1 strategy or a v2 step list names a network anywhere (network, bridge source or destination). */
export function strategyNamesNetwork(strategy: unknown, network: CatalogNetworkId): boolean {
  const steps = isObject(strategy) && strategy.version === 2 && Array.isArray(strategy.steps) ? strategy.steps : [strategy];
  return steps.some(step => isObject(step) && [step.network, step.sourceNetwork, step.destinationNetwork].includes(network));
}
/** Whether a v1 strategy or a v2 step list names Robinhood Chain anywhere (network, bridge source or destination). */
export const strategyNamesRobinhood = (strategy: unknown) => strategyNamesNetwork(strategy, 'robinhood');
/** Registers the catalog of every named catalog network that has a loader. Never throws: a failure only leaves its listed symbols unresolvable. */
export async function prepareNetworkCatalogs(strategy: unknown, loaders: Readonly<Partial<Record<CatalogNetworkId, () => Promise<AssetCatalog>>>>): Promise<void> {
  for (const network of ['robinhood', 'base'] as const) {
    const load = loaders[network];
    if (!load || !strategyNamesNetwork(strategy, network)) continue;
    try { registerNetworkCatalog(await load()); } catch { /* unavailable source: composition refuses that network's listed symbols */ }
  }
}
/**
 * BUILD-BASE-001: registers the catalog of every catalog network a message names (channels: before the exact grammar and the Copilot plan
 * read it). Never throws: a failure only leaves that network's listed symbols unresolvable (pinned assets always resolve).
 */
export async function prepareCatalogsForText(text: string, loaders: Readonly<Partial<Record<CatalogNetworkId, () => Promise<AssetCatalog>>>>, intent?: unknown): Promise<void> {
  for (const network of catalogNetworksNamed(text, intent)) {
    const load = loaders[network.key as CatalogNetworkId];
    if (!load) continue;
    try { registerNetworkCatalog(await load()); } catch { /* unavailable source: that network's listed symbols stay unresolvable */ }
  }
}
/** Registers the Robinhood Chain catalog `load` returns when `strategy` names Robinhood Chain. Never throws: a failure only leaves Stock Token symbols unresolvable. */
export async function prepareStrategyCatalogs(strategy: unknown, load: () => Promise<AssetCatalog>): Promise<void> {
  return prepareNetworkCatalogs(strategy, { robinhood: load });
}
