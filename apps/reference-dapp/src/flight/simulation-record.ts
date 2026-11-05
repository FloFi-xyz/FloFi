// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: what a successful simulation records for a boarding pass (pure; see `simulation-evidence.ts`): the run, and
 * the route projected from the workflow the server simulated (`flightRoute`: networks and step labels, never an amount).
 */
import { workflowDependencyOrder } from '@defi-workflow-engine/workflow-contracts';
import { flightRoute, type FlightRoute } from './campaign.ts';

type Workflow = { readonly workflowId: string; readonly revision: number; readonly nodes: Parameters<typeof flightRoute>[0] };
export type SimulationCall = { readonly flow: string; readonly method: string; readonly args: readonly unknown[]; readonly value: unknown };
export type SimulationRecord = { readonly flow: string; readonly runId: string; readonly workflowId: string; readonly revision: number; readonly route: FlightRoute };

const isWorkflow = (value: unknown): value is Workflow => {
  const v = value as Partial<Workflow> | null;
  return !!v && typeof v === 'object' && typeof v.workflowId === 'string' && v.workflowId.length >= 1 && v.workflowId.length <= 200
    && Number.isSafeInteger(v.revision) && (v.revision as number) >= 0 && Array.isArray(v.nodes) && v.nodes.length >= 1 && v.nodes.length <= 32;
};
/** The run of a simulation: the record id (`simulate`), or the catalog swap's execution id (`prepare`). */
const runIdOf = (method: string, value: unknown): string | null => {
  const v = value as { id?: unknown; runId?: unknown; quote?: { executionId?: unknown } } | null;
  if (!v || typeof v !== 'object') return null;
  const id = method === 'prepare' ? v.quote?.executionId : typeof v.id === 'string' ? v.id : v.runId;
  return typeof id === 'string' && id.length >= 1 && id.length <= 200 ? id : null;
};
const ordered = (nodes: Workflow['nodes']): Workflow['nodes'] => {
  try { return workflowDependencyOrder(nodes as never) as unknown as Workflow['nodes']; } catch { return nodes; }
};

/** What a successful simulation call records, or null when it is not one (another method, no workflow, no run, a testnet route). */
export function simulationRecord(call: SimulationCall): SimulationRecord | null {
  if (call.method !== 'simulate' && call.method !== 'prepare') return null;
  const workflow = call.args[0], runId = runIdOf(call.method, call.value);
  if (!isWorkflow(workflow) || !runId || !/^[a-z0-9-]{1,64}$/.test(call.flow)) return null;
  const route = flightRoute(ordered(workflow.nodes));
  return route ? { flow: call.flow, runId, workflowId: workflow.workflowId, revision: workflow.revision, route } : null;
}
