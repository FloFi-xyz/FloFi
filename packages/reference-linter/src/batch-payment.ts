// SPDX-License-Identifier: AGPL-3.0-only
import { BATCH_PAYMENT_ACTION, readBatchPaymentNode, type BatchPaymentFields, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { NATIVE_TRANSFER_PROFILES, transferAllowsRecipients, transferAllowsTokens, transferEnvironment } from '@defi-workflow-engine/action-registry';
import { validateCatalogAssetIdentity } from './catalog-swap.js';
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: one isolated Batch Payment on a MAINNET transfer profile that pays explicit recipients (templates may
 * coexist, nothing may connect). Each payment obeys the same rules as one transfer of that profile (a native amount within the profile's per-transfer
 * maximum, a catalog ERC-20 bound by its identity), because each payment executes as exactly that transfer. Balances stay a live simulation check.
 */
export function validateBatchPaymentWorkflow(workflow: SemanticWorkflow): BatchPaymentFields {
  const nodes = workflow.nodes.filter(n => n.actionType === BATCH_PAYMENT_ACTION);
  if (nodes.length !== 1 || workflow.nodes.some(n => n.actionType !== BATCH_PAYMENT_ACTION && !n.actionType.startsWith('mock-')) ||
      workflow.resourceEdges.some(e => e.fromNodeId === nodes[0]?.nodeId || e.toNodeId === nodes[0]?.nodeId) ||
      workflow.nodes.some(n => n.dependencies.includes(nodes[0]?.nodeId ?? ''))) throw new Error('BATCH_PAYMENT_ISOLATED_ONLY');
  const fields = readBatchPaymentNode(nodes[0]!);
  const profile = NATIVE_TRANSFER_PROFILES.find(item => item.chain === fields.chain);
  if (!profile || transferEnvironment(profile) !== 'MAINNET') throw new Error('BATCH_PAYMENT_NETWORK_UNSUPPORTED');
  if (!transferAllowsRecipients(profile)) throw new Error('BATCH_PAYMENT_RECIPIENT_UNSUPPORTED');
  if (fields.asset.kind === 'NATIVE') {
    for (const p of fields.payments) if (BigInt(p.amount) > BigInt(profile.maximumValueWei)) throw new Error('BATCH_PAYMENT_AMOUNT_OUT_OF_RANGE');
    return fields;
  }
  if (!transferAllowsTokens(profile)) throw new Error('BATCH_PAYMENT_TOKEN_UNSUPPORTED');
  try { validateCatalogAssetIdentity({ chain: fields.chain, address: fields.asset.address, decimals: fields.asset.decimals, officialId: fields.asset.officialId }); }
  catch { throw new Error('BATCH_PAYMENT_ASSET_IDENTITY_INVALID'); }
  return fields;
}
