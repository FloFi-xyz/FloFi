// SPDX-License-Identifier: AGPL-3.0-only
import { isCatalogSwapNode, readCatalogSwapNode, type CatalogAssetRef, type CatalogSwapFields, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { ROBINHOOD_BASE_ASSETS, type AssetCatalog } from '@defi-workflow-engine/action-registry';
export { isCatalogSwapNode };
/** The code-pinned base assets of each catalog network. Anything else must carry an official issuer id. */
const BASE_ASSETS: Readonly<Record<string, AssetCatalog>> = Object.freeze({ [ROBINHOOD_BASE_ASSETS.chain]: ROBINHOOD_BASE_ASSETS });
/**
 * Authoring identity of one catalog-swap asset, without network access: a pinned base asset must match its address and
 * decimals exactly and carries no official id; any other asset must be an issuer-registered asset (official id, 18
 * decimals). Membership in the current official registry is proven at Simulate, never assumed here.
 */
export function validateCatalogAssetIdentity(ref: CatalogAssetRef): void {
  const base = BASE_ASSETS[ref.chain]?.assets.find(asset => asset.address === ref.address);
  if (base ? base.decimals !== ref.decimals || ref.officialId !== null : ref.officialId === null || ref.decimals !== 18)
    throw new Error('CATALOG_SWAP_ASSET_IDENTITY_INVALID');
}
/** One isolated catalog swap (templates may coexist, nothing may connect). */
export function validateCatalogSwapWorkflow(workflow: SemanticWorkflow): CatalogSwapFields {
  const nodes = workflow.nodes.filter(isCatalogSwapNode), id = nodes[0]?.nodeId ?? '';
  if (nodes.length !== 1 || workflow.nodes.some(n => n.nodeId !== id && !n.actionType.startsWith('mock-')) || nodes[0]!.dependencies.length ||
      workflow.resourceEdges.some(e => e.fromNodeId === id || e.toNodeId === id) || workflow.nodes.some(n => n.dependencies.includes(id)))
    throw new Error('CATALOG_SWAP_ISOLATED_ONLY');
  const fields = readCatalogSwapNode(nodes[0]!);
  validateCatalogAssetIdentity(fields.input);
  validateCatalogAssetIdentity(fields.output);
  return fields;
}
