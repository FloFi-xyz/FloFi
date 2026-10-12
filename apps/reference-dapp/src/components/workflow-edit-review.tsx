// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useWorkflow } from '../state/workflow-store';
import { poolProposalTarget } from './composer-card';
import { singleAmountProposalTarget } from '../domain/composer-presentation';
import { ProposalReviewArtifact } from './proposal-review';
export { workflowProposalSummary } from './proposal-review';

type Pending = ReturnType<typeof useWorkflow>['pending'];
/** Whether the Canvas-level review shows this pending proposal. Card-based proposals retain their existing eligibility and acceptance handler;
 *  Copilot proposals on those cards render this same review through a canvas portal. */
export function workflowEditProposalVisible(pending: Pending, workflow: ReturnType<typeof useWorkflow>['state']['workflow']): boolean {
  return Boolean(pending && !pending.authoringId && !singleAmountProposalTarget(workflow, pending.command) && !poolProposalTarget(pending.command));
}
/** Existing authoring proposal acceptance; never financial authorization. `centered` (UX-006): the empty Canvas's central place. */
export function WorkflowEditReview({ centered = false }: { centered?: boolean } = {}) {
  const { pending, state } = useWorkflow();
  if (!workflowEditProposalVisible(pending, state.workflow)) return null;
  return <ProposalReviewArtifact centered={centered}/>;
}
