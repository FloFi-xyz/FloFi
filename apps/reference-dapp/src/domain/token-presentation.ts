// SPDX-License-Identifier: AGPL-3.0-only
import { resolveNetworkAsset } from './asset-catalogs.ts';
/** Never infer identity from a symbol: only a network-bound official catalog address can clarify USDC. */
export function bridgeTokenSymbol(chain: string, token: { address?: string | null; symbol: string }): string {
  if (!token.address) return token.symbol;
  const asset = resolveNetworkAsset(chain, { address: token.address });
  if (asset?.symbol === 'USDC.e') return 'USDC.e';
  return asset?.symbol === 'USDC' ? 'USDC (native)' : token.symbol;
}
