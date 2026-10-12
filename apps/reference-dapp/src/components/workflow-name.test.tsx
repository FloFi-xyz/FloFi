// SPDX-License-Identifier: AGPL-3.0-only
/** UX-002: the existing "Automate this workflow" action is a clock icon beside the workflow name's rename/save controls. */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { WorkflowName } from './workflow-name';

describe('UX-002 workflow header automation control', () => {
  it('places one accessible clock control immediately after rename and save, with its tooltip', () => {
    const html = renderToStaticMarkup(createElement(WorkflowName, { name: 'Your Workflow', rename: vi.fn(), onSave: vi.fn(), onAutomate: vi.fn() }));
    const order = ['workflow-rename', 'workflow-save', 'workflow-automate'].map(name => html.indexOf(`class="${name}"`));
    expect(order.every(index => index > 0)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('<button type="button" class="workflow-automate" aria-label="Automate this workflow" title="Automate this workflow">');
    expect(html.match(/Automate this workflow/g)).toHaveLength(2);
    expect(html).toMatch(/class="workflow-automate"[^>]*><svg[^>]*aria-hidden="true"><circle cx="12" cy="12" r="9"><\/circle><path d="M12 7v5l3 2"><\/path><\/svg>/);
  });
  it('shows no automation control where automations are unavailable', () => {
    expect(renderToStaticMarkup(createElement(WorkflowName, { name: 'Your Workflow', rename: vi.fn(), onSave: vi.fn() }))).not.toContain('Automate');
  });
  it('removes the former floating Canvas control; the Canvas passes the same handler to the header', () => {
    const canvas = readFileSync(new URL('./workflow-canvas.tsx', import.meta.url), 'utf8'), css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
    expect(canvas).not.toContain('canvas-automate-action'); expect(css).not.toContain('canvas-automate-action');
    expect(canvas).toContain("onAutomate={onAutomate && workflow.nodes.some(node => !node.actionType.startsWith('mock-')) ? onAutomate : undefined}");
    expect(canvas.match(/Automate this workflow/g) ?? []).toHaveLength(0);
  });
});
