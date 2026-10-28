// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useEffect, useState, type CSSProperties } from 'react';
import { navigateCanvas } from '../domain/canvas-navigation';
import { Panel, useReactFlow, useStore, type FitViewOptions, type ReactFlowState } from '@xyflow/react';

/** Plain wheel scrolls the page until navigation is explicitly enabled. Pinch always zooms. */
export const CANVAS_GESTURES = Object.freeze({ panOnScroll: false, zoomOnScroll: false, zoomOnPinch: true, zoomOnDoubleClick: false, preventScrolling: false });

/** React Flow owns the viewport, including zoom changes from gestures and automatic fitting. */
export function CanvasNavigator({ fitViewOptions, compactBelow = 800 }: { fitViewOptions?: FitViewOptions; compactBelow?: number }) {
  const { t: tr } = useLocale();
  const zoom = useStore((state: ReactFlowState) => state.transform[2]);
  const minZoom = useStore((state: ReactFlowState) => state.minZoom);
  const maxZoom = useStore((state: ReactFlowState) => state.maxZoom);
  // BUILD-FLOFI-PRODUCT-UX-001: React Flow measures the pane only in the browser (width 0 on the server). Until then the navigator is laid out
  // nowhere visible, so it never paints at a compact position and jumps once the canvas is measured.
  const measured = useStore((state: ReactFlowState) => state.width > 0);
  const compact = useStore((state: ReactFlowState) => state.width < compactBelow);
  const narrow = useStore((state: ReactFlowState) => state.width < 400);
  const { fitView, zoomTo, getViewport, setViewport } = useReactFlow();
  const domNode = useStore((state: ReactFlowState) => state.domNode);
  const [wheelZoom, setWheelZoom] = useState(false);
  useEffect(() => {
    if (!domNode || !wheelZoom) return;
    const wheel = (event: WheelEvent) => {
      // React Flow handles pinch. Forms, node controls and scrollable panels retain native behavior.
      if (event.ctrlKey || event.metaKey || !(event.target instanceof Element) || event.target.closest('.nowheel, input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"]')) return;
      event.preventDefault(); event.stopPropagation();
      const rect = domNode.getBoundingClientRect();
      void setViewport(navigateCanvas(getViewport(), { x: event.clientX - rect.left, y: event.clientY - rect.top, deltaX: event.deltaX, deltaY: event.deltaY, shiftKey: event.shiftKey, deltaMode: event.deltaMode }, minZoom, maxZoom));
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setWheelZoom(false); };
    domNode.addEventListener('wheel', wheel, { passive: false, capture: true });
    document.addEventListener('keydown', escape);
    return () => { domNode.removeEventListener('wheel', wheel, true); document.removeEventListener('keydown', escape); };
  }, [domNode, wheelZoom, minZoom, maxZoom, getViewport, setViewport]);
  const percentage = `${Math.round(zoom * 100)}%`;
  const progress = (zoom - minZoom) / (maxZoom - minZoom) * 100;

  return <Panel position="bottom-center" className="canvas-navigator nodrag nopan nowheel" role="group" aria-label={tr("Canvas navigator")}
    data-measured={measured} data-compact={measured && compact} data-narrow={measured && narrow}>
    <button type="button" className="canvas-navigator-wheel" aria-label={tr('Wheel navigation')} aria-pressed={wheelZoom} title={tr('Enable wheel zoom; Shift + wheel pans. Escape returns to page scrolling.')} onClick={() => setWheelZoom(value => !value)}>↔</button>
    <button type="button" className="canvas-navigator-out" aria-label={tr('Zoom out')} disabled={zoom <= minZoom} onClick={() => { void zoomTo(Math.max(minZoom, zoom / 1.2)); }}>−</button>
    <button type="button" className="canvas-navigator-in" aria-label={tr('Zoom in')} disabled={zoom >= maxZoom} onClick={() => { void zoomTo(Math.min(maxZoom, zoom * 1.2)); }}>+</button>
    <button type="button" className="canvas-navigator-fit" aria-label={tr("Fit workflow")} title={tr("Fit workflow")} onClick={() => { void fitView(fitViewOptions); }}>
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/><rect x="8" y="8" width="8" height="8" rx="1.5"/>
      </svg>
    </button>
    <input className="canvas-navigator-slider" type="range" aria-label={tr("Canvas zoom")} aria-valuetext={percentage}
      min={minZoom} max={maxZoom} step={0.01} value={zoom}
      style={{ '--zoom-progress': `${progress}%` } as CSSProperties}
      onChange={event => { void zoomTo(Number(event.currentTarget.value)); }}/>
    <button type="button" className="canvas-navigator-percentage" aria-label={tr(`Zoom ${percentage}. Reset to 100%`)} title={tr("Reset zoom to 100%")}
      onClick={() => { void zoomTo(Math.min(maxZoom, Math.max(minZoom, 1))); }}>{tr(percentage)}</button>
  </Panel>;
}
