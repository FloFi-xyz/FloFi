// SPDX-License-Identifier: AGPL-3.0-only
import { isSolanaTransferNode, readSolanaTransferNode, TRANSFER_ACTION, type SemanticWorkflow, type SolanaTransferFields } from '@defi-workflow-engine/workflow-contracts';
import { solanaTransferAsset, solanaTransferProfile } from '@defi-workflow-engine/action-registry';
/**
 * BUILD-SOLANA-TRANSFER-UX-001: one isolated direct transfer on a Solana cluster with a transfer profile (mainnet-beta, Devnet); templates may
 * coexist, nothing may connect. A token named by a verified profile asset must carry exactly that asset's decimals and program; any other
 * mint is authorable and is verified against the chain (owner program, decimals, extensions) at Simulate.
 */
export function validateSolanaTransferWorkflow(workflow: SemanticWorkflow): SolanaTransferFields {
  const nodes = workflow.nodes.filter(n => n.actionType === TRANSFER_ACTION);
  if (nodes.length !== 1 || workflow.nodes.some(n => n.actionType !== TRANSFER_ACTION && !n.actionType.startsWith('mock-')) ||
      workflow.resourceEdges.some(e => e.fromNodeId === nodes[0]?.nodeId || e.toNodeId === nodes[0]?.nodeId) ||
      workflow.nodes.some(n => n.dependencies.includes(nodes[0]?.nodeId ?? '')) || nodes[0]!.dependencies.length) throw new Error('SOLANA_TRANSFER_ISOLATED_ONLY');
  if (!isSolanaTransferNode(nodes[0]!)) throw new Error('SOLANA_TRANSFER_PORTS_INVALID');
  const fields = readSolanaTransferNode(nodes[0]!);
  const profile = solanaTransferProfile(fields.chain);
  if (!profile) throw new Error('SOLANA_TRANSFER_NETWORK_UNSUPPORTED');
  if (!fields.token) {
    if (BigInt(fields.amount) > BigInt(profile.maximumLamports)) throw new Error('SOLANA_TRANSFER_AMOUNT_OUT_OF_RANGE');
    return fields;
  }
  const known = solanaTransferAsset(profile, fields.token.mint);
  if (known && (known.decimals !== fields.token.decimals || known.program !== fields.token.program)) throw new Error('SOLANA_TRANSFER_MINT_DECIMALS_MISMATCH');
  // At most one billion whole units, like the other transfer engines.
  if (BigInt(fields.amount) > 10n ** BigInt(fields.token.decimals + 9)) throw new Error('SOLANA_TRANSFER_AMOUNT_OUT_OF_RANGE');
  return fields;
}
