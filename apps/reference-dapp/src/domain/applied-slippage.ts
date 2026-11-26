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
 *
 * `exact` (security review): the edit is applied at once only when the resulting step equals the applied one apart from its slippage. The
 * authoring input cannot express every valid step (a universal bridge with a provider list that is not a routing preset, a Router bridge whose
 * stricter earlier editing bounds are kept on purpose), and rebuilding such a step from it would also change those: then the same edit is
 * offered as a proposal instead, so the owner sees every change before applying it. The same holds when anything else in the workflow would change
 * (another step, a resource edge), and for a step a step-by-step sequence already EXECUTED (`executed`): editing it ends that sequence's history
 * for this workflow, so it is never done in one click (workflow review).
 */
export function appliedSlippageCommand(state: EditorState, nodeId: string, slippage: string, context?: ReviewContext, options: { readonly executed?: boolean } = {}):
  { readonly command: Command; readonly exact: boolean } | { readonly code: string } {
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
  if (preview.error) return { code: preview.error };
  const others = (workflow: EditorState['workflow']) => JSON.stringify({ nodes: workflow.nodes.filter(item => item.nodeId !== nodeId), edges: workflow.resourceEdges });
  const after = preview.workflow.nodes.find(item => item.nodeId === nodeId);
  return { command, exact: !options.executed && Boolean(after) && withoutSlippage(after!) === withoutSlippage(node) && others(preview.workflow) === others(state.workflow) };
}
/**
 * A short key of a step apart from its slippage: the inspector keys a step's settings form by it, so a slippage commit (the only change) keeps the
 * form mounted (a "Review … change" press that committed it still lands, and other unapplied fields stay), while any other change remounts it
 * from the applied step as before.
 */
export function settingsKeyOf(node: EditorState['workflow']['nodes'][number]): string {
  let hash = 0x811c9dc5;
  for (const char of withoutSlippage(node)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return `${node.nodeId}:${hash.toString(16)}`;
}
/** A step's canonical form without its slippage (its MAXIMUM_SLIPPAGE_BPS constraint and slippage fields). */
function withoutSlippage(node: EditorState['workflow']['nodes'][number]): string {
  return JSON.stringify({ ...node, userConstraints: node.userConstraints.filter(constraint => constraint.kind !== 'MAXIMUM_SLIPPAGE_BPS') },
    (key, value: unknown) => /slippage/i.test(key) ? undefined : value);
}
