// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-ARB-001 Phase 1: canonical Arbitrum One metadata, shared by discovery, the Router and wallet vocabulary.
 * Verified 2026-10-11 against https://docs.arbitrum.io/chain-info and the Foundation's wallet guide;
 * the public RPC returned eth_chainId 0xa4b1. Registration grants no new runtime or execution authority.
 */
export const ARBITRUM_ONE = Object.freeze({
  name: 'Arbitrum One', chain: 'eip155:42161', chainId: 42161, chainHex: '0xa4b1', environment: 'MAINNET', funds: 'REAL_FUNDS',
  nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 } as const),
  rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io/', officialSource: 'https://docs.arbitrum.io/chain-info',
} as const);
