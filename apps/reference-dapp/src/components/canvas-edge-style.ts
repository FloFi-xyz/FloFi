// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-BUILDER-UX-002: an edge label is a small rounded tag on the card surface colour, shared by the Build and Simulate canvases. */
export const CANVAS_EDGE_LABEL = { labelStyle: { fontSize: 10, fontWeight: 500, fill: 'var(--edge-label)' }, labelShowBg: true,
  labelBgStyle: { fill: 'var(--paper)', stroke: 'var(--line)', strokeWidth: 1 }, labelBgPadding: [6, 3] as [number, number], labelBgBorderRadius: 6 } as const;
/** A link that only orders two steps reads "Then"; a link that passes a value keeps its own label. The full text names the edge. */
export const edgeLabel = (label: string) => label === 'After previous step' ? 'Then' : label;
export const edgeAccessibleLabel = (label: string) => label === 'After previous step' ? 'Then: after the previous step' : label;
