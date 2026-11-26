// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02): the Batch Payment card on the Editor's Canvas. One card is one operation: the Canvas reads it
 * back to the SAME canonical strategy and hash every other channel composes (its run is the card's payments, one atomic group), a Chat / MCP batch
 * opens as ONE card (never one Send card per payment), and the card shows its recipients, count and exact total from the step itself.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BATCH_PAYMENT_ACTION } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, initialEditor } from '../domain/editor';
import type { Command } from '../domain/commands';
import { composerSummary } from '../domain/composer-presentation';
import { checkBatchPaymentDraft } from '../domain/batch-payment-authoring';
import { composeWorkflow, dappReviewContext } from '../engine/strategy-engine';
import { BatchPaymentFields, type BatchPaymentCardData } from '../components/batch-payment-fields';
import { canvasWorkflowOfStrategy, editorWorkflowStrategy } from './workflow-strategy';

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const BATCH = { action: 'batch_payment', network: 'base', asset: 'USDC', recipients: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }, { recipient: C, amount: '75' }] };
const INPUT = { network: 'Base', asset: 'USDC', payments: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }, { recipient: C, amount: '75' }] };

function authored(input: unknown = INPUT) {
  const state = editorReducer(initialEditor(), { type: 'ADD_BATCH_PAYMENT', input, source: 'CANVAS', baseRevision: 0 } as Command, dappReviewContext());
  expect(state.error).toBeFalsy();
  return state.workflow;
}

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 Batch Payment card (Canvas)', () => {
  it('a lone Batch Payment card is the canonical one-operation strategy: same hash as every channel, its run is its three payments', () => {
    const workflow = authored();
    const nodes = workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
    expect(nodes.map(node => node.actionType)).toEqual([BATCH_PAYMENT_ACTION]);
    const converted = editorWorkflowStrategy(workflow);
    const engine = composeWorkflow(BATCH);
    expect(converted.ok && engine.ok).toBe(true);
    if (!converted.ok || !engine.ok) return;
    expect(converted.workflowHash).toBe(engine.workflowHash);
    expect(converted.stepCount).toBe(3);
    expect(converted.strategy).toMatchObject({ version: 2, steps: [{ action: 'batch_payment', network: 'base', asset: 'USDC', recipients: BATCH.recipients }] });
  });

  it('a Chat / MCP Batch Payment opens as ONE card and reads back to the same hash; a changed payment is a different workflow', () => {
    const opened = canvasWorkflowOfStrategy(BATCH);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.workflow.nodes.filter(node => !node.actionType.startsWith('mock-')).map(node => node.actionType)).toEqual([BATCH_PAYMENT_ACTION]);
    expect(opened.workflowHash).toBe((composeWorkflow(BATCH) as { workflowHash: string }).workflowHash);
    const changed = editorWorkflowStrategy(authored({ ...INPUT, payments: [INPUT.payments[0], INPUT.payments[1], { recipient: C, amount: '75.000001' }] }));
    expect(changed.ok && changed.workflowHash).not.toBe(opened.workflowHash);
  });

  it('the card states the operation, its exact total and its recipient count from the step itself', () => {
    const workflow = authored();
    const node = workflow.nodes.find(n => n.actionType === BATCH_PAYMENT_ACTION)!;
    expect(composerSummary(workflow, node, dappReviewContext())).toMatchObject({ action: 'Batch Payment', amount: '150 USDC', detail: '3 recipients', chain: expect.stringContaining('Base') });
  });

  it('the card fields: one row per recipient, the count and the exact total; Apply only for a valid draft; a duplicate is named, never merged', () => {
    const data = (payments: BatchPaymentCardData['rows']): BatchPaymentCardData => ({ network: 'Base', asset: 'USDC', networks: ['Robinhood Chain', 'Base', 'Arbitrum One', 'Ethereum'],
      assets: ['ETH', 'USDC', 'WETH'], rows: payments, minRecipients: 2, maxRecipients: 8, check: checkBatchPaymentDraft({ ...INPUT, payments }), changed: true,
      applyLabel: 'Apply batch payment', onNetwork: vi.fn(), onAsset: vi.fn(), onRow: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn(), onSameAmount: vi.fn(), onApply: vi.fn(() => null), onCancel: vi.fn() });
    const html = renderToStaticMarkup(createElement(BatchPaymentFields, { batch: data(INPUT.payments) }));
    expect(html.match(/data-batch-row=/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Recipient 3 amount (USDC)"');
    expect(html).toContain('3 recipients');
    expect(html).toContain('Total: 150 USDC');
    expect(html).toContain('All payments run together in one wallet approval, or none of them run.');
    expect(html).toMatch(/<button type="submit" class="composer-amount-apply">Apply batch payment<\/button>/);
    const duplicate = renderToStaticMarkup(createElement(BatchPaymentFields, { batch: data([{ recipient: A, amount: '1' }, { recipient: A, amount: '2' }]) }));
    expect(duplicate).toContain('An address appears more than once. Remove the repeated recipient: payments are never merged.');
    expect(duplicate).toMatch(/<button type="submit" class="composer-amount-apply" disabled="">/);
    expect(duplicate).toContain('Total: enter every amount');
  });
});
