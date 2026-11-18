// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the existing read-only Canvas shows the execution on the SAME cards and connections — same nodes,
 * positions and links, the card content unchanged — and colors nothing for a record of another revision. No live quote is asked while it runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { editorReducer, initialEditor } from '../domain/editor';
import { canvasAddCommand } from '../domain/canvas-authoring';
import { composerActions, composerConnections } from '../domain/composer-presentation';
import type { CanvasExecution, CanvasNodeExecution } from '../domain/canvas-execution';
import { SimulateWorkflowCanvas } from './simulate-workflow-canvas';

type Graph = { nodes: { id: string; position: { x: number; y: number }; data: Record<string, unknown>; ariaLabel?: string }[];
  edges: { id: string; source: string; target: string; style: { stroke: string }; className?: string }[] };
const fixture = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof import('../state/workflow-store').useWorkflow>, graph: {} as Graph, quotes: 0 }));
vi.mock('../state/workflow-store', () => ({ useWorkflow: () => fixture.store }));
// Counts the cards that may ask for a live quote (a frozen card keeps its estimate and asks nothing).
vi.mock('../state/build-estimate', () => ({ useLiveQuote: (workflow: unknown, _node: string, _owner: unknown, _destination: unknown, frozen?: boolean) => {
  if (workflow && !frozen) fixture.quotes++; return { status: 'idle', estimate: null }; } }));
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    ReactFlow: (props: Graph & { nodeTypes: { workflow: React.ComponentType } }) => {
      fixture.graph = props;
      return React.createElement('div', { 'data-projected-graph': '' }, props.nodes.map(node => React.createElement(props.nodeTypes.workflow, { key: node.id, data: node.data } as React.Attributes)));
    },
    Background: () => null, Controls: () => null, Handle: () => null, Panel: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' }, MarkerType: { ArrowClosed: 'arrowclosed' },
    useStoreApi: () => ({}), useUpdateNodeInternals: () => vi.fn(), useNodesInitialized: () => false, getNodesBounds: vi.fn(), getViewportForBounds: vi.fn(), useReactFlow: () => ({ setViewport: vi.fn() }), useStore: () => '',
  };
});

/** A connected multi-step workflow (Supply → Borrow → Swap): its links are the workflow's own dependencies. */
function authorComposition() {
  const context = createBaseSepoliaReviewContext();
  const state = editorReducer(initialEditor(), canvasAddCommand('lending', 0, '0x1111111111111111111111111111111111111111'), context);
  expect(state.error).toBeNull();
  fixture.store = { state, context, canvasLayout: {}, reviewError: null, dispatch: vi.fn(), propose: vi.fn() } as unknown as typeof fixture.store;
}
const node = (visual: CanvasNodeExecution['visual']): CanvasNodeExecution => ({ visual, phase: visual === 'done' ? 'RECONCILED' : visual === 'pending' ? 'SUBMITTED' : null,
  text: { key: visual === 'done' ? 'Reconciled' : 'Sent to the network', args: [] } });
function execution(visuals: readonly CanvasNodeExecution['visual'][], revision = fixture.store.state.workflow.revision): CanvasExecution {
  const ids = composerActions(fixture.store.state.workflow).map(n => n.nodeId);
  return { key: 'lifecycle:run-1', workflowId: fixture.store.state.workflow.workflowId, revision, nodes: Object.fromEntries(ids.map((id, i) => [id, node(visuals[i] ?? 'waiting')])),
    started: true, settled: !visuals.some(v => ['active', 'wallet', 'authorize', 'pending'].includes(v)), runKeys: ['run-1'] };
}
const render = (props: Partial<Parameters<typeof SimulateWorkflowCanvas>[0]> = {}) => {
  const html = renderToStaticMarkup(createElement(SimulateWorkflowCanvas, { workflowName: 'Supply, borrow and swap', stage: 'execute', ...props }));
  return { html, graph: fixture.graph };
};

beforeEach(() => { fixture.quotes = 0; authorComposition(); });

describe('Live Canvas on the existing read-only Canvas', () => {
  it('keeps the same cards, positions, connections and card content while it colors them from the record', () => {
    const before = render();
    const nodesBefore = before.graph.nodes.map(n => ({ id: n.id, position: n.position })), edgesBefore = before.graph.edges.map(e => [e.id, e.source, e.target]);
    expect(composerConnections(fixture.store.state.workflow).length).toBeGreaterThan(0);
    const during = render({ execution: execution(['done', 'pending', 'waiting']) });
    expect(during.graph.nodes.map(n => ({ id: n.id, position: n.position }))).toEqual(nodesBefore);
    expect(during.graph.edges.map(e => [e.id, e.source, e.target])).toEqual(edgesBefore);
    // The card's own content is untouched: the same summary object, plus its execution state.
    for (const [index, n] of during.graph.nodes.entries()) expect(n.data.summary).toEqual(before.graph.nodes[index]!.data.summary);
    expect(during.html.match(/data-execution="(\w+)"/g)).toEqual(['data-execution="live"', 'data-execution="done"', 'data-execution="pending"', 'data-execution="waiting"']);
    expect(during.html).toContain('class="canvas-execution-badge" data-visual="done"');
    expect(during.html).toContain('Execution status: Reconciled');
    expect(during.graph.nodes[0]!.ariaLabel).toMatch(/· Completed$/);
    expect(during.html).toContain('Live execution');
  });
  it('colors a satisfied dependency green and the transition it unlocks blue', () => {
    const { graph } = render({ execution: execution(['done', 'pending', 'waiting']) });
    expect(graph.edges[1]).toMatchObject({ className: 'canvas-execution-edge canvas-execution-edge-waiting', style: { stroke: 'var(--edge-line)' } });
    expect(graph.edges[0]).toMatchObject({ className: 'canvas-execution-edge canvas-execution-edge-active', style: { stroke: 'var(--canvas-exec-active)' } });
    const finished = render({ execution: execution(['done', 'done', 'done']) });
    expect(finished.graph.edges[0]).toMatchObject({ className: 'canvas-execution-edge canvas-execution-edge-done', style: { stroke: 'var(--canvas-exec-done)' } });
    expect(finished.html).toContain('Execution result');
  });
  it('while the workflow executes, every card keeps its estimate and asks for no new quote (the plan before it still does)', () => {
    const before = render();
    const planned = fixture.quotes;
    expect(planned).toBeGreaterThan(0);
    // The card data is the same (its estimate inputs are kept): only the quote hook is frozen.
    const quoted = before.graph.nodes.filter(n => n.data.estimateWorkflow).map(n => n.id);
    fixture.quotes = 0;
    const running = render({ execution: execution(['pending', 'waiting', 'waiting']) });
    expect(running.graph.nodes.filter(n => n.data.estimateWorkflow).map(n => n.id)).toEqual(quoted);
    expect(running.graph.nodes.every(n => n.data.quoteFrozen === true)).toBe(true);
    expect(fixture.quotes).toBe(0);
  });
  it('ignores a record of another revision or workflow: no state, no badge, the plan as before', () => {
    for (const stale of [execution(['done', 'done', 'done'], fixture.store.state.workflow.revision + 1), { ...execution(['done', 'done', 'done']), workflowId: 'workflow-other' }]) {
      const { html, graph } = render({ execution: stale });
      expect(html).not.toContain('data-execution');
      expect(html).not.toContain('canvas-execution-badge');
      expect(graph.edges.every(e => e.style.stroke === 'var(--edge-line)')).toBe(true);
    }
  });
  it('a waiting step keeps the neutral card (no badge); a failed one is labeled, not only colored', () => {
    const base = execution(['failed', 'waiting', 'waiting']), first = Object.keys(base.nodes)[0]!;
    const failed: CanvasExecution = { ...base, nodes: { ...base.nodes, [first]: { visual: 'failed', phase: 'FAILED', text: { key: 'Failed', args: [] } } } };
    const { html } = render({ execution: failed });
    expect(html.match(/canvas-execution-badge"/g)).toHaveLength(1);
    expect(html).toContain('data-visual="failed"'); expect(html).toContain('Execution status: Failed');
  });
});
