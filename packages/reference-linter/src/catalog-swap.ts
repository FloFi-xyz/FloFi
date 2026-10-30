// SPDX-License-Identifier: AGPL-3.0-only
import { isCatalogSwapNode, readCatalogSwapNode, type CatalogAssetRef, type CatalogSwapFields, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { ETHEREUM_BASE_ASSETS, ARBITRUM_BASE_ASSETS, BASE_BASE_ASSETS, ROBINHOOD_BASE_ASSETS, type AssetCatalog } from '@defi-workflow-engine/action-registry';
export { isCatalogSwapNode };
/** The code-pinned base assets of each catalog network. */
const BASE_ASSETS: Readonly<Record<string, AssetCatalog>> = Object.freeze({ [ROBINHOOD_BASE_ASSETS.chain]: ROBINHOOD_BASE_ASSETS,
  [BASE_BASE_ASSETS.chain]: BASE_BASE_ASSETS, [ARBITRUM_BASE_ASSETS.chain]: ARBITRUM_BASE_ASSETS, [ETHEREUM_BASE_ASSETS.chain]: ETHEREUM_BASE_ASSETS });
/** Networks whose other catalog assets are issuer-registered (official id, 18 decimals): Robinhood Chain Stock Tokens. */
const ISSUER_REGISTERED: ReadonlySet<string> = new Set([ROBINHOOD_BASE_ASSETS.chain]);
/**
 * Authoring identity of one catalog asset, without network access: a pinned base asset must match its address and decimals exactly
 * and carries no official id. On Robinhood Chain any other asset must be an issuer-registered asset (official id, 18 decimals); on
 * Base (BUILD-BASE-001) any other asset is a listed token, which carries no official id. Membership in the current official catalog,
 * and the contract's own `decimals()`, are proven at Simulate, never assumed here.
 */
export function validateCatalogAssetIdentity(ref: CatalogAssetRef): void {
  const pinned = BASE_ASSETS[ref.chain];
  // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the network's native ETH (every catalog network's native currency) — no address, 18 decimals, no official id.
  if (ref.address === null) { if (!pinned || ref.decimals !== 18 || ref.officialId !== null) throw new Error('CATALOG_SWAP_ASSET_IDENTITY_INVALID'); return; }
  const base = pinned?.assets.find(asset => asset.address === ref.address);
  const valid = !pinned ? false : base ? base.decimals === ref.decimals && ref.officialId === null
    : ISSUER_REGISTERED.has(ref.chain) ? ref.officialId !== null && ref.decimals === 18
    : ref.officialId === null && Number.isSafeInteger(ref.decimals) && ref.decimals >= 0 && ref.decimals <= 36;
  if (!valid) throw new Error('CATALOG_SWAP_ASSET_IDENTITY_INVALID');
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
