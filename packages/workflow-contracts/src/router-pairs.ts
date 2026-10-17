// SPDX-License-Identifier: Apache-2.0
/** BUILD-ROUTER-001: router identities and supported pairs. Dependency-free so schema validation can use it. */
export const ROUTER_ADAPTER = Object.freeze({ id: 'flofi.router', version: '1.0.0' } as const);
export const ROUTER_CAPABILITY = 'bridge.direct-transaction';
/** Routing providers the router can ask for a route. Order in the IR is the owner's preference. */
export const ROUTING_PROVIDERS = Object.freeze(['lifi', 'across'] as const);
export type RoutingProvider = typeof ROUTING_PROVIDERS[number];
/** Underlying bridge protocols whose settlement the router can reconcile independently on chain. */
export const RECONCILABLE_PROTOCOLS = Object.freeze(['across'] as const);
export type UnderlyingProtocol = typeof RECONCILABLE_PROTOCOLS[number];

export type RouterToken = { readonly chainId: string; readonly address: string; readonly decimals: number; readonly symbol: string };
const ROBINHOOD_USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export type RouterPair = { readonly id: string; readonly source: RouterToken; readonly destination: RouterToken;
  readonly minimumAmount: string; readonly maximumAmount: string };
/** Pairs the canonical IR accepts. Deployment details (contracts, RPCs, pins) live in the action registry profile. */
export const ROUTER_PAIRS: readonly RouterPair[] = Object.freeze([Object.freeze({
  id: 'base-usdc-to-arbitrum-usdc',
  source: Object.freeze({ chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC' }),
  destination: Object.freeze({ chainId: 'eip155:42161', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6, symbol: 'USDC' }),
  minimumAmount: '100000', maximumAmount: '100000000',
}), Object.freeze({
  // BUILD-JOURNEY-001: test USDC on public testnets; the ceiling stays below the Across testnet relayer's deposit limit.
  id: 'base-sepolia-usdc-to-arbitrum-sepolia-usdc',
  source: Object.freeze({ chainId: 'eip155:84532', address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', decimals: 6, symbol: 'USDC' }),
  destination: Object.freeze({ chainId: 'eip155:421614', address: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', decimals: 6, symbol: 'USDC' }),
  minimumAmount: '500000', maximumAmount: '5000000',
}),
// BUILD-RH-002: Robinhood Chain in and out (Across). USDC on Base or Arbitrum arrives on Robinhood as USDG, and USDG leaves as USDC:
// the destination asset is part of the pair, never assumed to be the source token. 1–100 per bridge, the release cap of Base → Arbitrum.
...([['base-usdc-to-robinhood-usdg', 'eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC', 'eip155:4663', ROBINHOOD_USDG, 'USDG'],
  ['robinhood-usdg-to-base-usdc', 'eip155:4663', ROBINHOOD_USDG, 'USDG', 'eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC'],
  ['arbitrum-usdc-to-robinhood-usdg', 'eip155:42161', '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'USDC', 'eip155:4663', ROBINHOOD_USDG, 'USDG'],
  ['robinhood-usdg-to-arbitrum-usdc', 'eip155:4663', ROBINHOOD_USDG, 'USDG', 'eip155:42161', '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'USDC']] as const)
  .map(([id, sourceChain, sourceAddress, sourceSymbol, destinationChain, destinationAddress, destinationSymbol]) => Object.freeze({ id,
    source: Object.freeze({ chainId: sourceChain, address: sourceAddress, decimals: 6, symbol: sourceSymbol }),
    destination: Object.freeze({ chainId: destinationChain, address: destinationAddress, decimals: 6, symbol: destinationSymbol }),
    minimumAmount: '1000000', maximumAmount: '100000000' })),
// BUILD-BASE-001: Base bridge IN from Arbitrum One, the reverse of the BUILD-ROUTER-001 pair with the same 0.1–100 USDC bounds.
Object.freeze({
  id: 'arbitrum-usdc-to-base-usdc',
  source: Object.freeze({ chainId: 'eip155:42161', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6, symbol: 'USDC' }),
  destination: Object.freeze({ chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC' }),
  minimumAmount: '100000', maximumAmount: '100000000',
}),
// Ethereum routes retain the existing Router ceilings and source-asset floors; providers enforce live liquidity and minimums.
...([
  ['ethereum-usdc-to-base-usdc', 'eip155:1', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC', 'eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC'],
  ['base-usdc-to-ethereum-usdc', 'eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC', 'eip155:1', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC'],
  ['ethereum-usdc-to-arbitrum-usdc', 'eip155:1', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC', 'eip155:42161', '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'USDC'],
  ['arbitrum-usdc-to-ethereum-usdc', 'eip155:42161', '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'USDC', 'eip155:1', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC'],
  ['ethereum-usdc-to-robinhood-usdg', 'eip155:1', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC', 'eip155:4663', ROBINHOOD_USDG, 'USDG'],
  ['robinhood-usdg-to-ethereum-usdc', 'eip155:4663', ROBINHOOD_USDG, 'USDG', 'eip155:1', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC'],
] as const).map(([id, from, input, inputSymbol, to, output, outputSymbol]) => Object.freeze({ id,
  source: Object.freeze({ chainId: from, address: input, decimals: 6, symbol: inputSymbol }),
  destination: Object.freeze({ chainId: to, address: output, decimals: 6, symbol: outputSymbol }), minimumAmount: from === 'eip155:4663' || to === 'eip155:4663' ? '1000000' : '100000', maximumAmount: '100000000' }))]);
export const ROUTER_MAXIMUM_SLIPPAGE_BPS = 300;
export function routerPair(sourceChain: string, sourceToken: string, destinationChain: string, destinationToken: string): RouterPair | null {
  return ROUTER_PAIRS.find(p => p.source.chainId === sourceChain && p.source.address === sourceToken &&
    p.destination.chainId === destinationChain && p.destination.address === destinationToken) ?? null;
}
