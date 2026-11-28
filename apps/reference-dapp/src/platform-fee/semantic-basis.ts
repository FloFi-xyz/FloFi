// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (completion): the platform fee basis of a canonical semantic workflow (the IR a flow simulates,
 * reviews and executes). Pure and client-safe: the Review discloses exactly what the server records as the authorized basis (`single-flow.ts`),
 * from the same nodes, with the same policy module.
 *   - each financial node is one step, in order; its action is the node's action type (never a label);
 *   - a node whose action has no approved policy (borrow, withdraw, repay, liquidity) is never charged; a node this module cannot read (a fiat
 *     payment, an unknown action type) makes the execution UNSUPPORTED: never charged.
 */
import type { Composition } from '../engine/strategy-engine';
import type { StrategyAction } from '../engine/strategy-spec';
import { ACTION_FEE_POLICY, PLATFORM_FEE_BPS, PLATFORM_FEE_POLICY_ID } from './policy';
import { workflowFeeBasis, type AssetClassOf, type FeeBasis } from './principal';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
type Node = Composition['workflow']['nodes'][number];

/** The strategy action a canonical node executes, `NOT_APPLICABLE` for an action family with no approved fee policy, or null (unreadable). */
export function nodeFeeAction(actionType: string): StrategyAction | 'NOT_APPLICABLE' | null {
  if (actionType.startsWith('asset.swap.')) return 'swap';
  if (actionType === 'asset.bridge') return 'bridge';
  if (actionType === 'asset.transfer') return 'transfer';
  if (actionType === 'supply' || actionType === 'borrow' || actionType === 'repay' || actionType === 'withdraw') return actionType;
  if (actionType.startsWith('asset.liquidity.')) return 'NOT_APPLICABLE';
  return null;
}
const nonFinancial = (node: Node) => node.actionType.startsWith('mock-') || node.actionType === 'asset.liquidity.prepare';

const unsupported = (reason: string): FeeBasis => ({ policyId: PLATFORM_FEE_POLICY_ID, rateBps: PLATFORM_FEE_BPS, status: 'UNSUPPORTED', lines: [], steps: [], reason });
const notApplicable = (steps: FeeBasis['steps']): FeeBasis =>
  ({ policyId: PLATFORM_FEE_POLICY_ID, rateBps: PLATFORM_FEE_BPS, status: 'NOT_APPLICABLE', lines: [], steps, reason: 'PLATFORM_FEE_NO_FEEABLE_PRINCIPAL' });

/** The fee basis of one execution of `workflow` as reviewed (the estimate: never more than each node's reviewed maximum input). */
export function semanticWorkflowFeeBasis(workflow: Composition['workflow'] | null, options: { readonly flow?: string; readonly assetClassOf?: AssetClassOf } = {}): FeeBasis {
  if (!workflow) return unsupported('PLATFORM_FEE_WORKFLOW_UNREADABLE');
  const nodes = (workflow.nodes as readonly Node[]).filter(node => object(node) && typeof node.actionType === 'string' && !nonFinancial(node));
  if (!nodes.length || nodes.length > 8) return unsupported('PLATFORM_FEE_WORKFLOW_UNREADABLE');
  const actions = nodes.map(node => nodeFeeAction(node.actionType));
  if (actions.some(action => action === null)) return unsupported('PLATFORM_FEE_ACTION_UNKNOWN');
  const steps = nodes.map((node, index) => ({ step: index, action: node.actionType, treatment: 'NOT_APPLICABLE' as const }));
  // The lending composition has no approved policy as a whole (policy.ts), exactly as its workflow form.
  if (options.flow === 'lending-composition') return notApplicable(steps);
  if (actions.every(action => action === 'NOT_APPLICABLE' || ACTION_FEE_POLICY[action as StrategyAction] === 'NOT_APPLICABLE')) return notApplicable(steps);
  // Each node as the isolated one-node step the binding helpers read (they need only the action and the node itself). A liquidity node has no
  // approved policy: it is never charged, and a position is no asset a later step could spend, so it leaves the basis.
  const compositions = nodes.flatMap((node, index) => actions[index] === 'NOT_APPLICABLE' ? []
    : [{ strategy: { action: actions[index] }, workflow: { ...workflow, nodes: [node] } } as unknown as Composition]);
  return workflowFeeBasis({ steps: compositions, bindings: [] }, options.assetClassOf ? { assetClassOf: options.assetClassOf } : {});
}
