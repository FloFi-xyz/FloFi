// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: what a successful simulation records for a boarding pass (pure; see `simulation-evidence.ts`): the run, and
 * the route projected from the workflow the server simulated (`flightRoute`: networks and step labels, never an amount).
 */
import { flightRoute, type FlightRoute } from './campaign.ts';

type Workflow = { readonly workflowId: string; readonly revision: number; readonly nodes: Parameters<typeof flightRoute>[0] };
export type SimulationCall = { readonly flow: string; readonly method: string; readonly args: readonly unknown[]; readonly value: unknown };
export type SimulationRecord = { readonly flow: string; readonly runId: string; readonly workflowId: string; readonly revision: number; readonly route: FlightRoute };

const isWorkflow = (value: unknown): value is Workflow => {
  const v = value as Partial<Workflow> | null;
  return !!v && typeof v === 'object' && typeof v.workflowId === 'string' && v.workflowId.length >= 1 && v.workflowId.length <= 200
    && Number.isSafeInteger(v.revision) && (v.revision as number) >= 0 && Array.isArray(v.nodes) && v.nodes.length >= 1 && v.nodes.length <= 32;
};
/**
 * The run of a simulation: the record id (`simulate`), or the catalog swap's execution id (`prepare`) — only once the owner's own
 * preflight is in it (`quote.ownerReview`), never a bare quote.
 */
const runIdOf = (method: string, value: unknown): string | null => {
  const v = value as { id?: unknown; runId?: unknown; quote?: { executionId?: unknown; ownerReview?: unknown } } | null;
  if (!v || typeof v !== 'object') return null;
  const id = method === 'prepare' ? (v.quote?.ownerReview ? v.quote.executionId : null) : typeof v.id === 'string' ? v.id : v.runId;
  return typeof id === 'string' && id.length >= 1 && id.length <= 200 ? id : null;
};

/**
 * What a successful simulation call records, or null when it is not one (another method, no workflow, no run, a testnet route). Every
 * mainnet service simulates exactly one financial step (a sequence is simulated step by step; the compositions are test networks
 * only), so the record is that one step: a workflow carrying other financial steps records nothing, and no unsimulated step can
 * reach a pass.
 */
export function simulationRecord(call: SimulationCall): SimulationRecord | null {
  if (call.method !== 'simulate' && call.method !== 'prepare') return null;
  const workflow = call.args[0], runId = runIdOf(call.method, call.value);
  if (!isWorkflow(workflow) || !runId || !/^[a-z0-9-]{1,64}$/.test(call.flow)) return null;
  const steps = workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
  const route = steps.length === 1 ? flightRoute(steps) : null;
  return route ? { flow: call.flow, runId, workflowId: workflow.workflowId, revision: workflow.revision, route } : null;
}
