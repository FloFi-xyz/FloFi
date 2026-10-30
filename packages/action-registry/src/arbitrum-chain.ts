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

/** Same-chain owner-wallet transfers. Nitro's estimate/receipt gas includes parent posting cost; no OP Stack oracle. */
export const ARBITRUM_ONE_TRANSFER = Object.freeze({
  network: ARBITRUM_ONE.name, chain: ARBITRUM_ONE.chain, chainId: ARBITRUM_ONE.chainId, chainHex: ARBITRUM_ONE.chainHex,
  rpc: ARBITRUM_ONE.rpc, explorer: ARBITRUM_ONE.explorer, officialSource: ARBITRUM_ONE.officialSource,
  adapterId: 'evm.native-transfer', action: 'asset.transfer', maximumValueWei: (2n ** 256n - 1n).toString(), defaultValueWei: '1000000000000',
  reviewTtlSeconds: 60, gasLimitMarginPercent: 150, maxFeeMultiplier: 2, minimumConfirmations: 2, reestimateBeforeSubmission: true,
  settlement: 'L2' as const, recipients: 'ANY' as const, contractRecipients: true, tokenAdapterId: 'evm.token-transfer', environment: 'MAINNET' as const,
});
