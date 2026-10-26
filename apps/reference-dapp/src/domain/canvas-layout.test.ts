// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { canvasPosition, defaultCanvasPosition, reconcileCanvasLayout } from './canvas-layout';
import { templateWorkflow } from './initial-workflow';
import { editorReducer, templateEditor } from './editor';
import { parseMockCommand } from './commands';

describe('workflow canvas layout', () => {
  it('stores positions beside, not in, semantic IR and survives semantic edits', () => {
    const initial = templateWorkflow();
    const layout = { 'node-001': { x: 420, y: 315, actionType: 'mock-read' } };
    const changed = editorReducer(templateEditor(), parseMockCommand('add transform', 0));
    expect(canvasPosition(reconcileCanvasLayout(layout, changed.workflow), changed.workflow.nodes[0]!, 0)).toEqual({ x: 420, y: 315 });
    expect(changed.workflow.nodes[0]).toEqual(initial.nodes[0]);
    expect(changed.workflow.revision).toBe(1);
    expect(initial.revision).toBe(0);
    expect('position' in changed.workflow.nodes[0]!).toBe(false);
    expect(defaultCanvasPosition(0)).not.toEqual(defaultCanvasPosition(1));
  });
  it('drops stale positions when a semantic action is replaced', () => {
    const workflow = templateWorkflow();
    expect(reconcileCanvasLayout({ 'node-001': { x: 9, y: 12, actionType: 'asset.bridge' } }, workflow)).toEqual({});
  });
});
