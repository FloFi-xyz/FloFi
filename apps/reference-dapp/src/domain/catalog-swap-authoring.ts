// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: authoring of the canonical catalog swap from symbols — Robinhood Chain (Stock Tokens, USDG, WETH) and, since
 * BUILD-BASE-001, Base (pinned USDC/WETH and the validated token list). Symbols are resolved through the network's asset catalog to
 * chain + address + decimals (+ official id for issuer-registered assets); an unresolvable symbol, an unloaded official catalog or a
 * native asset fails closed. Base's USDC ⇄ WETH reference pair is not a catalog swap (it keeps its BUILD-002 declaration). Reading a
 * node back resolves its assets by address.
 */
import { formatAssetAmount, parseAssetAmount, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { catalogSwapKind, createCatalogSwapNode, isCatalogSwapNode, readCatalogSwapNode, type CatalogAssetRef, type CatalogSwapKind, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { resolveNetworkAsset } from './asset-catalogs';
import { SWAP_PROFILES, type CatalogSwapProfile } from './public-testnet-swap';
import { parseSlippage } from './swap-authoring';

type Node = SemanticWorkflow['nodes'][number];
export type CatalogSwapNetwork = CatalogSwapProfile['network'];
export type CatalogSwapInput = { readonly network: CatalogSwapNetwork; readonly from: string; readonly to: string; readonly amount: string; readonly slippage: string };
export const CATALOG_SWAP_NETWORKS = Object.freeze(Object.fromEntries(SWAP_PROFILES.filter(profile => profile.kind === 'CATALOG').map(profile => [profile.network, profile.chainRef])) as Record<CatalogSwapNetwork, string>);
const networkOfChain = (chain: string): CatalogSwapNetwork | null =>
  (Object.keys(CATALOG_SWAP_NETWORKS) as CatalogSwapNetwork[]).find(network => CATALOG_SWAP_NETWORKS[network] === chain) ?? null;
/**
 * BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a catalog side by symbol. The network's native ETH (the catalog's NATIVE asset) is its own asset — never WETH;
 * WETH stays the ERC-20 it is. Before this build a native asset was refused (SWAP_NATIVE_ASSET_UNSUPPORTED).
 */
function side(chain: string, symbol: string): { asset: CanonicalAsset; ref: CatalogAssetRef } {
  const asset = resolveNetworkAsset(chain, { symbol });
  if (!asset) throw new Error('ASSET_CATALOG_UNAVAILABLE');
  if (asset.kind === 'NATIVE') {
    if (asset.symbol !== 'ETH' || asset.decimals !== 18) throw new Error('SWAP_NATIVE_ASSET_UNSUPPORTED');
    return { asset, ref: { chain, address: null, decimals: 18, officialId: null } };
  }
  if (asset.kind !== 'ERC20') throw new Error('SWAP_NATIVE_ASSET_UNSUPPORTED');
  return { asset, ref: { chain: asset.chain, address: asset.address!, decimals: asset.decimals, officialId: asset.stock?.officialId ?? null } };
}
export function createCatalogSwapAuthoringNode(nodeId: string, input: CatalogSwapInput): Node {
  const chain = Object.hasOwn(CATALOG_SWAP_NETWORKS, input.network) ? CATALOG_SWAP_NETWORKS[input.network] : null;
  if (!chain) throw new Error('CATALOG_SWAP_NETWORK_UNSUPPORTED');
  if (input.from.toUpperCase() === input.to.toUpperCase()) throw new Error('INVALID_ASSET_PAIR');
  const from = side(chain, input.from), to = side(chain, input.to);
  // ETH ⇄ WETH9 is a 1:1 WETH9 conversion: no pool and no slippage (a slippage the owner typed for it does not apply).
  const conversion = catalogSwapKind({ chain, input: from.ref, output: to.ref }) !== 'SWAP';
  return createCatalogSwapNode(nodeId, { chain, amount: parseAssetAmount(input.amount, from.asset.decimals), slippageBps: conversion ? 0 : parseSlippage(input.slippage),
    input: from.ref, output: to.ref });
}
export type CatalogSwapDetails = { readonly network: CatalogSwapNetwork; readonly from: string; readonly to: string; readonly fromAsset: CanonicalAsset | null;
  readonly toAsset: CanonicalAsset | null; readonly units: string; readonly amount: string; readonly slippage: number; readonly stockPurchase: boolean;
  /** BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a pool swap, or a WETH9 wrap / unwrap of the network's native ETH. */ readonly kind: CatalogSwapKind };
/** A canonical catalog swap's display details. Unresolved assets (catalog not loaded) keep a neutral label, never a guess. */
export function catalogSwapDetails(node: { readonly actionType: string; readonly chainId: string }): CatalogSwapDetails | null {
  if (!isCatalogSwapNode(node)) return null;
  const network = networkOfChain(node.chainId);
  let fields;
  try { fields = readCatalogSwapNode({ ...node as Node, dependencies: [] }); } catch { return null; }
  if (!network) return null;
  const resolve = (ref: CatalogAssetRef) => ref.address === null ? resolveNetworkAsset(fields.chain, { symbol: 'ETH' }) : resolveNetworkAsset(fields.chain, { address: ref.address });
  const fromAsset = resolve(fields.input), toAsset = resolve(fields.output);
  // A resolved asset must still match the authored decimals (a listing change never relabels an authored amount).
  const label = (asset: CanonicalAsset | null, decimals: number, officialId: string | null) =>
    asset && asset.decimals === decimals && (asset.stock?.officialId ?? null) === officialId ? asset.symbol : officialId ? 'Stock Token' : 'Token';
  // The native side is ETH by its canonical identity, also when no catalog is loaded (it is never a token address).
  const from = fields.input.address === null ? 'ETH' : label(fromAsset, fields.input.decimals, fields.input.officialId);
  const to = fields.output.address === null ? 'ETH' : label(toAsset, fields.output.decimals, fields.output.officialId);
  return { network, from, to, fromAsset, toAsset, units: fields.amount, amount: formatAssetAmount(fields.amount, fields.input.decimals),
    slippage: fields.slippageBps, stockPurchase: fromAsset?.symbol === 'USDG' && fields.output.officialId !== null, kind: catalogSwapKind(fields) };
}
