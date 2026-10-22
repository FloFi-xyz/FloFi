// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: a conversational workflow run as the source of a delegated execution. Its work item drives the run's ONE delegated
 * execution (payload `{ workflowRunId, authorizationId }`, deduplicated per run); the automation occurrence kind is unchanged.
 */
export const DELEGATION_EXECUTE_RUN_KIND = 'delegation.execute-run';
export const WORKFLOW_RUN_ID = /^wfr_[a-z2-7]{26}$/;
