// SPDX-License-Identifier: AGPL-3.0-only
import { semanticWorkflowHash, type Composition } from '../engine/strategy-engine';
import type { RunRecord } from './pg-store';

export function isLiveDeveloperRun(run: Pick<RunRecord, 'requester'>): boolean {
  return run.requester.kind === 'DEVELOPER_PROJECT' && run.requester.ref.endsWith('.production');
}

/** The approved strategy retains its canonical hash. The hosted step has an additional server-assigned identity so
 * the same owner executing identical strategies for two projects cannot settle the other project's workflow. */
export function executionStep(run: Pick<RunRecord, 'runId' | 'requester'>, stepIndex: number, composition: Composition): Composition {
  if (!isLiveDeveloperRun(run)) return composition;
  const workflow = { ...composition.workflow, workflowId: `${run.runId}-step-${stepIndex}` };
  return { ...composition, workflow, workflowHash: semanticWorkflowHash(workflow) };
}
