// SPDX-License-Identifier: AGPL-3.0-only
import { cloudFlow } from './flow-runtime.ts';
import { createUniversalDiscovery, type DiscoveryResult } from './universal-router/discovery.ts';
import { parseDiscoveryRequest } from './universal-router/requests.ts';
import { universalRouterMode, universalRouterRuntime } from './universal-router/runtime.ts';
import type { FlowResult } from './cloud-api-client.ts';

/** The same read-only discovery for Canvas, standalone discovery and channels. No simulation, run or financial authority. */
export async function readBridgeDiscovery(request: unknown, env: Readonly<Record<string, string | undefined>> = process.env,
  correlationId?: string): Promise<FlowResult<DiscoveryResult>> {
  const parsed = parseDiscoveryRequest(request);
  const cloud = await cloudFlow<DiscoveryResult>('crosschain-universal', 'discover', [request], { env, principal: null,
    timeoutMs: 30_000, maxAttempts: 1, ...correlationId ? { correlationId } : {} });
  if (cloud) return cloud;
  const mode = universalRouterMode(env);
  if (mode === 'off') return { ok: false, code: 'UNIVERSAL_ROUTER_NOT_ENABLED' };
  const runtime = universalRouterRuntime(mode, env);
  return { ok: true, value: await createUniversalDiscovery({ http: runtime.http, apis: runtime.apis, keys: runtime.keys,
    ...correlationId ? { correlationId } : {} }).discover(parsed, parsed.providers) };
}
