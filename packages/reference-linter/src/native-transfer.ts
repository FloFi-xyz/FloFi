// SPDX-License-Identifier: AGPL-3.0-only
import { readTransferNode, TRANSFER_ACTION, type TransferFields, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { NATIVE_TRANSFER_PROFILES, transferAllowsRecipients, transferAllowsTokens } from '@defi-workflow-engine/action-registry';
import { validateCatalogAssetIdentity } from './catalog-swap.js';
/**
 * One isolated transfer on a network with a transfer profile; templates may coexist, nothing may connect. The testnet profiles
 * (RH-DEMO-001 Robinhood Testnet, BUILD-ETHEREUM-001 Ethereum Sepolia) remain native self-transfers only. BUILD-RH-002: Robinhood
 * Chain mainnet also accepts an explicit recipient and catalog ERC-20s (pinned base assets, or issuer-registered assets bound by
 * their official id). Networks without a registered transfer profile are refused.
 */
export function validateNativeTransferWorkflow(workflow: SemanticWorkflow): TransferFields {
  const nodes = workflow.nodes.filter(n => n.actionType === TRANSFER_ACTION);
  if (nodes.length !== 1 || workflow.nodes.some(n => n.actionType !== TRANSFER_ACTION && !n.actionType.startsWith('mock-')) ||
      workflow.resourceEdges.some(e => e.fromNodeId === nodes[0]?.nodeId || e.toNodeId === nodes[0]?.nodeId) ||
      workflow.nodes.some(n => n.dependencies.includes(nodes[0]?.nodeId ?? ''))) throw new Error('TRANSFER_ISOLATED_ONLY');
  const read = readTransferNode(nodes[0]!);
  const profile = NATIVE_TRANSFER_PROFILES.find(item => item.chain === read.fields.chain);
  if (!profile) throw new Error('TRANSFER_NETWORK_UNSUPPORTED');
  if (read.fields.recipient !== 'CONNECTED_OWNER' && !transferAllowsRecipients(profile)) throw new Error('TRANSFER_RECIPIENT_UNSUPPORTED');
  if (read.kind === 'NATIVE') {
    if (BigInt(read.fields.amount) > BigInt(profile.maximumValueWei)) throw new Error('TRANSFER_AMOUNT_OUT_OF_RANGE');
    return read;
  }
  if (!transferAllowsTokens(profile)) throw new Error('TRANSFER_TOKEN_UNSUPPORTED');
  const { token } = read.fields;
  try { validateCatalogAssetIdentity({ chain: read.fields.chain, address: token.address, decimals: token.decimals, officialId: token.officialId }); }
  catch { throw new Error('TRANSFER_ASSET_IDENTITY_INVALID'); }
  // ERC-20 transfer amounts are uint256; balances remain a live simulation check.
  if (BigInt(read.fields.amount) > (2n ** 256n - 1n)) throw new Error('TRANSFER_AMOUNT_OUT_OF_RANGE');
  return read;
}
