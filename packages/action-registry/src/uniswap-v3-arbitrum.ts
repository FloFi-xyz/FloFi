// SPDX-License-Identifier: Apache-2.0
import { ARBITRUM_ONE } from './arbitrum-chain.js';
/** Swap-only deployment profile, verified PUBLIC_READ_ONLY at block 513943961 on 2026-10-11.
 * Official identities: https://developers.uniswap.org/deployments.json.
 * Runtime pins and factory/WETH relationships: BUILD-ARB-001-PHASE-2-READ-VERIFICATION.json.
 * Listing never implies liquidity. The shared service checks canonical pools and token code/decimals per quote.
 */
export const UNISWAP_V3_ARBITRUM = Object.freeze({
  network: ARBITRUM_ONE.name, chain: ARBITRUM_ONE.chain, chainId: ARBITRUM_ONE.chainId, chainHex: ARBITRUM_ONE.chainHex,
  rpc: ARBITRUM_ONE.rpc, explorer: ARBITRUM_ONE.explorer, officialSource: 'https://developers.uniswap.org/deployments.json',
  protocol: 'uniswap-v3', adapterId: 'uniswap.v3', providerLabel: 'Uniswap v3',
  factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984', router: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
  weth: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  poolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  feeTiers: Object.freeze([Object.freeze({ fee: 100, tickSpacing: 1 }), Object.freeze({ fee: 500, tickSpacing: 10 }),
    Object.freeze({ fee: 3000, tickSpacing: 60 }), Object.freeze({ fee: 10000, tickSpacing: 200 })]),
  codeSha256: Object.freeze({
    factory: 'fd5e0ec0633afeb92b2f6b6cac36e13a9732bd1914f8158a78f127d51d54a572',
    router: 'e1d11180e845c882d04df87f009d45061fdf1115ef607b734cbf6d3da9a58d86',
    quoter: '606e62b332f9d979e27593eb38e3e214d22f08e1502b3ded0bd32c4fa81398ea',
    usdc: 'b46445c0c96a50cd0ae6245d2ceb5058fbbcd24afad9cb878974d8f17b4655c8',
    weth: 'cbbb906270e2b7c031e119ec2f41a8d73d3e14ab437075760adc735e38edd888',
  }),
  reviewTtlSeconds: 60, defaultSlippageBps: 50, maximumSlippageBps: 300,
});
