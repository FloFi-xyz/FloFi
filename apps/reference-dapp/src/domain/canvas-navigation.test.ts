// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { navigateCanvas } from './canvas-navigation';
it('preserves the flow coordinate under the cursor across zoom and bounds', () => {
  const view = { x: -30, y: 70, zoom: .7 }, point = { x: 270, y: 120, deltaX: 0, deltaY: -40, shiftKey: false, deltaMode: 0 };
  for (const deltaY of [-10000, -40, 40, 10000]) {
    const next = navigateCanvas(view, { ...point, deltaY }, .35, 1.4);
    expect((point.x - next.x) / next.zoom).toBeCloseTo((point.x - view.x) / view.zoom, 10);
    expect((point.y - next.y) / next.zoom).toBeCloseTo((point.y - view.y) / view.zoom, 10);
    expect(next.zoom).toBeGreaterThanOrEqual(.35); expect(next.zoom).toBeLessThanOrEqual(1.4);
  }
});
it('pans both axes with Shift and normalizes line-based mouse wheels', () => {
  expect(navigateCanvas({ x: 10, y: 20, zoom: 1 }, { x: 0, y: 0, deltaX: 2, deltaY: 3, deltaMode: 1, shiftKey: true }, .35, 1.4)).toEqual({ x: -22, y: -28, zoom: 1 });
});
