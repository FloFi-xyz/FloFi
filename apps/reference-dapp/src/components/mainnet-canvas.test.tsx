// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-MAINNET-PRODUCT-001: the Canvas of the Mainnet-only product (rendered without a browser; the store is the canonical editor). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { initialEditor, editorReducer } from '../domain/editor';
import { canvasAddCommand } from '../domain/canvas-authoring';
import { setActiveNetworkScope } from '../domain/network-scope';
import { WorkflowCanvas } from './workflow-canvas';

const fixture = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof import('../state/workflow-store').useWorkflow> }));
vi.mock('../state/workflow-store', () => ({ useWorkflow: () => fixture.store }));
vi.mock('../state/build009-wallet-store', () => ({ useBuild009Wallet: () => ({ account: '0x1111111111111111111111111111111111111111', chainId: '0x14a34' }) }));
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    ReactFlow: ({ nodes, nodeTypes }: { nodes: { id: string; data: unknown }[]; nodeTypes: { workflow: React.ComponentType } }) =>
      React.createElement('div', null, nodes.map(node => React.createElement(nodeTypes.workflow, { key: node.id, ...{ id: node.id, data: node.data } as object }))),
    MarkerType: { ArrowClosed: 'arrowclosed' }, Background: () => null, Controls: () => null, Handle: () => null, Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useNodesState: (nodes: unknown) => [nodes, vi.fn(), vi.fn()], useNodesInitialized: () => false,
    useReactFlow: () => ({ fitView: vi.fn() }), useStore: () => '', useStoreApi: () => ({}), useUpdateNodeInternals: () => vi.fn(),
  };
});
const owner = '0x1111111111111111111111111111111111111111';
function setWorkflow(action?: 'supply') {
  const context = createBaseSepoliaReviewContext();
  const state = action ? editorReducer(initialEditor(), canvasAddCommand(action, 0, owner, '1'), context) : initialEditor();
  fixture.store = { state, context, canvasLayout: {}, canUndo: false, canRedo: false, cryptoSelections: {}, bridgeNetworkInputs: {}, amountInputs: {}, recipientInputs: {},
    dispatch: vi.fn(), propose: vi.fn(), undo: vi.fn(), redo: vi.fn(), moveCanvasNodes: vi.fn(), addCanvasCommand: vi.fn(), duplicateCanvasNodes: vi.fn(), editCryptoSelection: vi.fn(),
    editBridgeNetworks: vi.fn() } as unknown as typeof fixture.store;
}
const render = () => renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: null, select: vi.fn(), environment: 'mainnet' }));
afterEach(() => setActiveNetworkScope(null));

describe('the Canvas of the Mainnet-only product', () => {
  it('opens a test-network workflow as it was, says why it cannot run, and offers only the owner\'s explicit rebuild on its mainnet', () => {
    setActiveNetworkScope('PUBLIC_MAINNET');
    setWorkflow('supply');
    const before = JSON.stringify(fixture.store.state.workflow), html = render();
    expect(html).toContain('data-legacy-network="base-sepolia"');
    expect(html).toContain('Base Sepolia is a test network. FloFi runs on mainnets only, with real funds: rebuild this on Base.');
    expect(html).toContain('>Rebuild on Base</button>');
    // Nothing is re-networked or proposed by opening it.
    expect(JSON.stringify(fixture.store.state.workflow)).toBe(before);
    for (const handler of [fixture.store.dispatch, fixture.store.propose, fixture.store.addCanvasCommand, fixture.store.editCryptoSelection, fixture.store.editBridgeNetworks])
      expect(handler).not.toHaveBeenCalled();
  });
  it('offers no test-network-only action in the toolbar', () => {
    setActiveNetworkScope('PUBLIC_MAINNET');
    setWorkflow();
    const html = render();
    expect(html).not.toContain('Add Supply → Borrow → Swap');
    expect(html).not.toContain('data-legacy-network');
    expect(html).toContain('aria-label="Add swap"');
  });
  it('keeps engineering certification unchanged', () => {
    setActiveNetworkScope('ENGINEERING');
    setWorkflow('supply');
    const html = render();
    expect(html).not.toContain('data-legacy-network');
    expect(html).toContain('Add Supply → Borrow → Swap');
  });
});
