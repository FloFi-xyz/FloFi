// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-ROUTER-001: deployment profile of the Cross-chain Router for its first pair, Base (8453) USDC → Arbitrum One
 * (42161) USDC. Underlying protocol: Across (SpokePool `deposit` on Base, `FilledRelay` on Arbitrum). Routing providers:
 * LI.FI (primary discovery, through the LI.FI Diamond) and Across (direct).
 *
 * Verified read-only on 2026-10-04 against https://mainnet.base.org (block ≈ 52,170,000) and
 * https://arb1.arbitrum.io/rpc (block ≈ 511,658,000): code present at every address; both SpokePools report their chain
 * id, `depositQuoteTimeBuffer` = 3600 and `fillDeadlineBuffer` = 21600; real `FundsDeposited` / `FilledRelay` logs match
 * the topics in the compiler; the LI.FI quote's `approvalAddress` / `transactionRequest.to` is the Diamond below and its
 * fee "swap" calls the fee forwarder below; the Across Swap API's `swapTx.to` and allowance spender is the Base
 * SpokePool. SpokePools and the Diamond are upgradeable proxies: the proxy runtime code is pinned here, and the
 * implementation observed at Review is bound into each Review commitment.
 */
/**
 * A router deployment profile: one supported pair on one network. Code-pin keys keep their BUILD-ROUTER-001 names
 * (`base*` = source chain, `arbitrum*` = destination chain; `baseUsdc`/`arbitrumUsdc` = the source/destination token) on every
 * network. BUILD-RH-002: a side's token is generic (`token`, `symbol`, `decimals`) because a route may map assets across chains
 * (Base or Arbitrum USDC → Robinhood USDG); `l1DataFee` says whether the source chain's receipts carry an OP Stack `l1Fee`.
 */
import { ARBITRUM_ONE } from './arbitrum-chain.js';
export type RouterProfile = {
  readonly id: string; readonly adapterId: 'flofi.router'; readonly underlyingProtocol: 'across';
  readonly network: 'MAINNET' | 'TESTNET'; readonly environment: 'MAINNET' | 'PUBLIC_TESTNET';
  readonly source: { readonly network: string; readonly chain: string; readonly chainId: number; readonly chainHex: string; readonly rpc: string;
    readonly explorer: string; readonly token: string; readonly symbol: string; readonly decimals: number; readonly spokePool: string;
    readonly lifiDiamond: string; readonly lifiFeeForwarder: string; readonly l1DataFee: boolean };
  readonly destination: { readonly network: string; readonly chain: string; readonly chainId: number; readonly chainHex: string; readonly rpc: string;
    readonly explorer: string; readonly token: string; readonly symbol: string; readonly decimals: number; readonly spokePool: string };
  readonly codeSha256: { readonly baseSpokePool: string; readonly baseLifiDiamond: string; readonly baseLifiFeeForwarder: string; readonly baseUsdc: string;
    readonly arbitrumSpokePool: string; readonly arbitrumUsdc: string };
  readonly providers: { readonly lifi: { readonly api: string; readonly integrator: string; readonly docs: string };
    readonly across: { readonly api: string; readonly docs: string } };
  readonly reviewTtlSeconds: number; readonly depositSafetyMarginSeconds: number; readonly defaultSlippageBps: number; readonly maximumSlippageBps: number;
  readonly finality: 'safe'; readonly destinationScanBlocks: number;
};
export const CROSSCHAIN_ROUTER_BASE_ARBITRUM: RouterProfile = Object.freeze({
  id: 'base-usdc-to-arbitrum-usdc', adapterId: 'flofi.router', underlyingProtocol: 'across', network: 'MAINNET', environment: 'MAINNET',
  source: Object.freeze({ network: 'Base', chain: 'eip155:8453', chainId: 8453, chainHex: '0x2105', rpc: 'https://mainnet.base.org',
    explorer: 'https://basescan.org/', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6,
    spokePool: '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64', lifiDiamond: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae',
    lifiFeeForwarder: '0xce40449b773a3e6e5e769adb4e567179d4828cbd', l1DataFee: true }),
  destination: Object.freeze({ network: ARBITRUM_ONE.name, chain: ARBITRUM_ONE.chain, chainId: ARBITRUM_ONE.chainId, chainHex: ARBITRUM_ONE.chainHex, rpc: ARBITRUM_ONE.rpc,
    explorer: ARBITRUM_ONE.explorer, token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, spokePool: '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a' }),
  /** SHA-256 of the runtime code read on 2026-10-04; a different deployment fails closed. */
  codeSha256: Object.freeze({
    baseSpokePool: '3cc5e539eb61133fec38655ae3f55d8e1f944fce2cbc02e151972cf9c9880545',
    baseLifiDiamond: 'a5f481fb142b210db0011bacc8dafa949714aa3a56ab4377efc1a080f987a296',
    baseLifiFeeForwarder: '8e1f9e10378ce2648b2d1cb2c7a4a061058bf202b2e7b8d68a70a17082728981',
    baseUsdc: '98d785fcb1bf847f287adc2310759fd94cc13e754b974bc72131382e8266f607',
    arbitrumSpokePool: '3cc5e539eb61133fec38655ae3f55d8e1f944fce2cbc02e151972cf9c9880545',
    arbitrumUsdc: 'b46445c0c96a50cd0ae6245d2ceb5058fbbcd24afad9cb878974d8f17b4655c8',
  }),
  providers: Object.freeze({
    lifi: Object.freeze({ api: 'https://li.quest/v1', integrator: 'flofi', docs: 'https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer' }),
    across: Object.freeze({ api: 'https://app.across.to/api', docs: 'https://docs.across.to/api-reference/swap/approval/get' }),
  }),
  /** A Review authorizes wallet requests for at most this long (and never past the provider quote's own validity). */
  reviewTtlSeconds: 180,
  /** A bridge deposit is never prepared closer than this to the SpokePool's quote-time limit or the fill deadline. */
  depositSafetyMarginSeconds: 300,
  defaultSlippageBps: 50, maximumSlippageBps: 300,
  /** Source and destination blocks must be at or below their chain's `safe` head before success is final. */
  finality: 'safe',
  /** Destination log scan window per observation (Arbitrum blocks are ≈ 0.25 s). */
  destinationScanBlocks: 2_000,
});
/**
 * BUILD-JOURNEY-001: the same router on public testnets with test USDC, Base Sepolia (84532) → Arbitrum Sepolia (421614),
 * so any external wallet can complete the journey without real funds or an operator opt-in.
 *
 * Verified read-only on 2026-10-04 against https://sepolia.base.org (block ≈ 47,686,000) and
 * https://sepolia-rollup.arbitrum.io/rpc (block ≈ 315,767,000): code present at every address; both SpokePools report
 * their chain id (84532 / 421614), deposits/fills not paused, `depositQuoteTimeBuffer` = 3600, `fillDeadlineBuffer` =
 * 21600; both SpokePool proxies carry the same runtime code as the mainnet Across proxies. The Across testnet Swap API
 * (`https://testnet.across.to/api/swap/approval`) answers with the Base Sepolia SpokePool as `swapTx.to` and allowance
 * spender; LI.FI (`https://li.quest/v1/quote`, `allowBridges=across`) answers with the Diamond and fee forwarder below.
 * Both calldata shapes decode byte-exactly with the router codecs. A real Across `FilledRelay` of Base Sepolia USDC to
 * Arbitrum Sepolia USDC was observed on 2026-10-04 (`0x7fba4c5d…7cb9`). Testnet relayer liquidity is small (the Across
 * API reported a 8.000352 USDC maximum deposit), hence the pair's 5 USDC ceiling.
 */
export const CROSSCHAIN_ROUTER_BASE_SEPOLIA_ARBITRUM_SEPOLIA: RouterProfile = Object.freeze({
  id: 'base-sepolia-usdc-to-arbitrum-sepolia-usdc', adapterId: 'flofi.router', underlyingProtocol: 'across', network: 'TESTNET', environment: 'PUBLIC_TESTNET',
  source: Object.freeze({ network: 'Base Sepolia', chain: 'eip155:84532', chainId: 84532, chainHex: '0x14a34', rpc: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org/', token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', symbol: 'USDC', decimals: 6,
    spokePool: '0x82b564983ae7274c86695917bbf8c99ecb6f0f8f', lifiDiamond: '0x816fc6eee47e3157a666827a0c06205294c81770',
    lifiFeeForwarder: '0xc7e003943ddae973d7d6455ab54a22e18302abeb', l1DataFee: true }),
  destination: Object.freeze({ network: 'Arbitrum Sepolia', chain: 'eip155:421614', chainId: 421614, chainHex: '0x66eee',
    rpc: 'https://sepolia-rollup.arbitrum.io/rpc', explorer: 'https://sepolia.arbiscan.io/', token: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', symbol: 'USDC', decimals: 6,
    spokePool: '0x7e63a5f1a8f0b4d0934b2f2327daed3f6bb2ee75' }),
  /** SHA-256 of the runtime code read on 2026-10-04; a different deployment fails closed. */
  codeSha256: Object.freeze({
    baseSpokePool: '3cc5e539eb61133fec38655ae3f55d8e1f944fce2cbc02e151972cf9c9880545',
    baseLifiDiamond: '1aa40e468f883ff7a9f061860064d14886dbd983d73cb2bff21df56363ad79e3',
    baseLifiFeeForwarder: '5e2c2193e2f00b726b31634ef323b30cf65cae3d78444403b43e6a5b8cc2e357',
    baseUsdc: 'e878b99fc0c17354c86c7edeb999c70c18cfd925abb0958496f027cbad996d28',
    arbitrumSpokePool: '3cc5e539eb61133fec38655ae3f55d8e1f944fce2cbc02e151972cf9c9880545',
    arbitrumUsdc: '6deb9dc1d51dd7acc0eb359f0bbbc65ae282468d57055aa231b056ca054312d7',
  }),
  providers: Object.freeze({
    lifi: Object.freeze({ api: 'https://li.quest/v1', integrator: 'flofi', docs: 'https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer' }),
    across: Object.freeze({ api: 'https://testnet.across.to/api', docs: 'https://docs.across.to/reference/testnet-environment' }),
  }),
  reviewTtlSeconds: 180, depositSafetyMarginSeconds: 300, defaultSlippageBps: 50, maximumSlippageBps: 300, finality: 'safe', destinationScanBlocks: 2_000,
});
/**
 * BUILD-RH-002: Robinhood Chain (4663) in and out through the same router, underlying Across, real funds. Across routes Base and
 * Arbitrum USDC to Robinhood **USDG** (and USDG back to USDC): a cross-asset route whose Review names both assets and itemizes
 * Across's stablecoin conversion fee (`internalizedSwap`). Verified read-only on 2026-10-11: the Robinhood SpokePool
 * (`app.across.to` `destinationSpokePoolAddress`) reports chain id 0x1237, the official WETH as wrapped native token,
 * `depositQuoteTimeBuffer` 3600 and `fillDeadlineBuffer` 21600, deposits and fills not paused; the Across Swap API answers each
 * direction with the source SpokePool as `swapTx.to` and allowance spender (selector 0xad5425c6, decoded by the router codec);
 * LI.FI routes through the Robinhood Diamond and fee forwarder below. Robinhood is an Arbitrum Orbit chain: no OP Stack `l1Fee`
 * (gasUsed already folds in L1 data gas). Code pins are the SHA-256 of the runtime code read on 2026-10-11.
 */
const ROBINHOOD_SIDE: RouterProfile['source'] = Object.freeze({ network: 'Robinhood Chain', chain: 'eip155:4663', chainId: 4663, chainHex: '0x1237',
  rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com/', token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG',
  decimals: 6, spokePool: '0xd29c85f15df544ba632c9e25829fd29d767d7978', lifiDiamond: '0xb477751b76cf82d00a686a1232f5fcd772414af3',
  lifiFeeForwarder: '0xf4bffe4dfc693f37715a47c15bda8af9ed8f7cf1', l1DataFee: false });
const ARBITRUM_SIDE: RouterProfile['source'] = Object.freeze({ ...CROSSCHAIN_ROUTER_BASE_ARBITRUM.destination, lifiDiamond: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae',
  lifiFeeForwarder: '0xce40449b773a3e6e5e769adb4e567179d4828cbd', l1DataFee: false });
const BASE_SIDE: RouterProfile['source'] = CROSSCHAIN_ROUTER_BASE_ARBITRUM.source;
const destinationOf = (side: RouterProfile['source']): RouterProfile['destination'] => Object.freeze({ network: side.network, chain: side.chain, chainId: side.chainId,
  chainHex: side.chainHex, rpc: side.rpc, explorer: side.explorer, token: side.token, symbol: side.symbol, decimals: side.decimals, spokePool: side.spokePool });
const PINS = Object.freeze({
  base: { spokePool: '3cc5e539eb61133fec38655ae3f55d8e1f944fce2cbc02e151972cf9c9880545', lifiDiamond: 'a5f481fb142b210db0011bacc8dafa949714aa3a56ab4377efc1a080f987a296',
    lifiFeeForwarder: '8e1f9e10378ce2648b2d1cb2c7a4a061058bf202b2e7b8d68a70a17082728981', token: '98d785fcb1bf847f287adc2310759fd94cc13e754b974bc72131382e8266f607' },
  arbitrum: { spokePool: '3cc5e539eb61133fec38655ae3f55d8e1f944fce2cbc02e151972cf9c9880545', lifiDiamond: '72211202d3d54f9e8b4590855d8f8390f1fad2d55c2472a3e488b58ccb61c2e9',
    lifiFeeForwarder: '8e1f9e10378ce2648b2d1cb2c7a4a061058bf202b2e7b8d68a70a17082728981', token: 'b46445c0c96a50cd0ae6245d2ceb5058fbbcd24afad9cb878974d8f17b4655c8' },
  robinhood: { spokePool: '10efc5eecc7c3f396d1ffe6d0e562751b603af26122eb44fc3fdfe135dbe9d04', lifiDiamond: 'f944e98f50ee2189577d0bb9fef38e8c16d8d01709bafe2b053bea3372008a8c',
    lifiFeeForwarder: '8e1f9e10378ce2648b2d1cb2c7a4a061058bf202b2e7b8d68a70a17082728981', token: 'c85d18dc1e49769e01f9f88981176e213b2bc24d2f14d33a81d54bc06579f6db' },
});
type Side = keyof typeof PINS;
const SIDES = Object.freeze({ base: BASE_SIDE, arbitrum: ARBITRUM_SIDE, robinhood: ROBINHOOD_SIDE });
/** A route between two verified sides (BUILD-RH-002; BUILD-BASE-001 reuses it for Arbitrum → Base). */
function routeBetween(id: string, from: Side, to: Side): RouterProfile {
  return Object.freeze({ id, adapterId: 'flofi.router', underlyingProtocol: 'across', network: 'MAINNET', environment: 'MAINNET',
    source: SIDES[from], destination: destinationOf(SIDES[to]),
    codeSha256: Object.freeze({ baseSpokePool: PINS[from].spokePool, baseLifiDiamond: PINS[from].lifiDiamond, baseLifiFeeForwarder: PINS[from].lifiFeeForwarder,
      baseUsdc: PINS[from].token, arbitrumSpokePool: PINS[to].spokePool, arbitrumUsdc: PINS[to].token }),
    providers: CROSSCHAIN_ROUTER_BASE_ARBITRUM.providers, reviewTtlSeconds: 180, depositSafetyMarginSeconds: 300, defaultSlippageBps: 50, maximumSlippageBps: 300,
    finality: 'safe', destinationScanBlocks: 2_000 });
}
export const CROSSCHAIN_ROUTER_BASE_ROBINHOOD = routeBetween('base-usdc-to-robinhood-usdg', 'base', 'robinhood');
export const CROSSCHAIN_ROUTER_ROBINHOOD_BASE = routeBetween('robinhood-usdg-to-base-usdc', 'robinhood', 'base');
export const CROSSCHAIN_ROUTER_ARBITRUM_ROBINHOOD = routeBetween('arbitrum-usdc-to-robinhood-usdg', 'arbitrum', 'robinhood');
export const CROSSCHAIN_ROUTER_ROBINHOOD_ARBITRUM = routeBetween('robinhood-usdg-to-arbitrum-usdc', 'robinhood', 'arbitrum');
/**
 * BUILD-BASE-001: Base bridge IN from Arbitrum One — Arbitrum USDC → Base USDC through the same router and Across, the reverse of the
 * BUILD-ROUTER-001 pair. Verified read-only on 2026-10-11: `app.across.to` lists the route; the Across Swap API answers with the
 * Arbitrum SpokePool (code pin below, `chainId()` 42161, deposits and fills not paused, buffers 3600/21600) as `swapTx.to` and allowance
 * spender (selector 0xad5425c6); LI.FI (`allowBridges=across`) answers through the Arbitrum Diamond with fee lines that sum exactly to
 * input − output. Both sides reuse the pins verified for the existing routes (identical runtime code on 2026-10-11).
 */
export const CROSSCHAIN_ROUTER_ARBITRUM_BASE = routeBetween('arbitrum-usdc-to-base-usdc', 'arbitrum', 'base');
export type CrossChainRouterProfile = RouterProfile;
export const CROSSCHAIN_ROUTER_PROFILES: readonly RouterProfile[] = Object.freeze([CROSSCHAIN_ROUTER_BASE_ARBITRUM, CROSSCHAIN_ROUTER_BASE_SEPOLIA_ARBITRUM_SEPOLIA,
  CROSSCHAIN_ROUTER_BASE_ROBINHOOD, CROSSCHAIN_ROUTER_ROBINHOOD_BASE, CROSSCHAIN_ROUTER_ARBITRUM_ROBINHOOD, CROSSCHAIN_ROUTER_ROBINHOOD_ARBITRUM, CROSSCHAIN_ROUTER_ARBITRUM_BASE]);
/** The profile serving one canonical pair (source and destination CAIP-2 chains), or null. */
export function routerProfileFor(sourceChain: string, destinationChain: string): RouterProfile | null {
  return CROSSCHAIN_ROUTER_PROFILES.find(p => p.source.chain === sourceChain && p.destination.chain === destinationChain) ?? null;
}
