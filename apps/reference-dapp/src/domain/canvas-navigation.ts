// SPDX-License-Identifier: AGPL-3.0-only
export type CanvasViewport = { x: number; y: number; zoom: number };
/** Cursor-anchored wheel zoom in pane coordinates; no node/workflow writes. */
export function navigateCanvas(view: CanvasViewport, event: { x: number; y: number; deltaX: number; deltaY: number; shiftKey: boolean; deltaMode: number }, min: number, max: number): CanvasViewport {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  if (event.shiftKey) return { ...view, x: view.x - event.deltaX * unit, y: view.y - event.deltaY * unit };
  const zoom = Math.max(min, Math.min(max, view.zoom * Math.exp(-Math.max(-200, Math.min(200, event.deltaY * unit)) * .002)));
  const scale = zoom / view.zoom;
  return { x: event.x - (event.x - view.x) * scale, y: event.y - (event.y - view.y) * scale, zoom };
}
