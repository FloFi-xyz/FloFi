// SPDX-License-Identifier: AGPL-3.0-only
// The backend imports this module under plain Node: runtime imports carry `.ts` and avoid the engine facade, whose imports
// are extensionless. The step hash is the canonical semanticWorkflowHash, computed as the flows compute it (router-service.ts).
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import type { Composition } from '../engine/strategy-engine';
import type { Workflow } from '../domain/initial-workflow';
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { normalizePrincipal } from '../server/run-ownership.ts';
import type { RunRecord } from './pg-store';

const EXTERNAL_WORKFLOW = /^(wfr_[a-z2-7]{26})-step-([0-7])$/;
export const isExternalStepWorkflow = (workflowId: string) => EXTERNAL_WORKFLOW.test(workflowId);
// The bearer-authenticated BFF supplies this from server configuration, never from the browser.
export const DEVELOPER_LIVE_HEADER = 'x-flofi-developer-live';
const ISSUES_WALLET_REQUEST = new Set(['begin', 'beginGasless', 'beginSwap', 'beginLiquidity', 'handoff']);
export const issuesWalletRequest = (method: string) => ISSUES_WALLET_REQUEST.has(method);
const stepHash = (workflow: Workflow) => hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow)));
/** Every code `externalWalletRequestRefusal` returns. Each precedes any wallet request, so signing classifies it as a refusal. */
export const EXTERNAL_STEP_REFUSALS = ['LIVE_MODE_DISABLED', 'WALLET_SESSION_REQUIRED', 'HANDOFF_WORKFLOW_MISMATCH',
  'DEVELOPER_PROJECT_DISABLED', 'WORKFLOW_RUN_EXPIRED', 'WORKFLOW_RUN_NO_STEP'] as const;

export function isLiveDeveloperRun(run: Pick<RunRecord, 'requester'>): boolean {
  return run.requester.kind === 'DEVELOPER_PROJECT' && run.requester.ref.endsWith('.production');
}

/** The approved strategy retains its canonical hash. The hosted step has an additional server-assigned identity so
 * the same owner executing identical strategies for two projects cannot settle the other project's workflow. */
export function executionStep(run: Pick<RunRecord, 'runId' | 'requester'>, stepIndex: number, composition: Composition): Composition {
  if (!isLiveDeveloperRun(run)) return composition;
  const workflow = { ...composition.workflow, workflowId: `${run.runId}-step-${stepIndex}` };
  return { ...composition, workflow, workflowHash: stepHash(workflow) };
}

export function externalStepWorkflow(record: unknown, workflowId?: string): Workflow | undefined {
  const r = record as { readonly workflow?: Workflow; readonly review?: { readonly workflow?: Workflow };
    readonly prepared?: { readonly workflow?: Workflow }; readonly reviews?: readonly { readonly workflow?: Workflow }[] } | null;
  return [r?.workflow, r?.review?.workflow, r?.prepared?.workflow, r?.reviews?.[0]?.workflow]
    .find(w => typeof w?.workflowId === 'string' && (workflowId === undefined ? isExternalStepWorkflow(w.workflowId) : w.workflowId === workflowId));
}

/** The existing flow owns its wallet request. A live external step also needs a current, applied approval
 * for this exact reviewed workflow and wallet. Issued requests can still report and reconcile. */
export async function externalWalletRequestRefusal(db: Database, input: {
  readonly tenantId: string; readonly workflowId: string; readonly flow: string; readonly executionId: string;
  readonly principal: string | null; readonly live: boolean; readonly record: unknown;
}): Promise<string | null> {
  const match = EXTERNAL_WORKFLOW.exec(input.workflowId);
  if (!match) return null;
  if (!input.live) return 'LIVE_MODE_DISABLED';
  const principal = normalizePrincipal(input.principal);
  if (!principal) return 'WALLET_SESSION_REQUIRED';
  const workflow = externalStepWorkflow(input.record, input.workflowId);
  if (!workflow) return 'HANDOFF_WORKFLOW_MISMATCH';
  const { rows: [step] } = await db.query<{ active: boolean; expired: boolean; signable: boolean }>(`
    SELECT p.status = 'ACTIVE' AS active, r.expires_at <= clock_timestamp() AS expired,
      (r.mode = 'CONFIRM_EACH_STEP' AND r.state IN ('RUNNING', 'ATTENTION') AND r.current_step = s.step_index
        AND (s.state = 'AWAITING_OWNER' OR (s.state = 'UNCERTAIN' AND s.outcome->>'kind' = 'OWNER_RUN'
          AND s.outcome->>'executionId' = $7))) AS signable
    FROM workflow_runs r
    JOIN workflow_run_steps s USING (tenant_id, run_id)
    JOIN mcp_handoffs h USING (tenant_id, handoff_id)
    JOIN developer_approvals a USING (tenant_id, handoff_id)
    JOIN developer_projects p USING (tenant_id, project_id)
    WHERE r.tenant_id = $1 AND r.run_id = $2 AND s.step_index = $3 AND s.flow = $4 AND s.workflow_hash = $5
      AND r.wallets->>(CASE WHEN left($6::text, 2) = '0x' THEN 'eip155' ELSE 'solana' END) = $6
      AND r.requester_kind = 'DEVELOPER_PROJECT' AND r.requester_ref = a.project_id || '.production'
      AND a.environment = 'production' AND a.workflow_hash = r.workflow_hash AND h.workflow_hash = r.workflow_hash
      AND h.requester_kind = r.requester_kind AND h.requester_ref = r.requester_ref AND h.funds_class = 'REAL_FUNDS'
      AND h.claimed_namespace = r.owner_namespace AND h.claimed_address = r.owner_account AND h.status = 'APPLIED'`,
  [input.tenantId, match[1], Number(match[2]), input.flow, stepHash(workflow), principal, input.executionId]);
  if (!step) return 'HANDOFF_WORKFLOW_MISMATCH';
  if (!step.active) return 'DEVELOPER_PROJECT_DISABLED';
  if (step.expired) return 'WORKFLOW_RUN_EXPIRED';
  return step.signable ? null : 'WORKFLOW_RUN_NO_STEP';
}
