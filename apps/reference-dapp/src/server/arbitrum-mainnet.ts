// SPDX-License-Identifier: AGPL-3.0-only
import { ARBITRUM_ONE, ARBITRUM_TOKEN_LIST, parseArbitrumTokenList } from '@defi-workflow-engine/action-registry';
import { createEvmCatalogRuntime, EVM_CATALOG_RPC_METHODS } from './evm-catalog-runtime.ts';
/** Real funds, disabled by default. Router gates grant no authority here. No harness bypass or wallet allowlist.
 * GRYLOO_ARBITRUM_MAINNET=live enables reads/Simulate/Review; GRYLOO_ARBITRUM_OWNER_EXECUTION=MAINNET_OWNER_APPROVED
 * additionally permits owner-wallet preparation. Neither variable is set by this build.
 */
const runtime = createEvmCatalogRuntime({ ...ARBITRUM_ONE, prefix: 'ARBITRUM', tokenList: ARBITRUM_TOKEN_LIST,
  parse: parseArbitrumTokenList, userAgent: 'Flofi/BUILD-ARB-001 asset catalog' });
export const arbitrumMainnetMode = runtime.mode, arbitrumOwnerExecutionEnabled = runtime.ownerExecutionEnabled,
  arbitrumRpcUrl = runtime.rpcUrl, arbitrumMainnetRpc = runtime.rpc, createArbitrumCatalogLoader = runtime.createCatalogLoader,
  arbitrumCatalogFor = runtime.catalogFor, arbitrumSwapRuntime = runtime.swapRuntime, arbitrumAuthoringCatalog = runtime.authoringCatalog,
  ARBITRUM_MAINNET_RPC_METHODS = EVM_CATALOG_RPC_METHODS;
