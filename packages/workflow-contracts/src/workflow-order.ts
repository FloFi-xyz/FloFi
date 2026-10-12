// SPDX-License-Identifier: Apache-2.0
import type { SemanticWorkflow } from './semantic-workflow.js';

/** Deterministic topological projection of canonical instance dependencies.
 * Array order and Canvas coordinates are not semantic sequencing authority.
 */
export function workflowDependencyOrder<T extends { readonly nodeId: string; readonly dependencies: readonly string[] }>(nodes: readonly T[]): T[] {
  const remaining = new Map(nodes.map(node => [node.nodeId, node]));
  if (remaining.size !== nodes.length) throw Error('DUPLICATE_NODE');
  for (const node of nodes) for (const id of node.dependencies) if (!remaining.has(id)) throw Error('INVALID_DEPENDENCY');
  const ordered: T[] = [], done = new Set<string>();
  while (remaining.size) {
    const ready = [...remaining.values()].filter(node => node.dependencies.every(id => done.has(id)))
      .sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)[0];
    if (!ready) throw Error('CYCLIC_CONNECTION');
    ordered.push(ready); done.add(ready.nodeId); remaining.delete(ready.nodeId);
  }
  return ordered;
}
export const workflowOrder = (workflow: SemanticWorkflow) => workflowDependencyOrder(workflow.nodes);
