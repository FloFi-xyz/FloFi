// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the Build Canvas (`WorkflowCanvas`) shows the execution the shell hands it on its own cards and
 * connections — same nodes and positions — and colors nothing for a record of another revision or workflow.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { initialEditor, editorReducer } from '../domain/editor';
import { canvasAddCommand } from '../domain/canvas-authoring';
import { composerActions } from '../domain/composer-presentation';
import type { CanvasExecution, CanvasNodeExecution } from '../domain/canvas-execution';
import { WorkflowCanvas } from './workflow-canvas';

type Graph = { nodes: { id: string; position: { x: number; y: number }; data: Record<string, unknown> }[];
  edges: { id: string; source: string; target: string; className?: string; style?: { stroke?: string } }[] };
const fixture = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof import('../state/workflow-store').useWorkflow>, graph: { nodes: [], edges: [] } as Graph }));
vi.mock('../state/workflow-store', () => ({ useWorkflow: () => fixture.store }));
vi.mock('../state/build009-wallet-store', () => ({ useBuild009Wallet: () => ({ account: '0x1111111111111111111111111111111111111111', chainId: '0x14a34' }) }));
vi.mock('../state/build-estimate', () => ({ useLiveQuote: () => ({ status: 'idle', estimate: null }) }));
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    ReactFlow: (props: Graph & { nodeTypes: { workflow: React.ComponentType } }) => {
      fixture.graph = props;
      return React.createElement('div', null, props.nodes.map(node => React.createElement(props.nodeTypes.workflow, { key: node.id, ...{ id: node.id, data: node.data } as object })));
    },
    MarkerType: { ArrowClosed: 'arrowclosed' }, Background: () => null, Controls: () => null, Handle: () => null, NodeToolbar: () => null,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useNodesState: (nodes: unknown) => [nodes, vi.fn(), vi.fn()], useNodesInitialized: () => false,
    useReactFlow: () => ({ fitView: vi.fn(), setViewport: vi.fn() }), useStore: () => '', useStoreApi: () => ({}), useUpdateNodeInternals: () => vi.fn(), getNodesBounds: vi.fn(),
  };
});

const owner = '0x1111111111111111111111111111111111111111';
beforeEach(() => {
  const context = createBaseSepoliaReviewContext();
  const state = editorReducer(initialEditor(), canvasAddCommand('lending', 0, owner), context);
  expect(state.error).toBeNull();
  fixture.store = { state, context, canvasLayout: {}, canUndo: false, canRedo: false, cryptoSelections: {}, bridgeNetworkInputs: {}, amountInputs: {}, recipientInputs: {},
    dispatch: vi.fn(), propose: vi.fn(), undo: vi.fn(), redo: vi.fn(), moveCanvasNodes: vi.fn(), addCanvasCommand: vi.fn(), duplicateCanvasNodes: vi.fn(), editCryptoSelection: vi.fn(),
    editBridgeNetworks: vi.fn() } as unknown as typeof fixture.store;
});
const node = (visual: CanvasNodeExecution['visual']): CanvasNodeExecution => ({ visual, phase: visual === 'done' ? 'RECONCILED' : visual === 'pending' ? 'SUBMITTED' : null,
  text: { key: visual === 'done' ? 'Reconciled' : 'Sent to the network', args: [] } });
function execution(visuals: readonly CanvasNodeExecution['visual'][], identity: { workflowId?: string; revision?: number } = {}): CanvasExecution {
  const workflow = fixture.store.state.workflow, ids = composerActions(workflow).map(n => n.nodeId);
  return { key: 'lifecycle:run-1', workflowId: identity.workflowId ?? workflow.workflowId, revision: identity.revision ?? workflow.revision,
    nodes: Object.fromEntries(ids.map((id, i) => [id, node(visuals[i] ?? 'waiting')])), started: true, settled: false, runKeys: ['run-1'] };
}
const render = (exec: CanvasExecution | null) => {
  const html = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: null, select: vi.fn(), environment: 'mainnet', runActive: true, execution: exec }));
  return { html, graph: fixture.graph };
};

describe('Live Canvas on the Build Canvas', () => {
  it('colors the same cards and connections from the execution, without moving a card', () => {
    const before = render(null);
    const positions = before.graph.nodes.map(n => [n.id, n.position.x, n.position.y]), links = before.graph.edges.map(e => [e.id, e.source, e.target]);
    expect(before.html).not.toContain('data-execution=');
    const live = render(execution(['done', 'pending', 'waiting']));
    expect(live.graph.nodes.map(n => [n.id, n.position.x, n.position.y])).toEqual(positions);
    expect(live.graph.edges.map(e => [e.id, e.source, e.target])).toEqual(links);
    expect(live.graph.nodes.map(n => (n.data.execution as CanvasNodeExecution | undefined)?.visual)).toEqual(['done', 'pending', 'waiting']);
    expect(live.html).toContain('data-execution="live"');
    expect(live.html).toContain('data-execution="done"'); expect(live.html).toContain('data-execution="pending"');
    // The first link's dependency is reconciled and the step it unlocks is in flight: it is the active (blue) connection.
    expect(live.graph.edges[0]!.className).toContain('canvas-execution-edge-active');
  });
  it('colors nothing for a record of another revision or workflow', () => {
    const revision = fixture.store.state.workflow.revision;
    for (const stale of [execution(['done', 'pending'], { revision: revision + 1 }), execution(['done', 'pending'], { workflowId: 'another-workflow' })]) {
      const { html, graph } = render(stale);
      expect(html).not.toContain('data-execution=');
      expect(graph.nodes.every(n => n.data.execution === undefined)).toBe(true);
      expect(graph.edges.every(e => !e.className?.includes('canvas-execution-edge'))).toBe(true);
    }
  });
});
