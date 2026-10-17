// SPDX-License-Identifier: Apache-2.0
import { ETHEREUM_MAINNET } from './ethereum-chain.js';
import { type UniswapCatalogLiquidity } from './uniswap-v3-catalog.js';
/** Shared swap/liquidity deployment profile, freshly verified PUBLIC_READ_ONLY at Ethereum block 26208660.
 * Official identities: https://developers.uniswap.org/deployments.json.
 * Runtime pins, factory/WETH relationships and enabled tiers: BUILD-ETHEREUM-MAINNET-001-READONLY.json.
 * Listing never implies liquidity. The shared service checks canonical pools and token code/decimals per quote.
 */
export const UNISWAP_V3_ETHEREUM = Object.freeze({
  network: ETHEREUM_MAINNET.name, chain: ETHEREUM_MAINNET.chain, chainId: ETHEREUM_MAINNET.chainId, chainHex: ETHEREUM_MAINNET.chainHex,
  rpc: ETHEREUM_MAINNET.rpc, explorer: ETHEREUM_MAINNET.explorer, officialSource: 'https://developers.uniswap.org/deployments.json',
  protocol: 'uniswap-v3', adapterId: 'uniswap.v3', providerLabel: 'Uniswap v3',
  factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984', router: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
  positionManager: '0xc36442b4a4522e871399cd717abdd847ab11fe88',
  weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  poolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  feeTiers: Object.freeze([Object.freeze({ fee: 100, tickSpacing: 1 }), Object.freeze({ fee: 500, tickSpacing: 10 }),
    Object.freeze({ fee: 3000, tickSpacing: 60 }), Object.freeze({ fee: 10000, tickSpacing: 200 })]),
  codeSha256: Object.freeze({
    factory: 'fd5e0ec0633afeb92b2f6b6cac36e13a9732bd1914f8158a78f127d51d54a572',
    router: '73fa6fcc81954e96e46dfde91f8e282cd98868c0992ed2c7875a9618fa0711e5',
    quoter: 'c2797888d8316e5070ceb951465277a225d3707b4dab40c94cf61e330c5e6b85',
    positionManager: '041f86b3949f420cabdb0a466c06ddd5639ffea1e1eaff906aa62cce18ecae20',
    usdc: 'c1bcd4dc4f30c4dcf6c9fe462abeaf2efefc065dcb4dec74996e471f1ce219b4',
    weth: '5566bf50796faf93c9b6f6adacd3b32c70bfe16b48ffc59db6cd144cbdc89739',
  }),
  reviewTtlSeconds: 60, defaultSlippageBps: 50, maximumSlippageBps: 300,
});
/** Existing catalog liquidity engine; no pool creation or native ETH wrapping. Ethereum L1 gas accounting. */
export const UNISWAP_V3_ETHEREUM_LIQUIDITY: UniswapCatalogLiquidity = Object.freeze({
  network: UNISWAP_V3_ETHEREUM.network, chain: UNISWAP_V3_ETHEREUM.chain, chainId: UNISWAP_V3_ETHEREUM.chainId,
  chainHex: UNISWAP_V3_ETHEREUM.chainHex, providerLabel: 'Uniswap v3', rpc: UNISWAP_V3_ETHEREUM.rpc,
  explorer: UNISWAP_V3_ETHEREUM.explorer, officialSource: UNISWAP_V3_ETHEREUM.officialSource,
  factory: UNISWAP_V3_ETHEREUM.factory, positionManager: UNISWAP_V3_ETHEREUM.positionManager, weth: UNISWAP_V3_ETHEREUM.weth,
  poolInitCodeHash: UNISWAP_V3_ETHEREUM.poolInitCodeHash, feeTiers: UNISWAP_V3_ETHEREUM.feeTiers,
  codeSha256: Object.freeze({ factory: UNISWAP_V3_ETHEREUM.codeSha256.factory, positionManager: UNISWAP_V3_ETHEREUM.codeSha256.positionManager }),
  gasPriceOracle: null, maximumSlippageBps: 300, defaultSlippageBps: 100, reviewTtlSeconds: 60, mintDeadlineSeconds: 900,
});
