// SPDX-License-Identifier: AGPL-3.0-only
import { cloudFlow } from './flow-runtime.ts';
import { CONVERSATIONAL_DISCOVERY_WINDOW, createUniversalDiscovery, type DiscoveryResult } from './universal-router/discovery.ts';
import { parseDiscoveryRequest } from './universal-router/requests.ts';
import { universalRouterMode, universalRouterRuntime } from './universal-router/runtime.ts';
import type { FlowResult } from './cloud-api-client.ts';

/**
 * The same read-only discovery for Canvas, standalone discovery and channels. No simulation, run or financial authority.
 * `window` CONVERSATIONAL (chat tools) closes the discovery window under the tool's own time limit (BUILD-FLOFI-EXECUTION-PERFORMANCE-001).
 */
export async function readBridgeDiscovery(request: unknown, env: Readonly<Record<string, string | undefined>> = process.env,
  correlationId?: string, window: 'STANDARD' | 'CONVERSATIONAL' = 'STANDARD'): Promise<FlowResult<DiscoveryResult>> {
  const parsed = parseDiscoveryRequest(request);
  const options = { env, principal: null, timeoutMs: 30_000, maxAttempts: 1, ...correlationId ? { correlationId } : {} };
  let cloud = await cloudFlow<DiscoveryResult>('crosschain-universal', 'discover', window === 'CONVERSATIONAL' ? [request, window] : [request], options);
  // Deploy skew: an API from before the discovery window accepts the request alone. It answers with its own (standard) window, so a slow provider may
  // still reach the tool's limit, but route discovery keeps working while the web build is ahead of the API.
  if (cloud && !cloud.ok && cloud.code === 'ARGUMENTS_INVALID' && window === 'CONVERSATIONAL')
    cloud = await cloudFlow<DiscoveryResult>('crosschain-universal', 'discover', [request], options);
  if (cloud) return cloud;
  const mode = universalRouterMode(env);
  if (mode === 'off') return { ok: false, code: 'UNIVERSAL_ROUTER_NOT_ENABLED' };
  const runtime = universalRouterRuntime(mode, env);
  return { ok: true, value: await createUniversalDiscovery({ http: runtime.http, apis: runtime.apis, keys: runtime.keys,
    ...window === 'CONVERSATIONAL' ? { window: CONVERSATIONAL_DISCOVERY_WINDOW } : {}, ...correlationId ? { correlationId } : {} }).discover(parsed, parsed.providers) };
}
