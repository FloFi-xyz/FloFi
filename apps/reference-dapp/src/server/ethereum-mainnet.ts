// SPDX-License-Identifier: AGPL-3.0-only
import { ETHEREUM_MAINNET, ETHEREUM_TOKEN_LIST, parseEthereumTokenList } from '@defi-workflow-engine/action-registry';
import { createEvmCatalogRuntime, EVM_CATALOG_RPC_METHODS } from './evm-catalog-runtime.ts';
/** Real funds, disabled by default. Router gates grant no authority here. No harness bypass or wallet allowlist.
 * GRYLOO_ETHEREUM_MAINNET=live enables reads/Simulate/Review; GRYLOO_ETHEREUM_OWNER_EXECUTION=MAINNET_OWNER_APPROVED
 * additionally permits owner-wallet preparation. Neither variable is set by this build.
 */
const runtime = createEvmCatalogRuntime({ ...ETHEREUM_MAINNET, prefix: 'ETHEREUM', tokenList: ETHEREUM_TOKEN_LIST,
  parse: parseEthereumTokenList, userAgent: 'Flofi/BUILD-ETHEREUM-MAINNET-001 asset catalog' });
export const ethereumMainnetMode = runtime.mode, ethereumOwnerExecutionEnabled = runtime.ownerExecutionEnabled,
  ethereumRpcUrl = runtime.rpcUrl, ethereumMainnetRpc = runtime.rpc, createEthereumCatalogLoader = runtime.createCatalogLoader,
  ethereumCatalogFor = runtime.catalogFor, ethereumSwapRuntime = runtime.swapRuntime, ethereumAuthoringCatalog = runtime.authoringCatalog,
  ETHEREUM_MAINNET_RPC_METHODS = EVM_CATALOG_RPC_METHODS;
export const ETHEREUM_LIQUIDITY_RPC_METHODS = Object.freeze([...ETHEREUM_MAINNET_RPC_METHODS, 'eth_simulateV1']);
