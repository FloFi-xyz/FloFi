// SPDX-License-Identifier: Apache-2.0
import { ARBITRUM_ONE } from './arbitrum-chain.js';
import { type UniswapCatalogLiquidity } from './uniswap-v3-catalog.js';
/** Shared swap/liquidity deployment profile, freshly verified PUBLIC_READ_ONLY at block 513952674.
 * Official identities: https://developers.uniswap.org/deployments.json.
 * Runtime pins, factory/WETH relationships and enabled tiers: BUILD-ARB-001-PHASE-4-READ-VERIFICATION.json.
 * Listing never implies liquidity. The shared service checks canonical pools and token code/decimals per quote.
 */
export const UNISWAP_V3_ARBITRUM = Object.freeze({
  network: ARBITRUM_ONE.name, chain: ARBITRUM_ONE.chain, chainId: ARBITRUM_ONE.chainId, chainHex: ARBITRUM_ONE.chainHex,
  rpc: ARBITRUM_ONE.rpc, explorer: ARBITRUM_ONE.explorer, officialSource: 'https://developers.uniswap.org/deployments.json',
  protocol: 'uniswap-v3', adapterId: 'uniswap.v3', providerLabel: 'Uniswap v3',
  factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984', router: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
  positionManager: '0xc36442b4a4522e871399cd717abdd847ab11fe88',
  weth: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  poolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  feeTiers: Object.freeze([Object.freeze({ fee: 100, tickSpacing: 1 }), Object.freeze({ fee: 500, tickSpacing: 10 }),
    Object.freeze({ fee: 3000, tickSpacing: 60 }), Object.freeze({ fee: 10000, tickSpacing: 200 })]),
  codeSha256: Object.freeze({
    factory: 'fd5e0ec0633afeb92b2f6b6cac36e13a9732bd1914f8158a78f127d51d54a572',
    router: 'e1d11180e845c882d04df87f009d45061fdf1115ef607b734cbf6d3da9a58d86',
    quoter: '606e62b332f9d979e27593eb38e3e214d22f08e1502b3ded0bd32c4fa81398ea',
    positionManager: 'b64e5e5cd16edcf933484038d9f5a0de0c5c70fd5c03c1f92673c6cfdc74d538',
    usdc: 'b46445c0c96a50cd0ae6245d2ceb5058fbbcd24afad9cb878974d8f17b4655c8',
    weth: 'cbbb906270e2b7c031e119ec2f41a8d73d3e14ab437075760adc735e38edd888',
  }),
  reviewTtlSeconds: 60, defaultSlippageBps: 50, maximumSlippageBps: 300,
});
/** Existing catalog liquidity engine; no pool creation or native ETH wrapping. Nitro fees include posting gas. */
export const UNISWAP_V3_ARBITRUM_LIQUIDITY: UniswapCatalogLiquidity = Object.freeze({
  network: UNISWAP_V3_ARBITRUM.network, chain: UNISWAP_V3_ARBITRUM.chain, chainId: UNISWAP_V3_ARBITRUM.chainId,
  chainHex: UNISWAP_V3_ARBITRUM.chainHex, providerLabel: 'Uniswap v3', rpc: UNISWAP_V3_ARBITRUM.rpc,
  explorer: UNISWAP_V3_ARBITRUM.explorer, officialSource: UNISWAP_V3_ARBITRUM.officialSource,
  factory: UNISWAP_V3_ARBITRUM.factory, positionManager: UNISWAP_V3_ARBITRUM.positionManager, weth: UNISWAP_V3_ARBITRUM.weth,
  poolInitCodeHash: UNISWAP_V3_ARBITRUM.poolInitCodeHash, feeTiers: UNISWAP_V3_ARBITRUM.feeTiers,
  codeSha256: Object.freeze({ factory: UNISWAP_V3_ARBITRUM.codeSha256.factory, positionManager: UNISWAP_V3_ARBITRUM.codeSha256.positionManager }),
  gasPriceOracle: null, maximumSlippageBps: 300, defaultSlippageBps: 100, reviewTtlSeconds: 60, mintDeadlineSeconds: 900,
});
