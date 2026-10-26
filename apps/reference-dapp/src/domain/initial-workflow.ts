// SPDX-License-Identifier: AGPL-3.0-only
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';

export type Immutable<T> = T extends readonly (infer V)[] ? readonly Immutable<V>[]
  : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type Workflow = Immutable<SemanticWorkflow>;

export function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

/**
 * BUILD-FLOFI-PRODUCT-UX-001: a new workflow is genuinely empty — no hidden template or sample step. The canonical IR needs at least one node,
 * so an empty draft is never linted, simulated, saved, handed off or reviewed; it becomes a canonical workflow with the owner's first action.
 * Engineering fixtures that exercise template steps add them explicitly (the `ADD` command), never through the product's initial state.
 */
export function initialWorkflow(): Workflow {
  return freeze<SemanticWorkflow>({
    schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 0,
    nodes: [] as unknown as SemanticWorkflow['nodes'], resourceEdges: [],
  });
}
/** No financial action yet: the new, empty draft (and a draft saved before this build that holds only template steps). */
export function isEmptyDraft(workflow: { readonly nodes: readonly { readonly actionType: string }[] }): boolean {
  return workflow.nodes.every(node => node.actionType.startsWith('mock-'));
}
/** The visit's untouched draft: empty and never edited. A run persisted in this browser may be recovered into it, never into another workflow. */
export function isPristineDraft(workflow: { readonly revision: number; readonly nodes: readonly { readonly actionType: string }[] }): boolean {
  return workflow.revision === 0 && isEmptyDraft(workflow);
}
