// SPDX-License-Identifier: AGPL-3.0-only
import type { Workflow } from './initial-workflow';
import { isLendingComposition, readConcentratedLiquiditySource } from '@defi-workflow-engine/workflow-contracts';
import { compositionBindingFor } from '@defi-workflow-engine/action-registry';
const boundSource = (node: Workflow['nodes'][number]) => { try { return readConcentratedLiquiditySource(node as never).source?.nodeId ?? null; } catch { return null; } };
export function isTextEntry(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"], [role="spinbutton"], [aria-multiline="true"]'));
}
/**
 * BUILD-SOLANA-MAINNET-001 (requirement D): every action on the Canvas can be deleted — whatever its id, a locked amount, a dependant or being
 * the last one. Deleting is an authoring edit of the draft only: it never cancels, hides or changes a transaction already submitted, and every
 * Review and authorization bound to the previous revision is retired by the new revision as for any edit.
 */
export function canDeleteCanvasNode(workflow: Workflow, nodeId: string | null): boolean {
  // The hidden starting template step of every new workflow is not an action and never shown as a card.
  return Boolean(nodeId && workflow.nodes.some(node => node.nodeId === nodeId && !(node.nodeId === 'node-001' && node.actionType.startsWith('mock-'))));
}
/**
 * The exact effect of deleting `selectedIds`: the selected steps; dependants that read a deleted step's output and cannot stand alone
 * (`cascaded`, removed with it and reported to the owner); and bound composition consumers that return to their isolated form (`unbound`).
 * Steps that only depended on a deleted step's ordering keep their own values and lose that link.
 */
export type CanvasRemoval = { readonly removed: readonly string[]; readonly cascaded: readonly string[]; readonly unbound: readonly string[] };
export function planCanvasRemoval(workflow: Workflow, selectedIds: readonly string[]): CanvasRemoval | null {
  const selected = selectedIds.filter(id => workflow.nodes.some(node => node.nodeId === id));
  if (!selected.length) return null;
  const removed = new Set(selected), unbound = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const node of workflow.nodes) {
      if (removed.has(node.nodeId) || unbound.has(node.nodeId)) continue;
      const source = boundSource(node);
      if (source && removed.has(source)) { unbound.add(node.nodeId); continue; }
      // A financial step whose input is the deleted step's output has no value of its own to keep; template steps only lose the link.
      if (!node.actionType.startsWith('mock-') && node.inputs.some(input => input.kind === 'OUTPUT_REFERENCE' && removed.has(input.value.nodeId))) {
        removed.add(node.nodeId); changed = true;
      }
    }
  }
  const order = (ids: Set<string>) => workflow.nodes.filter(node => ids.has(node.nodeId)).map(node => node.nodeId);
  return { removed: order(removed), cascaded: order(removed).filter(id => !selected.includes(id)), unbound: order(unbound) };
}
/** Backwards-compatible view of the plan: the steps a deletion of `selectedIds` removes. */
export function deletableCanvasNodes(workflow: Workflow, selectedIds: readonly string[]): string[] {
  return [...planCanvasRemoval(workflow, selectedIds)?.removed ?? []];
}
export function canDeleteCanvasEdge(workflow: Workflow, from: string, to: string): boolean {
  const source = workflow.nodes.find(node => node.nodeId === from);
  const target = workflow.nodes.find(node => node.nodeId === to);
  // The canonical lending composition also requires its Supply → Borrow health
  // checkpoint dependency, even though that link carries no asset output.
  return Boolean(source && target && !isLendingComposition(workflow) && target.dependencies.includes(from)
    && (!workflow.resourceEdges.some(edge => edge.fromNodeId === from && edge.toNodeId === to)
      || source.actionType.startsWith('mock-') && target.actionType.startsWith('mock-')
      // A swap → position binding can be unlinked; the position returns to its isolated form.
      || compositionBindingFor(source, target) !== null && boundSource(target) === from));
}
export function canvasShortcut(key: string, textEntry: boolean, selectedId: string | null,
  workflow: Workflow): 'REMOVE' | 'CLEAR' | null {
  if (!selectedId) return null;
  if (key === 'Escape') return 'CLEAR';
  if (textEntry) return null;
  if ((key === 'Delete' || key === 'Backspace') && canDeleteCanvasNode(workflow, selectedId)) return 'REMOVE';
  return null;
}
