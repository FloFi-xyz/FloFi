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
import { BASE_MAINNET, BASE_TOKEN_LIST, parseBaseTokenList } from '@defi-workflow-engine/action-registry';
import { createEvmCatalogRuntime, EVM_CATALOG_RPC_METHODS, type EvmCatalogMode } from './evm-catalog-runtime.ts';
export type BaseMainnetMode = EvmCatalogMode;
export const BASE_MAINNET_HARNESS = Object.freeze({ rpc: 'http://127.0.0.1:8562/rpc', tokenList: 'http://127.0.0.1:8562/token-list' });
export const BASE_MAINNET_RPC_METHODS = EVM_CATALOG_RPC_METHODS;
export const BASE_LIQUIDITY_RPC_METHODS = Object.freeze([...BASE_MAINNET_RPC_METHODS, 'eth_simulateV1']);
const runtime = createEvmCatalogRuntime({ ...BASE_MAINNET, prefix: 'BASE', tokenList: BASE_TOKEN_LIST, parse: parseBaseTokenList,
  userAgent: 'Flofi/BUILD-BASE-001 asset catalog', harness: BASE_MAINNET_HARNESS });
export const baseMainnetMode = runtime.mode, baseOwnerExecutionEnabled = runtime.ownerExecutionEnabled, baseRpcUrl = runtime.rpcUrl,
  baseMainnetRpc = runtime.rpc, createBaseCatalogLoader = runtime.createCatalogLoader, baseSwapRuntime = runtime.swapRuntime,
  baseCatalogFor = runtime.catalogFor, baseAuthoringCatalog = runtime.authoringCatalog;
