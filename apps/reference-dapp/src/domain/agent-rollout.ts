// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-SOLANA-TRANSFER-UX-001 (audit A9): agent-surface capabilities that are implemented and kept for review, but whose rollout to the
 * Copilot, MCP, channels and the Developer API awaits explicit owner approval. Until a reviewed change lists one in
 * `AGENT_ROLLOUT_APPROVED`, every handoff refuses it (`AGENT_ROLLOUT_NOT_APPROVED`) and the Copilot does not author it. Deployment flags
 * cannot release it. The Canvas keeps its own, separately approved controls for the same actions.
 */
export const PENDING_AGENT_CAPABILITIES = ['orca-liquidity-mainnet', 'testnet-native-transfer'] as const;
export type PendingAgentCapability = (typeof PENDING_AGENT_CAPABILITIES)[number];
/** The owner explicitly authorized the existing mainnet Orca journey on every public conversational surface in PR #139. */
export const AGENT_ROLLOUT_APPROVED: readonly PendingAgentCapability[] = Object.freeze(['orca-liquidity-mainnet']);

/** The pending capability an action needs on a network (stable MCP network id), or null when this gate does not apply. */
export function pendingAgentCapability(action: string, network: string): PendingAgentCapability | null {
  if (action === 'add_liquidity' && network === 'solana') return 'orca-liquidity-mainnet';
  if (action === 'transfer' && (network === 'ethereum-sepolia' || network === 'robinhood-testnet')) return 'testnet-native-transfer';
  return null;
}

/** Whether agent surfaces may offer this action on this network. */
export function agentRolloutAllows(action: string, network: string, approved: readonly PendingAgentCapability[] = AGENT_ROLLOUT_APPROVED): boolean {
  const pending = pendingAgentCapability(action, network);
  return pending === null || approved.includes(pending);
}
