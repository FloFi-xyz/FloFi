// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: the catalog-network runtime registry, shared by the cloud flows (`backend/flows.ts`) and the in-process server
 * actions. A catalog network is a mainnet (real funds) whose assets come from a validated official catalog: Robinhood Chain
 * (BUILD-RH-002, the Stock Token registry) and Base (the Uniswap Labs Default Token List). Each record binds, once, what every
 * capability of that network needs — its gates, chain-bound read client, catalog loader, run namespaces, journal and cloud flow
 * names — so no flow or action branches per network. Nothing here signs, sends or holds a key.
 */
import { ARBITRUM_ONE, BASE_MAINNET, ROBINHOOD_CHAIN_MAINNET, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import type { CatalogSwapRuntime, Rpc } from './public-testnet-service.ts';
import { robinhoodCatalogFor, robinhoodMainnetMode, robinhoodMainnetRpc, robinhoodOwnerExecutionEnabled, robinhoodSwapRuntime,
  ROBINHOOD_LIQUIDITY_RPC_METHODS, ROBINHOOD_MAINNET_RPC_METHODS } from './robinhood-mainnet.ts';
import { baseCatalogFor, baseMainnetMode, baseMainnetRpc, baseOwnerExecutionEnabled, baseSwapRuntime, BASE_LIQUIDITY_RPC_METHODS,
  BASE_MAINNET_RPC_METHODS } from './base-mainnet.ts';

import { arbitrumMainnetMode, arbitrumOwnerExecutionEnabled, arbitrumMainnetRpc, arbitrumCatalogFor, arbitrumSwapRuntime, ARBITRUM_MAINNET_RPC_METHODS, ARBITRUM_LIQUIDITY_RPC_METHODS } from './arbitrum-mainnet.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type CatalogNetworkId = 'robinhood' | 'base' | 'arbitrum-one';
export type CatalogNetworkMode = 'live' | 'harness' | 'off';
export type CatalogNetworkRuntime = {
  readonly id: CatalogNetworkId; readonly name: string; readonly chain: string; readonly chainId: number;
  /** The deployment gate (`GRYLOO_<NETWORK>_MAINNET=live`; the loopback MOCKED harness always wins). */
  readonly mode: (env: Env) => CatalogNetworkMode;
  /** The deployment-wide real-funds owner-execution opt-in (`GRYLOO_<NETWORK>_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`). */
  readonly ownerExecutionEnabled: (mode: CatalogNetworkMode, env: Env) => boolean;
  /** The chain-bound read client (allowlisted read methods only). */
  readonly rpc: (mode: 'live' | 'harness', env: Env, methods?: readonly string[]) => Rpc;
  readonly rpcMethods: readonly string[]; readonly liquidityRpcMethods: readonly string[];
  /** The process-wide validated official catalog of a mode (fails closed; never a recorded copy). */
  readonly catalogFor: (mode: 'live' | 'harness') => (chain: string) => Promise<AssetCatalog>;
  readonly swapRuntime: (mode: 'live' | 'harness', env: Env, catalogFor: (chain: string) => Promise<AssetCatalog>) => CatalogSwapRuntime;
  /** Closed codes: the network is off here; its journal is not configured; its official catalog cannot be read. */
  readonly disabledCode: string; readonly storageCode: string; readonly catalogUnavailableCode: string;
  /** The local journal root of the in-process actions (each capability has its own subdirectory). */
  readonly journalEnv: string;
  /** Run namespaces; `lending` is null where the network has no Aave profile. */
  readonly prefixes: { readonly swap: 'rhs' | 'bas' | 'ars'; readonly transfer: 'rht' | 'bat' | 'art'; readonly liquidity: 'rhlp' | 'balp' | 'arlp'; readonly lending: 'baave' | null };
  /** Cloud flow names of each capability. */
  readonly flows: { readonly swap: 'robinhood-swap' | 'base-swap' | 'arbitrum-swap'; readonly transfer: 'robinhood-mainnet-transfer' | 'base-mainnet-transfer' | 'arbitrum-mainnet-transfer';
    readonly liquidity: 'robinhood-liquidity' | 'base-liquidity' | 'arbitrum-liquidity'; readonly lending: 'base-aave' | null };
};

export const CATALOG_NETWORKS = Object.freeze({
  robinhood: Object.freeze({ id: 'robinhood', name: ROBINHOOD_CHAIN_MAINNET.name, chain: ROBINHOOD_CHAIN_MAINNET.chain, chainId: ROBINHOOD_CHAIN_MAINNET.chainId,
    mode: robinhoodMainnetMode, ownerExecutionEnabled: robinhoodOwnerExecutionEnabled, rpc: robinhoodMainnetRpc,
    rpcMethods: ROBINHOOD_MAINNET_RPC_METHODS, liquidityRpcMethods: ROBINHOOD_LIQUIDITY_RPC_METHODS, catalogFor: robinhoodCatalogFor, swapRuntime: robinhoodSwapRuntime,
    disabledCode: 'ROBINHOOD_MAINNET_NOT_ENABLED', storageCode: 'ROBINHOOD_STORAGE_NOT_CONFIGURED', catalogUnavailableCode: 'STOCK_REGISTRY_UNAVAILABLE',
    journalEnv: 'GRYLOO_ROBINHOOD_JOURNAL', prefixes: Object.freeze({ swap: 'rhs', transfer: 'rht', liquidity: 'rhlp', lending: null }),
    flows: Object.freeze({ swap: 'robinhood-swap', transfer: 'robinhood-mainnet-transfer', liquidity: 'robinhood-liquidity', lending: null }) }),
  base: Object.freeze({ id: 'base', name: BASE_MAINNET.name, chain: BASE_MAINNET.chain, chainId: BASE_MAINNET.chainId,
    mode: baseMainnetMode, ownerExecutionEnabled: baseOwnerExecutionEnabled, rpc: baseMainnetRpc,
    rpcMethods: BASE_MAINNET_RPC_METHODS, liquidityRpcMethods: BASE_LIQUIDITY_RPC_METHODS, catalogFor: baseCatalogFor, swapRuntime: baseSwapRuntime,
    disabledCode: 'BASE_MAINNET_NOT_ENABLED', storageCode: 'BASE_STORAGE_NOT_CONFIGURED', catalogUnavailableCode: 'BASE_TOKEN_LIST_UNAVAILABLE',
    journalEnv: 'GRYLOO_BASE_JOURNAL', prefixes: Object.freeze({ swap: 'bas', transfer: 'bat', liquidity: 'balp', lending: 'baave' }),
    flows: Object.freeze({ swap: 'base-swap', transfer: 'base-mainnet-transfer', liquidity: 'base-liquidity', lending: 'base-aave' }) }),
  'arbitrum-one': Object.freeze({ id: 'arbitrum-one', name: ARBITRUM_ONE.name, chain: ARBITRUM_ONE.chain, chainId: ARBITRUM_ONE.chainId,
    mode: arbitrumMainnetMode, ownerExecutionEnabled: arbitrumOwnerExecutionEnabled, rpc: arbitrumMainnetRpc,
    rpcMethods: ARBITRUM_MAINNET_RPC_METHODS, liquidityRpcMethods: ARBITRUM_LIQUIDITY_RPC_METHODS, catalogFor: arbitrumCatalogFor, swapRuntime: arbitrumSwapRuntime,
    disabledCode: 'ARBITRUM_MAINNET_NOT_ENABLED', storageCode: 'ARBITRUM_STORAGE_NOT_CONFIGURED', catalogUnavailableCode: 'ARBITRUM_TOKEN_LIST_UNAVAILABLE',
    journalEnv: 'GRYLOO_ARBITRUM_JOURNAL', prefixes: Object.freeze({ swap: 'ars', transfer: 'art', liquidity: 'arlp', lending: null }),
    flows: Object.freeze({ swap: 'arbitrum-swap', transfer: 'arbitrum-mainnet-transfer', liquidity: 'arbitrum-liquidity', lending: null }) }),
} satisfies Readonly<Record<CatalogNetworkId, CatalogNetworkRuntime>>);
export const CATALOG_NETWORK_IDS: readonly CatalogNetworkId[] = Object.freeze(Object.keys(CATALOG_NETWORKS) as CatalogNetworkId[]);

/** The catalog network of a CAIP-2 chain or chain id, or null. */
export function catalogNetworkOfChain(chain: string | number | null | undefined): CatalogNetworkRuntime | null {
  return CATALOG_NETWORK_IDS.map(id => CATALOG_NETWORKS[id]).find(network => network.chain === chain || network.chainId === chain) ?? null;
}
/** The catalog network a run id belongs to by its namespace, or null (a testnet run). */
export function catalogNetworkOfRun(id: unknown, capability: keyof CatalogNetworkRuntime['prefixes']): CatalogNetworkRuntime | null {
  if (typeof id !== 'string') return null;
  return CATALOG_NETWORK_IDS.map(n => CATALOG_NETWORKS[n]).find(network => network.prefixes[capability] !== null && id.startsWith(`${network.prefixes[capability]}-`)) ?? null;
}
/** The catalog network a workflow addresses: the chain of its first node of `actionType`, when that chain is a catalog network. */
export function catalogNetworkOfWorkflow(workflow: unknown, actionType: string): CatalogNetworkRuntime | null {
  if (!workflow || typeof workflow !== 'object' || !Array.isArray((workflow as { nodes?: unknown }).nodes)) return null;
  const node = ((workflow as { nodes: unknown[] }).nodes).find(n => !!n && typeof n === 'object' && (n as { actionType?: unknown }).actionType === actionType) as
    { chainId?: unknown } | undefined;
  return typeof node?.chainId === 'string' ? catalogNetworkOfChain(node.chainId) : null;
}
/**
 * The mode the in-process server actions may use: the MOCKED harness, or `live` only in local development (hosted deployments use the
 * cloud flows), else off.
 */
export function localCatalogNetworkMode(network: CatalogNetworkRuntime, env: Env): CatalogNetworkMode {
  const mode = network.mode(env);
  return mode === 'harness' || (mode === 'live' && env.NODE_ENV === 'development') ? mode : 'off';
}
