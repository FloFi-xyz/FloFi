// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #149 (cross-channel parity): the route discovery a channel offers follows the same deployment gate as the web's. The web's read-only
 * universal discovery (`server/bridge-discovery.ts`) answers only where the deployment enables the universal router (`GRYLOO_UNIVERSAL_ROUTER`,
 * `server/universal-router/runtime.ts` `universalRouterMode`; the cloud flow `crosschain-universal` applies the same mode) and otherwise
 * refuses with UNIVERSAL_ROUTER_NOT_ENABLED. A channel's Copilot tools (`find_routes`, `get_quote`) therefore never offer a route whose
 * execution capability this deployment does not have:
 *
 *   live     the authenticated channel toolkit's read-only discovery (`server/channel-copilot-toolkit.ts`)
 *   off      the same contract with discovery refused exactly as the web refuses it (UNIVERSAL_ROUTER_NOT_ENABLED)
 *   harness  the MOCKED loopback harness serves the web only; the channel toolkit reaches public providers, so a harness deployment's
 *            channels never discover through them (closed: ROUTE_DISCOVERY_UNAVAILABLE)
 *
 * Read-only either way: nothing here holds a flow runtime, a wallet principal or financial authority. `FLOFI_COPILOT_TOOLS=off` still turns
 * every tool off.
 */
import { copilotToolkitOf, copilotToolsEnabled, type CopilotToolkit, type CopilotToolPorts } from '../platform/copilot-tools.ts';
import { scopeOfEnv } from '../domain/network-scope';
import { authoringCatalogPreparer } from '../server/authoring-catalogs.ts';
import { channelCopilotToolkit } from '../server/channel-copilot-toolkit.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type ChannelRouteDiscoveryMode = 'live' | 'harness' | 'off';
/**
 * The deployment's universal-router mode, read exactly as `universalRouterMode` reads it (repeated here because the channel boundary admits
 * no universal-router runtime module; `route-discovery.test.ts` keeps the two equal).
 */
export function channelRouteDiscoveryMode(env: Env): ChannelRouteDiscoveryMode {
  if (env.GRYLOO_UNIVERSAL_ROUTER_HARNESS === 'MOCKED_LOOPBACK_ONLY') return 'harness';
  return env.GRYLOO_UNIVERSAL_ROUTER === 'live' ? 'live' : 'off';
}

type Ports = NonNullable<Parameters<typeof channelCopilotToolkit>[1]>;
/** The read-only Copilot toolkit a channel turn may use on this deployment, or null when the operator turned tools off. */
export function channelRouteToolkit(env: Env, ports: Ports = {}): CopilotToolkit | null {
  if (!copilotToolsEnabled(env)) return null;
  const mode = channelRouteDiscoveryMode(env);
  if (mode === 'live') return channelCopilotToolkit(env, ports);
  const code = mode === 'off' ? 'UNIVERSAL_ROUTER_NOT_ENABLED' : 'ROUTE_DISCOVERY_UNAVAILABLE';
  const discover: NonNullable<CopilotToolPorts['discover']> = async () => ({ ok: false, code });
  return copilotToolkitOf(scopeOfEnv(env), { discover, prepareCatalogs: ports.prepareCatalogs ?? authoringCatalogPreparer(env) });
}
