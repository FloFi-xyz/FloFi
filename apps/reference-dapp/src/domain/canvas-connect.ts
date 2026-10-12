// SPDX-License-Identifier: AGPL-3.0-only
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import type { Command } from './commands';
import { editorReducer, type EditorState } from './editor';

/**
 * BUILD-FIX-UX-001: one Canvas connection attempt. The pointer gesture only names two steps; whether they may be linked is decided by the
 * existing CONNECT command alone (output → input, no cycles, one input per step, the workflow's own edge rules). A connection the Canvas
 * shows is therefore always a persisted workflow edge.
 */
export const CONNECTION_REASONS: Readonly<Record<string, string>> = Object.freeze({
  CYCLIC_CONNECTION: 'This connection would create a loop.', INPUT_ALREADY_CONNECTED: 'This step already has an input.',
  SWAP_EDGE_UNSUPPORTED: 'Swap connections are not available in this workflow.', ISOLATED_ACTION_EDGE_UNSUPPORTED: 'This step cannot be connected in this workflow.',
  INVALID_CONNECTION: 'Choose two different steps to connect.',
});
export type ConnectionCheck = { readonly ok: true; readonly command: Command } | { readonly ok: false; readonly message: string };

export function checkConnection(state: EditorState, context: ReviewContext, from: string, to: string): ConnectionCheck {
  if (from === to) return { ok: false, message: CONNECTION_REASONS.INVALID_CONNECTION! };
  const command: Command = { type: 'CONNECT', from, to, source: 'CANVAS', baseRevision: state.workflow.revision };
  const preview = editorReducer(state, command, context);
  return preview.error ? { ok: false, message: CONNECTION_REASONS[preview.error] ?? 'These steps cannot be connected.' } : { ok: true, command };
}

/**
 * The two steps an ended drag names: from a step's output to the step it was released on (its input handle, or anywhere on its card), or —
 * a drag started at an input — from the released step to the starting one. Null when released on the empty canvas or on the starting step.
 */
export function connectionEnd(start: { readonly nodeId: string; readonly type: 'source' | 'target' }, releasedOn: string | null): { readonly from: string; readonly to: string } | null {
  if (!releasedOn || releasedOn === start.nodeId) return null;
  return start.type === 'source' ? { from: start.nodeId, to: releasedOn } : { from: releasedOn, to: start.nodeId };
}

/** The connection hit area grows as the Canvas zooms out (it is drawn inside the zoomed viewport), up to twice its size. */
export function handleHitScale(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? Math.min(2, Math.max(1, 1 / zoom)) : 1;
}
