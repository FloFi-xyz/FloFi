// SPDX-License-Identifier: Apache-2.0
/**
 * Protocol discovery is separate from executionCapabilityRegistry. SUPPORTED means a verified network/protocol can provide the action;
 * it never enables authoring, Simulate, Review or execution. Those stay bound to existing runtime profiles and canonical examples.
 * BUILD-ARB-001 Phase 1 evidence: docs/builds/BUILD-ARB-001-DISCOVERY.md, read-only block 513935282, 2026-10-11.
 */
import { ARBITRUM_ONE } from './arbitrum-chain.js';
import { CROSSCHAIN_ROUTER_ARBITRUM_BASE, CROSSCHAIN_ROUTER_BASE_ARBITRUM } from './crosschain-router.js';

export type CapabilityDiscoveryStatus = 'SUPPORTED' | 'UNSUPPORTED' | 'BLOCKED' | 'UNKNOWN / REQUIRES VERIFICATION';
export type DiscoveredCapability = 'SWAP' | 'TRANSFER_NATIVE' | 'TRANSFER_ERC20' | 'BRIDGE_IN' | 'BRIDGE_OUT' | 'LIQUIDITY' | 'SUPPLY' | 'BORROW' | 'REPAY' | 'WITHDRAW';
export type NetworkCapabilityDiscovery = {
  readonly chain: string; readonly capability: DiscoveredCapability; readonly status: CapabilityDiscoveryStatus;
  readonly adapterId: string; readonly protocol: string; readonly deployments: Readonly<Record<string, string>>;
  readonly source: string; readonly verifiedAt: string; readonly evidence: 'PUBLIC_READ_ONLY';
  readonly runtime: 'EXISTING' | 'NOT_IMPLEMENTED'; readonly scope: string;
};
/** Discovery identities only: not runtime code pins or engine profiles. Native Circle USDC is distinct from USDC.e. */
export const ARBITRUM_PROTOCOL_DEPLOYMENTS = Object.freeze({
  uniswap: Object.freeze({ factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984', router: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
    quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e', positionManager: '0xc36442b4a4522e871399cd717abdd847ab11fe88' }),
  aave: Object.freeze({ provider: '0xa97684ead0e402dc232d5a977953df7ecbab3cdb', pool: '0x794a61358d6845594f94dc1db02a252b5b4814ad',
    oracle: '0xb56c2f0b653b2e0b10c9b928c8580ac5df02c7c7', aToken: '0x724dc807b04555b71ed48a6896b6f41593b8c637',
    variableDebtToken: '0xf611aeb5013fd2c0511c9cd55c7dc5c1140741a6' }),
});
const row = (capability: DiscoveredCapability, adapterId: string, protocol: string, deployments: Readonly<Record<string, string>>, source: string,
  scope: string, runtime: NetworkCapabilityDiscovery['runtime'] = 'NOT_IMPLEMENTED'): NetworkCapabilityDiscovery =>
  Object.freeze({ chain: ARBITRUM_ONE.chain, capability, status: 'SUPPORTED', adapterId, protocol, deployments, source, scope, runtime,
    verifiedAt: '2026-10-11', evidence: 'PUBLIC_READ_ONLY' });
const uniSource = 'https://developers.uniswap.org/deployments.json';
const aaveSource = 'https://github.com/aave-dao/aave-address-book/blob/4250a79306a1de2a98aa3f60bb42fbfcfc612ec7/src/AaveV3Arbitrum.sol';
const noContracts = Object.freeze({});
export const capabilityDiscoveryRegistry: readonly NetworkCapabilityDiscovery[] = Object.freeze([
  row('SWAP', 'uniswap.v3', 'Uniswap v3', ARBITRUM_PROTOCOL_DEPLOYMENTS.uniswap, uniSource, 'Catalog ERC-20 pairs; liquidity and decimals must be revalidated', 'EXISTING'),
  row('TRANSFER_NATIVE', 'evm.native-transfer', 'EVM', noContracts, ARBITRUM_ONE.officialSource, 'Native ETH to an explicit recipient or connected owner', 'EXISTING'),
  row('TRANSFER_ERC20', 'evm.token-transfer', 'ERC-20', noContracts, 'https://eips.ethereum.org/EIPS/eip-20', 'Catalog assets; standard transfer semantics must be revalidated', 'EXISTING'),
  row('BRIDGE_IN', 'flofi.router', 'Across', Object.freeze({ sourceSpokePool: CROSSCHAIN_ROUTER_BASE_ARBITRUM.source.spokePool,
    destinationSpokePool: CROSSCHAIN_ROUTER_BASE_ARBITRUM.destination.spokePool }), 'https://app.across.to/api/available-routes', 'Existing Base USDC → Arbitrum USDC route', 'EXISTING'),
  row('BRIDGE_OUT', 'flofi.router', 'Across', Object.freeze({ sourceSpokePool: CROSSCHAIN_ROUTER_ARBITRUM_BASE.source.spokePool,
    destinationSpokePool: CROSSCHAIN_ROUTER_ARBITRUM_BASE.destination.spokePool }), 'https://app.across.to/api/available-routes', 'Existing Arbitrum USDC → Base USDC route', 'EXISTING'),
  row('LIQUIDITY', 'uniswap.v3', 'Uniswap v3', ARBITRUM_PROTOCOL_DEPLOYMENTS.uniswap, uniSource, 'Concentrated positions, existing pools only; no new pool creation', 'EXISTING'),
  ...(['SUPPLY', 'BORROW', 'REPAY', 'WITHDRAW'] as const).map(capability => row(capability, 'aave-v3', 'Aave V3', ARBITRUM_PROTOCOL_DEPLOYMENTS.aave,
    aaveSource, 'Native Circle USDC reserve id 12, 6 decimals; one-reserve engine profile still required')),
]);
/** Exact CAIP-2 lookup, with no inference from symbols, sibling chains or protocol deployment on another network. */
export const discoverNetworkCapabilities = (chain: string): readonly NetworkCapabilityDiscovery[] => capabilityDiscoveryRegistry.filter(row => row.chain === chain);
