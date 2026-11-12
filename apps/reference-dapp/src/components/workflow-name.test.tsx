// SPDX-License-Identifier: AGPL-3.0-only
/**
 * UX-002: the existing "Automate this workflow" action stays beside Save in the workflow header.
 * P0 approved UX (board 04, intentional change): the name itself is the rename control, and Save, Automate (where enabled) and the toolbar layout
 * moved into the header's ··· menu.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { WorkflowMoreMenu, WorkflowName } from './workflow-name';

describe('UX-002 workflow header automation control', () => {
  it('names the workflow on a rename button with a muted pencil; the ··· menu offers Save, then Automate (clock), then the layout', () => {
    const rename = vi.fn();
    const name = renderToStaticMarkup(createElement(WorkflowName, { name: 'Your Workflow', rename }));
    expect(name).toMatch(/<h2><button type="button" class="workflow-rename" aria-label="Rename workflow: Your Workflow" title="Click to rename"><span class="workflow-name-text">Your Workflow<\/span><svg[^>]*aria-hidden="true"/);
    expect(rename).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(createElement(WorkflowMoreMenu, { onSave: vi.fn(), onAutomate: vi.fn(), dock: { docked: false, toggle: vi.fn() } }));
    expect(html).toContain('aria-label="More options" title="More options" aria-haspopup="menu" aria-expanded="false"');
    // The menu is closed until opened; its items keep their order (Save, Automate, toolbar layout).
    expect(html).toMatch(/role="menu" aria-label="More options" hidden=""/);
    const order = ['workflow-save', 'workflow-automate', 'toolbox-mode-toggle'].map(name => html.indexOf(`class="${name}"`));
    expect(order.every(index => index > 0)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/role="menuitem" tabindex="-1" class="workflow-automate"><svg[^>]*aria-hidden="true"><circle cx="12" cy="12" r="9"><\/circle><path d="M12 7v5l3 2"><\/path><\/svg><span>Automate this workflow<\/span>/);
    expect(html.match(/Automate this workflow/g)).toHaveLength(1);
    expect(html).toContain('<span>Save workflow</span>'); expect(html).toContain('<span>Dock toolbar</span>');
  });
  it('shows no automation control where automations are unavailable', () => {
    expect(renderToStaticMarkup(createElement(WorkflowMoreMenu, { onSave: vi.fn(), dock: { docked: true, toggle: vi.fn() } }))).not.toContain('Automate');
    expect(renderToStaticMarkup(createElement(WorkflowMoreMenu, { onSave: vi.fn(), dock: { docked: true, toggle: vi.fn() } }))).toContain('Undock toolbar');
  });
  it('removes the former floating Canvas control; the Canvas passes the same handler to the header', () => {
    const canvas = readFileSync(new URL('./workflow-canvas.tsx', import.meta.url), 'utf8'), css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
    expect(canvas).not.toContain('canvas-automate-action'); expect(css).not.toContain('canvas-automate-action');
    expect(canvas).toContain("onAutomate={onAutomate && workflow.nodes.some(node => !node.actionType.startsWith('mock-')) ? onAutomate : undefined}");
    expect(canvas.match(/Automate this workflow/g) ?? []).toHaveLength(0);
  });
});
