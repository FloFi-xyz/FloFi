// SPDX-License-Identifier: Apache-2.0
/** Ethereum L1. Registration never enables a deployment or authorizes a wallet transaction. */
export const ETHEREUM_MAINNET = Object.freeze({
  name: 'Ethereum', chain: 'eip155:1', chainId: 1, chainHex: '0x1', environment: 'MAINNET', funds: 'REAL_FUNDS',
  nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 } as const),
  rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io',
  officialSource: 'https://ethereum.org/en/developers/docs/networks/',
} as const);
export function ethereumAddChainParameters() {
  return Object.freeze({ chainId: ETHEREUM_MAINNET.chainHex, chainName: 'Ethereum Mainnet', nativeCurrency: ETHEREUM_MAINNET.nativeCurrency,
    rpcUrls: Object.freeze([ETHEREUM_MAINNET.rpc]), blockExplorerUrls: Object.freeze([ETHEREUM_MAINNET.explorer]) });
}

/** Native ETH and validated ERC-20 sends through the shared owner-wallet engine. */
export const ETHEREUM_MAINNET_TRANSFER = Object.freeze({
  network: ETHEREUM_MAINNET.name, chain: ETHEREUM_MAINNET.chain, chainId: ETHEREUM_MAINNET.chainId, chainHex: ETHEREUM_MAINNET.chainHex,
  rpc: ETHEREUM_MAINNET.rpc, explorer: ETHEREUM_MAINNET.explorer, officialSource: ETHEREUM_MAINNET.officialSource,
  adapterId: 'evm.native-transfer', action: 'asset.transfer', maximumValueWei: '1000000000000000000000000', defaultValueWei: '1000000000000',
  reviewTtlSeconds: 60, gasLimitMarginPercent: 150, maxFeeMultiplier: 2, minimumConfirmations: 3, reestimateBeforeSubmission: true,
  settlement: 'L1' as const, recipients: 'ANY' as const, contractRecipients: true, tokenAdapterId: 'evm.token-transfer', environment: 'MAINNET' as const,
});
