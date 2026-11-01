// SPDX-License-Identifier: AGPL-3.0-only
import type { AssetCatalog } from '@defi-workflow-engine/action-registry';
import { chainBoundRpc, createBaseSepoliaReadRpc, pacedReadRpc, readPacingFor } from './public-testnet-rpc.ts';
import { createOfficialCatalogLoader, type RegistryFetch } from './network-catalog.ts';
import type { CatalogSwapRuntime, Rpc } from './public-testnet-service.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type EvmCatalogMode = 'live' | 'harness' | 'off';
export const EVM_CATALOG_RPC_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call',
  'eth_getStorageAt', 'eth_getBalance', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs']);
/** Profile-bound reads/catalog/gates, shared by Base and Arbitrum. No signer or submission port. */
export function createEvmCatalogRuntime(profile: { chain: string; chainId: number; rpc: string; prefix: string;
  tokenList: { url: string; maximumBytes: number }; parse: (text: string, fetchedAt: string) => AssetCatalog; userAgent: string;
  harness?: { rpc: string; tokenList: string } }) {
  const envPrefix = `GRYLOO_${profile.prefix}`;
  const mode = (env: Env): EvmCatalogMode => profile.harness && env[`${envPrefix}_MAINNET_HARNESS`] === 'MOCKED_LOOPBACK_ONLY' ? 'harness'
    : env[`${envPrefix}_MAINNET`] === 'live' ? 'live' : 'off';
  const ownerExecutionEnabled = (m: EvmCatalogMode, env: Env) => Boolean(m === 'harness' && profile.harness) ||
    (m === 'live' && env[`${envPrefix}_OWNER_EXECUTION`] === 'MAINNET_OWNER_APPROVED');
  function rpcUrl(override: string | undefined): string {
    if (!override) return profile.rpc;
    let url: URL;
    try { url = new URL(override); } catch { throw new Error(`${profile.prefix}_RPC_CONFIGURATION_INVALID`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(`${profile.prefix}_RPC_CONFIGURATION_INVALID`);
    return url.href;
  }
  const rpc = (m: 'live' | 'harness', env: Env, methods: readonly string[] = EVM_CATALOG_RPC_METHODS): Rpc => {
    if (m === 'harness' && !profile.harness) throw new Error(`${profile.prefix}_MAINNET_NOT_ENABLED`);
    const read = createBaseSepoliaReadRpc(m === 'harness' ? profile.harness!.rpc : rpcUrl(env[`${envPrefix}_RPC_URL`]), methods);
    return chainBoundRpc(m === 'harness' ? read : pacedReadRpc(read, readPacingFor(env, Boolean(env[`${envPrefix}_RPC_URL`]))), profile.chainId);
  };
  function createCatalogLoader(options: { mode: 'live' | 'harness'; fetcher?: RegistryFetch; now?: () => Date; ttlMs?: number }) {
    if (options.mode === 'harness' && !profile.harness) throw new Error(`${profile.prefix}_MAINNET_NOT_ENABLED`);
    return createOfficialCatalogLoader({ chain: profile.chain, url: options.mode === 'harness' ? profile.harness!.tokenList : profile.tokenList.url,
      maximumBytes: profile.tokenList.maximumBytes, userAgent: profile.userAgent, unavailableCode: `${profile.prefix}_TOKEN_LIST_UNAVAILABLE`,
      parse: profile.parse }, { ...options, ttlMs: options.ttlMs ?? 300_000 });
  }
  const loaders = new Map<'live' | 'harness', (chain: string) => Promise<AssetCatalog>>();
  function catalogFor(m: 'live' | 'harness') {
    let loader = loaders.get(m);
    if (!loader) { loader = createCatalogLoader({ mode: m }); loaders.set(m, loader); }
    return loader;
  }
  const swapRuntime = (m: 'live' | 'harness', env: Env, load: (chain: string) => Promise<AssetCatalog>): CatalogSwapRuntime =>
    ({ catalogFor: load, provenance: m === 'harness' ? 'MOCKED' : 'PUBLIC_MAINNET', executionEnabled: ownerExecutionEnabled(m, env),
      // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: `GRYLOO_DEPLOYMENT_FACT_CACHE=off` re-verifies every immutable deployment fact on every quote.
      ...env.GRYLOO_DEPLOYMENT_FACT_CACHE === 'off' ? { deploymentFacts: null } : {} });
  async function authoringCatalog(deploymentMode: EvmCatalogMode | null, env: Env = process.env) {
    const m = deploymentMode ?? mode(env);
    if (m === 'off') throw new Error(`${profile.prefix}_MAINNET_NOT_ENABLED`);
    return catalogFor(m)(profile.chain);
  }
  return { mode, ownerExecutionEnabled, rpcUrl, rpc, createCatalogLoader, catalogFor, swapRuntime, authoringCatalog };
}
