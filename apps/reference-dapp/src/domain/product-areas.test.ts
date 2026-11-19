// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { PRODUCT_AREAS, productArea } from './product-areas';

// BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio, A2/B2/C2): the global navigation names product areas, each an existing destination.
describe('product areas', () => {
  it('are Operate, Dashboard and My Workflows, in that order, on the existing routes', () => {
    expect(PRODUCT_AREAS.map(area => [area.label, area.href])).toEqual([['Operate', '/app'], ['Dashboard', '/app/dashboard'], ['My Workflows', '/app/workflows']]);
  });
  it('marks the area of the current page, and none outside the three areas', () => {
    expect(productArea('/app')).toBe('operate');
    expect(productArea('/app', 'Build')).toBe('operate');
    expect(productArea(null)).toBe('operate');
    expect(productArea('/app/dashboard')).toBe('dashboard');
    expect(productArea('/app/dashboard/runs/run-1')).toBe('dashboard');
    expect(productArea('/app/workflows')).toBe('workflows');
    expect(productArea('/app/automations')).toBeNull();
    expect(productArea('/app/credentials')).toBeNull();
  });
});
