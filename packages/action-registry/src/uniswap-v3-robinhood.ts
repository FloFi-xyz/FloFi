// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-RH-002: Uniswap v3 on Robinhood Chain mainnet (4663), the swap and concentrated-liquidity venue.
 *
 * Source: the official Uniswap deployment registry (https://developers.uniswap.org/deployments.json v1.0.0, generated
 * 2026-09-22, Uniswap/contracts a677c0d; 49 `labs-supported`, `active` records for chain 4663). Verified read-only against
 * https://rpc.mainnet.chain.robinhood.com at block 85,478,379 (2026-10-11): SwapRouter02, QuoterV2 and the
 * NonfungiblePositionManager each report `factory()` = the factory and `WETH9()` = the official Robinhood WETH; pools are
 * derived locally with CREATE2 from the factory and the canonical v3 pool init-code hash (the derived addresses of
 * TSLA/USDG 0.3% and USDG/WETH 0.01% equal the factory's `getPool` answers). Live pools exist for 95 of the 194 official
 * Stock Tokens against USDG; their liquidity is read at quote time and never assumed.
 *
 * Mainnet: real funds. Quotes, simulation and Review need `GRYLOO_ROBINHOOD_MAINNET=live`; owner execution additionally needs
 * the explicit real-funds opt-in `GRYLOO_ROBINHOOD_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`. Flofi never signs or sends.
 */
import { ROBINHOOD_CHAIN_MAINNET } from './robinhood-chain.js';
import type { UniswapPoolProfile, UniswapPoolToken } from './uniswap-liquidity-profiles.js';
import { catalogLiquidityMaximumUnits, catalogLiquidityPool, uniswapV3PoolAddress, type UniswapCatalogLiquidity } from './uniswap-v3-catalog.js';

export const UNISWAP_V3_ROBINHOOD = Object.freeze({
  network: ROBINHOOD_CHAIN_MAINNET.name, chain: ROBINHOOD_CHAIN_MAINNET.chain, chainId: ROBINHOOD_CHAIN_MAINNET.chainId,
  chainHex: ROBINHOOD_CHAIN_MAINNET.chainHex, rpc: ROBINHOOD_CHAIN_MAINNET.rpc, explorer: ROBINHOOD_CHAIN_MAINNET.explorer,
  officialSource: 'https://developers.uniswap.org/deployments.json', protocol: 'uniswap-v3', adapterId: 'uniswap.v3', providerLabel: 'Uniswap v3',
  factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  router: '0xcaf681a66d020601342297493863e78c959e5cb2',
  quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  positionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  /** The canonical Uniswap v3 `POOL_INIT_CODE_HASH`; a pool is the CREATE2 address of (factory, token0, token1, fee). */
  poolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  /** Standard v3 fee tiers and their tick spacing (the pool's own `tickSpacing()` is re-read before use). */
  feeTiers: Object.freeze([Object.freeze({ fee: 100, tickSpacing: 1 }), Object.freeze({ fee: 500, tickSpacing: 10 }),
    Object.freeze({ fee: 3000, tickSpacing: 60 }), Object.freeze({ fee: 10000, tickSpacing: 200 })]),
  /** SHA-256 of the runtime code read on 2026-10-11 (block 85,478,379); a different deployment fails closed. */
  codeSha256: Object.freeze({
    factory: '6c41051606215dd79309b298d5395b8e4e4acb155516920b52051c230ee125cf',
    router: 'a84426d2e34ef0d88f458c34993f1aef59617481f17891a74cfc15e6ee93c0cf',
    quoter: 'cbe792709be619ef62094970e1aa40487a104feec2360bb5b65310a89aac77d9',
    positionManager: '793201247e3d2c731401e2538a73b3f7de6c0882f4e89c341498f8f7c7993e5c',
    weth: 'eb5a5f69ebb602e71cdf5fdeb7d49ca9e4b37d105432c0cbd31a754fc4d360a7',
    usdg: 'c85d18dc1e49769e01f9f88981176e213b2bc24d2f14d33a81d54bc06579f6db',
    /** Every official Stock Token is the same ERC-1967 beacon proxy (283 bytes); its beacon is below. */
    stockTokenProxy: '399ec4bc5b43db03486ceae11f9a6fc5c126427f8f8e10c90fed0c773f4325c6',
  }),
  stockTokenBeacon: '0xe10b6f6b275de231345c20d14ab812db62151b00',
  /** ERC-1967 beacon slot (`bytes32(uint256(keccak256('eip1967.proxy.beacon')) - 1)`). */
  beaconSlot: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  /** A Review authorizes wallet requests for at most this long. */
  reviewTtlSeconds: 60, defaultSlippageBps: 50, maximumSlippageBps: 300,
  /** Arbitrum Nitro receipts: the network cost is gasUsed × effectiveGasPrice (gasUsed includes L1 data gas); no l1Fee field. */
  l1DataFee: false,
});
/** The concentrated-liquidity runtime constants on Robinhood Chain (pool chosen per pair and fee tier). */
export const UNISWAP_V3_ROBINHOOD_LIQUIDITY = Object.freeze({
  network: UNISWAP_V3_ROBINHOOD.network, chain: UNISWAP_V3_ROBINHOOD.chain, chainId: UNISWAP_V3_ROBINHOOD.chainId, chainHex: UNISWAP_V3_ROBINHOOD.chainHex,
  protocol: 'uniswap-v3', adapterId: 'uniswap.v3', providerLabel: 'Uniswap v3', rpc: UNISWAP_V3_ROBINHOOD.rpc,
  explorer: `${UNISWAP_V3_ROBINHOOD.explorer}/`, officialSource: UNISWAP_V3_ROBINHOOD.officialSource,
  factory: UNISWAP_V3_ROBINHOOD.factory, positionManager: UNISWAP_V3_ROBINHOOD.positionManager,
  gasPriceOracle: null, maximumSlippageBps: 300, defaultSlippageBps: 100, reviewTtlSeconds: 60, mintDeadlineSeconds: 900,
});
/** Per-side sanity bound of a Robinhood Chain position (the catalog swap's bound: 10^9 whole tokens); real amounts are checked against balances. */
export const robinhoodLiquidityMaximumUnits = catalogLiquidityMaximumUnits;
/** BUILD-BASE-001: the Robinhood Chain deployment as the shared catalog-pool builder consumes it (no OP Stack L1 fee). */
export const UNISWAP_V3_ROBINHOOD_CATALOG: UniswapCatalogLiquidity = Object.freeze({ ...UNISWAP_V3_ROBINHOOD_LIQUIDITY, weth: UNISWAP_V3_ROBINHOOD.weth,
  poolInitCodeHash: UNISWAP_V3_ROBINHOOD.poolInitCodeHash, feeTiers: UNISWAP_V3_ROBINHOOD.feeTiers,
  codeSha256: Object.freeze({ factory: UNISWAP_V3_ROBINHOOD.codeSha256.factory, positionManager: UNISWAP_V3_ROBINHOOD.codeSha256.positionManager }) });
/**
 * A Uniswap v3 pool on Robinhood Chain as a liquidity runtime: the CREATE2 pool of the pinned factory for (tokenA, tokenB, fee),
 * tokens in pool order. Identity, code and live state are verified at simulation; an unknown fee tier or identical tokens fail closed.
 */
export function robinhoodLiquidityPool(tokenA: Omit<UniswapPoolToken, 'maximumAmount'>, tokenB: Omit<UniswapPoolToken, 'maximumAmount'>, fee: number): UniswapPoolProfile {
  return catalogLiquidityPool(UNISWAP_V3_ROBINHOOD_CATALOG, tokenA, tokenB, fee);
}
export { uniswapV3PoolAddress };
