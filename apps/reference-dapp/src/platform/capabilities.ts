// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-DEVELOPER-001: capability discovery facts for every supported action × network on this deployment, shared by every
 * surface (moved from the MCP `get_capabilities` handler without change). Code support comes from the execution capability
 * registry on each canonical example; deployment enablement from the runtime; policy from the caller's handoff policy;
 * demonstrated evidence is reported, never a gate. What a surface offers on top (MCP's tool flags, a developer API's operations)
 * is that surface's own projection.
 */
import type { FlowName } from '../../backend/flows.ts';
import { codeCapabilities, type CodeCapability } from '../engine/capability-catalog';
import type { WorkflowComposition } from '../engine/strategy-engine';
import type { NetworkId, StrategyAction } from '../engine/strategy-spec';
import { evaluateWorkflowGates, type ExecutionPlan, type Gates, type HandoffPolicy } from '../mcp/execution.ts';
import type { McpRuntime as EngineRuntime } from '../mcp/runtime.ts';
import { previewPlan, strategyFlow } from '../mcp/simulation.ts';
import { authorizationPlan } from '../workflow-runs/authorization-plan.ts';
import { composeWorkflowOrRefuse } from './strategy.ts';
import type { NetworkScope } from '../domain/network-scope';
import { networkScope } from '../server/network-scope.ts';

/** One mode/info lookup per flow per call. */
export function memoizedRuntime(runtime: EngineRuntime): EngineRuntime {
  const modes = new Map<string, ReturnType<EngineRuntime['mode']>>(), infos = new Map<string, ReturnType<NonNullable<EngineRuntime['info']>>>();
  return { ...runtime, mode: flow => { if (!modes.has(flow)) modes.set(flow, runtime.mode(flow)); return modes.get(flow)!; },
    info: flow => { if (!infos.has(flow)) infos.set(flow, runtime.info?.(flow) ?? Promise.resolve(null)); return infos.get(flow)!; } };
}

export type CapabilityFact = {
  readonly row: CodeCapability;
  /** The flow whose enablement governs this row (even when it cannot be previewed), and its mode here (`null` when unknowable). */
  readonly flow: FlowName | null; readonly mode: Awaited<ReturnType<EngineRuntime['mode']>>;
  /** Whether a read-only simulation preview can run for this row on this deployment, and why not. */
  readonly previewable: boolean; readonly previewUnavailableReason: string | null;
  readonly gates: Gates & { readonly plan: ExecutionPlan };
};
export type CapabilityFilter = { readonly network?: NetworkId | undefined; readonly action?: StrategyAction | undefined };

/** Why a workflow with a Batch Payment is not handed off here. */
export const BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE = 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE';
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (review MCP-3, DEV-BP-2): the gates of a workflow as an approval request evaluates them once it has a Batch
 * Payment (`prepareApprovalRequest`): a batch is handed off only where it can run as ONE atomic authorization of the owner's own wallet on this deployment
 * (user-funded groups for its chain, every leg batchable). `ownerStepsOnly` (a production Developer API key) never offers user-funded groups, so a batch is
 * never handed off there. Every surface that REPORTS approvability applies this same rule, so it never advertises what the request then refuses. Gates
 * that already refuse keep their own reason; a workflow without a batch is returned unchanged.
 */
export async function batchPaymentGates<G extends Pick<Gates, 'supportedByCode' | 'enabledByDeployment' | 'enabledByPolicy' | 'handoff'> & { readonly plan: ExecutionPlan }>(
  workflow: WorkflowComposition, gates: G, runtime: Pick<EngineRuntime, 'sequences'>, { ownerStepsOnly = false }: { readonly ownerStepsOnly?: boolean } = {}): Promise<G> {
  if (!workflow.batches?.length || !gates.handoff.allowed) return gates;
  const facts = ownerStepsOnly ? null : (await runtime.sequences?.().catch(() => null))?.userFunded ?? null;
  const atomic = authorizationPlan(workflow, gates, null, undefined, facts ? { facts } : undefined).userFunded;
  return atomic.available ? gates : { ...gates, handoff: { allowed: false, reason: BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE } };
}

/**
 * The four facts and the preview availability of every capability row matching `filter` (rows in registry order). `ownerStepsOnly`: the caller's approvals
 * offer only the owner's own steps (a production Developer API key, `createApproval`), so a Batch Payment row is never approvable there.
 */
export async function capabilityFacts(runtime: EngineRuntime, policy: HandoffPolicy, filter: CapabilityFilter = {}, scope: NetworkScope = networkScope(),
  { singleStepRun = false, ownerStepsOnly = false } = {}): Promise<readonly CapabilityFact[]> {
  const rows = codeCapabilities(scope).filter(r => (!filter.network || r.network === filter.network || r.destinationNetwork === filter.network) && (!filter.action || r.action === filter.action));
  const memo = memoizedRuntime(runtime), cloud = runtime.kind === 'remote' || runtime.kind === 'embedded';
  const sequences = singleStepRun ? runtime.sequences?.() : undefined;
  const gatedRuntime = sequences ? { ...memo, sequences: () => sequences } : memo;
  return Promise.all(rows.map(async row => {
    const workflow = composeWorkflowOrRefuse(row.example, undefined, scope);
    // A Batch Payment executes as its transfer legs (one asset, one network): their flow's enablement governs the row (review MCP-3).
    const governing = workflow.batches?.length ? workflow.steps[0]!.strategy : row.example;
    const plan = previewPlan(row.example), flow = strategyFlow(governing), mode = flow ? await memo.mode(flow) : null;
    const previewable = 'flow' in plan && cloud && (mode === 'live' || mode === 'harness');
    const gates = await batchPaymentGates(workflow, await evaluateWorkflowGates(workflow, gatedRuntime, policy, { run: singleStepRun }), gatedRuntime, { ownerStepsOnly });
    const previewUnavailableReason = previewable ? null : 'code' in plan ? plan.code
      : !cloud ? (runtime.kind === 'local' ? 'MCP_CLOUD_RUNTIME_REQUIRED' : 'CLOUD_RUNTIME_NOT_CONFIGURED') : 'FLOW_NOT_ENABLED_IN_DEPLOYMENT';
    return { row, flow, mode, previewable, previewUnavailableReason, gates };
  }));
}
