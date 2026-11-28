// SPDX-License-Identifier: AGPL-3.0-only
/** The execution a platform-fee request names: exactly one of a single-flow run id or a workflow run id (mirrors `backend/platform-fee-api.ts`). */
export type PlatformFeeExecution = { readonly runId: string } | { readonly workflowRunId: string };
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, WORKFLOW_RUN_ID = /^wfr_[a-z2-7]{26}$/;
export function platformFeeExecutionOf(input: unknown): PlatformFeeExecution | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>, keys = Object.keys(value);
  if (keys.length !== 1) return null;
  if (typeof value.runId === 'string' && RUN_ID.test(value.runId) && !value.runId.startsWith('wfr_')) return { runId: value.runId };
  if (typeof value.workflowRunId === 'string' && WORKFLOW_RUN_ID.test(value.workflowRunId)) return { workflowRunId: value.workflowRunId };
  return null;
}
