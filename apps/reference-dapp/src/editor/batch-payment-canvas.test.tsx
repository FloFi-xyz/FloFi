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
import { BATCH_PAYMENT_NETWORKS, UNRESOLVED_BATCH_ASSET, batchDraftWithSavedAsset, batchPaymentAssetChoices, batchPaymentChain, batchPaymentDraftTotal, batchPaymentNetworkChange,
  checkBatchPaymentDraft, defaultBatchPaymentDraft, savedBatchPayment, type BatchPaymentInput } from '../domain/batch-payment-authoring';
import { composeWorkflow, dappReviewContext } from '../engine/strategy-engine';
import { BatchPaymentFields, type BatchPaymentCardData } from '../components/batch-payment-fields';
import { canvasWorkflowOfStrategy, editorWorkflowStrategy, singleCardRunRecord } from './workflow-strategy';
import { canvasRunOrder, loneCardRunVerdict } from '../domain/batch-run-record';

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
      assets: ['ETH', 'USDC', 'WETH'], rows: payments, minRecipients: 2, maxRecipients: 8, check: checkBatchPaymentDraft({ ...INPUT, payments }), changed: true, saved: false,
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
    // FE-BATCH-11: this assertion used to expect 'Total: enter every amount' although both amounts were valid (the old total waited for every
    // address too). The total is now shown whenever every amount is valid, whatever the recipients say.
    expect(duplicate).toContain('Total: 3 USDC');
    expect(duplicate).not.toContain('Total: enter every amount');
  });
});

const CHECKSUM = '0x52908400098527886E0F7030069857D2E4169EE7', MISTYPED = '0x52908400098527886E0F7030069857D2E4169Ee7';
const fields = (patch: Partial<BatchPaymentCardData>): BatchPaymentCardData => ({ network: 'Base', asset: 'USDC', networks: [...BATCH_PAYMENT_NETWORKS], assets: ['ETH', 'USDC', 'WETH'],
  rows: INPUT.payments, minRecipients: 2, maxRecipients: 8, check: checkBatchPaymentDraft(INPUT as BatchPaymentInput), changed: true, saved: false, applyLabel: 'Apply batch payment',
  onNetwork: vi.fn(), onAsset: vi.fn(), onRow: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn(), onSameAmount: vi.fn(), onApply: vi.fn(() => null), onCancel: vi.fn(), ...patch });
const html = (data: BatchPaymentCardData) => renderToStaticMarkup(createElement(BatchPaymentFields, { batch: data }));

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 Batch Payment card: review fixes (authoring)', () => {
  it('FE-BATCH-09: the card validates exactly the trimmed values Apply submits', () => {
    const padded = { ...INPUT, payments: [{ recipient: ` ${A} `, amount: ' 25 ' }, { recipient: B, amount: '50\t' }] } as BatchPaymentInput;
    expect(checkBatchPaymentDraft(padded)).toMatchObject({ valid: true, total: '75', problem: null });
  });

  it('FE-BATCH-11: the exact total is computed from the amounts alone (a wrong address never hides it); an invalid amount does', () => {
    const wrong = { ...INPUT, payments: [{ recipient: MISTYPED, amount: '0.5' }, { recipient: '', amount: '1.25' }] } as BatchPaymentInput;
    expect(checkBatchPaymentDraft(wrong)).toMatchObject({ valid: false, code: 'BATCH_PAYMENT_RECIPIENT_INVALID', total: '1.75' });
    expect(batchPaymentDraftTotal(wrong)).toBe('1.75');
    expect(batchPaymentDraftTotal({ ...wrong, payments: [{ recipient: A, amount: '0.5' }, { recipient: B, amount: 'abc' }] })).toBeNull();
    expect(batchPaymentDraftTotal({ ...wrong, payments: [{ recipient: A, amount: '0.5' }, { recipient: B, amount: '0' }] })).toBeNull();
    // Exact integer sums of base units (never a float): 0.1 + 0.2 ETH is exactly 0.3.
    expect(batchPaymentDraftTotal({ network: 'Base', asset: 'ETH', payments: [{ recipient: A, amount: '0.1' }, { recipient: B, amount: '0.2' }] })).toBe('0.3');
    // More decimals than USDC has is not a valid USDC amount.
    expect(batchPaymentDraftTotal({ ...wrong, payments: [{ recipient: A, amount: '0.1234567' }, { recipient: B, amount: '1' }] })).toBeNull();
  });

  it('FE-BATCH-07: the asset choices always hold the draft\'s asset; a network change keeps an offered asset and otherwise clears it (never ETH)', () => {
    expect(batchPaymentAssetChoices('Base', 'USDC')).toEqual(expect.arrayContaining(['ETH', 'USDC']));
    expect(batchPaymentAssetChoices('Base', UNRESOLVED_BATCH_ASSET).at(-1)).toBe(UNRESOLVED_BATCH_ASSET);
    expect(batchPaymentAssetChoices('Base', 'cbBTC-not-a-shortcut')).toContain('cbBTC-not-a-shortcut');
    expect(batchPaymentAssetChoices('Base', '')).not.toContain('');
    const draft = { ...INPUT, payments: [{ recipient: A, amount: '0.5' }, { recipient: B, amount: '0.5' }] } as BatchPaymentInput;
    expect(batchPaymentNetworkChange(draft, 'Arbitrum One')).toMatchObject({ network: 'Arbitrum One', asset: 'USDC', payments: draft.payments });
    const cleared = batchPaymentNetworkChange({ ...draft, asset: 'NOT-ON-ETHEREUM' }, 'Ethereum');
    expect(cleared).toMatchObject({ network: 'Ethereum', asset: '', payments: draft.payments });
    // With no asset chosen the asset problem is the one shown (first), and nothing can be applied.
    expect(checkBatchPaymentDraft(cleared)).toMatchObject({ valid: false, code: 'BATCH_PAYMENT_ASSET_REQUIRED', problem: 'Choose an asset available for Batch Payment on this network.', total: null });
    expect(checkBatchPaymentDraft({ ...cleared, payments: [{ recipient: '', amount: '' }, { recipient: '', amount: '' }] }).code).toBe('BATCH_PAYMENT_ASSET_REQUIRED');
    expect(batchPaymentChain('Base')).toBe('eip155:8453');
    expect(batchPaymentChain('Base Sepolia')).toBeNull();
    expect(defaultBatchPaymentDraft()).toMatchObject({ network: 'Base', asset: 'USDC', payments: [{ recipient: '', amount: '' }, { recipient: '', amount: '' }] });
  });

  it('FE-BATCH-10: an invalid draft names which row fields are invalid; a valid one names none', () => {
    const rows = checkBatchPaymentDraft({ ...INPUT, payments: [{ recipient: A, amount: '1' }, { recipient: MISTYPED, amount: 'x' }, { recipient: A, amount: '2' }] } as BatchPaymentInput).rows;
    expect(rows).toEqual([{ recipient: true, amount: false }, { recipient: true, amount: true }, { recipient: true, amount: false }]);
    const zero = checkBatchPaymentDraft({ ...INPUT, payments: [{ recipient: '0x' + '0'.repeat(39) + '1', amount: '1' }, { recipient: CHECKSUM, amount: '' }] } as BatchPaymentInput).rows;
    expect(zero).toEqual([{ recipient: true, amount: false }, { recipient: false, amount: true }]);
    expect(checkBatchPaymentDraft(INPUT as BatchPaymentInput).rows).toEqual([{ recipient: false, amount: false }, { recipient: false, amount: false }, { recipient: false, amount: false }]);
  });

  it('a saved step\'s draft is keyed by the step\'s own declaration; a token the catalog did not name yet becomes the step\'s token once it does', () => {
    const workflow = authored(), node = workflow.nodes.find(n => n.actionType === BATCH_PAYMENT_ACTION)!;
    const saved = savedBatchPayment(node)!;
    expect(saved.input).toMatchObject({ network: 'Base', asset: 'USDC', payments: INPUT.payments.map(p => ({ recipient: p.recipient, amount: p.amount })) });
    // The links of the node are not its declaration: a new connection never drops a draft.
    expect(savedBatchPayment({ ...node, dependencies: ['node-x'] } as typeof node)!.key).toBe(saved.key);
    const edited = editorReducer(editorReducer(initialEditor(), { type: 'ADD_BATCH_PAYMENT', input: INPUT, source: 'CANVAS', baseRevision: 0 } as Command, dappReviewContext()),
      { type: 'SET_BATCH_PAYMENT', nodeId: node.nodeId, input: { ...INPUT, payments: [INPUT.payments[0], INPUT.payments[1]] }, source: 'CANVAS', baseRevision: 1 } as Command, dappReviewContext());
    expect(edited.error).toBeFalsy();
    expect(savedBatchPayment(edited.workflow.nodes.find(n => n.nodeId === node.nodeId))!.key).not.toBe(saved.key);
    const early = { ...saved.input, asset: UNRESOLVED_BATCH_ASSET };
    expect(batchDraftWithSavedAsset(early, saved.input).asset).toBe('USDC');
    expect(batchDraftWithSavedAsset({ ...early, network: 'Ethereum' }, saved.input).asset).toBe(UNRESOLVED_BATCH_ASSET);
    expect(batchDraftWithSavedAsset({ ...saved.input, asset: 'ETH' }, saved.input).asset).toBe('ETH');
  });
});

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 Batch Payment card: review fixes (fields)', () => {
  it('FE-BATCH-10: a brand-new untouched card announces no problem; an edited card (or a saved step\'s draft) states it, linked from the form and its invalid row', () => {
    const empty = [{ recipient: '', amount: '' }, { recipient: '', amount: '' }];
    const fresh = html(fields({ rows: empty, check: checkBatchPaymentDraft({ ...INPUT, payments: empty } as BatchPaymentInput), fresh: true }));
    expect(fresh).not.toContain('role="alert"');
    expect(fresh).not.toContain('aria-invalid');
    const typed = [{ recipient: MISTYPED, amount: '1' }, { recipient: B, amount: '2' }];
    const edited = html(fields({ rows: typed, check: checkBatchPaymentDraft({ ...INPUT, payments: typed } as BatchPaymentInput), fresh: false }));
    const problemId = /<span id="([^"]+)" class="composer-amount-error" role="alert">Enter a valid 0x address/.exec(edited)?.[1];
    expect(problemId).toBeTruthy();
    expect(edited).toContain(`aria-label="Batch Payment recipients" aria-describedby="${problemId}"`);
    expect(edited).toMatch(new RegExp(`aria-label="Recipient 1 address"[^>]*aria-invalid="true" aria-describedby="${problemId}"`));
    expect(edited).not.toMatch(/aria-label="Recipient 2 address"[^>]*aria-invalid/);
    expect(edited).not.toMatch(/aria-label="Recipient 1 amount \(USDC\)"[^>]*aria-invalid/);
  });

  it('FE-BATCH-07/11: with no asset chosen the select says so, the amounts name no asset and the total asks for one', () => {
    const draft = { ...INPUT, network: 'Ethereum', asset: '' } as BatchPaymentInput;
    const markup = html(fields({ network: 'Ethereum', asset: '', assets: ['ETH', 'USDC'], check: checkBatchPaymentDraft(draft) }));
    expect(markup).toContain('<option value="" disabled="" selected="">Choose an asset</option>');
    expect(markup).toContain('aria-label="Recipient 1 amount"');
    expect(markup).toContain('Total: choose an asset');
    expect(markup).toContain('Choose an asset available for Batch Payment on this network.');
    expect(markup).toMatch(/<select id="[^"]+-asset" class="composer-recipient-input" aria-invalid="true"/);
    // An asset outside the shortcuts stays the selected value (never ETH shown in its place).
    const token = html(fields({ asset: UNRESOLVED_BATCH_ASSET, assets: batchPaymentAssetChoices('Base', UNRESOLVED_BATCH_ASSET) }));
    expect(token).toContain(`<option value="${UNRESOLVED_BATCH_ASSET}" selected="">${UNRESOLVED_BATCH_ASSET}</option>`);
    expect(token).not.toContain('<option value="ETH" selected="">');
  });
});

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 Batch Payment run: review fixes (record and Canvas order)', () => {
  const run = (patch: Partial<Parameters<typeof singleCardRunRecord>[0]> = {}) => {
    const converted = editorWorkflowStrategy(authored());
    if (!converted.ok) throw new Error(converted.code);
    return { state: 'COMPLETED', stepCount: 3, workflowHash: converted.workflowHash, groups: [{ feePayer: '0x' + '9'.repeat(40) }],
      steps: [0, 1, 2].map(() => ({ state: 'RECONCILED', outcome: { received: [] } })), ...patch };
  };
  it('FE-BATCH-02: a completed lone Batch Payment run of exactly this card, every payment reconciled, is the card executed (RECONCILED)', () => {
    const card = authored(), node = card.nodes.find(n => n.actionType === BATCH_PAYMENT_ACTION)!;
    expect(singleCardRunRecord(run(), card)).toEqual({ verdict: 'RECONCILED', workflow: { workflowId: card.workflowId, nodes: [{ nodeId: node.nodeId }] }, received: [],
      owner: '0x' + '9'.repeat(40) });
    // One payment not reconciled: not executed (the run's own state is reported instead).
    expect(singleCardRunRecord(run({ steps: [{ state: 'RECONCILED' }, { state: 'UNCERTAIN' }, { state: 'RECONCILED' }] }), card)?.verdict).toBe('COMPLETED');
    expect(singleCardRunRecord(run({ state: 'RUNNING' }), card)?.verdict).toBe('RUNNING');
    // Not this card's run: another step count or another hash proves nothing.
    expect(singleCardRunRecord(run({ stepCount: 1, steps: [{ state: 'RECONCILED' }] }), card)).toBeNull();
    expect(singleCardRunRecord(run({ stepCount: 2, steps: [{ state: 'RECONCILED' }, { state: 'RECONCILED' }] }), card)).toBeNull();
    expect(singleCardRunRecord(run({ workflowHash: '0x' + '0'.repeat(64) }), card)).toBeNull();
    const changed = authored({ ...INPUT, payments: [INPUT.payments[0], INPUT.payments[1], { recipient: C, amount: '76' }] });
    expect(singleCardRunRecord(run(), changed)).toBeNull();
    // F1: the browser's client-safe reading (no hash) gives the same verdicts on the step shape; the hash stays the server's proof.
    expect(loneCardRunVerdict(run(), card)).toBe('RECONCILED');
    expect(loneCardRunVerdict(run({ steps: [{ state: 'RECONCILED' }, { state: 'UNCERTAIN' }, { state: 'RECONCILED' }] }), card)).toBe('COMPLETED');
    expect(loneCardRunVerdict(run({ state: 'RUNNING' }), card)).toBe('RUNNING');
    expect(loneCardRunVerdict(run({ stepCount: 1, steps: [{ state: 'RECONCILED' }] }), card)).toBeNull();
    expect(loneCardRunVerdict(run({ stepCount: 2, steps: [{ state: 'RECONCILED' }, { state: 'RECONCILED' }] }), card)).toBeNull();
    expect(loneCardRunVerdict(run({ stepCount: 3, steps: [{ state: 'RECONCILED' }, { state: 'RECONCILED' }] }), card)).toBeNull();
  });

  it('FE-BATCH-03: the Canvas run order names each card with the run steps it is (a Batch Payment card: its payments)', () => {
    const card = authored(), node = card.nodes.find(n => n.actionType === BATCH_PAYMENT_ACTION)!;
    expect(canvasRunOrder(card)).toEqual([{ nodeId: node.nodeId, legs: 3 }]);
    const two = editorReducer({ ...initialEditor(), workflow: card }, { type: 'ADD_BATCH_PAYMENT', input: { ...INPUT, payments: [INPUT.payments[0], INPUT.payments[1]] }, source: 'CANVAS', baseRevision: card.revision } as Command, dappReviewContext());
    expect(two.error).toBeFalsy();
    const order = canvasRunOrder(two.workflow);
    expect(order.map(item => item.legs)).toEqual([3, 2]);
    expect(canvasRunOrder(null)).toEqual([]);
    // F1: the client-safe order is exactly the engine composition the run executes: the cards in its step order, each with its `batches` leg range.
    for (const workflow of [card, two.workflow]) {
      const converted = editorWorkflowStrategy(workflow, { singleStep: true });
      if (!converted.ok) throw new Error(converted.code);
      const legs = canvasRunOrder(workflow).map(item => item.legs);
      expect(legs).toEqual(converted.composition.batches!.map(batch => batch.to - batch.from + 1));
      expect(legs.reduce((sum, n) => sum + n, 0)).toBe(converted.stepCount);
    }
  });
});
