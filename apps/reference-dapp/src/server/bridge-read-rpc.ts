// SPDX-License-Identifier: AGPL-3.0-only
/** Bounded read failover. A provider refusal/revert is authoritative; transport outages can use another configured path. */
import { chainBoundRpc, createBaseSepoliaReadRpc, pacedReadRpc, readPacingFor } from './public-testnet-rpc.ts';
import type { Rpc } from './public-testnet-service.ts';

type Env = Readonly<Record<string, string | undefined>>;
const names: Readonly<Record<number, string>> = { 1: 'ETHEREUM', 8453: 'BASE', 42161: 'ARBITRUM', 4663: 'ROBINHOOD', 84532: 'BASE_SEPOLIA', 421614: 'ARBITRUM_SEPOLIA', 11155111: 'ETHEREUM_SEPOLIA' };
const alchemy: Readonly<Record<number, string>> = { 1: 'eth-mainnet', 8453: 'base-mainnet', 42161: 'arb-mainnet' };

export function bridgeRpcUrls(chainId: number, primary: string, env: Env): readonly string[] {
  const extra = env[`GRYLOO_${names[chainId]}_FALLBACK_RPC_URLS`]?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
  const keyed = env.GRYLOO_ALCHEMY_API_KEY && alchemy[chainId]
    ? [`https://${alchemy[chainId]}.g.alchemy.com/v2/${encodeURIComponent(env.GRYLOO_ALCHEMY_API_KEY)}`] : [];
  const urls = [...new Set([primary, ...extra, ...keyed])];
  if (urls.length > 4) throw Error('ROUTER_RPC_CONFIGURATION_INVALID');
  for (const value of urls) {
    let url: URL; try { url = new URL(value); } catch { throw Error('ROUTER_RPC_CONFIGURATION_INVALID'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('ROUTER_RPC_CONFIGURATION_INVALID');
  }
  return urls;
}

export function failoverReadRpc(providers: readonly Rpc[], chainId: number): Rpc {
  if (!providers.length || providers.length > 4) throw Error('ROUTER_RPC_CONFIGURATION_INVALID');
  const clients = providers.map(rpc => chainBoundRpc(rpc, chainId));
  const bound = new Set<number>();
  let preferred = 0;
  return async (method, params) => {
    const start = preferred;
    for (let turn = 0; turn < clients.length; turn++) {
      const index = (start + turn) % clients.length, rpc = clients[index]!;
      try {
        // Bind each candidate before any financial read, including a fallback first used mid-observation.
        if (method !== 'eth_chainId' && !bound.has(index)) { await rpc('eth_chainId', []); bound.add(index); }
        const result = await rpc(method, params);
        if (method === 'eth_chainId') bound.add(index);
        preferred = index;
        return result;
      } catch (cause) {
        if (!(cause instanceof Error && ['PUBLIC_RPC_UNAVAILABLE', 'PUBLIC_RPC_HISTORY_UNAVAILABLE'].includes(cause.message)) || turn === clients.length - 1) throw cause;
      }
    }
    throw Error('PUBLIC_RPC_UNAVAILABLE');
  };
}

export function bridgeReadRpc(chainId: number, primary: string, methods: readonly string[], env: Env, primaryIsOperatorEndpoint = false): Rpc {
  // At most four 3s paths. Queue backoff belongs to the durable worker, never a six-retry request behind the UI.
  // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: operator endpoints (a configured primary, the fallbacks and the keyed provider) may use the dedicated
  // read profile; a public default primary keeps the measured pacing.
  const clients = bridgeRpcUrls(chainId, primary, env).map((url, index) => pacedReadRpc(createBaseSepoliaReadRpc(url, methods, 3_000),
    { retries: 0, ...readPacingFor(env, index > 0 || primaryIsOperatorEndpoint) }));
  return failoverReadRpc(clients, chainId);
}
