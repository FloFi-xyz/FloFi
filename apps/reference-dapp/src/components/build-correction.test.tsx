// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { lintWorkflow, createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { initialEditor, editorReducer } from '../domain/editor';
import { canvasAddCommand } from '../domain/canvas-authoring';
import { ActionRail, CANVAS_STEP_ACTIONS, RAIL_EXPANDED_KEY, RAIL_GROUPS, WorkflowCanvas, readRailExpanded, saveRailExpanded } from './workflow-canvas';
import { setActiveNetworkScope } from '../domain/network-scope';
import type { EditorOverview } from '../domain/editor-overview';
import type { LiveQuote } from '../state/build-estimate';
import { ActionSettingsContent } from './artifact-inspector';
import { createUniswapLiquidityNode } from '../domain/uniswap-liquidity-authoring';
import { ComposerCard, significantAmount, type ComposerCardData } from './composer-card';
import { createCrossChainLiquidityWorkflow } from '../domain/cross-chain-liquidity';
import { createSolanaSwapNode } from '../domain/jupiter-authoring';
import { createSolanaLiquidityNode } from '../domain/solana-liquidity-authoring';
import { composerSummary, composerConnections, composerNodeState, supplyProposalTarget } from '../domain/composer-presentation';
/** BUILD-FLOFI-BUILDER-UX-002: a card title renders its step number in a circle; its text is still "N. Action". */
const titled = (html: string) => html.replace(/<span class="composer-step-number">(\d+)<\/span><span class="composer-step-dot">\. <\/span><span class="composer-action-name">([^<]+)<\/span>/g, '$1. $2');

const fixture = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof import('../state/workflow-store').useWorkflow>, quote: null as unknown }));
vi.mock('../state/workflow-store', () => ({ useWorkflow: () => fixture.store }));
vi.mock('../state/build009-wallet-store', () => ({ useBuild009Wallet: () => ({ account: '0x1111111111111111111111111111111111111111' }) }));
// A card's live quote is the shared estimate hook; a test may answer it with a fixed estimate (otherwise the real hook runs, with no request).
vi.mock('../state/build-estimate', async importOriginal => {
  const actual = await importOriginal<typeof import('../state/build-estimate')>();
  return { ...actual, useLiveQuote: (...args: Parameters<typeof actual.useLiveQuote>) => (fixture.quote as LiveQuote | null) ?? actual.useLiveQuote(...args) };
});
// Render the actual card projection without a browser/layout engine. Financial state stays in the canonical editor.
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    // Of the graph's overlays, only the selected card's toolbar is rendered here (the viewport, zoom and focus helpers need a browser).
    ReactFlow: ({ nodes, nodeTypes, nodesDraggable, nodesConnectable, elementsSelectable, children }: { nodes: { id: string; data: unknown }[]; nodeTypes: { workflow: React.ComponentType }; nodesDraggable?: boolean; nodesConnectable?: boolean; elementsSelectable?: boolean; children?: React.ReactNode }) =>
      React.createElement('div', { 'data-graph-readonly': nodesDraggable === false && nodesConnectable === false && elementsSelectable === false }, nodes.map(node => React.createElement(nodeTypes.workflow, { key: node.id, data: node.data } as React.Attributes)),
        React.Children.toArray(children).filter(child => React.isValidElement(child) && (child.type as { name?: string }).name === 'SelectionToolbar')),
    NodeToolbar: ({ isVisible, nodeId, className, children }: { isVisible?: boolean; nodeId: string | string[]; className?: string; children?: React.ReactNode }) =>
      isVisible ? React.createElement('div', { className, 'data-node-toolbar': [nodeId].flat().join(' ') }, children) : null,
    MarkerType: { ArrowClosed: 'arrowclosed' }, Background: () => null, Controls: () => null, Handle: () => null, Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useNodesState: (nodes: unknown) => [nodes, vi.fn(), vi.fn()], useNodesInitialized: () => false,
    useReactFlow: () => ({ fitView: vi.fn() }), useStore: () => '', useStoreApi: () => ({}), useUpdateNodeInternals: () => vi.fn(),
  };
});

describe('Execute workflow overview', () => {
  function renderOverview() {
    const before = JSON.stringify(fixture.store.state.workflow);
    const html = renderToStaticMarkup(createElement(WorkflowCanvas, { mode: 'execute', workflowName: 'ESPARTACUS' }));
    expect(html).toContain('aria-label="Workflow overview graph"');
    expect(html).toContain('data-graph-readonly="true"');
    expect(html).toContain('<h2>ESPARTACUS</h2>');
    expect(html).not.toMatch(/<form|<input|data-mocked-value|Expected |Minimum |Select to edit|Generate mocked|MOCK|EXECUTE \/ UNAVAILABLE|Completed|Running|Confirmed/);
    expect(JSON.stringify(fixture.store.state.workflow)).toBe(before);
    for (const handler of [fixture.store.dispatch, fixture.store.propose, fixture.store.moveCanvasNodes, fixture.store.addCanvasCommand]) expect(handler).not.toHaveBeenCalled();
    return html;
  }

  it('renders an empty workflow surface without the internal scaffold or authoring controls', () => {
    setWorkflow();
    expect(renderOverview()).not.toMatch(/class="flow-card|<button|Start your workflow|Add action|Rename workflow|flofi-droplet-wave|canvas-empty-mascot/);
  });

  it.each(['supply', 'borrow', 'repay', 'withdraw'] as const)('shows the canonical %s parameters without editing or execution claims', action => {
    setWorkflow(action);
    const html = renderOverview();
    expect(html).toContain('class="flow-card"');
    expect(html).toContain('USDC');
    expect(html).toContain('AAVE V3');
    expect(html).toContain('Base Sepolia');
  });

  it('shows the authored swap amount without projecting simulation outputs as execution results', () => {
    setWorkflow();
    fixture.store.state = editorReducer(initialEditor(), { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '2.25', slippage: '50', source: 'CHAT', baseRevision: 0 }, fixture.store.context);
    const html = renderOverview();
    expect(html).toContain('USDC → WETH');
    expect(html).toContain('2.25 USDC');
    expect(fixture.store.state.workflow.revision).toBe(1);
  });
});

const authoredPoolInput = { network: 'Base Sepolia' as const, maxUsdc: '1', maxWeth: '0.0001', rangeUnit: 'TICK' as const, lower: '-887270', upper: '887270', slippage: '50' };
const owner = '0x1111111111111111111111111111111111111111';
function setWorkflow(action?: 'supply' | 'borrow' | 'repay' | 'withdraw') {
  const context = createBaseSepoliaReviewContext();
  const state = action ? editorReducer(initialEditor(), canvasAddCommand(action, 0, owner, '1'), context) : initialEditor();
  fixture.store = { state, context, canvasLayout: {}, canUndo: false, canRedo: false,
    dispatch: vi.fn(), propose: vi.fn(), undo: vi.fn(), redo: vi.fn(), moveCanvasNodes: vi.fn(), addCanvasCommand: vi.fn(), duplicateCanvasNodes: vi.fn(),
  } as unknown as typeof fixture.store;
  return state.workflow.nodes.find(node => node.actionType === action)?.nodeId ?? null;
}

describe('corrected Build workspace presentation', () => {
  it('shows an empty authoring surface instead of the internal starting scaffold', () => {
    setWorkflow();
    const before = JSON.stringify(fixture.store.state.workflow);
    const html = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: null, select: vi.fn() }));
    expect(html).toContain('Start your workflow');
    expect(html).toMatch(/data-graph-readonly="false"><\/div><div class="canvas-empty"><span class="canvas-empty-mascot" aria-hidden="true">/);
    const lightImage = html.match(/<img[^>]*class="flofi-droplet-wave-light"[^>]*>/)?.[0];
    expect(lightImage).toContain('alt=""');
    expect(lightImage).toContain('draggable="false"');
    expect(lightImage).toContain('src="/brand/flofi-droplet-wave.svg"');
    expect(html).toContain('src="/brand/flofi-droplet-wave-dark.svg"');
    expect(html).toMatch(/class="canvas-empty-mascot"[\s\S]*?<\/span><strong>Start your workflow<\/strong><p>Add an action from the toolbar/);
    expect(html).not.toMatch(/class="flow-card|Mock example|Local mock|MOCK ACTION|Template.*no execution/i);
    expect(JSON.stringify(fixture.store.state.workflow)).toBe(before);
    expect(fixture.store.dispatch).not.toHaveBeenCalled();
    expect(fixture.store.addCanvasCommand).not.toHaveBeenCalled();
  });

  // P0 approved UX (board 04, intentional change): Privacy is no longer shown as a disabled placeholder (hidden until it is available); the name is
  // its own rename control and Save moved into the header's ··· menu.
  it('offers no Privacy placeholder and renders the presentation title without editing IR', () => {
    setWorkflow();
    const before = JSON.stringify(fixture.store.state.workflow);
    const renameWorkflow = vi.fn();
    const html = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: null, select: vi.fn(), workflowName: 'ETH Carry Strategy', renameWorkflow, onSave: vi.fn() }));
    expect(html).toMatch(/<h2><button type="button" class="workflow-rename" aria-label="Rename workflow: ETH Carry Strategy" title="Click to rename"><span class="workflow-name-text">ETH Carry Strategy<\/span>/);
    expect(html).toMatch(/aria-label="More options"[\s\S]*?role="menu"[\s\S]*?class="workflow-save"[^>]*>[\s\S]*?<span>Save workflow<\/span>/);
    expect(html).toContain('aria-label="Add withdraw"');
    expect(html).not.toMatch(/Privacy|Cloak|Zcash/);
    expect(JSON.stringify(fixture.store.state.workflow)).toBe(before);
    expect(renameWorkflow).not.toHaveBeenCalled();
    expect(fixture.store.dispatch).not.toHaveBeenCalled();
    expect(fixture.store.addCanvasCommand).not.toHaveBeenCalled();
  });

  // BUILD-FLOFI-BUILDER-UX-002 (owner-approved brief): the Canvas lifecycle control lives once in the Editor footer (summary-bar.test.tsx); the Build
  // Canvas hosts none, so it can never be duplicated, and rendering the Canvas triggers no authoring or navigation.
  it('hosts no lifecycle control in the Build graph and triggers no authoring on render', () => {
    setWorkflow();
    const html = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: null, select: vi.fn() }));
    expect(html).toMatch(/aria-label="Workflow graph"/);
    expect(html).not.toMatch(/canvas-primary-action|data-lifecycle-action/);
    expect(fixture.store.dispatch).not.toHaveBeenCalled();
    expect(fixture.store.addCanvasCommand).not.toHaveBeenCalled();
  });

  it.each(['supply', 'borrow', 'repay', 'withdraw'] as const)('%s is a compact selected card with its existing editor binding', action => {
    const selectedId = setWorkflow(action);
    const before = JSON.stringify(fixture.store.state.workflow);
    const canvas = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId, select: vi.fn() }));
    expect(canvas).toContain('class="flow-card composer-card active"');
    expect(canvas).not.toMatch(/canvas-empty-mascot|flofi-droplet-wave|Start your workflow/);
    expect(canvas).toContain('Aave V3');
    expect(canvas).toContain('Base Sepolia');
    // BUILD-FLOFI-CONVERSATIONAL-001: the card's own settings control (no bottom Advanced Settings inspector) opens its settings dialog.
    expect(canvas).not.toContain('Advanced Settings');
    expect(canvas).toMatch(/<button type="button" class="composer-selected nodrag nopan" aria-haspopup="dialog" aria-expanded="false" aria-label="Action settings"[^>]*>Settings\s*<svg/);
    const name = action[0]!.toUpperCase() + action.slice(1);
    expect(canvas).toMatch(new RegExp(`class="composer-action-title"><span class="composer-step-number">1</span><span class="composer-step-dot">\\. </span><span class="composer-action-name">${name}</span><svg[^>]*aria-hidden="true"[^>]*>[\\s\\S]*?</svg></strong>`));
    expect(titled(canvas)).toContain(`1. ${name}`);
    // BUILD-FLOFI-BUILDER-UX-002 (owner-approved brief): one discreet status per card, from the review and the Canvas drafts only.
    // P0 approved UX (board 04): "Configured" is the workflow's state in the header only; a card shows a status only for a draft or attention.
    expect((canvas.match(/class="composer-status" data-card-status="(draft|attention)"/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(canvas).not.toContain('data-card-status="configured"');
    expect(canvas).not.toMatch(/Step 1|Simulated|Approved|Ready to execute/);
    expect(canvas).toContain('USDC');
    // BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: the card's only form is its own amount form (Enter applies), never a dialog or a mock.
    expect(canvas.match(/<form/g)).toHaveLength(1);
    expect(canvas).toContain('<form class="composer-amount-form composer-lending-amount-form nodrag nopan"');
    expect(canvas).not.toMatch(/role="dialog"|MOCK ACTION|Template.*no execution/i);
    expect(canvas.match(/class="numeric composer-amount-box/g)).toHaveLength(1);
    expect(canvas).toContain('class="composer-token-chip"');
    expect(canvas).toContain('aria-label="Base Sepolia network"');
    // BUILD-FIX-UX-001: Base Sepolia test tokens have no market value; the card says so instead of a placeholder.
    expect(canvas).toContain('Test token · no USD value');
    expect(canvas).not.toContain('USD value unavailable');
    expect(canvas).not.toMatch(/composer-destination-box|composer-value-arrow/);
    expect(canvas).not.toContain('Liquidity range view');
    expect(canvas).toMatch(/aria-label="Source amount \(USDC\)"[^>]*value="1"/);
    // BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: an ordinary amount edit applies on Enter in the card's own form, so the card offers no
    // Review/Apply proposal and its amount input is not bound to the external review form (a reserve picked on the card still is).
    expect(canvas).not.toMatch(/Review (Supply|Borrow|Repay|Withdraw) change/);
    expect(canvas).not.toMatch(/<input[^>]*form="composer-supply-review-/);
    expect(canvas).not.toContain('Apply proposal');
    const inspector = renderToStaticMarkup(createElement(ActionSettingsContent, { selectedId, select: vi.fn() }));
    expect(inspector).toContain(`aria-label="Edit ${name}"`);
    expect(inspector).toContain(`aria-label="${name} amount (USDC)"`);
    expect(inspector).toContain(`id="composer-supply-review-${selectedId}"`);
    expect(inspector).not.toContain(`Review ${name} change`);
    expect(JSON.stringify(fixture.store.state.workflow)).toBe(before);
    expect(fixture.store.dispatch).not.toHaveBeenCalled();
    expect(fixture.store.propose).not.toHaveBeenCalled();
  });
});


describe('UX-002 canonical composer projections', () => {
  it('scopes Supply acceptance to its existing command, including only the Supply edit in a lending composition', () => {
    const id = setWorkflow('supply')!;
    const input = { network: 'Base Sepolia' as const, asset: 'USDC' as const, amount: '2', beneficiary: owner };
    expect(supplyProposalTarget(fixture.store.state.workflow, { type: 'SET_SUPPLY', nodeId: id, input, source: 'CANVAS', baseRevision: 1 })).toBe(id);
    expect(supplyProposalTarget(fixture.store.state.workflow, { type: 'SET_BORROW', nodeId: id, input, source: 'CANVAS', baseRevision: 1 })).toBeNull();
    fixture.store.state = editorReducer(initialEditor(), { type: 'AUTHOR_LENDING', source: 'CANVAS', baseRevision: 0, input: { supply: '0.1', borrow: '0.01', slippage: '50', owner } }, fixture.store.context);
    const before = JSON.stringify(fixture.store.state.workflow);
    const command = { type: 'AUTHOR_LENDING' as const, source: 'CANVAS' as const, baseRevision: 1, input: { supply: '0.2', borrow: '0.01', slippage: '50', owner } };
    expect(supplyProposalTarget(fixture.store.state.workflow, command)).toBe('lending-supply');
    expect(supplyProposalTarget(fixture.store.state.workflow, { ...command, input: { ...command.input, supply: '0.1', borrow: '0.02' } })).toBeNull();
    expect(supplyProposalTarget(fixture.store.state.workflow, { ...command, input: { ...command.input, slippage: '75' } })).toBeNull();
    expect(JSON.stringify(fixture.store.state.workflow)).toBe(before);
  });
  it.each(['swap', 'bridge', 'pool', 'supply', 'borrow', 'repay', 'withdraw'] as const)('summarizes the real %s toolbar node without modifying it', action => {
    setWorkflow();
    fixture.store.state = editorReducer(initialEditor(), action === 'pool' ? { type: 'ADD_UNISWAP_LIQUIDITY', source: 'CANVAS', baseRevision: 0, input: authoredPoolInput } : canvasAddCommand(action, 0, '0x1111111111111111111111111111111111111111', '1'), fixture.store.context);
    const workflow = fixture.store.state.workflow;
    const node = workflow.nodes.find(item => !item.actionType.startsWith('mock-'))!;
    const before = JSON.stringify(workflow);
    const summary = composerSummary(workflow, node, fixture.store.context);
    expect(summary.action).not.toBe('Action');
    expect(summary.provider).not.toBe('');
    expect(summary.chain).toContain('Base Sepolia');
    expect(summary.amount).toContain('USDC');
    expect(summary.amount).not.toMatch(/undefined|sample|mock/i);
    expect(JSON.stringify(workflow)).toBe(before);
  });

  it('projects actual Uniswap and Orca contributions into two liquidity boxes without Swap authoring', () => {
    for (const node of [
      createUniswapLiquidityNode('uniswap-position', authoredPoolInput),
      createSolanaLiquidityNode('orca-position', { network: 'Solana Devnet', maxSol: '0.01', maxDevUsdc: '0.3', rangeUnit: 'TICK', lower: '-443584', upper: '443584', slippage: '100' }),
    ]) {
      setWorkflow();
      fixture.store.state = { ...fixture.store.state, workflow: { ...fixture.store.state.workflow, nodes: [node] } };
      const before = JSON.stringify(fixture.store.state.workflow);
      const values = composerSummary(fixture.store.state.workflow, node, fixture.store.context).liquidityValues!;
      expect(values.map(value => value.token)).toEqual(node.chainId === 'eip155:84532' ? ['USDC', 'WETH'] : ['SOL', 'devUSDC']);
      const canvas = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: node.nodeId, select: vi.fn() }));
      expect(canvas.match(/class="numeric composer-amount-box/g)).toHaveLength(2);
      for (const value of values) {
        expect(canvas).toContain(`value="${value.amount}"`);
        expect(canvas).toContain(`<span class="composer-amount-token">${value.token}</span>`);
      }
      expect(canvas).not.toContain('composer-value-arrow');
      expect(canvas).toContain('data-relationship="contribution"');
      const inspection = renderToStaticMarkup(createElement(ComposerCard, { data: { inspection: true, composer: true, selected: false, vertical: false, step: 1, summary: composerSummary(fixture.store.state.workflow, node, fixture.store.context) } }));
      expect(inspection).not.toContain('composer-value-arrow');
      expect(inspection).toContain('data-relationship="contribution"');
      expect(inspection.match(/class="numeric composer-amount-box/g)).toHaveLength(2);
      expect(canvas).toContain('aria-label="Liquidity provider"');
      expect(canvas).toContain(`<button type="button" aria-pressed="true">${node.chainId === 'eip155:84532' ? 'Uniswap' : 'Solana'}</button>`);
      expect(canvas).not.toContain('<select');
      expect(canvas).not.toContain('aria-label="Custom range percentage"');
      expect(canvas).not.toContain('composer-price-range');
      expect(canvas).not.toContain('composer-pool-range-line');
      expect(canvas).not.toContain('composer-pool-thin-control');
      expect(canvas).not.toContain('>Range<');
      expect(canvas).toContain('composer-pool-control-row');
      expect(canvas).toContain('>Review</button>');
      expect(canvas).toContain('>Apply</button>');
      expect(canvas).not.toContain('Price range:');
      expect(canvas).not.toContain('class="composer-detail"');
      expect(canvas.match(/<input/g) ?? []).toHaveLength(2);
      expect(canvas).toContain(`aria-label="First liquidity amount (${values[0]!.token})"`);
      expect(canvas).toContain(`aria-label="Second liquidity amount (${values[1]!.token})"`);
      expect(canvas).toContain('aria-label="Liquidity range view"');
      expect(canvas).toContain('<button type="button" aria-pressed="true">Tick</button><button type="button" aria-pressed="false">Price</button>');
      expect(canvas).not.toContain('Price strategies');
      expect(canvas).not.toMatch(/<form|Review amount|Apply amount|unquoted placeholder/);
      expect(JSON.stringify(fixture.store.state.workflow)).toBe(before);
    }
  });

  it.each(['swap', 'bridge'] as const)('keeps the directional arrow for %s in Build and read-only inspection', action => {
    setWorkflow();
    fixture.store.state = editorReducer(initialEditor(), canvasAddCommand(action, 0, owner, '1'), fixture.store.context);
    const workflow = fixture.store.state.workflow;
    const node = workflow.nodes.find(item => !item.actionType.startsWith('mock-'))!;
    const before = JSON.stringify(workflow);
    const build = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: node.nodeId, select: vi.fn() }));
    const inspection = renderToStaticMarkup(createElement(ComposerCard, { data: { inspection: true, composer: true, selected: false, vertical: false, step: 1, summary: composerSummary(workflow, node, fixture.store.context) } }));
    // BUILD-SOLANA-MAINNET-001 (intentional change, requirement C): on an editable Swap card in Build the same arrow is the From/To switch.
    expect(build.match(/class="composer-value-arrow[^"]*"/g)).toHaveLength(1);
    expect(build.includes('aria-label="Switch From and To tokens"')).toBe(action === 'swap');
    expect(inspection.match(/class="composer-value-arrow"/g)).toHaveLength(1);
    expect(build).toContain('data-relationship="directional"');
    expect(JSON.stringify(workflow)).toBe(before);
    expect(fixture.store.dispatch).not.toHaveBeenCalled();
  });

  // BUILD-RH-002: Stocks is a canonical Robinhood Chain swap (USDG → Stock Token); it was an editing-only placeholder before.
  it('renders Stocks as a Robinhood Chain swap: USDG amount, Stock Token pill, and no command or wallet request on render', () => {
    setWorkflow();
    const before = JSON.stringify(fixture.store.state.workflow);
    const html = renderToStaticMarkup(createElement(ComposerCard, { data: {
      composer: true, step: 1, selected: true, vertical: false,
      summary: { action: 'Stocks', provider: 'Uniswap', chain: 'Robinhood Chain', amount: '0 USDG', detail: 'USDG → AAPL', bridgePair: undefined, linked: false, risk: undefined },
      validation: { findings: [], status: 'Draft', tone: 'neutral', message: undefined, next: undefined },
      stocks: { equity: 'AAPL', onEquityChange: vi.fn() },
      amountEditor: { value: '0', changed: false, canApply: false, onChange: vi.fn(), onReview: () => null, onApply: vi.fn() },
    } }));
    expect(titled(html)).toContain('1. Stocks'); expect(html).toContain('Uniswap'); expect(html).toContain('Robinhood Chain');
    expect(html).toContain('data-relationship="directional"');
    expect(html.match(/class="numeric composer-amount-box/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Stocks amount (USDG)"'); expect(html).toContain('value="0"');
    expect(html).toContain('aria-label="Select stock"'); expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('src="/brand/robinhood-avatar.jpg"');
    expect(html).toContain('aria-label="Robinhood Chain network"');
    expect(html).not.toContain('<select');
    expect(html).toContain('aria-label="Action settings"'); expect(html).not.toContain('Advanced Settings');
    // The destination box keeps the shared Swap-card label ("Destination amount (unquoted placeholder)") until a quote exists.
    expect(html).toContain('aria-label="Destination amount (unquoted placeholder)"');
    expect(html.match(/unsupported|non-executable|coming soon|debug|lab\b|Transfer/i)?.[0] ?? null).toBeNull();
    expect(JSON.stringify(fixture.store.state.workflow)).toBe(before);
    expect(fixture.store.dispatch).not.toHaveBeenCalled(); expect(fixture.store.propose).not.toHaveBeenCalled();
  });

  it('keeps dependency arrows, order, active editor and linked summaries on the same lending IR', () => {
    setWorkflow();
    fixture.store.state = editorReducer(initialEditor(), canvasAddCommand('lending', 0, '0x1111111111111111111111111111111111111111'), fixture.store.context);
    const workflow = fixture.store.state.workflow;
    expect(composerConnections(workflow).map(edge => [edge.source, edge.target])).toEqual([
      ['lending-supply', 'lending-borrow'], ['lending-borrow', 'lending-swap'],
    ]);
    const canvas = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: 'lending-borrow', select: vi.fn() }));
    expect(canvas.match(/composer-card active/g)).toHaveLength(1);
    expect(titled(canvas)).toContain('1. Supply'); expect(titled(canvas)).toContain('2. Borrow'); expect(titled(canvas)).toContain('3. Swap');
    // BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: the only forms are the Aave cards' own amount forms (Enter applies an ordinary amount edit).
    expect(canvas).not.toMatch(/Completed|Runtime:|Confirmed|<form(?! class="composer-amount-form composer-lending-amount-form)/);
    const inspector = renderToStaticMarkup(createElement(ActionSettingsContent, { selectedId: 'lending-borrow', select: vi.fn() }));
    expect(inspector).not.toContain('Advanced Settings');
    expect(inspector).not.toContain('Selected Action · 2. Borrow');
    expect(inspector).toContain('aria-label="Edit Aave Borrow"');
    fixture.store.state = editorReducer(fixture.store.state, { type: 'AUTHOR_LENDING', source: 'CANVAS', baseRevision: workflow.revision,
      input: { supply: '0.1', borrow: '0.025', slippage: '50', owner: '0x1111111111111111111111111111111111111111' } }, fixture.store.context);
    for (const id of ['lending-borrow', 'lending-swap']) {
      const node = fixture.store.state.workflow.nodes.find(item => item.nodeId === id)!;
      expect(composerSummary(fixture.store.state.workflow, node, fixture.store.context).amount).toBe('0.025 USDC');
    }
    expect(composerConnections(fixture.store.state.workflow)).toEqual(composerConnections(workflow));
  });

  it('shows existing slippage findings while keeping quote gates distinct from authoring errors', () => {
    setWorkflow();
    fixture.store.state = editorReducer(initialEditor(), { type: 'ADD_SWAP', source: 'CANVAS', baseRevision: 0, direction: 'USDC_TO_WETH', amount: '1', slippage: '200' }, fixture.store.context);
    const node = fixture.store.state.workflow.nodes.find(item => item.actionType === 'asset.swap.exact-input')!;
    fixture.store.review = lintWorkflow(fixture.store.state.workflow, fixture.store.context);
    const state = composerNodeState(fixture.store.review, node.nodeId);
    expect(state.status).toBe('Warning'); expect(state.tone).toBe('warning');
    expect(state.findings.map(finding => finding.code)).toContain('ELEVATED_SLIPPAGE');
    expect(state.next).toBe('Simulation / review required');
    const canvas = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: node.nodeId, select: vi.fn() }));
    expect(canvas).not.toContain('data-state="warning"'); expect(canvas).not.toContain('Check settings');
    expect(canvas).not.toMatch(/composer-card-state|composer-warning|composer-value-edit/);
    // BUILD-FLOFI-BUILDER-UX-002 (owner-approved brief): the card's one discreet status now names the review's warning (no "⚠"/"Check settings" tags).
    expect(state.message).toBe('Review the prototype slippage limit.');
    expect(canvas).toContain('class="composer-status" data-card-status="attention" title="Check this step’s slippage limit."');
    const inspector = renderToStaticMarkup(createElement(ActionSettingsContent, { selectedId: node.nodeId, select: vi.fn() }));
    // Board 16: the card's settings show the same check in plain words; the review engine's own text stays out of the product surface.
    expect(inspector).toContain('Selected action checks'); expect(inspector).toContain('Check this step’s slippage limit.'); expect(inspector).not.toContain(state.message);
    const missingSlippage = { ...fixture.store.state.workflow, nodes: fixture.store.state.workflow.nodes.map(item => item.nodeId === node.nodeId ? { ...item, userConstraints: item.userConstraints.filter(constraint => constraint.kind !== 'MAXIMUM_SLIPPAGE_BPS') } : item) };
    expect(composerNodeState(lintWorkflow(missingSlippage, fixture.store.context), node.nodeId).tone).toBe('invalid');
  });

  it('creates no sequence edges for independent actions and leaves cleared selection empty', () => {
    setWorkflow('supply');
    expect(composerConnections(fixture.store.state.workflow)).toEqual([]);
    const canvas = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: null, select: vi.fn() }));
    expect(canvas).not.toContain('composer-card active');
    // No selected action: there is no settings content at all (no empty bottom panel remains).
    expect(renderToStaticMarkup(createElement(ActionSettingsContent, { selectedId: null, select: vi.fn() }))).toBe('');
  });
});


it('projects cross-chain output references and Solana assets without guessed amounts', () => {
  setWorkflow();
  const cross = createCrossChainLiquidityWorkflow('strategy', 1, { amount: '100', bridgeSlippageBps: '50', swapSlippageBps: '50', tickLower: '-200100', tickUpper: '-199900', recipient: '0x1111111111111111111111111111111111111111', provider: 'across.direct', noSwap: false });
  const before = JSON.stringify(cross);
  expect(composerConnections(cross)).toHaveLength(4);
  expect(composerSummary(cross, cross.nodes[0]!, fixture.store.context)).toMatchObject({ action: 'Bridge', provider: 'Across', amount: '100 USDC' });
  for (const node of cross.nodes.slice(1)) expect(composerSummary(cross, node, fixture.store.context).amount).toBe('Amount from linked step');
  expect(JSON.stringify(cross)).toBe(before);
  const swap = createSolanaSwapNode('swap', { network: 'Solana', from: 'USDC', to: 'SOL', amount: '10', slippage: '50' });
  expect(composerSummary({ ...cross, nodes: [swap], resourceEdges: [] }, swap, fixture.store.context)).toMatchObject({ action: 'Swap', amount: '10 USDC', detail: 'USDC → SOL' });
  const pool = createSolanaLiquidityNode('pool', { network: 'Solana Devnet', maxSol: '0.01', maxDevUsdc: '0.30', rangeUnit: 'PRICE', lower: '20.121902', upper: '24.593436', slippage: '100' });
  expect(composerSummary({ ...cross, nodes: [pool], resourceEdges: [] }, pool, fixture.store.context)).toMatchObject({ action: 'Pool / Liquidity', amount: '0.01 SOL + 0.3 devUSDC' });
});

describe('P0 approved UX: the Editor Create screen (boards 04 and 05)', () => {
  const overview = (state: EditorOverview['state'], networks: readonly string[] = ['Base Sepolia']): EditorOverview =>
    ({ count: 1, steps: [], networks, state, attention: [], drafts: 0, invalid: false });
  const labels = (html: string) => [...html.slice(html.indexOf('class="canvas-primary-tools"'), html.indexOf('class="canvas-rail-toggle"'))
    .matchAll(/aria-label="(Add [^"]+|Stocks)"|canvas-rail-separator/g)].map(match => match[1] ?? '|');

  it('header: the name, its network chip, the step count and the state once; Undo, Redo and ··· (Save, Automate)', () => {
    setWorkflow('supply');
    const before = JSON.stringify(fixture.store.state.workflow);
    const html = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: null, select: vi.fn(), workflowName: 'My flow', onSave: vi.fn(), onAutomate: vi.fn(), overview: overview('configured') }));
    expect(html).toContain('aria-label="Rename workflow: My flow"');
    expect(html).toMatch(/<ul class="editor-network-chips" aria-label="Workflow networks"><li>[\s\S]*?Base Sepolia<\/li><\/ul>/);
    expect(html).not.toMatch(/\(84532\)/);
    expect(html).toContain('<span class="revision">1 step</span>');
    expect(html.match(/class="editor-state-pill"/g)).toHaveLength(1);
    expect(html.match(/>Configured</g)).toHaveLength(1);
    const order = ['aria-label="Undo"', 'aria-label="Redo"', 'aria-label="More options"'].map(label => html.indexOf(label));
    expect(order.every(index => index > 0)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('<span>Save workflow</span>'); expect(html).toContain('<span>Automate this workflow</span>');
    // One footer line: the count and the review's warnings, no usage hints.
    expect(html).toContain('<div class="canvas-foot"><span>1 step · No warnings</span></div>');
    expect(html).not.toMatch(/Step numbers show|Arrows show linked steps|Dragging changes layout/);
    expect(JSON.stringify(fixture.store.state.workflow)).toBe(before);
    expect(fixture.store.dispatch).not.toHaveBeenCalled();
  });

  it('header: a workflow without any network yet says "Network?" (board 05); its footer names the step that needs attention', () => {
    setWorkflow('supply');
    const html = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: null, select: vi.fn(),
      overview: { ...overview('attention', []), attention: [{ nodeId: 'n', step: 1, action: 'Swap', flow: null, status: { kind: 'attention', label: 'Needs attention', detail: 'x' } }] } }));
    expect(html).toContain('class="editor-network-chips editor-network-pending"');
    expect(html).toContain('Network?');
    expect(html).toContain('<span>1 step · 1 step needs attention</span>');
  });

  it('rail: icon-only by default, in the approved groups, without Privacy, with the expand chevron (aria-expanded)', () => {
    setActiveNetworkScope('PUBLIC_MAINNET');
    try {
      setWorkflow();
      const html = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: null, select: vi.fn() }));
      expect(labels(html)).toEqual(['Add swap', 'Add bridge', 'Add send', '|', 'Add pool', 'Add supply', 'Add withdraw', '|', 'Add borrow', 'Add repay', '|', 'Stocks']);
      expect(html).toMatch(/<div class="floating-toolbox" id="([^"]+)" data-rail-expanded="false">[\s\S]*<button type="button" class="canvas-rail-toggle" aria-label="Show action names" aria-expanded="false" aria-controls="\1">/);
      // The name is the tooltip and the expanded label; the accessible name stays "Add {action}".
      expect(html).toContain('aria-label="Add swap"'); expect(html).toContain('<span class="canvas-rail-label">Swap</span>');
      expect(html).not.toMatch(/Privacy|title="Add swap"/);
    } finally { setActiveNetworkScope(null); }
    // Lending stays engineering-only, in the Borrow/Repay group.
    setActiveNetworkScope('ENGINEERING');
    try {
      setWorkflow();
      expect(labels(renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: null, select: vi.fn() })))).toEqual(['Add swap', 'Add bridge', 'Add send', '|', 'Add pool',
        'Add supply', 'Add withdraw', '|', 'Add borrow', 'Add repay', 'Add Supply → Borrow → Swap', '|', 'Stocks']);
    } finally { setActiveNetworkScope(null); }
  });

  it('rail: the groups list exactly the actions that exist today, each once (none added, none dropped)', () => {
    expect([...RAIL_GROUPS.flat()].sort()).toEqual([...CANVAS_STEP_ACTIONS].sort());
    expect(new Set(RAIL_GROUPS.flat()).size).toBe(CANVAS_STEP_ACTIONS.length);
  });

  it('rail: expanded shows the names (aria-expanded true); the choice is remembered per viewer and storage failures fall back to collapsed', () => {
    const collapsed = renderToStaticMarkup(createElement(ActionRail, { id: 'rail', expanded: false, onToggle: vi.fn() }, 'tools'));
    const expanded = renderToStaticMarkup(createElement(ActionRail, { id: 'rail', expanded: true, onToggle: vi.fn() }, 'tools'));
    expect(collapsed).toContain('data-rail-expanded="false"'); expect(collapsed).toContain('aria-expanded="false" aria-controls="rail"');
    expect(expanded).toContain('data-rail-expanded="true"'); expect(expanded).toContain('aria-expanded="true" aria-controls="rail"');
    expect(readRailExpanded({ getItem: key => key === RAIL_EXPANDED_KEY ? 'true' : null })).toBe(true);
    expect(readRailExpanded({ getItem: () => 'false' })).toBe(false);
    expect(readRailExpanded({ getItem: () => null })).toBe(false);
    expect(readRailExpanded({ getItem: () => { throw new Error('SecurityError'); } })).toBe(false);
    expect(readRailExpanded(null)).toBe(false);
    expect(readRailExpanded()).toBe(false);
    const stored = new Map<string, string>();
    saveRailExpanded(true, { setItem: (key, value) => { stored.set(key, value); } });
    expect(stored.get(RAIL_EXPANDED_KEY)).toBe('true');
    expect(() => saveRailExpanded(true, { setItem: () => { throw new Error('QuotaExceededError'); } })).not.toThrow();
    expect(() => saveRailExpanded(false)).not.toThrow();
  });

  it('Duplicate and Delete appear right above the selected card only; Undo and Redo stay in the header', () => {
    const id = setWorkflow('supply')!;
    const before = JSON.stringify(fixture.store.state.workflow);
    const none = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: null, select: vi.fn() }));
    expect(none).not.toContain('data-node-toolbar'); expect(none).not.toContain('aria-label="Duplicate selection"');
    const selected = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: id, select: vi.fn() }));
    const toolbar = selected.slice(selected.indexOf('data-node-toolbar'));
    expect(selected).toContain(`class="canvas-selection-toolbar nodrag nopan nowheel" data-node-toolbar="${id}"`);
    expect(toolbar).toMatch(/^data-node-toolbar="[^"]+"><div class="canvas-utility-tools" role="toolbar" aria-label="Selected step actions"><button type="button" title="Duplicate selection" aria-label="Duplicate selection"[^>]*>[\s\S]*?<\/button><button type="button" class="canvas-selection-delete" aria-label="Delete" title="Delete">/);
    expect(toolbar.slice(0, toolbar.indexOf('</div></div>'))).not.toMatch(/Undo|Redo/);
    expect(selected.indexOf('aria-label="Undo"')).toBeGreaterThan(0);
    expect(selected.indexOf('aria-label="Undo"')).toBeLessThan(selected.indexOf('flow-surface build-flow-surface'));
    // Rendering changes nothing; deleting keeps its existing handler (not invoked here).
    expect(JSON.stringify(fixture.store.state.workflow)).toBe(before);
    expect(fixture.store.dispatch).not.toHaveBeenCalled();
  });

  it('while a run is active, the header shows the lock and "Editing paused during execution" instead of Undo, Redo and ···', () => {
    const id = setWorkflow('supply')!;
    const html = renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: id, select: vi.fn(), onSave: vi.fn(), runActive: true }));
    expect(html).toMatch(/<span class="canvas-edit-paused" role="status"><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg>Editing paused during execution<\/span>/);
    expect(html).not.toMatch(/aria-label="(Undo|Redo|More options)"/);
    expect(html).not.toContain('data-node-toolbar');
    expect(html).toContain('aria-label="Add swap" disabled=""');
    expect(html).toContain('data-run-active="true"');
    // No run: the edit controls are back.
    expect(renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: id, select: vi.fn() }))).not.toContain('Editing paused during execution');
  });

  const swapCard = (overrides: Partial<ComposerCardData> = {}): ComposerCardData => ({
    composer: true, step: 1, selected: false, vertical: false,
    summary: { action: 'Swap', provider: 'Uniswap', chain: 'Base (8453)', amount: '1 USDC', detail: 'USDC → WETH', bridgePair: undefined, linked: false, risk: undefined },
    validation: { findings: [], status: 'Configured', tone: 'neutral', message: undefined, next: undefined },
    cardStatus: { kind: 'configured', label: 'Configured', detail: 'Configured. Simulation, Review and your signature come next.' },
    estimateWorkflow: fixture.store.state.workflow, estimateNodeId: 'swap',
    params: [{ key: 'slippage', value: '1% (100 bps)' }], onOpenSettings: vi.fn(),
    ...overrides,
  } as ComposerCardData);

  it('card: "Uniswap · Base" without a chain id, You send / You receive, approximately, "Max price difference: 1%" with Adjust, no flow line, no "Configured"', () => {
    setWorkflow();
    const data = swapCard();
    const html = renderToStaticMarkup(createElement(ComposerCard, { data }));
    expect(html).toMatch(/<span class="composer-provider">Uniswap<\/span> · <span class="composer-chain">Base<\/span>/);
    expect(html).not.toMatch(/8453|bps|Max slippage|composer-operation|composer-status/);
    expect(html).toContain('<span class="composer-value-caption">You send</span>');
    expect(html).toContain('<span class="composer-value-caption">You receive, approximately</span>');
    expect(html).toMatch(/<span>Max price difference: 1%<\/span><button type="button" class="composer-adjust nodrag nopan" aria-haspopup="dialog" aria-expanded="false" aria-label="Adjust max price difference">Adjust<\/button>/);
    // The card's real configured limit is unchanged (Adjust opens the existing settings; nothing is edited on render).
    expect(data.params).toEqual([{ key: 'slippage', value: '1% (100 bps)' }]);
    expect(data.onOpenSettings).not.toHaveBeenCalled();
    // A step that needs attention or a draft still says so.
    expect(renderToStaticMarkup(createElement(ComposerCard, { data: swapCard({ cardStatus: { kind: 'attention', label: 'Needs attention', detail: 'Check this step’s slippage limit.' } }) })))
      .toContain('class="composer-status" data-card-status="attention"');
  });

  it('card: the quoted output shows six significant digits with the full value in its title; the estimate itself is unchanged', () => {
    setWorkflow();
    const estimate = { provider: 'Uniswap V3', expected: '0.000486123456789', minimum: '0.000481', symbol: 'WETH' };
    fixture.quote = { status: 'ready', estimate };
    try {
      const html = renderToStaticMarkup(createElement(ComposerCard, { data: swapCard() }));
      expect(html).toMatch(/title="0\.000486123456789" data-clipped="true" data-rounded="true" role="button"[^>]*>0\.000486123<\/span>/);
      expect(estimate.expected).toBe('0.000486123456789');
    } finally { fixture.quote = null; }
    expect(significantAmount('0.000486123456789')).toBe('0.000486123');
    expect(significantAmount('0.0004861235')).toBe('0.000486124');
    expect(significantAmount('1234.56789')).toBe('1234.57');
    expect(significantAmount('1234567.89')).toBe('1234568');
    expect(significantAmount('0.99999999')).toBe('1');
    expect(significantAmount('999999.5')).toBe('1000000');
    expect(significantAmount('12.5')).toBe('12.5');
    expect(significantAmount('0.000000')).toBe('0.000000');
    for (const value of ['—', '1e-7', '-1.5', '1,234.5', '']) expect(significantAmount(value)).toBe(value);
  });

  it('card (board 05): only a step that genuinely lacks a network shows as a network draft', () => {
    setWorkflow();
    const pending = renderToStaticMarkup(createElement(ComposerCard, { data: swapCard({ summary: { ...swapCard().summary, chain: '' },
      cardStatus: { kind: 'draft', label: 'Draft', detail: 'Not applied to the workflow yet.' } }) }));
    expect(pending).toContain('data-network-pending="true"');
    expect(pending).toContain('<span class="composer-network-pending-chip">Network?</span>');
    expect(pending).toContain('<span class="composer-value-caption">You receive</span>');
    expect(pending).toContain('<span class="composer-amount-placeholder">calculated after the network</span>');
    expect(pending).toMatch(/class="composer-quote-note composer-network-pending-note" role="status">[\s\S]*?Choose the network in the chat<\/span>/);
    expect(pending).not.toContain('composer-amount-skeleton');
    expect(renderToStaticMarkup(createElement(ComposerCard, { data: swapCard({ networkPending: true }) }))).toContain('data-network-pending="true"');
    const ready = renderToStaticMarkup(createElement(ComposerCard, { data: swapCard() }));
    expect(ready).not.toMatch(/data-network-pending|Network\?|calculated after the network|Choose the network in the chat/);
  });
});
