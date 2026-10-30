// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001: the web chat's wiring of the Copilot's read-only tools (`platform/copilot-tools.ts`) for this deployment:
 *
 *   scope      this server's network scope (`network-scope.ts`): the public product discovers mainnets only
 *   discovery  the platform's read-only universal route discovery (`readBridgeDiscovery`), public quote subjects, nothing persisted
 *   catalogs   the validated official catalogs this deployment enables (`authoringCatalogPreparer`)
 *
 * Channel Core uses the same contracts without route discovery (its boundary admits no flow runtime): its route tools answer
 * ROUTE_DISCOVERY_UNAVAILABLE instead of a substitute. `FLOFI_COPILOT_TOOLS=off` turns tools off everywhere.
 */
import { copilotToolkitOf, copilotToolsEnabled, type CopilotToolkit, type CopilotToolPorts } from '../platform/copilot-tools.ts';
import { networkScope } from './network-scope.ts';
import { readBridgeDiscovery } from './bridge-discovery.ts';
import { authoringCatalogPreparer } from './authoring-catalogs.ts';

type Env = Readonly<Record<string, string | undefined>>;
/** The toolkit of this deployment, or null when the operator turned tools off. `ports` replaces the production ports (tests, closed replay). */
export function copilotToolkit(env: Env, ports?: CopilotToolPorts): CopilotToolkit | null {
  if (!copilotToolsEnabled(env)) return null;
  const discover: CopilotToolPorts['discover'] = async request => {
    try { return await readBridgeDiscovery(request, env); } catch (cause) { return { ok: false, code: cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'ROUTE_DISCOVERY_FAILED' }; }
  };
  return copilotToolkitOf(networkScope(env), ports ?? { discover, prepareCatalogs: authoringCatalogPreparer(env) });
}
