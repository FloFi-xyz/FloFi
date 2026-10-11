// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: the Base mainnet (8453) runtime, shared by the in-process server actions and the cloud backend — the same model as
 * Robinhood Chain (BUILD-RH-002). Real funds. Explicit, deployment-wide gates, none set by this build:
 *  - `GRYLOO_BASE_MAINNET=live`: the Base asset catalog (pinned assets + the Uniswap Labs Default Token List), quotes, simulation and
 *    Review for Base swaps, transfers, liquidity and Aave lending;
 *  - `GRYLOO_BASE_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`: additionally allows `begin` for any connected user. Their own wallet signs and
 *    sends every transaction; Flofi never does, keeps no key and allowlists no wallet;
 *  - `GRYLOO_BASE_MAINNET_HARNESS=MOCKED_LOOPBACK_ONLY`: the loopback MOCKED harness (tests); it always wins over `live`.
 * Reads use allowlisted methods only (no send, sign or wallet method exists) on a client bound to chain 8453, at the public Base RPC or
 * the existing HTTPS override `GRYLOO_BASE_RPC_URL`. The token list is read from its pinned HTTPS endpoint without redirects, size-capped,
 * and validated fail-closed; it is never committed or replaced by a recorded copy.
 */
import { BASE_MAINNET, BASE_TOKEN_LIST, parseBaseTokenList, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import { chainBoundRpc, createBaseSepoliaReadRpc, pacedReadRpc } from './public-testnet-rpc.ts';
import type { CatalogSwapRuntime, Rpc } from './public-testnet-service.ts';
import { createOfficialCatalogLoader, type RegistryFetch } from './network-catalog.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type BaseMainnetMode = 'live' | 'harness' | 'off';
/** Loopback MOCKED harness (e2e/base-mainnet-serve.ts); never a public provider. */
export const BASE_MAINNET_HARNESS = Object.freeze({ rpc: 'http://127.0.0.1:8562/rpc', tokenList: 'http://127.0.0.1:8562/token-list' });
export const BASE_MAINNET_RPC_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call',
  'eth_getStorageAt', 'eth_getBalance', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_getTransactionReceipt',
  'eth_getTransactionByHash', 'eth_getLogs']);
/** The liquidity runtime additionally simulates the exact approvals and mint (`eth_simulateV1`). */
export const BASE_LIQUIDITY_RPC_METHODS = Object.freeze([...BASE_MAINNET_RPC_METHODS, 'eth_simulateV1']);
export function baseMainnetMode(env: Env): BaseMainnetMode {
  if (env.GRYLOO_BASE_MAINNET_HARNESS === 'MOCKED_LOOPBACK_ONLY') return 'harness';
  return env.GRYLOO_BASE_MAINNET === 'live' ? 'live' : 'off';
}
/** Owner execution on Base mainnet needs the explicit deployment-wide real-funds opt-in; the MOCKED harness always allows it (loopback only). */
export const baseOwnerExecutionEnabled = (mode: BaseMainnetMode, env: Env) =>
  mode === 'harness' || (mode === 'live' && env.GRYLOO_BASE_OWNER_EXECUTION === 'MAINNET_OWNER_APPROVED');
/** Optional HTTPS override of the public RPC (`GRYLOO_BASE_RPC_URL`, a keyed provider); anything else is a configuration error. */
export function baseRpcUrl(override: string | undefined): string {
  if (override === undefined || override === '') return BASE_MAINNET.rpc;
  let url: URL;
  try { url = new URL(override); } catch { throw new Error('BASE_RPC_CONFIGURATION_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('BASE_RPC_CONFIGURATION_INVALID');
  return url.href;
}
/** The chain-bound read client: an `eth_chainId` for any chain but 8453 is refused, never followed. */
export function baseMainnetRpc(mode: 'live' | 'harness', env: Env, methods: readonly string[] = BASE_MAINNET_RPC_METHODS): Rpc {
  if (mode === 'harness') return chainBoundRpc(createBaseSepoliaReadRpc(BASE_MAINNET_HARNESS.rpc, methods), BASE_MAINNET.chainId);
  return chainBoundRpc(pacedReadRpc(createBaseSepoliaReadRpc(baseRpcUrl(env.GRYLOO_BASE_RPC_URL), methods)), BASE_MAINNET.chainId);
}
/** The Base catalog (pinned assets + the validated token list), read from the pinned official URL (or the loopback harness). */
export function createBaseCatalogLoader(options: { readonly mode: 'live' | 'harness'; readonly fetcher?: RegistryFetch; readonly now?: () => Date;
  readonly ttlMs?: number }): (chain: string) => Promise<AssetCatalog> {
  return createOfficialCatalogLoader({ chain: BASE_MAINNET.chain, url: options.mode === 'harness' ? BASE_MAINNET_HARNESS.tokenList : BASE_TOKEN_LIST.url,
    maximumBytes: BASE_TOKEN_LIST.maximumBytes, userAgent: 'Flofi/BUILD-BASE-001 asset catalog', unavailableCode: 'BASE_TOKEN_LIST_UNAVAILABLE',
    parse: parseBaseTokenList }, { ...options, ttlMs: options.ttlMs ?? 300_000 });
}
/** The catalog swap runtime of the shared Uniswap swap service on Base. */
export function baseSwapRuntime(mode: 'live' | 'harness', env: Env, catalogFor: (chain: string) => Promise<AssetCatalog>): CatalogSwapRuntime {
  return { catalogFor, provenance: mode === 'harness' ? 'MOCKED' : 'PUBLIC_MAINNET', executionEnabled: baseOwnerExecutionEnabled(mode, env) };
}
const loaders = new Map<'live' | 'harness', (chain: string) => Promise<AssetCatalog>>();
/** The process-wide catalog loader of a mode, shared by the swap, transfer, liquidity and lending services and the authoring catalog. */
export function baseCatalogFor(mode: 'live' | 'harness'): (chain: string) => Promise<AssetCatalog> {
  let loader = loaders.get(mode);
  if (!loader) { loader = createBaseCatalogLoader({ mode }); loaders.set(mode, loader); }
  return loader;
}
/**
 * The validated Base catalog for authoring outside the browser (MCP): read only where the deployment enables Base mainnet —
 * `deploymentMode` is the cloud flow's own mode, `null` when unknowable here (then the local gates decide).
 */
export async function baseAuthoringCatalog(deploymentMode: BaseMainnetMode | null, env: Env = process.env): Promise<AssetCatalog> {
  const mode = deploymentMode ?? baseMainnetMode(env);
  if (mode === 'off') throw new Error('BASE_MAINNET_NOT_ENABLED');
  return baseCatalogFor(mode)(BASE_MAINNET.chain);
}
