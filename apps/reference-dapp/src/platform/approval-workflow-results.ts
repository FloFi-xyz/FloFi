// SPDX-License-Identifier: AGPL-3.0-only
import type { HandoffRecord } from './handoff-store.ts';
import type { WorkflowRunStore } from '../workflow-runs/pg-store.ts';

export type ApprovalRunReader = Pick<WorkflowRunStore, 'byHandoff' | 'steps' | 'groups'>;

/** Read the run bound to an applied approval whose claimant chose to share status. */
export async function approvalWorkflowResults(h: HandoffRecord, store: ApprovalRunReader) {
  if (h.status !== 'APPLIED' || !h.shareStatus || !h.claimed || h.plan.kind !== 'SEQUENTIAL') return null;
  const run = await store.byHandoff(h.handoffId);
  if (!run || run.handoffId !== h.handoffId || run.requester.kind !== h.requesterKind || run.requester.ref !== h.requesterRef
    || run.workflowHash !== h.workflowHash || run.owner.namespace !== h.claimed.namespace || run.owner.address !== h.claimed.address) return null;
  const [steps, groups] = await Promise.all([store.steps(run.runId), run.mode === 'USER_FUNDED' ? store.groups(run.runId) : []]);
  return { run, steps, groups };
}
