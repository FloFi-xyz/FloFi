// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: the Robinhood Chain mainnet (4663) runtime, shared by the in-process server actions and the cloud backend.
 * Real funds. Explicit gates, none set by this build:
 *  - `GRYLOO_ROBINHOOD_MAINNET=live`: the official asset catalog, quotes, simulation and Review on Robinhood Chain;
 *  - `GRYLOO_ROBINHOOD_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`: additionally allows `begin` (the owner's wallet signs and sends
 *    every transaction; Flofi never does) — the same real-funds opt-in convention as the Router and Jupiter mainnet flows;
 *  - `GRYLOO_ROBINHOOD_MAINNET_HARNESS=MOCKED_LOOPBACK_ONLY`: the loopback MOCKED harness (tests); it always wins over `live`.
 * Reads use allowlisted methods only (no send, sign or wallet method exists) on a client bound to chain 4663; the official
 * Stock Token registry is read from its pinned HTTPS endpoint without redirects, size-capped, and validated fail-closed.
 */
import { ROBINHOOD_CHAIN_MAINNET, ROBINHOOD_STOCK_TOKEN_REGISTRY, parseRobinhoodStockTokenRegistry, robinhoodNetworkCatalog,
  type AssetCatalog } from '@defi-workflow-engine/action-registry';
import { chainBoundRpc, createBaseSepoliaReadRpc, pacedReadRpc, readPacingFor } from './public-testnet-rpc.ts';
import type { CatalogSwapRuntime, Rpc } from './public-testnet-service.ts';
import { createOfficialCatalogLoader, type RegistryFetch } from './network-catalog.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type RobinhoodMainnetMode = 'live' | 'harness' | 'off';
/** Loopback MOCKED harness (e2e/robinhood-mainnet-harness.mjs); never a public provider. */
export const ROBINHOOD_MAINNET_HARNESS = Object.freeze({ rpc: 'http://127.0.0.1:8561/rpc', registry: 'http://127.0.0.1:8561/rhj/assets' });
export const ROBINHOOD_MAINNET_RPC_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call',
  'eth_getStorageAt', 'eth_getBalance', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_gasPrice', 'eth_getTransactionReceipt',
  'eth_getTransactionByHash', 'eth_getLogs']);
/** The liquidity runtime additionally simulates the exact approvals and mint (`eth_simulateV1`, supported on 4663) and reads the priority fee. */
export const ROBINHOOD_LIQUIDITY_RPC_METHODS = Object.freeze([...ROBINHOOD_MAINNET_RPC_METHODS, 'eth_simulateV1', 'eth_maxPriorityFeePerGas']);
export function robinhoodMainnetMode(env: Env): RobinhoodMainnetMode {
  if (env.GRYLOO_ROBINHOOD_MAINNET_HARNESS === 'MOCKED_LOOPBACK_ONLY') return 'harness';
  return env.GRYLOO_ROBINHOOD_MAINNET === 'live' ? 'live' : 'off';
}
/** Owner execution on mainnet needs the explicit real-funds opt-in; the MOCKED harness always allows it (loopback only). */
export const robinhoodOwnerExecutionEnabled = (mode: RobinhoodMainnetMode, env: Env) =>
  mode === 'harness' || (mode === 'live' && env.GRYLOO_ROBINHOOD_OWNER_EXECUTION === 'MAINNET_OWNER_APPROVED');
/** Optional HTTPS override of the public RPC (a keyed provider); anything else is a configuration error. */
export function robinhoodRpcUrl(override: string | undefined): string {
  if (override === undefined || override === '') return ROBINHOOD_CHAIN_MAINNET.rpc;
  let url: URL;
  try { url = new URL(override); } catch { throw new Error('ROBINHOOD_RPC_CONFIGURATION_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('ROBINHOOD_RPC_CONFIGURATION_INVALID');
  return url.href;
}
/** The chain-bound read client: an `eth_chainId` for any chain but 4663 is refused, never followed. */
export function robinhoodMainnetRpc(mode: 'live' | 'harness', env: Env, methods: readonly string[] = ROBINHOOD_MAINNET_RPC_METHODS): Rpc {
  if (mode === 'harness') return chainBoundRpc(createBaseSepoliaReadRpc(ROBINHOOD_MAINNET_HARNESS.rpc, methods), ROBINHOOD_CHAIN_MAINNET.chainId);
  return chainBoundRpc(pacedReadRpc(createBaseSepoliaReadRpc(robinhoodRpcUrl(env.GRYLOO_ROBINHOOD_RPC_URL), methods),
    readPacingFor(env, Boolean(env.GRYLOO_ROBINHOOD_RPC_URL))), ROBINHOOD_CHAIN_MAINNET.chainId);
}

export type { RegistryFetch } from './network-catalog.ts';
/**
 * The official Robinhood Chain catalog (base assets + every validated active Stock Token). Each call returns a catalog no
 * older than `ttlMs` (the registry itself caches; prices are never read here); concurrent callers share one read. Any
 * failure — HTTP, size, redirect, malformed payload, duplicate or ambiguous asset — fails closed and is never replaced by
 * an older or recorded catalog. BUILD-BASE-001: the generic official-catalog loader every catalog network shares.
 */
export function createRobinhoodCatalogLoader(options: { readonly mode: 'live' | 'harness'; readonly fetcher?: RegistryFetch;
  readonly now?: () => Date; readonly ttlMs?: number }): (chain: string) => Promise<AssetCatalog> {
  return createOfficialCatalogLoader({ chain: ROBINHOOD_CHAIN_MAINNET.chain,
    url: options.mode === 'harness' ? ROBINHOOD_MAINNET_HARNESS.registry : ROBINHOOD_STOCK_TOKEN_REGISTRY.url,
    maximumBytes: ROBINHOOD_STOCK_TOKEN_REGISTRY.maximumBytes, userAgent: 'Flofi/BUILD-RH-002 asset registry', unavailableCode: 'STOCK_REGISTRY_UNAVAILABLE',
    parse: (text, fetchedAt) => robinhoodNetworkCatalog(parseRobinhoodStockTokenRegistry(text, fetchedAt)) }, options);
}
/** The catalog swap runtime of the shared Uniswap swap service on Robinhood Chain. */
export function robinhoodSwapRuntime(mode: 'live' | 'harness', env: Env, catalogFor: (chain: string) => Promise<AssetCatalog>): CatalogSwapRuntime {
  return { catalogFor, provenance: mode === 'harness' ? 'MOCKED' : 'PUBLIC_MAINNET', executionEnabled: robinhoodOwnerExecutionEnabled(mode, env) };
}
const loaders = new Map<'live' | 'harness', (chain: string) => Promise<AssetCatalog>>();
/** The process-wide catalog loader of a mode, shared by the swap, transfer and liquidity services and the authoring catalog. */
export function robinhoodCatalogFor(mode: 'live' | 'harness'): (chain: string) => Promise<AssetCatalog> {
  let loader = loaders.get(mode);
  if (!loader) { loader = createRobinhoodCatalogLoader({ mode }); loaders.set(mode, loader); }
  return loader;
}
/**
 * The validated official catalog for authoring outside the browser (MCP): read only where the deployment enables
 * Robinhood Chain — `deploymentMode` is the cloud flow's own mode, `null` when unknowable here (then the local gates decide).
 */
export async function robinhoodAuthoringCatalog(deploymentMode: RobinhoodMainnetMode | null, env: Env = process.env): Promise<AssetCatalog> {
  const mode = deploymentMode ?? robinhoodMainnetMode(env);
  if (mode === 'off') throw new Error('ROBINHOOD_MAINNET_NOT_ENABLED');
  return robinhoodCatalogFor(mode)(ROBINHOOD_CHAIN_MAINNET.chain);
}
