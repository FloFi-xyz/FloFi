// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { canvasPosition, defaultCanvasPosition, flowCanvasPositions, lendingCanvasPosition, reconcileCanvasLayout, shownCanvasPositions, CANVAS_COLUMN, CANVAS_ROW } from './canvas-layout';
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
  // BUILD-FLOFI-BUILDER-UX-002: new cards land in reading order or beside the step they consume, never on a card already placed; layout only.
  const step = (nodeId: string, dependencies: string[] = []) => ({ ...templateWorkflow().nodes[0]!, nodeId, dependencies }) as Parameters<typeof canvasPosition>[1];
  it('places independent new steps in the next free reading-order slot', () => {
    const nodes = [step('a'), step('b'), step('c')];
    expect(flowCanvasPositions(nodes, {})).toEqual({ a: defaultCanvasPosition(0), b: defaultCanvasPosition(1), c: defaultCanvasPosition(2) });
    // The owner moved `a` onto slot 1: `b` takes slot 2 instead of covering it, and stored positions never move.
    const moved = { a: { ...defaultCanvasPosition(1), actionType: nodes[0]!.actionType } };
    expect(flowCanvasPositions(nodes, moved)).toEqual({ a: defaultCanvasPosition(1), b: defaultCanvasPosition(2), c: defaultCanvasPosition(3) });
    // A card being set up is avoided too.
    expect(flowCanvasPositions([step('a')], {}, [defaultCanvasPosition(0)])).toEqual({ a: defaultCanvasPosition(1) });
  });
  it('puts a consumer to the right of the step it depends on, and below when that place is taken', () => {
    const producer = { x: 400, y: 500, actionType: step('p').actionType };
    expect(flowCanvasPositions([step('p'), step('c', ['p'])], { p: producer })).toEqual({ p: { x: 400, y: 500 }, c: { x: 400 + CANVAS_COLUMN, y: 500 } });
    const taken = { p: producer, other: { x: 400 + CANVAS_COLUMN, y: 500, actionType: producer.actionType } };
    expect(flowCanvasPositions([step('p'), step('other'), step('c', ['p'])], taken).c).toEqual({ x: 400 + CANVAS_COLUMN, y: 500 + CANVAS_ROW });
    // Independent steps beside it are not treated as linked: they keep their reading-order slots.
    expect(flowCanvasPositions([step('p'), step('q')], { p: producer }).q).toEqual(defaultCanvasPosition(1));
  });
  it('continues a long linked chain on the next row after the third column', () => {
    const chain = [step('a'), step('b', ['a']), step('c', ['b']), step('d', ['c'])];
    expect(flowCanvasPositions(chain, {})).toEqual({ a: defaultCanvasPosition(0), b: defaultCanvasPosition(1), c: defaultCanvasPosition(2),
      d: { x: defaultCanvasPosition(0).x, y: defaultCanvasPosition(0).y + CANVAS_ROW } });
  });
  it('draws a lending composition without stored places in its column, and keeps stored places', () => {
    const nodes = [step('s'), step('b', ['s'])];
    expect(shownCanvasPositions(nodes, {}, { lending: true })).toEqual({ s: lendingCanvasPosition(0), b: lendingCanvasPosition(1) });
    expect(shownCanvasPositions(nodes, { s: { x: 7, y: 9, actionType: nodes[0]!.actionType } }, { lending: true }).s).toEqual({ x: 7, y: 9 });
  });
});
