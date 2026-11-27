// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02 review fixes): the Batch Payment card on the Build Canvas, rendered from the workflow store's own
 * drafts (FE-BATCH-01): a saved step being edited is a draft whose header names the draft's network (FE-BATCH-06) and whose Asset select keeps the
 * draft's asset (FE-BATCH-07); a brand-new card announces no problem before the person edits it (FE-BATCH-10). Rendering changes nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BATCH_PAYMENT_ACTION } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, initialEditor } from '../domain/editor';
import type { Command } from '../domain/commands';
import { dappReviewContext } from '../engine/strategy-engine';
import { defaultBatchPaymentDraft, type BatchPaymentInput } from '../domain/batch-payment-authoring';
import { WorkflowCanvas } from './workflow-canvas';

const fixture = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof import('../state/workflow-store').useWorkflow> }));
vi.mock('../state/workflow-store', () => ({ useWorkflow: () => fixture.store }));
vi.mock('../state/build009-wallet-store', () => ({ useBuild009Wallet: () => ({ account: '0x1111111111111111111111111111111111111111' }) }));
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    ReactFlow: ({ nodes, nodeTypes }: { nodes: { id: string; data: unknown }[]; nodeTypes: { workflow: React.ComponentType } }) =>
      React.createElement('div', null, nodes.map(node => React.createElement('div', { key: node.id, 'data-card-id': node.id }, React.createElement(nodeTypes.workflow, { data: node.data } as React.Attributes)))),
    NodeToolbar: () => null, MarkerType: { ArrowClosed: 'arrowclosed' }, Background: () => null, Controls: () => null, Handle: () => null,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useNodesState: (nodes: unknown) => [nodes, vi.fn(), vi.fn()], useNodesInitialized: () => false,
    useReactFlow: () => ({ fitView: vi.fn() }), useStore: () => '', useStoreApi: () => ({}), useUpdateNodeInternals: () => vi.fn(),
  };
});

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20);
const INPUT = { network: 'Base', asset: 'USDC', payments: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }] };
function setStore(extra: { readonly saved?: boolean; readonly drafts?: Readonly<Record<string, BatchPaymentInput>>; readonly setup?: { id: string; edited: boolean } | null } = {}) {
  const context = dappReviewContext();
  const state = extra.saved ? editorReducer(initialEditor(), { type: 'ADD_BATCH_PAYMENT', input: INPUT, source: 'CANVAS', baseRevision: 0 } as Command, context) : initialEditor();
  expect(state.error).toBeFalsy();
  fixture.store = { state, context, canvasLayout: {}, canUndo: false, canRedo: false,
    dispatch: vi.fn(), propose: vi.fn(), undo: vi.fn(), redo: vi.fn(), moveCanvasNodes: vi.fn(), addCanvasCommand: vi.fn(), duplicateCanvasNodes: vi.fn(),
    batchSetup: extra.setup ? { id: extra.setup.id, position: { x: 0, y: 0 }, workflowId: state.workflow.workflowId, edited: extra.setup.edited } : null,
    batchDrafts: extra.drafts ?? {}, startBatchSetup: vi.fn(), editBatchDraft: vi.fn(), discardBatchDraft: vi.fn(), applyBatchDraft: vi.fn(() => null),
  } as unknown as typeof fixture.store;
  return state.workflow.nodes.find(node => node.actionType === BATCH_PAYMENT_ACTION)?.nodeId ?? null;
}
const render = () => renderToStaticMarkup(createElement(WorkflowCanvas, { selectedId: null, select: vi.fn() }));
const card = (html: string, id: string) => html.slice(html.indexOf(`data-card-id="${id}"`), html.indexOf('</form>', html.indexOf(`data-card-id="${id}"`)));

describe('the Batch Payment card from the workflow store\'s drafts', () => {
  it('a saved step without a draft shows the saved step: its network in the header, no draft status, no Apply', () => {
    const id = setStore({ saved: true })!;
    const shown = card(render(), id);
    expect(shown).toContain('<span class="composer-chain">Base</span>');
    expect(shown).not.toContain('data-card-status="draft"');
    expect(shown).not.toContain('Apply changes');
    expect(shown).toContain('2 recipients · Total: 75 USDC');
  });

  it('FE-BATCH-06/07: a saved step with a draft on another network names the draft\'s network, is a draft, and keeps the draft\'s asset selected', () => {
    const id = setStore({ saved: true })!;
    setStore({ saved: true, drafts: { [id]: { network: 'Ethereum', asset: '', payments: INPUT.payments } as BatchPaymentInput } });
    const shown = card(render(), id);
    expect(shown).toContain('<span class="composer-chain">Ethereum</span>');
    expect(shown).not.toContain('<span class="composer-chain">Base</span>');
    expect(shown).toContain('data-card-status="draft"');
    expect(shown).toContain('<option value="Ethereum" selected="">Ethereum</option>');
    // No asset on the new network: the select says so and nothing is shown as ETH.
    expect(shown).toContain('Choose an asset</option>');
    expect(shown).not.toContain('<option value="ETH" selected="">');
    expect(shown).toContain('Choose an asset available for Batch Payment on this network.');
    expect(shown).toContain('Apply changes');
    // A token draft outside the shortcuts keeps that token as the selected asset.
    setStore({ saved: true, drafts: { [id]: { ...INPUT, asset: 'SOME-TOKEN' } as BatchPaymentInput } });
    expect(card(render(), id)).toContain('<option value="SOME-TOKEN" selected="">SOME-TOKEN</option>');
  });

  it('FE-BATCH-10: a brand-new card states no problem until it is edited; once edited, it does', () => {
    setStore({ setup: { id: 'batch-payment-setup-1', edited: false }, drafts: { 'batch-payment-setup-1': defaultBatchPaymentDraft() } });
    const fresh = card(render(), 'batch-payment-setup-1');
    expect(fresh).toContain('Batch Payment');
    expect(fresh).toContain('2 recipients · Total: enter every amount');
    expect(fresh).not.toContain('role="alert"');
    expect(fresh).not.toContain('aria-invalid');
    setStore({ setup: { id: 'batch-payment-setup-1', edited: true }, drafts: { 'batch-payment-setup-1': defaultBatchPaymentDraft() } });
    const edited = card(render(), 'batch-payment-setup-1');
    expect(edited).toContain('role="alert"');
    expect(edited).toContain('aria-invalid="true"');
  });
});
