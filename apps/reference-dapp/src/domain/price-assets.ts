// SPDX-License-Identifier: AGPL-3.0-only
import { ARBITRUM_BASE_ASSETS, BASE_BASE_ASSETS, ETHEREUM_BASE_ASSETS, JUPITER_SOLANA_MAINNET, SOLANA_MAINNET_TOKENS,
  UNISWAP_V3_ARBITRUM, UNISWAP_V3_BASE, UNISWAP_V3_ETHEREUM, UNISWAP_V3_ROBINHOOD } from '@defi-workflow-engine/action-registry';

export const DISPLAY_PRICE_ASSETS = ['ETH', 'SOL', 'USDC', 'USDT'] as const;
export type DisplayPriceAsset = (typeof DISPLAY_PRICE_ASSETS)[number];
export const ETHEREUM_USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
/** Issuer-canonical stablecoins. The same symbol at another address says nothing about the asset's value. */
export const CANONICAL_STABLECOINS: ReadonlyMap<string, { readonly asset: 'USDC' | 'USDT'; readonly decimals: number }> = new Map([
  ...[ETHEREUM_BASE_ASSETS, BASE_BASE_ASSETS, ARBITRUM_BASE_ASSETS].flatMap(pinned => pinned.assets
    .filter(asset => asset.symbol === 'USDC' && asset.assetClass === 'STABLECOIN' && asset.address)
    .map(asset => [`${pinned.chain}:${asset.address!.toLowerCase()}`, { asset: 'USDC' as const, decimals: asset.decimals }] as const)),
  [`${ETHEREUM_BASE_ASSETS.chain}:${ETHEREUM_USDT}`, { asset: 'USDT', decimals: 6 }],
  [`${JUPITER_SOLANA_MAINNET.chain}:${SOLANA_MAINNET_TOKENS.USDC.mint}`, { asset: 'USDC', decimals: SOLANA_MAINNET_TOKENS.USDC.decimals }],
  [`${JUPITER_SOLANA_MAINNET.chain}:${SOLANA_MAINNET_TOKENS.USDT.mint}`, { asset: 'USDT', decimals: SOLANA_MAINNET_TOKENS.USDT.decimals }],
]);

export function canonicalStablecoin(chain: string, address: string, decimals: number): 'USDC' | 'USDT' | null {
  const known = CANONICAL_STABLECOINS.get(`${chain}:${chain.startsWith('eip155:') ? address.toLowerCase() : address}`);
  return known && known.decimals === decimals ? known.asset : null;
}

const WRAPPED_ETH: Readonly<Record<string, string>> = {
  'eip155:1': UNISWAP_V3_ETHEREUM.weth, 'eip155:8453': UNISWAP_V3_BASE.weth,
  'eip155:42161': UNISWAP_V3_ARBITRUM.weth, 'eip155:4663': UNISWAP_V3_ROBINHOOD.weth,
};

export function displayPriceAsset(ref: { chainId: string; decimals: number } & ({ address: string } | { nativeId: string })): DisplayPriceAsset | null {
  const address = 'address' in ref ? ref.address : null;
  const nativeId = 'nativeId' in ref ? ref.nativeId : null;
  const weth = WRAPPED_ETH[ref.chainId];
  if (weth && ref.decimals === 18 && (nativeId === 'ETH' || address?.toLowerCase() === weth.toLowerCase())) return 'ETH';
  if (ref.chainId === JUPITER_SOLANA_MAINNET.chain && ref.decimals === 9 && (nativeId === 'SOL' || address === SOLANA_MAINNET_TOKENS.SOL.mint)) return 'SOL';
  return address ? canonicalStablecoin(ref.chainId, address, ref.decimals) : null;
}
