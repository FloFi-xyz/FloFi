// SPDX-License-Identifier: AGPL-3.0-only
import { BATCH_PAYMENT_ACTION, readBatchPaymentNode, readSolanaBatchPaymentNode, type BatchPaymentFields, type SemanticWorkflow,
  type SolanaBatchPaymentFields } from '@defi-workflow-engine/workflow-contracts';
import { NATIVE_TRANSFER_PROFILES, SOLANA_BATCH_PAYMENT, solanaBatchPaymentAsset, solanaTransferProfile, transferAllowsRecipients, transferAllowsTokens,
  transferEnvironment } from '@defi-workflow-engine/action-registry';
import { validateCatalogAssetIdentity } from './catalog-swap.js';
/** One isolated Batch Payment node (templates may coexist, nothing may connect), the same rule for both families. */
function isolatedBatchPayment(workflow: SemanticWorkflow): SemanticWorkflow['nodes'][number] {
  const nodes = workflow.nodes.filter(n => n.actionType === BATCH_PAYMENT_ACTION);
  if (nodes.length !== 1 || workflow.nodes.some(n => n.actionType !== BATCH_PAYMENT_ACTION && !n.actionType.startsWith('mock-')) ||
      workflow.resourceEdges.some(e => e.fromNodeId === nodes[0]?.nodeId || e.toNodeId === nodes[0]?.nodeId) ||
      workflow.nodes.some(n => n.dependencies.includes(nodes[0]?.nodeId ?? ''))) throw new Error('BATCH_PAYMENT_ISOLATED_ONLY');
  return nodes[0]!;
}
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: one isolated Batch Payment on a MAINNET transfer profile that pays explicit recipients (templates may
 * coexist, nothing may connect). Each payment obeys the same rules as one transfer of that profile (a native amount within the profile's per-transfer
 * maximum, a catalog ERC-20 bound by its identity), because each payment executes as exactly that transfer. Balances stay a live simulation check.
 */
export function validateBatchPaymentWorkflow(workflow: SemanticWorkflow): BatchPaymentFields {
  const fields = readBatchPaymentNode(isolatedBatchPayment(workflow));
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

/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02): one isolated Solana Batch Payment on mainnet-beta (Devnet has no batch). SOL
 * within the profile's u64 maximum, or a verified registry token (USDC, USDT) with exactly its decimals and token program; Token-2022 and any
 * other mint are refused. The compiler does the cryptographic checks (32-byte keys, on-curve recipients) and reads every account from the chain.
 */
export function validateSolanaBatchPaymentWorkflow(workflow: SemanticWorkflow): SolanaBatchPaymentFields {
  const fields = readSolanaBatchPaymentNode(isolatedBatchPayment(workflow));
  const profile = solanaTransferProfile(fields.chain);
  if (!profile || !profile.realFunds || profile.chain !== SOLANA_BATCH_PAYMENT.chain) throw new Error('BATCH_PAYMENT_NETWORK_UNSUPPORTED');
  if (fields.asset.kind === 'NATIVE') {
    for (const p of fields.payments) if (BigInt(p.amount) > BigInt(profile.maximumLamports)) throw new Error('BATCH_PAYMENT_AMOUNT_OUT_OF_RANGE');
    return fields;
  }
  const known = solanaBatchPaymentAsset(fields.asset.mint);
  if (!known) throw new Error('BATCH_PAYMENT_ASSET_UNSUPPORTED');
  if (known.decimals !== fields.asset.decimals || known.program !== fields.asset.program) throw new Error('BATCH_PAYMENT_ASSET_IDENTITY_INVALID');
  return fields;
}
