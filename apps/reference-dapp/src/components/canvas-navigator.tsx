// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { Panel, useReactFlow, useStore, type FitViewOptions, type PanelPosition, type ReactFlowState } from '@xyflow/react';

/**
 * Laptop-first canvas gestures, shared by every FloFi canvas. Two-finger trackpad movement (and a plain mouse wheel) pans
 * the viewport 1:1; a trackpad pinch (the browser's ctrl+wheel) or Ctrl/⌘ + wheel zooms. React Flow intercepts wheel
 * events only over the canvas pane, never over its `nowheel` controls, so the page keeps normal scrolling elsewhere.
 */
export const CANVAS_GESTURES = Object.freeze({ panOnScroll: true, panOnScrollSpeed: 1, zoomOnScroll: true, zoomOnPinch: true, preventScrolling: true });

/** React Flow owns the viewport, including zoom changes from gestures and automatic fitting.
 * P0 approved UX (board 04): the same three controls on every canvas, bottom right — Fit, zoom out (−) and zoom in (+); the zoom slider and the
 * percentage are gone. Every control stays within the engine's own minimum and maximum zoom, and Fit uses the caller's fit padding, so a fitted
 * card never sits under the controls. `steps` is kept for callers and changes nothing.
 * BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: `embedded` renders the navigator as an ordinary flow element inside a caller's own panel (the
 * Simulate/Execute plan's bottom controls), so its position comes from layout, never from an offset computed against other controls. */
export function CanvasNavigator({ fitViewOptions, compactBelow = 800, position = 'bottom-right', embedded = false }: { fitViewOptions?: FitViewOptions; compactBelow?: number; position?: PanelPosition; steps?: boolean; embedded?: boolean }) {
  const { t: tr } = useLocale();
  const zoom = useStore((state: ReactFlowState) => state.transform[2]);
  const minZoom = useStore((state: ReactFlowState) => state.minZoom);
  const maxZoom = useStore((state: ReactFlowState) => state.maxZoom);
  // BUILD-FLOFI-PRODUCT-UX-001: React Flow measures the pane only in the browser (width 0 on the server). Until then the navigator is laid out
  // nowhere visible, so it never paints at a compact position and jumps once the canvas is measured.
  const measured = useStore((state: ReactFlowState) => state.width > 0);
  const compact = useStore((state: ReactFlowState) => state.width < compactBelow);
  const narrow = useStore((state: ReactFlowState) => state.width < 400);
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const reduced = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const Container = embedded ? 'div' : Panel;
  return <Container {...embedded ? {} : { position }} className={`canvas-navigator nodrag nopan nowheel${embedded ? ' canvas-navigator-embedded' : ''}`} role="group" aria-label={tr("Canvas navigator")}
    data-measured={measured} data-compact={measured && compact} data-narrow={measured && narrow}>
    <button type="button" className="canvas-navigator-fit" aria-label={tr("Fit workflow")} title={tr("Fit workflow")} onClick={() => { void fitView(fitViewOptions); }}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>
      </svg>
    </button>
    <button type="button" className="canvas-navigator-step" aria-label={tr('Zoom out')} title={tr('Zoom out')} disabled={zoom <= minZoom + 0.001}
      onClick={() => { void zoomOut({ duration: reduced() ? 0 : 120 }); }}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M6 12h12"/></svg></button>
    <button type="button" className="canvas-navigator-step" aria-label={tr('Zoom in')} title={tr('Zoom in')} disabled={zoom >= maxZoom - 0.001}
      onClick={() => { void zoomIn({ duration: reduced() ? 0 : 120 }); }}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M6 12h12M12 6v12"/></svg></button>
  </Container>;
}
