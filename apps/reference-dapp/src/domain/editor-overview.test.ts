// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext, lintWorkflow } from '@defi-workflow-engine/reference-linter';
import { editorReducer, initialEditor, type EditorState } from './editor';
import type { Command } from './commands';
import { composerActions, composerNodeState } from './composer-presentation';
import { canvasCardStatus, editorOverview, editorStateDetail, EDITOR_INVALID_DETAIL, EDITOR_STATE_DETAIL, EDITOR_STATE_LABEL, CARD_STATUS_LABEL, CONFIGURED_DETAIL, UNREVIEWED_DETAIL } from './editor-overview';
import { translate } from '../i18n/locale';

const context = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id, assets: baseAssetRegistry });
const apply = (state: EditorState, command: Record<string, unknown>) => {
  const next = editorReducer(state, { source: 'CANVAS', baseRevision: state.workflow.revision, ...command } as Command, context);
  expect(next.error).toBeNull();
  return next;
};

describe('BUILD-FLOFI-BUILDER-UX-002 Editor overview and card status', () => {
  it('derives a card status only from the review and the Canvas drafts', () => {
    expect(canvasCardStatus({ status: 'Configured', tone: 'neutral' }, false)).toMatchObject({ kind: 'configured', label: 'Configured', detail: CONFIGURED_DETAIL });
    // No review for an applied step (the workflow's review failed) is never "not applied": it needs attention, and says why.
    expect(canvasCardStatus({ status: 'Draft', tone: 'neutral' }, false)).toMatchObject({ kind: 'attention', detail: UNREVIEWED_DETAIL });
    expect(canvasCardStatus({ status: 'Draft', tone: 'neutral' }, true).kind).toBe('draft');
    // An unapplied edit is a draft whatever its last review said.
    expect(canvasCardStatus({ status: 'Configured', tone: 'neutral' }, true).kind).toBe('draft');
    expect(canvasCardStatus({ status: 'Needs attention', tone: 'invalid', message: 'Set a maximum slippage.' }, false))
      .toEqual({ kind: 'attention', label: 'Needs attention', detail: 'Set a maximum slippage.' });
    expect(canvasCardStatus({ status: 'Warning', tone: 'warning', message: 'Slippage is elevated.' }, false).kind).toBe('attention');
    // The engine's slippage findings are stated in plain words (no internal build names).
    expect(canvasCardStatus({ status: 'Warning', tone: 'warning', message: 'Above the BUILD-003A review limit.' }, false).detail).not.toMatch(/BUILD|prototype/);
    expect(canvasCardStatus({ status: 'Warning', tone: 'warning', message: 'Review the prototype slippage limit.' }, false).detail).toBe('Check this step’s slippage limit.');
    // "Configured" states what comes next; it never claims a simulation, an approval or an executable transaction, nor denies one.
    expect(CONFIGURED_DETAIL).toBe('Configured. Simulation, Review and your signature come next.');
  });

  it('summarises the real workflow: count, networks, state and the steps that need attention', () => {
    expect(editorOverview(initialEditor().workflow, context, null)).toMatchObject({ count: 0, steps: [], networks: [], state: 'empty', attention: [], drafts: 0 });
    let state = apply(initialEditor(), { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '1', slippage: '50' });
    const review = lintWorkflow(state.workflow, context);
    const [swap] = composerActions(state.workflow);
    expect(composerNodeState(review, swap!.nodeId).status).toBe('Configured');
    const configured = editorOverview(state.workflow, context, review);
    expect(configured).toMatchObject({ count: 1, state: 'configured', attention: [], drafts: 0 });
    expect(configured.steps).toEqual([{ nodeId: swap!.nodeId, step: 1, action: 'Swap', flow: 'USDC → WETH', status: expect.objectContaining({ kind: 'configured' }) }]);
    expect(configured.networks).toEqual(['Base']);
    // An unapplied amount and a card being set up are drafts: the workflow is not configured until they are applied.
    expect(editorOverview(state.workflow, context, review, { amountInputs: { [swap!.nodeId]: '2' } })).toMatchObject({ state: 'draft', drafts: 1 });
    expect(editorOverview(state.workflow, context, review, { setup: { id: 'setup-1', action: 'bridge' } })).toMatchObject({ count: 2, state: 'draft', drafts: 1 });
    // A review warning (elevated slippage) is a step that needs attention, named with its step number.
    state = apply(state, { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '1', slippage: '200' });
    const warned = editorOverview(state.workflow, context, lintWorkflow(state.workflow, context));
    expect(warned.state).toBe('attention');
    expect(warned.attention.map(step => step.step)).toEqual([2]);
    expect(warned.attention[0]!.status.detail).toBeTruthy();
    // A refused edit is always surfaced, and named as such.
    const refused = editorOverview(state.workflow, context, review, {}, true);
    expect(refused.state).toBe('attention');
    expect(editorStateDetail(editorOverview(apply(initialEditor(), { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '1', slippage: '50' }).workflow, context, review, {}, true))).toBe(EDITOR_INVALID_DETAIL);
    // A workflow whose review failed: its applied steps need attention; nothing reads as an unapplied change.
    const unreviewed = editorOverview(state.workflow, context, null);
    expect(unreviewed).toMatchObject({ state: 'attention', drafts: 0 });
    expect(unreviewed.steps.every(step => step.status.kind === 'attention' && step.status.detail === UNREVIEWED_DETAIL)).toBe(true);
    // A step holding a draft leaves its applied flow out of the summary (the card shows the draft).
    const [first] = composerActions(state.workflow);
    expect(editorOverview(state.workflow, context, lintWorkflow(state.workflow, context), { cryptoSelections: { [first!.nodeId]: {} } }).steps[0]).toMatchObject({ flow: null, status: { kind: 'draft' } });
    // The card being set up is listed after the workflow's steps.
    expect(editorOverview(state.workflow, context, lintWorkflow(state.workflow, context), { setup: { id: 'setup-9', action: 'Bridge' } }).steps.at(-1)).toMatchObject({ nodeId: 'setup-9', step: 3, action: 'Bridge' });
  });

  it('has a Portuguese label for every status it can show', () => {
    for (const label of [...Object.values(CARD_STATUS_LABEL), ...Object.values(EDITOR_STATE_LABEL), ...Object.values(EDITOR_STATE_DETAIL), CONFIGURED_DETAIL, 'Not applied to the workflow yet.',
      UNREVIEWED_DETAIL, EDITOR_INVALID_DETAIL, 'Check this step’s slippage limit.', 'The slippage limit is above what FloFi accepts for review.', 'Set one slippage limit for this step.'])
      expect(translate('PT', label), label).not.toBe(label);
    expect(translate('PT', 'Configured')).toBe('Configurado');
    expect(translate('PT', 'Draft')).toBe('Rascunho');
    expect(translate('PT', 'Needs attention')).toBe('Requer atenção');
  });
});
