// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Read-only discovery for authenticated conversational entry points. This adapter deliberately has no flow runtime, wallet
 * principal, run store or transaction transport: quotes always use the registry's public subjects. The webhook authenticates
 * and admits the sender before constructing this toolkit; the dispatcher requires its scheduler bearer. Provider credentials
 * stay inside the server transport and neither inputs nor outputs grant financial authority.
 */
import { copilotToolkitOf, copilotToolsEnabled, type CopilotToolkit, type CopilotToolPorts } from '../platform/copilot-tools.ts';
import { networkScope } from './network-scope.ts';
import { authoringCatalogPreparer } from './authoring-catalogs.ts';
import { createUniversalDiscovery } from './universal-router/discovery.ts';
import { createUniversalHttp, type UniversalHttp } from './universal-router/http.ts';
import { parseDiscoveryRequest } from './universal-router/requests.ts';

type Env = Readonly<Record<string, string | undefined>>;
type ReadOnlyPorts = { readonly http?: UniversalHttp; readonly prepareCatalogs?: CopilotToolPorts['prepareCatalogs'] };
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;

export function channelCopilotToolkit(env: Env, ports: ReadOnlyPorts = {}): CopilotToolkit | null {
  if (!copilotToolsEnabled(env)) return null;
  const discovery = createUniversalDiscovery({ http: ports.http ?? createUniversalHttp(fetch, 7_000),
    keys: { ...env.RELAY_API_KEY ? { relay: env.RELAY_API_KEY } : {}, ...env.LIFI_API_KEY ? { lifi: env.LIFI_API_KEY } : {} } });
  const discover: NonNullable<CopilotToolPorts['discover']> = async request => {
    try {
      // The tool contract has no owner fields. Enforce it again at the provider boundary rather than trusting a caller.
      if (!request || typeof request !== 'object' || 'owner' in request || 'recipient' in request) return { ok: false, code: 'PUBLIC_QUOTE_SUBJECT_REQUIRED' };
      const parsed = parseDiscoveryRequest(request);
      return { ok: true, value: await discovery.discover(parsed, parsed.providers) };
    } catch (cause) { return { ok: false, code: cause instanceof Error && CODE.test(cause.message) ? cause.message : 'ROUTE_DISCOVERY_FAILED' }; }
  };
  return copilotToolkitOf(networkScope(env), { discover, prepareCatalogs: ports.prepareCatalogs ?? authoringCatalogPreparer(env) });
}
