// SPDX-License-Identifier: AGPL-3.0-only
import type { ReviewContext, ReviewResult } from '@defi-workflow-engine/reference-linter';
import type { Workflow } from './initial-workflow';
import { composerActions, composerNodeState, composerSummary } from './composer-presentation';
import { canvasCardFlow } from './canvas-card-summary';

/**
 * BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): the discreet status a Canvas step card states, its Editor header and footer summary,
 * and the FloFi panel's workflow summary. Presentation only: every value is derived from the real workflow, its lint review
 * (`composerNodeState`) and the drafts the Canvas already holds. Nothing here edits, links, simulates, approves or executes a step.
 *
 * - `draft`: the card holds an edit that is not applied to the workflow yet (a new card being set up, or an unapplied amount, network, pair or
 *   recipient).
 * - `attention`: the workflow's own review reports a blocking finding or a warning for this step (simulation and review requirements are not
 *   authoring findings and never count here), or an applied step could not be reviewed at all (the workflow's review failed).
 * - `configured`: the step is applied and its review reports nothing to fix. It is NOT simulated, approved or executable: a fresh simulation, the
 *   owner's Review and their wallet signature still come first.
 */
export type CardStatusKind = 'draft' | 'configured' | 'attention';
export type CardStatus = { readonly kind: CardStatusKind; readonly label: string; readonly detail: string };
type NodeValidation = { readonly status: string; readonly tone: string; readonly message?: string | undefined };

export const CARD_STATUS_LABEL: Readonly<Record<CardStatusKind, string>> = { draft: 'Draft', configured: 'Configured', attention: 'Needs attention' };
/** It states what comes next, never a simulation, Review or execution state it does not know. */
export const CONFIGURED_DETAIL = 'Configured. Simulation, Review and your signature come next.';
export const DRAFT_DETAIL = 'Not applied to the workflow yet.';
export const UNREVIEWED_DETAIL = 'This step could not be reviewed. Check its settings.';
/** The review's slippage findings in plain words (the engine's own text names internal limits). */
const FINDING_DETAIL: Readonly<Record<string, string>> = {
  'Review the prototype slippage limit.': 'Check this step’s slippage limit.',
  'Above the BUILD-003A review limit.': 'The slippage limit is above what FloFi accepts for review.',
  'Set one explicit slippage limit.': 'Set one slippage limit for this step.',
};
/** Board 16: a step's check in plain words, never the internal limit names the review engine uses ("BUILD-003A"). */
export const plainFinding = (message: string): string => FINDING_DETAIL[message] ?? message;

/** `validation.status === 'Draft'` without a Canvas draft means the step is applied but the workflow has no review (its review failed). */
export function canvasCardStatus(validation: NodeValidation, draft: boolean): CardStatus {
  if (draft) return { kind: 'draft', label: CARD_STATUS_LABEL.draft, detail: DRAFT_DETAIL };
  if (validation.status === 'Draft') return { kind: 'attention', label: CARD_STATUS_LABEL.attention, detail: UNREVIEWED_DETAIL };
  if (validation.tone === 'invalid' || validation.tone === 'warning') {
    const message = validation.message;
    return { kind: 'attention', label: CARD_STATUS_LABEL.attention, detail: message ? plainFinding(message) : 'Check this step’s settings.' };
  }
  return { kind: 'configured', label: CARD_STATUS_LABEL.configured, detail: CONFIGURED_DETAIL };
}

/** The Canvas drafts a step may hold (the same records the cards read). */
export type CanvasDrafts = {
  /** The card being set up, with its action as the Canvas names it ("Bridge"). */
  readonly setup?: { readonly id: string; readonly action: string } | null;
  readonly amountInputs?: Readonly<Record<string, string>>;
  readonly cryptoSelections?: Readonly<Record<string, unknown>>;
  readonly bridgeNetworkInputs?: Readonly<Record<string, unknown>>;
  readonly recipientInputs?: Readonly<Record<string, string>>;
};
export function hasCanvasDraft(drafts: CanvasDrafts, nodeId: string): boolean {
  return drafts.amountInputs?.[nodeId] !== undefined || Boolean(drafts.cryptoSelections?.[nodeId]) || Boolean(drafts.bridgeNetworkInputs?.[nodeId])
    || drafts.recipientInputs?.[nodeId] !== undefined;
}

export type EditorStep = { readonly nodeId: string; readonly step: number; readonly action: string; readonly flow: string | null; readonly status: CardStatus };
export type EditorWorkflowState = 'empty' | 'draft' | 'attention' | 'configured';
export type EditorOverview = {
  /** Steps on the Canvas, the card being set up included (the same count the Canvas footer states). */
  readonly count: number;
  readonly steps: readonly EditorStep[];
  /** The networks the workflow's steps use, in step order, without chain numbers (a bridge names both sides). */
  readonly networks: readonly string[];
  readonly state: EditorWorkflowState;
  /** Steps whose review reports something to fix, in workflow order. */
  readonly attention: readonly EditorStep[];
  /** Cards holding an edit that is not applied yet (a card being set up included). */
  readonly drafts: number;
  /** The workflow itself could not be reviewed (an edit was refused). */
  readonly invalid: boolean;
};

const networkName = (label: string) => label.replace(/ \(\d+\)$/, '').trim();

export function editorOverview(workflow: Workflow, context: ReviewContext, review: ReviewResult | null, drafts: CanvasDrafts = {}, invalid = false): EditorOverview {
  const steps: EditorStep[] = composerActions(workflow).map((node, index) => {
    const summary = composerSummary(workflow, node, context);
    const draft = hasCanvasDraft(drafts, node.nodeId);
    // A step holding a draft shows the draft's own values on its card; the summary names only what is applied, so it leaves the flow out.
    return { nodeId: node.nodeId, step: index + 1, action: summary.action, flow: draft ? null : canvasCardFlow(summary),
      status: canvasCardStatus(composerNodeState(review, node.nodeId), draft) };
  });
  const networks: string[] = [];
  for (const node of composerActions(workflow)) {
    for (const side of composerSummary(workflow, node, context).chain.split(' → ')) {
      const name = networkName(side);
      if (name && name !== 'Network not specified' && !networks.includes(name)) networks.push(name);
    }
  }
  // A card being set up is listed after the workflow's steps, as the Canvas numbers it; it is a draft until applied.
  if (drafts.setup) steps.push({ nodeId: drafts.setup.id, step: steps.length + 1, action: drafts.setup.action, flow: null, status: canvasCardStatus({ status: 'Draft', tone: 'neutral' }, true) });
  const attention = steps.filter(step => step.status.kind === 'attention');
  const pending = steps.filter(step => step.status.kind === 'draft').length;
  const count = steps.length;
  const state: EditorWorkflowState = count === 0 ? 'empty' : invalid || attention.length ? 'attention' : pending ? 'draft' : 'configured';
  return { count, steps, networks, state, attention, drafts: pending, invalid };
}

export const EDITOR_STATE_LABEL: Readonly<Record<EditorWorkflowState, string>> = {
  empty: 'No steps yet', draft: 'Draft', attention: 'Needs attention', configured: 'Configured',
};
/** What the state does not mean, said where it is shown. */
export const EDITOR_STATE_DETAIL: Readonly<Record<EditorWorkflowState, string>> = {
  empty: 'Add a step from the toolbar or describe it to FloFi.',
  draft: 'Some changes are not applied to the workflow yet.',
  attention: 'Check the step that needs attention.',
  configured: 'Configured. Simulate and review before signing.',
};
/** A refused edit: no step needs attention, the edit itself was not applied. */
export const EDITOR_INVALID_DETAIL = 'An edit was not applied.';
export function editorStateDetail(overview: Pick<EditorOverview, 'state' | 'invalid' | 'attention'>): string {
  return overview.state === 'attention' && overview.invalid && !overview.attention.length ? EDITOR_INVALID_DETAIL : EDITOR_STATE_DETAIL[overview.state];
}
export const EMPTY_EDITOR_OVERVIEW: EditorOverview = { count: 0, steps: [], networks: [], state: 'empty', attention: [], drafts: 0, invalid: false };
