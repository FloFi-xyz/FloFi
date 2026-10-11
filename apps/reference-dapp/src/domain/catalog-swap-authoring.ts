// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: authoring of the canonical catalog swap (Robinhood Chain: Stock Tokens, USDG, WETH) from symbols. Symbols are
 * resolved through the network's asset catalog to chain + address + decimals + official id; an unresolvable symbol, an
 * unloaded official catalog or a native asset fails closed. Reading a node back resolves its assets by address.
 */
import { formatAssetAmount, parseAssetAmount, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { createCatalogSwapNode, isCatalogSwapNode, readCatalogSwapNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { ROBINHOOD_CHAIN, ROBINHOOD_NETWORK, resolveNetworkAsset } from './asset-catalogs';
import { parseSlippage } from './swap-authoring';

type Node = SemanticWorkflow['nodes'][number];
export type CatalogSwapInput = { readonly network: typeof ROBINHOOD_NETWORK; readonly from: string; readonly to: string; readonly amount: string; readonly slippage: string };
export const CATALOG_SWAP_NETWORKS = Object.freeze({ [ROBINHOOD_NETWORK]: ROBINHOOD_CHAIN } as const);
function erc20(symbol: string): CanonicalAsset {
  const asset = resolveNetworkAsset(ROBINHOOD_CHAIN, { symbol });
  if (!asset) throw new Error('ASSET_CATALOG_UNAVAILABLE');
  if (asset.kind !== 'ERC20') throw new Error('SWAP_NATIVE_ASSET_UNSUPPORTED');
  return asset;
}
export function createCatalogSwapAuthoringNode(nodeId: string, input: CatalogSwapInput): Node {
  if (input.network !== ROBINHOOD_NETWORK) throw new Error('CATALOG_SWAP_NETWORK_UNSUPPORTED');
  if (input.from.toUpperCase() === input.to.toUpperCase()) throw new Error('INVALID_ASSET_PAIR');
  const from = erc20(input.from), to = erc20(input.to);
  return createCatalogSwapNode(nodeId, { chain: ROBINHOOD_CHAIN, amount: parseAssetAmount(input.amount, from.decimals), slippageBps: parseSlippage(input.slippage),
    input: { chain: from.chain, address: from.address!, decimals: from.decimals, officialId: from.stock?.officialId ?? null },
    output: { chain: to.chain, address: to.address!, decimals: to.decimals, officialId: to.stock?.officialId ?? null } });
}
export type CatalogSwapDetails = { readonly network: typeof ROBINHOOD_NETWORK; readonly from: string; readonly to: string; readonly fromAsset: CanonicalAsset | null;
  readonly toAsset: CanonicalAsset | null; readonly units: string; readonly amount: string; readonly slippage: number; readonly stockPurchase: boolean };
/** A canonical catalog swap's display details. Unresolved assets (catalog not loaded) keep a neutral label, never a guess. */
export function catalogSwapDetails(node: { readonly actionType: string; readonly chainId: string }): CatalogSwapDetails | null {
  if (!isCatalogSwapNode(node)) return null;
  let fields;
  try { fields = readCatalogSwapNode(node as Node); } catch { return null; }
  const fromAsset = resolveNetworkAsset(fields.chain, { address: fields.input.address }), toAsset = resolveNetworkAsset(fields.chain, { address: fields.output.address });
  const label = (asset: CanonicalAsset | null, officialId: string | null) => asset && (asset.stock?.officialId ?? null) === officialId ? asset.symbol : officialId ? 'Stock Token' : 'Token';
  const from = label(fromAsset, fields.input.officialId), to = label(toAsset, fields.output.officialId);
  return { network: ROBINHOOD_NETWORK, from, to, fromAsset, toAsset, units: fields.amount, amount: formatAssetAmount(fields.amount, fields.input.decimals),
    slippage: fields.slippageBps, stockPurchase: fromAsset?.symbol === 'USDG' && fields.output.officialId !== null };
}
