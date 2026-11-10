// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { withFlightAccess } from '../server/flight-access';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import type { SavedWorkflow, WorkflowDocument, WorkflowList, WorkflowOwner } from '../domain/saved-workflow';
import { workflowOperation } from '../server/workflow-persistence';
import { ownerHistoryOperation } from '../server/owner-history';
export async function listWorkflows(owner: WorkflowOwner) {
  return withFlightAccess(async () => { return workflowOperation<WorkflowList>('list', [], owner);
  });
}
export async function openWorkflow(owner: WorkflowOwner, workflowId: string) {
  return withFlightAccess(async () => { return workflowOperation<WorkflowDocument>('get', [workflowId], owner);
  });
}
export async function saveWorkflow(owner: WorkflowOwner, workflow: SemanticWorkflow, name: string, expectedVersion: number) {
  return withFlightAccess(async () => {
  return workflowOperation<SavedWorkflow>('save', [{ workflow, name, expectedVersion }], owner);

  });
}
export async function changeSavedWorkflowHistory(owner: WorkflowOwner, workflowId: string, action: 'DELETE' | 'ARCHIVE') {
  return withFlightAccess(async () => {
  return ownerHistoryOperation(owner.address, 'change', 'SAVED_WORKFLOW', workflowId, action);

  });
}
