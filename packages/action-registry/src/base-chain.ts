// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-BASE-001: Base mainnet (8453) as a first-class FloFi network, on the same model as Robinhood Chain (BUILD-RH-002).
 *
 * Network source (read 2026-10-11): https://docs.base.org/get-started/connect-to-base — chain ID 8453, RPC https://mainnet.base.org,
 * currency ETH, explorer https://basescan.org. The RPC returned `eth_chainId` 0x2105. Base is an OP Stack L2: every receipt carries a
 * separate L1 data fee (`l1Fee`) that is part of the owner's network cost; the GasPriceOracle predeploy bounds it before Review.
 * See docs/builds/BUILD-BASE-001-NETWORK-INTEGRATION-DISCOVERY.md.
 *
 * Real funds. Catalog, quotes, simulation and Review need `GRYLOO_BASE_MAINNET=live`; owner execution additionally needs the explicit
 * deployment-wide real-funds opt-in `GRYLOO_BASE_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`. The connected owner's wallet signs and sends
 * every transaction; FloFi never does.
 */
export const BASE_MAINNET = Object.freeze({
  name: 'Base', chain: 'eip155:8453', chainId: 8453, chainHex: '0x2105', environment: 'MAINNET',
  nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 } as const),
  rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org',
  officialSource: 'https://docs.base.org/get-started/connect-to-base',
  /** OP Stack GasPriceOracle predeploy: `getL1FeeUpperBound(uint256)` bounds the L1 data fee of a transaction of a given size. */
  gasPriceOracle: '0x420000000000000000000000000000000000000f',
} as const);
/** EIP-3085 parameters from the official network table; offered to a wallet only after it reports the chain unknown (4902). */
export function baseAddChainParameters() {
  return Object.freeze({ chainId: BASE_MAINNET.chainHex, chainName: BASE_MAINNET.name, nativeCurrency: BASE_MAINNET.nativeCurrency,
    rpcUrls: Object.freeze([BASE_MAINNET.rpc]), blockExplorerUrls: Object.freeze([BASE_MAINNET.explorer]) });
}
/**
 * Transfers on Base mainnet (real funds) through the shared transfer engine: native ETH (`evm.native-transfer`) and catalog ERC-20s
 * (`evm.token-transfer`), to the connected owner or an explicit recipient. The fee budget and reconciliation include the OP Stack L1
 * data fee (`l1DataFee`), bounded at Review through the GasPriceOracle predeploy.
 */
export const BASE_MAINNET_TRANSFER = Object.freeze({
  network: BASE_MAINNET.name, chain: 'eip155:8453', chainId: 8453,
  chainHex: '0x2105', rpc: BASE_MAINNET.rpc, explorer: BASE_MAINNET.explorer,
  officialSource: BASE_MAINNET.officialSource, adapterId: 'evm.native-transfer', action: 'asset.transfer',
  /** No product ceiling on real funds beyond the owner's balance and the reviewed fee budget (one million ETH is a representation bound). */
  maximumValueWei: '1000000000000000000000000', defaultValueWei: '1000000000000',
  reviewTtlSeconds: 60, gasLimitMarginPercent: 150, maxFeeMultiplier: 2, minimumConfirmations: 2,
  /** Inclusion is a sequencer block of an OP Stack rollup; L1 finality is not claimed. */
  settlement: 'L2' as const,
  recipients: 'ANY' as const, tokenAdapterId: 'evm.token-transfer', environment: 'MAINNET' as const,
  /** OP Stack: the owner also pays `l1Fee`, bounded at Review with the GasPriceOracle. */
  l1DataFee: true as const, gasPriceOracle: BASE_MAINNET.gasPriceOracle,
});
