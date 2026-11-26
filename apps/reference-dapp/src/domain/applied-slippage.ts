// SPDX-License-Identifier: AGPL-3.0-only
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import type { Command } from './commands';
import { editorReducer, type EditorState } from './editor';
import { createRouterNode, routerDetails, routerInputOf } from './router-authoring';
import { createUniversalBridgeFromInput, universalBridgeDetails, universalInputOf } from './universal-bridge-authoring';
import { createSolanaSwapNode, solanaSwapDetails } from './jupiter-authoring';

/**
 * PR #254 follow-up: the edit that applies a new max price difference (exact basis points) to an existing Router bridge, universal bridge or
 * Jupiter swap, as the swap card's settings already do. It is built from the APPLIED step with only its slippage changed, so a draft amount,
 * network, token, recipient or routing on the card is never applied with it; it is validated by the step's own authoring rules (provider
 * limits) and by the editor (locks, revision), and it is one ordinary edit: the new revision retires earlier quotes, simulations and Reviews.
 * It never simulates, authorizes, signs or executes anything. Returns the refusal code otherwise (the caller words it).
 */
export function appliedSlippageCommand(state: EditorState, nodeId: string, slippage: string, context?: ReviewContext): { readonly command: Command } | { readonly code: string } {
  const node = state.workflow.nodes.find(item => item.nodeId === nodeId);
  if (!node) return { code: 'NODE_NOT_FOUND' };
  const base = { nodeId, source: 'CANVAS' as const, baseRevision: state.workflow.revision };
  let command: Command;
  try {
    const router = routerDetails(node), universal = router ? null : universalBridgeDetails(node), solana = router || universal ? null : solanaSwapDetails(node);
    if (router) {
      const input = { ...routerInputOf(router), slippage };
      createRouterNode(nodeId, input);
      command = { ...base, type: 'SET_ROUTER_BRIDGE', input };
    } else if (universal) {
      const input = { ...universalInputOf(universal), slippage };
      createUniversalBridgeFromInput(nodeId, input);
      command = { ...base, type: 'SET_UNIVERSAL_BRIDGE', input };
    } else if (solana) {
      const input = { ...solana, slippage };
      createSolanaSwapNode(nodeId, input);
      command = { ...base, type: 'SET_SOLANA_SWAP', input };
    } else return { code: 'SLIPPAGE_NOT_APPLICABLE' };
  } catch (cause) { return { code: cause instanceof Error ? cause.message : 'INVALID_SLIPPAGE' }; }
  const preview = editorReducer(state, command, context);
  return preview.error ? { code: preview.error } : { command };
}
