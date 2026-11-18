// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useEffect } from 'react';
import { Panel, useReactFlow, useStore, useStoreApi, type FitViewOptions, type PanelPosition, type ProOptions, type ReactFlowState, type Viewport } from '@xyflow/react';

/**
 * Laptop-first canvas gestures, shared by every FloFi canvas. Two-finger trackpad movement pans the viewport 1:1; a trackpad pinch (the
 * browser's ctrl+wheel) or Ctrl/⌘ + wheel zooms. A plain mouse wheel pans the Simulate and Execute canvases too; on the Editor's Canvas
 * `CanvasWheelNavigation` (below) makes it zoom at the cursor instead (BUILD UX POLISH 004). React Flow intercepts wheel events only over the
 * canvas pane, never over its `nowheel` controls.
 */
export const CANVAS_GESTURES = Object.freeze({ panOnScroll: true, panOnScrollSpeed: 1, zoomOnScroll: true, zoomOnPinch: true, preventScrolling: true });

/**
 * BUILD UX POLISH 004 (UXA-02): which device a wheel event comes from, for the Editor's Canvas. A notched mouse wheel zooms at the cursor there;
 * a trackpad keeps the shared gestures above (two-finger pan, pinch zoom). Read `deltaMode` first: Firefox reports lines only to a page that
 * asks for the mode before the deltas.
 * - Lines or pages (Firefox, a notched wheel): mouse.
 * - Any horizontal movement, or none at all: trackpad (a mouse wheel moves on one axis; Shift + wheel stays a horizontal pan).
 * - Chromium and WebKit report the legacy `wheelDeltaY` in 120-unit notches for a wheel; a macOS trackpad reports exactly −3 × `deltaY`, and other
 *   trackpads report fractions of a notch. Anything that is not whole notches is a trackpad.
 * A device that cannot be told apart keeps the existing pan, never an unexpected zoom.
 */
export type WheelSource = 'mouse' | 'trackpad';
export type WheelSample = { readonly deltaMode: number; readonly deltaX: number; readonly deltaY: number; readonly wheelDeltaY?: number | undefined };
export function wheelSource(event: WheelSample): WheelSource {
  const mode = event.deltaMode;
  if (mode !== 0) return 'mouse';
  if (event.deltaX !== 0 || event.deltaY === 0) return 'trackpad';
  const notches = event.wheelDeltaY;
  return typeof notches === 'number' && notches !== 0 && notches % 120 === 0 && notches !== -3 * event.deltaY ? 'mouse' : 'trackpad';
}
/** The zoom factor of one wheel event: React Flow's own wheel curve (d3-zoom), so a notch zooms by the same step as its scroll zoom. */
export function wheelZoomFactor(event: Pick<WheelSample, 'deltaMode' | 'deltaY'>): number {
  return 2 ** (-event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002));
}
/**
 * The viewport after zooming by `factor` around `point` (pane pixels): the flow point under the cursor stays under it. The zoom stays within the
 * canvas's own limits; at a limit nothing moves.
 */
export function zoomAtPoint(viewport: Viewport, point: { readonly x: number; readonly y: number }, factor: number, minZoom: number, maxZoom: number): Viewport {
  const zoom = Math.min(maxZoom, Math.max(minZoom, viewport.zoom * factor));
  if (!Number.isFinite(zoom) || zoom === viewport.zoom) return viewport;
  const scale = zoom / viewport.zoom;
  return { x: point.x - (point.x - viewport.x) * scale, y: point.y - (point.y - viewport.y) * scale, zoom };
}
/** Wheel events closer together than this belong to one gesture, which keeps the device and the target it started with. */
export const WHEEL_GESTURE_GAP_MS = 200;
/** The scrollable element between `target` and `boundary` that can still move in the wheel's direction (a card's token list, the rail). */
export function scrollableAncestor(target: Element | null, boundary: Element, deltaX: number, deltaY: number): HTMLElement | null {
  const vertical = Math.abs(deltaY) >= Math.abs(deltaX), delta = vertical ? deltaY : deltaX;
  // A focused number or range field would take the wheel as a value change: it never scrolls (the Canvas handles the wheel and cancels it).
  if (target instanceof HTMLInputElement && (target.type === 'number' || target.type === 'range') && target === target.ownerDocument.activeElement) return null;
  for (let element = target; element && element !== boundary; element = element.parentElement) {
    if (!(element instanceof HTMLElement)) continue;
    const style = getComputedStyle(element), overflow = vertical ? style.overflowY : style.overflowX;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    const position = vertical ? element.scrollTop : element.scrollLeft;
    const room = vertical ? element.scrollHeight - element.clientHeight : element.scrollWidth - element.clientWidth;
    if (room > 1 && (delta > 0 ? position < room - 1 : delta < 0 && position > 0)) return element;
  }
  return null;
}
type WheelGesture = { readonly last: number; readonly kind: 'scroll' | 'zoom' | 'pan' | 'hold'; readonly element: HTMLElement | null };
/**
 * BUILD UX POLISH 004 (UXA-02): wheel input over the Editor's Canvas stays in the Canvas, and the page and the chat keep their own scrolling.
 * Rendered inside `<ReactFlow>`; it listens on the whole Canvas surface (rail, graph, overlays) before React Flow does:
 * - Ctrl/⌘ + wheel and a trackpad pinch: React Flow's own zoom at the cursor (unchanged).
 * - A list or field inside the Canvas that can still scroll that way (a card's token or network list, the rail): it scrolls, and only it.
 * - Over the graph, a mouse wheel zooms around the cursor through the same viewport transform as + / − and Fit; a trackpad pans (unchanged).
 * - Anything else inside the Canvas (its floating controls, a list at its end) keeps the wheel from scrolling the page behind it.
 * One gesture keeps its first decision, so a list scrolled to its end does not start zooming mid-gesture. Nothing here moves a card: only the
 * viewport changes, never a node's stored position. Outside the Canvas (the page, the chat) wheel events are untouched.
 */
export function CanvasWheelNavigation({ onViewportChange }: { onViewportChange?: (view: Viewport) => void } = {}) {
  const store = useStoreApi();
  // Subscribed, so the listener attaches whenever React Flow has its root (never silently missing it).
  const root = useStore((state: ReactFlowState) => state.domNode);
  const { getViewport, setViewport } = useReactFlow();
  useEffect(() => {
    const surface = root?.closest<HTMLElement>('.flow-surface') ?? root;
    if (!root || !surface) return;
    let gesture: WheelGesture | null = null;
    const listener = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) { gesture = null; return; }
      // The mode is read before the deltas (see `wheelSource`).
      const sample: WheelSample = { deltaMode: event.deltaMode, deltaX: event.deltaX, deltaY: event.deltaY, wheelDeltaY: (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY };
      const target = event.target instanceof Element ? event.target : null;
      const now = event.timeStamp;
      const continuing = gesture && now - gesture.last >= 0 && now - gesture.last < WHEEL_GESTURE_GAP_MS ? gesture : null;
      let kind: WheelGesture['kind'], element: HTMLElement | null;
      if (continuing) ({ kind, element } = continuing);
      else {
        element = scrollableAncestor(target, surface, sample.deltaX, sample.deltaY);
        const graph = Boolean(target && root.contains(target) && !target.closest('.nowheel'));
        kind = element ? 'scroll' : graph ? wheelSource(sample) === 'mouse' ? 'zoom' : 'pan' : 'hold';
      }
      gesture = { last: now, kind, element };
      if (kind === 'pan') return;
      // Over the graph React Flow would pan for this event: it is handled here instead (other wheel listeners in the Canvas are left alone).
      if (target && root.contains(target) && !target.closest('.nowheel')) event.stopPropagation();
      // From here on the page never scrolls because of this event.
      if (kind === 'scroll' && element && scrollableAncestor(target, surface, sample.deltaX, sample.deltaY) === element) return;
      event.preventDefault();
      if (kind !== 'zoom') return;
      const { minZoom, maxZoom } = store.getState(), box = root.getBoundingClientRect();
      const viewport = getViewport(), next = zoomAtPoint(viewport, { x: event.clientX - box.left, y: event.clientY - box.top }, wheelZoomFactor(sample), minZoom, maxZoom);
      if (next !== viewport) { void setViewport(next); onViewportChange?.(next); }
    };
    surface.addEventListener('wheel', listener, { capture: true, passive: false });
    return () => surface.removeEventListener('wheel', listener, { capture: true });
  }, [root, store, getViewport, setViewport, onViewportChange]);
  return null;
}
/**
 * HOTFIX-P1-UI-OVERFLOW-AND-ATTRIBUTION-001: every FloFi canvas hides React Flow's corner attribution link through the library's own supported
 * option (`proOptions.hideAttribution`, @xyflow/react 12, MIT licensed: the attribution is a request of its authors, not a license term; the
 * license notice ships with the package). Nothing else of the canvas changes: no CSS hides it and no other element is removed.
 */
export const CANVAS_PRO_OPTIONS: ProOptions = Object.freeze({ hideAttribution: true });

/** React Flow owns the viewport, including zoom changes from gestures and automatic fitting.
 * P0 approved UX (board 04): the same three controls on every canvas, bottom right — Fit, zoom out (−) and zoom in (+); the zoom slider and the
 * percentage are gone. Every control stays within the engine's own minimum and maximum zoom, and Fit uses the caller's fit padding, so a fitted
 * card never sits under the controls. `steps` is kept for callers and changes nothing.
 * BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: `embedded` renders the navigator as an ordinary flow element inside a caller's own panel (the
 * Simulate/Execute plan's bottom controls), so its position comes from layout, never from an offset computed against other controls. */
export function CanvasNavigator({ fitViewOptions, compactBelow = 800, position = 'bottom-right', embedded = false, onViewportChange }: { fitViewOptions?: FitViewOptions; compactBelow?: number; position?: PanelPosition; steps?: boolean; embedded?: boolean; onViewportChange?: (view: Viewport) => void }) {
  const { t: tr } = useLocale();
  const zoom = useStore((state: ReactFlowState) => state.transform[2]);
  const minZoom = useStore((state: ReactFlowState) => state.minZoom);
  const maxZoom = useStore((state: ReactFlowState) => state.maxZoom);
  // BUILD-FLOFI-PRODUCT-UX-001: React Flow measures the pane only in the browser (width 0 on the server). Until then the navigator is laid out
  // nowhere visible, so it never paints at a compact position and jumps once the canvas is measured.
  const measured = useStore((state: ReactFlowState) => state.width > 0);
  const compact = useStore((state: ReactFlowState) => state.width < compactBelow);
  const narrow = useStore((state: ReactFlowState) => state.width < 400);
  const { fitView, zoomIn, zoomOut, getViewport } = useReactFlow();
  const reduced = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const remember = () => onViewportChange?.(getViewport());

  const Container = embedded ? 'div' : Panel;
  return <Container {...embedded ? {} : { position }} className={`canvas-navigator nodrag nopan nowheel${embedded ? ' canvas-navigator-embedded' : ''}`} role="group" aria-label={tr("Canvas navigator")}
    data-measured={measured} data-compact={measured && compact} data-narrow={measured && narrow}>
    <button type="button" className="canvas-navigator-fit" aria-label={tr("Fit workflow")} title={tr("Fit workflow")} onClick={() => { void fitView(fitViewOptions).then(remember); }}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>
      </svg>
    </button>
    <button type="button" className="canvas-navigator-step" aria-label={tr('Zoom out')} title={tr('Zoom out')} disabled={zoom <= minZoom + 0.001}
      onClick={() => { void zoomOut({ duration: reduced() ? 0 : 120 }).then(remember); }}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M6 12h12"/></svg></button>
    <button type="button" className="canvas-navigator-step" aria-label={tr('Zoom in')} title={tr('Zoom in')} disabled={zoom >= maxZoom - 0.001}
      onClick={() => { void zoomIn({ duration: reduced() ? 0 : 120 }).then(remember); }}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M6 12h12M12 6v12"/></svg></button>
  </Container>;
}
