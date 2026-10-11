// SPDX-License-Identifier: AGPL-3.0-only
import { UNISWAP_V3_ETHEREUM_SEPOLIA as ethereum, UNISWAP_V3_ROBINHOOD as robinhood } from '@defi-workflow-engine/action-registry';
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
} as const);
export type PairSwapProfile = typeof BASE_SEPOLIA | typeof ETHEREUM_SEPOLIA_SWAP;
export type CatalogSwapProfile = typeof ROBINHOOD_MAINNET_SWAP;
/** The exact USDC/WETH public-testnet pair profiles (unchanged by BUILD-RH-002). */
export type PublicSwapProfile = PairSwapProfile;
export const PUBLIC_SWAP_PROFILES: readonly PublicSwapProfile[] = Object.freeze([BASE_SEPOLIA, ETHEREUM_SEPOLIA_SWAP]);
/** The public pair swap profile of a CAIP-2 chain or numeric chain id; null for any other chain. */
export function publicSwapProfile(chain: string | number | null | undefined): PublicSwapProfile | null {
  return PUBLIC_SWAP_PROFILES.find(profile => profile.chainRef === chain || profile.chainId === chain) ?? null;
}
/** Every profile the shared owner-wallet Uniswap swap service serves: the testnet pairs and the BUILD-RH-002 catalog networks. */
export type SwapProfile = PairSwapProfile | CatalogSwapProfile;
export const SWAP_PROFILES: readonly SwapProfile[] = Object.freeze([...PUBLIC_SWAP_PROFILES, ROBINHOOD_MAINNET_SWAP]);
export function swapProfile(chain: string | number | null | undefined): SwapProfile | null {
  return SWAP_PROFILES.find(profile => profile.chainRef === chain || profile.chainId === chain) ?? null;
}
/** Decimals of a quote side: bound by catalog quotes, implied by the USDC/WETH symbol on testnet pair quotes. */
export function quoteDecimals(quote: { readonly inputSymbol: string; readonly outputSymbol: string; readonly inputDecimals?: number; readonly outputDecimals?: number },
  side: 'input' | 'output'): number {
  const bound = side === 'input' ? quote.inputDecimals : quote.outputDecimals;
  return bound ?? ((side === 'input' ? quote.inputSymbol : quote.outputSymbol) === 'USDC' ? 6 : 18);
}
