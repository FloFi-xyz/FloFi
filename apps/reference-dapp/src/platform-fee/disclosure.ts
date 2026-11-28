// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (completion, §3.5): the FloFi fee as ONE compact line of an existing cost summary:
 * "FloFi fee (0.80%)" / "Taxa FloFi (0,80%)" and its amount per fee asset (six significant digits, the product's display rule). The amount comes
 * from the same basis the server records as the authorized cap (`semantic-basis.ts`). While collection is not active the same line ends with
 * "not charged" / "não cobrada": the owner never reads a cost they will not pay as one they will. No line when nothing is feeable.
 */
import { SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { resolveNetworkAsset } from '../domain/asset-catalogs';
import { formatDisplayTokenAmount } from '../domain/token-amount-display';
import { PLATFORM_FEE_PERCENT_LABEL, PLATFORM_FEE_PERCENT_LABEL_PT } from './policy';
import type { FeeBasis, FeeLine } from './principal';

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export function feeAssetSymbol(line: Pick<FeeLine, 'chainId' | 'address' | 'decimals'>): string | null {
  if (line.chainId.startsWith('solana:')) return Object.values(SOLANA_MAINNET_TOKENS).find(t => t.mint === line.address && t.decimals === line.decimals)?.symbol ?? null;
  if (line.address === NATIVE) return 'ETH';
  const asset = resolveNetworkAsset(line.chainId, { address: line.address });
  return asset && asset.decimals === line.decimals ? asset.symbol : null;
}

/** The fee amount of a basis in English display form ("0.8 USDC", several assets joined by " + "), or null when nothing is feeable. */
export function feeAmountText(basis: Pick<FeeBasis, 'status' | 'lines'>, workflow?: { readonly nodes: readonly unknown[] }): string | null {
  if (basis.status !== 'FEEABLE' || !basis.lines.length) return null;
  const parts = basis.lines.map(line => {
    const symbol = feeAssetSymbol(line) ?? workflowSymbol(workflow, line);
    return symbol ? `${formatDisplayTokenAmount({ units: line.fee, decimals: line.decimals }, { language: 'EN', marker: false })} ${symbol}` : null;
  });
  // An amount without its asset would be ambiguous: no line rather than a bare number.
  return parts.every(part => part !== null) ? parts.join(' + ') : null;
}
/** The symbol the reviewed workflow itself names for an exact asset identity (its MAXIMUM_INPUT quantity), when the catalog is not loaded. */
function workflowSymbol(workflow: { readonly nodes: readonly unknown[] } | undefined, line: Pick<FeeLine, 'chainId' | 'address' | 'decimals'>): string | null {
  for (const node of workflow?.nodes ?? []) {
    const limits = (node as { userConstraints?: { kind?: string; quantity?: { asset?: { chainId?: string; address?: string; nativeId?: string; decimals?: number; symbol?: string } } }[] })
      .userConstraints ?? [];
    for (const limit of limits) {
      const asset = limit.kind === 'MAXIMUM_INPUT' ? limit.quantity?.asset : undefined;
      if (!asset || asset.chainId !== line.chainId || asset.decimals !== line.decimals || typeof asset.symbol !== 'string') continue;
      const address = asset.address ? (line.chainId.startsWith('eip155:') ? asset.address.toLowerCase() : asset.address) : null;
      if (address === line.address || (!address && asset.nativeId && line.address === NATIVE)) return asset.symbol;
    }
  }
  return null;
}

export type FeeDisclosure = { readonly label: string; readonly value: string; readonly charged: boolean };
export function platformFeeDisclosure(basis: Pick<FeeBasis, 'status' | 'lines'>, language: 'EN' | 'PT', collectionActive: boolean): FeeDisclosure | null {
  if (basis.status !== 'FEEABLE' || !basis.lines.length) return null;
  const amounts = basis.lines.map(line => `${formatDisplayTokenAmount({ units: line.fee, decimals: line.decimals }, { language })} ${feeAssetSymbol(line) ?? ''}`.trim());
  const label = language === 'PT' ? `Taxa FloFi (${PLATFORM_FEE_PERCENT_LABEL_PT})` : `FloFi fee (${PLATFORM_FEE_PERCENT_LABEL})`;
  const value = amounts.join(' + ') + (collectionActive ? '' : language === 'PT' ? ' · não cobrada' : ' · not charged');
  return { label, value, charged: collectionActive };
}
