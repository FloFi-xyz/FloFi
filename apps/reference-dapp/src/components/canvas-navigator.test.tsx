// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CANVAS_GESTURES, CanvasNavigator, WHEEL_GESTURE_GAP_MS, wheelSource, wheelZoomFactor, zoomAtPoint } from './canvas-navigator';

const viewport = vi.hoisted(() => ({ transform: [0, 0, 1], minZoom: .35, maxZoom: 1.4, width: 1044 }));
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    Panel: ({ position, ...props }: { position: string }) => React.createElement('div', { ...props, 'data-position': position }),
    useStore: (select: (state: typeof viewport) => unknown) => select(viewport),
    useReactFlow: () => ({ fitView: vi.fn(), zoomTo: vi.fn() }),
    useStoreApi: () => ({ getState: () => viewport }),
  };
});
beforeEach(() => { Object.assign(viewport, { transform: [0, 0, 1], minZoom: .35, maxZoom: 1.4, width: 1044 }); });

describe('shared canvas navigator', () => {
  // P0 approved UX (board 04, intentional change): Fit, zoom out and zoom in only — the slider and the percentage are gone; the controls still
  // read the engine's own zoom limits and stay one accessible group.
  it('exposes Fit, zoom out and zoom in as accessible buttons, without the former slider or percentage', () => {
    const html = renderToStaticMarkup(createElement(CanvasNavigator));
    expect(html).toContain('role="group" aria-label="Canvas navigator"');
    const order = ['aria-label="Fit workflow" title="Fit workflow"', 'aria-label="Zoom out" title="Zoom out"', 'aria-label="Zoom in" title="Zoom in"'].map(label => html.indexOf(label));
    expect(order.every(index => index > 0)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).not.toMatch(/type="range"|Canvas zoom|Reset zoom|%<\/button>|react-flow__controls/);
    // Placed bottom right by default, the same corner on every canvas.
    expect(html).toContain('data-position="bottom-right"');
  });

  it('reads the zoom and its limits directly from the React Flow store', () => {
    Object.assign(viewport, { transform: [23, -40, .2], minZoom: .2, maxZoom: 2 });
    let html = renderToStaticMarkup(createElement(CanvasNavigator));
    expect(html).toMatch(/aria-label="Zoom out" title="Zoom out" disabled=""/);
    expect(html).not.toMatch(/aria-label="Zoom in" title="Zoom in" disabled=""/);
    viewport.transform[2] = 2;
    html = renderToStaticMarkup(createElement(CanvasNavigator));
    expect(html).toMatch(/aria-label="Zoom in" title="Zoom in" disabled=""/);
    expect(html).not.toMatch(/aria-label="Zoom out" title="Zoom out" disabled=""/);
  });

  it.each([[1044, false, false], [734, true, false], [286, true, true]])('adapts to canvas width %s while retaining all controls', (width, compact, narrow) => {
    viewport.width = width as number;
    const html = renderToStaticMarkup(createElement(CanvasNavigator));
    expect(html).toContain(`data-compact="${compact}" data-narrow="${narrow}"`);
    for (const label of ['Fit workflow', 'Zoom out', 'Zoom in']) expect(html).toContain(`aria-label="${label}"`);
  });
});

describe('shared canvas gestures', () => {
  it('pans on two-finger scroll 1:1 and keeps pinch and Ctrl/⌘ + wheel as zoom, scoped to the canvas pane', () => {
    expect(CANVAS_GESTURES).toEqual({ panOnScroll: true, panOnScrollSpeed: 1, zoomOnScroll: true, zoomOnPinch: true, preventScrolling: true });
    expect(Object.isFrozen(CANVAS_GESTURES)).toBe(true);
    // The navigator itself opts out of canvas wheel/drag handling, so page scrolling over it is untouched.
    expect(renderToStaticMarkup(createElement(CanvasNavigator))).toContain('class="canvas-navigator nodrag nopan nowheel"');
  });
});

// BUILD UX POLISH 004 (UXA-02): the Editor's Canvas tells a notched mouse wheel (zoom at the cursor) from a trackpad (the shared pan above).
describe('Canvas wheel device and cursor-anchored zoom', () => {
  it.each([
    // Firefox reports a notched wheel in lines (or pages).
    [{ deltaMode: 1, deltaX: 0, deltaY: 3 }, 'mouse'],
    [{ deltaMode: 2, deltaX: 0, deltaY: 1 }, 'mouse'],
    // Chromium on Windows/Linux and the browser's own wheel: whole 120-unit notches on one axis.
    [{ deltaMode: 0, deltaX: 0, deltaY: 100, wheelDeltaY: -120 }, 'mouse'],
    [{ deltaMode: 0, deltaX: 0, deltaY: -240, wheelDeltaY: 240 }, 'mouse'],
    [{ deltaMode: 0, deltaX: 0, deltaY: 53, wheelDeltaY: -120 }, 'mouse'],
    // macOS trackpads (Chromium and Safari) report exactly −3 × deltaY; other trackpads report fractions of a notch.
    [{ deltaMode: 0, deltaX: 0, deltaY: 4, wheelDeltaY: -12 }, 'trackpad'],
    [{ deltaMode: 0, deltaX: 0, deltaY: 40, wheelDeltaY: -120 }, 'trackpad'],
    [{ deltaMode: 0, deltaX: 0, deltaY: 7.5, wheelDeltaY: -9 }, 'trackpad'],
    // Two-axis movement, Shift + wheel (horizontal) and a pixel delta without the legacy value keep the existing pan.
    [{ deltaMode: 0, deltaX: 3, deltaY: 12, wheelDeltaY: -120 }, 'trackpad'],
    [{ deltaMode: 0, deltaX: 100, deltaY: 0, wheelDeltaY: 0 }, 'trackpad'],
    [{ deltaMode: 0, deltaX: 0, deltaY: 12 }, 'trackpad'],
    [{ deltaMode: 0, deltaX: 0, deltaY: 0, wheelDeltaY: 0 }, 'trackpad'],
  ] as const)('classifies %o as %s', (sample, source) => {
    expect(wheelSource(sample)).toBe(source);
  });

  it('reads the device mode before the deltas (Firefox reports lines only to a page that asks for the mode first)', () => {
    const reads: string[] = [];
    const sample = new Proxy({ deltaMode: 1, deltaX: 0, deltaY: 3 }, { get: (target, key: 'deltaMode' | 'deltaX' | 'deltaY') => { reads.push(key); return target[key]; } });
    expect(wheelSource(sample)).toBe('mouse');
    expect(reads[0]).toBe('deltaMode');
  });

  it('zooms one notch by React Flow\'s own wheel curve, in both directions and every delta mode', () => {
    expect(wheelZoomFactor({ deltaMode: 0, deltaY: 100 })).toBeCloseTo(2 ** -0.2, 10);
    expect(wheelZoomFactor({ deltaMode: 0, deltaY: -100 })).toBeCloseTo(2 ** 0.2, 10);
    expect(wheelZoomFactor({ deltaMode: 1, deltaY: 3 })).toBeCloseTo(2 ** -0.15, 10);
    expect(wheelZoomFactor({ deltaMode: 2, deltaY: -1 })).toBe(2);
    expect(wheelZoomFactor({ deltaMode: 0, deltaY: 0 })).toBe(1);
  });

  it('keeps the flow point under the cursor fixed while zooming, within the canvas limits', () => {
    const viewport = { x: 40, y: -25, zoom: 1 }, point = { x: 300, y: 180 };
    const flow = (v: typeof viewport) => ({ x: (point.x - v.x) / v.zoom, y: (point.y - v.y) / v.zoom });
    for (const factor of [2 ** 0.2, 2 ** -0.2, 1.31]) {
      const next = zoomAtPoint(viewport, point, factor, .35, 1.4);
      expect(next.zoom).toBeCloseTo(Math.min(1.4, Math.max(.35, factor)), 10);
      expect(flow(next).x).toBeCloseTo(flow(viewport).x, 9); expect(flow(next).y).toBeCloseTo(flow(viewport).y, 9);
    }
    // Clamped at the limit: zoom stops there and the anchor still holds.
    const clamped = zoomAtPoint({ x: 0, y: 0, zoom: 1.3 }, point, 2, .35, 1.4);
    expect(clamped.zoom).toBe(1.4);
    expect((point.x - clamped.x) / clamped.zoom).toBeCloseTo(point.x / 1.3, 9);
    // Already at a limit, or no change: the very same viewport, so nothing moves or re-renders.
    const max = { x: 12, y: 8, zoom: 1.4 };
    expect(zoomAtPoint(max, point, 1.5, .35, 1.4)).toBe(max);
    expect(zoomAtPoint(viewport, point, 1, .35, 1.4)).toBe(viewport);
    expect(zoomAtPoint(viewport, point, Number.NaN, .35, 1.4)).toBe(viewport);
  });

  it('treats wheel events closer than one gesture gap as one gesture', () => {
    expect(WHEEL_GESTURE_GAP_MS).toBeGreaterThanOrEqual(100);
    expect(WHEEL_GESTURE_GAP_MS).toBeLessThanOrEqual(300);
  });
});
