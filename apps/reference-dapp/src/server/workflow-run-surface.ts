// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: the workflow runs `/approve` serves on this deployment (FLOFI_WORKFLOW_RUNS=enabled; otherwise none and a multi-step
 * approval is refused). The run store lives with the approval handoffs; each step is re-gated with its requester kind's own handoff policy
 * (fail closed for a kind this surface does not serve). Delegated mode is offered only where this surface can perform it: delegation enabled
 * either on an embedded runtime (the owner's wallet review and signature are verified here) or, BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001,
 * on the remote runtime, where review, sign and revoke are forwarded to the API that holds the executor key (the worker executes). Elsewhere
 * the run offers confirm-each-step only, and says why.
 */
import { readAutomationConfig } from '../automations/config.ts';
import { automationHost } from '../automations/runtime.ts';
import { readDelegationConfig } from '../delegation/config.ts';
import { ownerDelegationService } from '../delegation/operations.ts';
import { createPgDelegationStore } from '../delegation/pg-store.ts';
import { DELEGATION_EXECUTE_RUN_KIND } from '../delegation/run-source.ts';
import type { ApprovalHost, ApprovalKindProfile, EngineRuntime, HandoffPolicy } from '../platform/index.ts';
import { typedId } from '../platform/ids.ts';
import type { ApprovalRequesterKind } from '../platform/handoff-store.ts';
import type { RunDelegationOps, WorkflowRunSurface } from '../platform/workflow-run-approvals.ts';
import { sequenceFacts } from '../workflow-runs/facts.ts';
import { createPgWorkflowRunStore } from '../workflow-runs/pg-store.ts';
import { workflowRunsEnabled } from '../workflow-runs/service.ts';
import { flowRuntimeKind } from './flow-runtime.ts';
import { delegationOperation } from './delegation-operation.ts';
import type { FlowResult } from './cloud-api-client.ts';

type Env = Readonly<Record<string, string | undefined>>;
const CLOSED: HandoffPolicy = { ok: false, code: 'MCP_HANDOFF_POLICY_INVALID' };

export async function workflowRunSurface(env: Env, host: ApprovalHost, runtime: EngineRuntime,
  profiles: Partial<Readonly<Record<ApprovalRequesterKind, ApprovalKindProfile>>>): Promise<WorkflowRunSurface | null> {
  if (!workflowRunsEnabled(env)) return null;
  const store = createPgWorkflowRunStore(host.db, host.tenantId);
  const delegation = await delegationParts(env, store, host);
  return { store, runtime, delegation: delegation?.store ?? null, now: () => new Date(), log: () => undefined,
    policyFor: kind => profiles[kind]?.policy ?? CLOSED, delegationFacts: delegation ? sequenceFacts(env).delegation : null,
    ...delegation ? { grantsOf: (owner: Parameters<typeof delegation.store.grants>[0]) => delegation.store.grants(owner) } : {}, newId: typedId,
    delegationOps: delegation?.ops ?? null };
}

/**
 * The owner's delegated run operations, or null where this surface cannot perform them. Embedded: in process. Remote (production):
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001 — forwarded to the Railway API (`delegationOperation`, the request's proven wallets),
 * which holds the executor key and re-checks that the run is the owner's and its EVM wallet was proven. Reads use this database.
 */
async function delegationParts(env: Env, runs: ReturnType<typeof createPgWorkflowRunStore>, approvalHost: ApprovalHost) {
  if (flowRuntimeKind(env) === 'remote') {
    const config = readDelegationConfig(env);
    if (!config.enabled) return null;
    const unwrap = <T>(result: FlowResult<T>): T => { if (!result.ok) throw new Error(result.code); return result.value; };
    const ops: RunDelegationOps = {
      review: async (owner, run) => unwrap(await delegationOperation<Awaited<ReturnType<RunDelegationOps['review']>>>('workflowRunWalletReview', [run.runId], owner)),
      sign: async (owner, runId, revision, signatures) => unwrap(await delegationOperation<{ authorizationId: string }>('workflowRunWalletSign', [runId, revision, signatures], owner)),
      revoke: async (owner, runId) => { unwrap(await delegationOperation('workflowRunWalletRevoke', [runId], owner)); },
    };
    return { ops, store: createPgDelegationStore(approvalHost.db, approvalHost.tenantId) };
  }
  const config = readDelegationConfig(env), automations = readAutomationConfig(env);
  if (!config.enabled || !automations.enabled) return null;
  const host = await automationHost(env, automations);
  if ('code' in host) return null;
  const service = ownerDelegationService(config, automations, host, () => undefined, () => new Date());
  const ops: RunDelegationOps = {
    // BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: a run's delegated authorization is the wallet signature of its exact workflow grants.
    review: (owner, run) => service.workflowRunWalletReview(owner, run as Parameters<typeof service.workflowRunWalletReview>[1]),
    sign: (owner, runId, revision, signatures, retryOnly) => service.workflowRunWalletSign(owner, runId, revision, signatures,
      (tx, authorizationId) => runs.activateDelegatedWithin(tx, runId, authorizationId, DELEGATION_EXECUTE_RUN_KIND), retryOnly === true),
    revoke: (owner, runId) => service.workflowRunAuthorizationRevoke(owner, runId),
  };
  return { ops, store: createPgDelegationStore(host.db, host.tenantId) };
}
