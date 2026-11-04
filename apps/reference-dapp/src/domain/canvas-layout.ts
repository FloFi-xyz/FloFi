// SPDX-License-Identifier: AGPL-3.0-only
import type { Workflow } from './initial-workflow';

export type CanvasPosition = { x: number; y: number; actionType: string };
export type CanvasLayout = Record<string, CanvasPosition>;
export const canvasLayoutKey = (workflowId: string) => `gryloo:canvas:${workflowId}`;
/** BUILD-FLOFI-BUILDER-UX-002: reading-order slots, three per row, with room between cards for a linked step's arrow and its label. */
export const CANVAS_COLUMN = 320, CANVAS_ROW = 300;
export function defaultCanvasPosition(index: number) {
  return { x: 85 + (index % 3) * CANVAS_COLUMN, y: 90 + Math.floor(index / 3) * CANVAS_ROW };
}
export function canvasPosition(layout: CanvasLayout, node: Workflow['nodes'][number], index: number) {
  const stored = layout[node.nodeId];
  return stored?.actionType === node.actionType ? { x: stored.x, y: stored.y } : defaultCanvasPosition(index);
}
/** The Supply → Borrow → Swap lending composition reads top to bottom, one card per row. */
export function lendingCanvasPosition(index: number) {
  return { x: 180, y: 35 + index * CANVAS_ROW };
}
/** Two cards closer than this would overlap (a card is ~236px wide and up to ~260px tall). */
export const CANVAS_CLEARANCE = { x: 250, y: 250 };
/** A linked step continues on the next row after the third column, so a long chain stays readable on a narrow screen. */
const LAST_COLUMN_X = 85 + 2 * CANVAS_COLUMN;
/**
 * BUILD-FLOFI-BUILDER-UX-002: where each step appears, in workflow (dependency) order. A stored position is kept. A step without one — a step
 * the chat or a proposal just added — takes the free place to the right of the step it consumes, so a linked pair reads left to right; any other
 * step takes the next free reading-order slot. A new card never covers a card the owner placed. Layout only: a position never creates, removes
 * or implies a dependency (only the workflow's own edges are drawn).
 */
export function flowCanvasPositions(nodes: readonly Workflow['nodes'][number][], layout: CanvasLayout,
  /** Other cards already on the Canvas (an action being set up). */ occupied: readonly { x: number; y: number }[] = []): Readonly<Record<string, { x: number; y: number }>> {
  const placed = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const stored = layout[node.nodeId];
    if (stored?.actionType === node.actionType) placed.set(node.nodeId, { x: stored.x, y: stored.y });
  }
  const free = (position: { x: number; y: number }) => ![...placed.values(), ...occupied].some(other =>
    Math.abs(other.x - position.x) < CANVAS_CLEARANCE.x && Math.abs(other.y - position.y) < CANVAS_CLEARANCE.y);
  nodes.forEach((node, index) => {
    if (placed.has(node.nodeId)) return;
    const producer = [...node.dependencies].reverse().map(id => placed.get(id)).find(position => position !== undefined);
    let position: { x: number; y: number };
    if (producer) {
      position = producer.x + CANVAS_COLUMN > LAST_COLUMN_X ? { x: defaultCanvasPosition(0).x, y: producer.y + CANVAS_ROW } : { x: producer.x + CANVAS_COLUMN, y: producer.y };
      while (!free(position)) position = { x: position.x, y: position.y + CANVAS_ROW };
    } else {
      let slot = index;
      position = defaultCanvasPosition(slot);
      while (!free(position)) position = defaultCanvasPosition(++slot);
    }
    placed.set(node.nodeId, position);
  });
  return Object.fromEntries(placed);
}
/**
 * Where the Canvas draws each shown step (Build and Simulate) and where a layout change pins it (editor-history): the flow placement above, or,
 * for a lending composition with no stored position, its fixed column. One function, so a pinned card is exactly where it was drawn.
 */
export function shownCanvasPositions(nodes: readonly Workflow['nodes'][number][], layout: CanvasLayout,
  options: { readonly lending?: boolean; readonly occupied?: readonly { x: number; y: number }[] } = {}): Readonly<Record<string, { x: number; y: number }>> {
  const flow = flowCanvasPositions(nodes, layout, options.occupied);
  return Object.fromEntries(nodes.map((node, index) => [node.nodeId, layout[node.nodeId] || !options.lending ? flow[node.nodeId]! : lendingCanvasPosition(index)]));
}
export function reconcileCanvasLayout(layout: CanvasLayout, workflow: Workflow): CanvasLayout {
  return Object.fromEntries(workflow.nodes.flatMap(node => {
    const position = layout[node.nodeId];
    return position && position.actionType === node.actionType && Number.isFinite(position.x) && Number.isFinite(position.y)
      ? [[node.nodeId, position]] : [];
  }));
}
export function readCanvasLayout(workflow: Workflow): CanvasLayout {
  try {
    const value = JSON.parse(localStorage.getItem(canvasLayoutKey(workflow.workflowId)) ?? '{}');
    return reconcileCanvasLayout(value && typeof value === 'object' && !Array.isArray(value) ? value : {}, workflow);
  } catch { return {}; }
}
export function saveCanvasLayout(workflowId: string, layout: CanvasLayout) {
  try { localStorage.setItem(canvasLayoutKey(workflowId), JSON.stringify(layout)); } catch { /* storage is optional */ }
}


export type ToolboxMode = 'top' | 'floating';
const toolboxModeKey = 'gryloo:toolbox-mode';
/** BUILD-FLOFI-BUILDER-UX-002 (owner-approved brief): on a desktop Canvas the vertical rail ('floating') is the default home of the tools; on a phone
 * (≤700 px) the docked row stays the default, so every tool keeps its 44 px touch target. An owner's own choice is remembered everywhere.
 * Layout preference only. */
export const NARROW_TOOLBOX_QUERY = '(max-width: 700px)';
export function readToolboxMode(): ToolboxMode {
  try {
    const stored = localStorage.getItem(toolboxModeKey);
    if (stored === 'top' || stored === 'floating') return stored;
  } catch { /* storage is optional */ }
  try { return window.matchMedia(NARROW_TOOLBOX_QUERY).matches ? 'top' : 'floating'; }
  catch { return 'floating'; }
}
export function saveToolboxMode(mode: ToolboxMode): void {
  try { localStorage.setItem(toolboxModeKey, mode); } catch { /* storage is optional */ }
}
