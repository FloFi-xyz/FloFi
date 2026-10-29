// SPDX-License-Identifier: AGPL-3.0-only
import { isCatalogSwapNode } from '@defi-workflow-engine/workflow-contracts';
import { UNISWAP_V3_ETHEREUM as mainnet, UNISWAP_V3_ARBITRUM as arbitrum, UNISWAP_V3_BASE as base, UNISWAP_V3_ETHEREUM_SEPOLIA as ethereum, UNISWAP_V3_ROBINHOOD as robinhood } from '@defi-workflow-engine/action-registry';
/** Pinned Base Sepolia Uniswap v3 profile; verified again against public chain state before use. */
export const BASE_SEPOLIA = Object.freeze({
  chainId: 84532, chainHex: '0x14a34', chainRef: 'eip155:84532', network: 'Base Sepolia',
  rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org/tx/',
  factory: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
  router: '0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4',
  quoter: '0xc5290058841028f1614f3a6f0f5816cad0df5e27',
  usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  weth: '0x4200000000000000000000000000000000000006',
  pool: '0x94bfc0574ff48e92ce43d495376c477b1d0eeec0', fee: 500,
  /** OP Stack receipts carry a separate L1 data fee (`l1Fee`) that is part of the owner's cost. */
  l1DataFee: true, kind: 'PAIR', environment: 'PUBLIC_TESTNET',
});
/** BUILD-ETHEREUM-001: the Ethereum Sepolia USDC/WETH 0.3% profile; every identity is re-verified against chain state before use. */
export const ETHEREUM_SEPOLIA_SWAP = Object.freeze({
  chainId: ethereum.chainId, chainHex: ethereum.chainHex, chainRef: ethereum.chain, network: ethereum.network,
  rpcUrl: ethereum.rpc, explorer: `${ethereum.explorer}/tx/`,
  factory: ethereum.factory, router: ethereum.router, quoter: ethereum.quoter, usdc: ethereum.usdc, weth: ethereum.weth,
  pool: ethereum.pool, fee: ethereum.fee,
  /** Ethereum L1: the network cost is gasUsed × effectiveGasPrice; a receipt l1Fee would be unexplained. */
  l1DataFee: false, kind: 'PAIR', environment: 'PUBLIC_TESTNET',
});
/**
 * BUILD-RH-002: Robinhood Chain mainnet (real funds) over the official asset catalog. Any catalog pair (Stock Tokens, USDG,
 * WETH) with a live canonical Uniswap v3 pool; the pool and fee tier are chosen per quote from the locally derived canonical
 * pools and bound into the Review, never authored.
 */
export const ROBINHOOD_MAINNET_SWAP = Object.freeze({
  chainId: 4663, chainHex: '0x1237', chainRef: 'eip155:4663', network: robinhood.network,
  rpcUrl: robinhood.rpc, explorer: `${robinhood.explorer}/tx/`,
  factory: robinhood.factory, router: robinhood.router, quoter: robinhood.quoter, weth: robinhood.weth,
  poolInitCodeHash: robinhood.poolInitCodeHash, feeTiers: robinhood.feeTiers, codeSha256: robinhood.codeSha256,
  stockTokenBeacon: robinhood.stockTokenBeacon, beaconSlot: robinhood.beaconSlot, reviewTtlSeconds: robinhood.reviewTtlSeconds,
  /** Arbitrum Nitro: gasUsed already includes L1 data gas; a receipt never carries `l1Fee`. */
  l1DataFee: false, kind: 'CATALOG', environment: 'MAINNET',
  /** Run namespace of this catalog network; the code-pinned tokens by address; only pinned assets and Stock Tokens exist here. */
  runPrefix: 'rhs', pinnedTokens: { [robinhood.weth]: 'weth', [robinhood.usdg]: 'usdg' }, listedTokens: 'REFUSE', referencePair: null,
  /** BUILD-FLOFI-BRIDGE-LIVE-FIX-003: this WETH (an Arbitrum-style aeWETH) logs a wrap as a Transfer mint and an unwrap as a Transfer burn. */
  wethEvents: 'MINT_BURN',
} as const);
/**
 * BUILD-BASE-001: Base mainnet (real funds) over the Base asset catalog (pinned ETH/USDC/WETH and the validated token list). Any catalog pair
 * with a live canonical Uniswap v3 pool; pool and fee tier are chosen per quote and bound into the Review. Base USDC ⇄ WETH keeps its
 * BUILD-002 declaration (`referencePair`) and is read into the same fields. A listed token is verified by code presence and its own
 * `decimals()` (listing is never authority); USDC and WETH carry their pinned code.
 */
export const BASE_MAINNET_SWAP = Object.freeze({
  chainId: 8453, chainHex: '0x2105', chainRef: 'eip155:8453', network: base.network,
  rpcUrl: base.rpc, explorer: `${base.explorer}/tx/`,
  factory: base.factory, router: base.router, quoter: base.quoter, weth: base.weth, usdc: base.usdc,
  poolInitCodeHash: base.poolInitCodeHash, feeTiers: base.feeTiers, codeSha256: base.codeSha256, reviewTtlSeconds: base.reviewTtlSeconds,
  /** OP Stack: receipts carry a separate `l1Fee`, bounded through the GasPriceOracle before the wallet is asked. */
  l1DataFee: true, gasPriceOracle: base.gasPriceOracle, kind: 'CATALOG', environment: 'MAINNET',
  runPrefix: 'bas', pinnedTokens: { [base.weth]: 'weth', [base.usdc]: 'usdc' }, listedTokens: 'CODE_AND_DECIMALS', referencePair: [base.usdc, base.weth],
  /** BUILD-FLOFI-BRIDGE-LIVE-FIX-003: canonical WETH9 logs `Deposit(dst, wad)` and `Withdrawal(src, wad)`. */
  wethEvents: 'WETH9',
} as const);
/** Arbitrum Nitro: standard estimates and receipts already include parent posting gas. Strict owner-bound Review. */
export const ARBITRUM_MAINNET_SWAP = Object.freeze({
  chainId: arbitrum.chainId, chainHex: arbitrum.chainHex, chainRef: arbitrum.chain, network: arbitrum.network,
  rpcUrl: arbitrum.rpc, explorer: `${arbitrum.explorer}tx/`, factory: arbitrum.factory, router: arbitrum.router, quoter: arbitrum.quoter,
  weth: arbitrum.weth, usdc: arbitrum.usdc, poolInitCodeHash: arbitrum.poolInitCodeHash, feeTiers: arbitrum.feeTiers,
  codeSha256: arbitrum.codeSha256, reviewTtlSeconds: arbitrum.reviewTtlSeconds, l1DataFee: false, kind: 'CATALOG', environment: 'MAINNET',
  runPrefix: 'ars', pinnedTokens: { [arbitrum.weth]: 'weth', [arbitrum.usdc]: 'usdc' }, listedTokens: 'CODE_AND_DECIMALS', referencePair: null,
  ownerBoundReview: true, wethEvents: 'MINT_BURN',
} as const);
export const ETHEREUM_MAINNET_SWAP = Object.freeze({
  chainId: mainnet.chainId, chainHex: mainnet.chainHex, chainRef: mainnet.chain, network: mainnet.network,
  rpcUrl: mainnet.rpc, explorer: `${mainnet.explorer}/tx/`, factory: mainnet.factory, router: mainnet.router, quoter: mainnet.quoter,
  weth: mainnet.weth, usdc: mainnet.usdc, poolInitCodeHash: mainnet.poolInitCodeHash, feeTiers: mainnet.feeTiers,
  codeSha256: mainnet.codeSha256, reviewTtlSeconds: mainnet.reviewTtlSeconds, l1DataFee: false, kind: 'CATALOG', environment: 'MAINNET',
  runPrefix: 'ets', pinnedTokens: { [mainnet.weth]: 'weth', [mainnet.usdc]: 'usdc' }, listedTokens: 'CODE_AND_DECIMALS', referencePair: null,
  ownerBoundReview: true, wethEvents: 'WETH9',
} as const);
/** BUILD-FLOFI-BRIDGE-LIVE-FIX-003: EIP-7528's native-asset address: a quote side that is the network's native ETH, never a token contract. */
export const NATIVE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const ownerBoundSwapReview = (profile: SwapProfile) => 'ownerBoundReview' in profile && profile.ownerBoundReview;
export type PairSwapProfile = typeof BASE_SEPOLIA | typeof ETHEREUM_SEPOLIA_SWAP;
export type CatalogSwapProfile = typeof ROBINHOOD_MAINNET_SWAP | typeof BASE_MAINNET_SWAP | typeof ARBITRUM_MAINNET_SWAP | typeof ETHEREUM_MAINNET_SWAP;
/** The exact USDC/WETH public-testnet pair profiles (unchanged by BUILD-RH-002). */
export type PublicSwapProfile = PairSwapProfile;
export const PUBLIC_SWAP_PROFILES: readonly PublicSwapProfile[] = Object.freeze([BASE_SEPOLIA, ETHEREUM_SEPOLIA_SWAP]);
/** The public pair swap profile of a CAIP-2 chain or numeric chain id; null for any other chain. */
export function publicSwapProfile(chain: string | number | null | undefined): PublicSwapProfile | null {
  return PUBLIC_SWAP_PROFILES.find(profile => profile.chainRef === chain || profile.chainId === chain) ?? null;
}
/** Every profile the shared owner-wallet Uniswap swap service serves: the testnet pairs and the catalog networks (BUILD-RH-002, BUILD-BASE-001). */
export type SwapProfile = PairSwapProfile | CatalogSwapProfile;
export const SWAP_PROFILES: readonly SwapProfile[] = Object.freeze([...PUBLIC_SWAP_PROFILES, ROBINHOOD_MAINNET_SWAP, BASE_MAINNET_SWAP, ARBITRUM_MAINNET_SWAP, ETHEREUM_MAINNET_SWAP]);
export function swapProfile(chain: string | number | null | undefined): SwapProfile | null {
  return SWAP_PROFILES.find(profile => profile.chainRef === chain || profile.chainId === chain) ?? null;
}
/** Decimals of a quote side: bound by catalog quotes, implied by the USDC/WETH symbol on testnet pair quotes. */
export function quoteDecimals(quote: { readonly inputSymbol: string; readonly outputSymbol: string; readonly inputDecimals?: number; readonly outputDecimals?: number },
  side: 'input' | 'output'): number {
  const bound = side === 'input' ? quote.inputDecimals : quote.outputDecimals;
  return bound ?? ((side === 'input' ? quote.inputSymbol : quote.outputSymbol) === 'USDC' ? 6 : 18);
}
/**
 * BUILD-BASE-001: whether the shared owner-wallet swap serves this swap node. Every testnet pair and catalog-network swap does. Base's
 * USDC ⇄ WETH reference swap (BUILD-002 declaration) does only where this instance serves Base mainnet swaps and no local fork runtime is
 * available (`referenceServed`); otherwise it keeps its BUILD-002 observation and fork paths, unchanged.
 */
export function ownerWalletSwapServes(node: { readonly actionType: string; readonly chainId: string }, referenceServed: boolean): boolean {
  const profile = node.actionType === 'asset.swap.exact-input' ? swapProfile(node.chainId) : null;
  if (!profile) return false;
  return profile.kind !== 'CATALOG' || !profile.referencePair || isCatalogSwapNode(node) || referenceServed;
}
