// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CANVAS_GESTURES, CanvasNavigator } from './canvas-navigator';

const viewport = vi.hoisted(() => ({ transform: [0, 0, 1], minZoom: .35, maxZoom: 1.4, width: 1044 }));
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    Panel: ({ position, ...props }: { position: string }) => React.createElement('div', { ...props, 'data-position': position }),
    useStore: (select: (state: typeof viewport) => unknown) => select(viewport),
    useReactFlow: () => ({ fitView: vi.fn(), zoomTo: vi.fn() }),
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
