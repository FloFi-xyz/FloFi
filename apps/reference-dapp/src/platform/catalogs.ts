// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: the official asset catalog a strategy needs, registered before it is composed outside the browser (MCP).
 *
 * Composition is pure and synchronous: a Robinhood Chain Stock Token symbol resolves only in the validated official catalog registered in
 * this process (`registerNetworkCatalog`). Before composing a strategy that names `robinhood`, a surface awaits this with its loader —
 * the deployment's own (`robinhoodAuthoringCatalog`): it reads and validates the registry where the deployment enables Robinhood Chain and
 * fails otherwise. On any failure nothing is registered and a Stock Token symbol is refused at composition (ASSET_CATALOG_UNAVAILABLE);
 * USDG and WETH are code-pinned and always resolve. Never a recorded copy.
 */
import type { AssetCatalog } from '@defi-workflow-engine/action-registry';
import { registerNetworkCatalog } from '../domain/asset-catalogs';

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Whether a v1 strategy or a v2 step list names Robinhood Chain anywhere (network, bridge source or destination). */
export function strategyNamesRobinhood(strategy: unknown): boolean {
  const steps = isObject(strategy) && strategy.version === 2 && Array.isArray(strategy.steps) ? strategy.steps : [strategy];
  return steps.some(step => isObject(step) && [step.network, step.sourceNetwork, step.destinationNetwork].includes('robinhood'));
}
/** Registers the catalog `load` returns when `strategy` names Robinhood Chain. Never throws: a failure only leaves Stock Token symbols unresolvable. */
export async function prepareStrategyCatalogs(strategy: unknown, load: () => Promise<AssetCatalog>): Promise<void> {
  if (!strategyNamesRobinhood(strategy)) return;
  try { registerNetworkCatalog(await load()); } catch { /* unavailable registry: composition refuses Stock Token symbols */ }
}
