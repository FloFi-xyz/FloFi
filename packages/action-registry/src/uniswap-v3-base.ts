// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-BASE-001: Uniswap v3 on Base mainnet (8453), the swap and concentrated-liquidity venue of the Base asset catalog.
 *
 * Source: the official Uniswap deployment registry (https://developers.uniswap.org/deployments.json v1.0.0, generated 2026-09-22,
 * Uniswap/contracts a677c0d; `labs-supported`, `active` v3 records for chain 8453) — the same addresses FloFi has pinned for Base since
 * BUILD-002 (observation) and BUILD-006 (fork liquidity). Verified read-only against https://mainnet.base.org on 2026-10-11 (block
 * 52,468,924): SwapRouter02, QuoterV2 and the NonfungiblePositionManager each report `factory()` = the factory and `WETH9()` = the OP
 * Stack WETH predeploy; the canonical v3 pool init-code hash reproduces the factory's `getPool` answer for USDC/WETH 0.05%
 * (0xd0b53d92…f224); fee tiers 100/500/3000/10000 are enabled with tick spacing 1/10/60/200. 62 of the 159 listed Base tokens had an
 * in-range USDC or WETH pool at the census block; liquidity is read at quote time and never assumed from listing.
 *
 * Mainnet: real funds. Quotes, simulation and Review need `GRYLOO_BASE_MAINNET=live`; owner execution additionally needs the explicit
 * real-funds opt-in `GRYLOO_BASE_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`. Flofi never signs or sends.
 */
import { BASE_MAINNET } from './base-chain.js';
import type { UniswapPoolProfile, UniswapPoolToken } from './uniswap-liquidity-profiles.js';
import { catalogLiquidityPool, type UniswapCatalogLiquidity } from './uniswap-v3-catalog.js';

export const UNISWAP_V3_BASE = Object.freeze({
  network: BASE_MAINNET.name, chain: BASE_MAINNET.chain, chainId: BASE_MAINNET.chainId,
  chainHex: BASE_MAINNET.chainHex, rpc: BASE_MAINNET.rpc, explorer: BASE_MAINNET.explorer,
  officialSource: 'https://developers.uniswap.org/deployments.json', protocol: 'uniswap-v3', adapterId: 'uniswap.v3', providerLabel: 'Uniswap v3',
  factory: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
  router: '0x2626664c2603336e57b271c5c0b26f421741e481',
  quoter: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a',
  positionManager: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1',
  weth: '0x4200000000000000000000000000000000000006',
  usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  /** The canonical Uniswap v3 `POOL_INIT_CODE_HASH`; a pool is the CREATE2 address of (factory, token0, token1, fee). */
  poolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  /** Standard v3 fee tiers and their tick spacing (the pool's own `tickSpacing()` is re-read before use). */
  feeTiers: Object.freeze([Object.freeze({ fee: 100, tickSpacing: 1 }), Object.freeze({ fee: 500, tickSpacing: 10 }),
    Object.freeze({ fee: 3000, tickSpacing: 60 }), Object.freeze({ fee: 10000, tickSpacing: 200 })]),
  /** SHA-256 of the runtime code read on 2026-10-11 (block 52,468,924); a different deployment fails closed. */
  codeSha256: Object.freeze({
    factory: '8545609892cc8d7d608dd4420ee110ab98448730570824fb029228e33846d28c',
    router: 'cdd0e7bce67f3b8cc4a3f517beaa9afa00ea25ee7b6c6ff14a60898228289ef6',
    quoter: 'a204e355059d9c809bfc026503d49b4ecf8655f482a76040dec4bcb4618047b4',
    positionManager: '54aa74382a5aade77e59efffb53208ca5c3d3a679daa2853881381e04b25c48d',
    /** Circle's FiatToken proxy (the code FloFi has pinned for Base USDC since BUILD-002 and the Router). */
    usdc: '98d785fcb1bf847f287adc2310759fd94cc13e754b974bc72131382e8266f607',
    /** The OP Stack WETH9 predeploy. */
    weth: '667c900c2c6da80d452501a9c6332e046384a0c438c3334ce6f71c86dd7b8735',
  }),
  /** A Review authorizes wallet requests for at most this long. */
  reviewTtlSeconds: 60, defaultSlippageBps: 50, maximumSlippageBps: 300,
  /** OP Stack receipts carry a separate `l1Fee`; the owner's cost is gasUsed × effectiveGasPrice + l1Fee. */
  l1DataFee: true, gasPriceOracle: BASE_MAINNET.gasPriceOracle,
});
/** The concentrated-liquidity runtime constants on Base (pool chosen per pair and fee tier). */
export const UNISWAP_V3_BASE_LIQUIDITY: UniswapCatalogLiquidity = Object.freeze({
  network: UNISWAP_V3_BASE.network, chain: UNISWAP_V3_BASE.chain, chainId: UNISWAP_V3_BASE.chainId, chainHex: UNISWAP_V3_BASE.chainHex,
  providerLabel: 'Uniswap v3', rpc: UNISWAP_V3_BASE.rpc, explorer: `${UNISWAP_V3_BASE.explorer}/`, officialSource: UNISWAP_V3_BASE.officialSource,
  factory: UNISWAP_V3_BASE.factory, positionManager: UNISWAP_V3_BASE.positionManager, weth: UNISWAP_V3_BASE.weth,
  poolInitCodeHash: UNISWAP_V3_BASE.poolInitCodeHash, feeTiers: UNISWAP_V3_BASE.feeTiers,
  codeSha256: Object.freeze({ factory: UNISWAP_V3_BASE.codeSha256.factory, positionManager: UNISWAP_V3_BASE.codeSha256.positionManager }),
  gasPriceOracle: UNISWAP_V3_BASE.gasPriceOracle, maximumSlippageBps: 300, defaultSlippageBps: 100, reviewTtlSeconds: 60, mintDeadlineSeconds: 900,
});
/** A Uniswap v3 pool on Base as a liquidity runtime (CREATE2 pool of the pinned factory for the pair and tier, tokens in pool order). */
export function baseLiquidityPool(tokenA: Omit<UniswapPoolToken, 'maximumAmount'>, tokenB: Omit<UniswapPoolToken, 'maximumAmount'>, fee: number): UniswapPoolProfile {
  return catalogLiquidityPool(UNISWAP_V3_BASE_LIQUIDITY, tokenA, tokenB, fee);
}
