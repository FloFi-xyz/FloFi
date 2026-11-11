// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-001: the gateway's view of the deployment's runtime (BUILD-CLOUD-PARITY-001 `flow-runtime.ts`), never a second one.
 *
 *   remote        previews and reads go to the Flofi API (bearer `API_AUTH_TOKEN`, server-to-server only)
 *   embedded      the same backend composition inside this function, on PostgreSQL
 *   local         development: previews, status and evidence fail closed (MCP_CLOUD_RUNTIME_REQUIRED) — local services keep
 *                 file journals, which the gateway must not read or write; use FLOFI_RUNTIME=embedded with a database
 *   unconfigured  hosted without a runtime: CLOUD_RUNTIME_NOT_CONFIGURED
 *
 * Reads are always made AS the owning wallet (`owner`), which comes from the operator's grant for the credential, never from
 * a tool argument; the runtime answers `null` for any run that wallet does not own.
 */
import type { FlowName } from '../../backend/flows.ts';
import type { DelegationFacts } from '../workflow-runs/authorization-plan.ts';
import type { UserFundedFacts } from '../workflow-runs/execution-groups.ts';
import { currentBetaIdentity } from '../flight/beta-context.ts';
import { CLOUD_API_DEADLINE_EXCEEDED, listCloudRuns, type CloudRunSummary } from '../server/cloud-api-client.ts';
import { cloudFlow, cloudFlowMode, cloudPreview, cloudRun, cloudRunJournal, cloudRuns, flowRuntimeKind, type CloudJournalPage, type CloudRun, type EmbeddedRuntime,
  type FlowRuntimeKind, type FlowRuntimeMode } from '../server/flow-runtime.ts';
import { budgetTransport, DeadlineError, isDeadlineError, MCP_UPSTREAM_TIMEOUTS, withinBudget, type RequestBudget } from './deadline.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };
export type EvidenceRecord = { readonly bundleHash: string; readonly environment: string; readonly outcome: string; readonly content: unknown };
export type McpRuntime = {
  readonly kind: FlowRuntimeKind;
  /** The flow's enablement on this deployment; `null` when it cannot be known here (local). */
  readonly mode: (flow: FlowName) => Promise<FlowRuntimeMode | null>;
  /**
   * BUILD-MCP-002: the flow's own owner-execution switch (`info.executionEnabled`, e.g. a mainnet flow whose Simulate/Review are on
   * but whose owner execution needs a separate opt-in). Only called for flows that expose `info`; `null` when unknown.
   */
  readonly info?: (flow: FlowName) => Promise<{ readonly executionEnabled: boolean; readonly networks?: readonly string[] } | null>;
  readonly preview: (flow: FlowName, args: readonly unknown[]) => Promise<Result<unknown>>;
  readonly run: (runId: string, owner: string) => Promise<Result<CloudRun | null>>;
  readonly journal: (runId: string, owner: string, after: number | null, limit: number) => Promise<Result<CloudJournalPage | null>>;
  /** The evidence the flow derives from its durable record (`FLOWS[flow].evidence`), read with the owner's read-only `status`. */
  readonly evidence: (flow: FlowName, runId: string, owner: string) => Promise<Result<EvidenceRecord | null>>;
  /** BUILD-MCP-002: one wallet's most recent runs of one flow (owner-scoped). */
  readonly runs?: (flow: FlowName, owner: string) => Promise<Result<readonly CloudRunSummary[]>>;
  /**
   * BUILD-MCP-002: the flow's durable record of one run, read as its owner, for SERVER-SIDE checks only (the reviewed workflow's hash).
   * It contains executable material and is never returned to an MCP client.
   */
  readonly record?: (flow: FlowName, runId: string, owner: string) => Promise<Result<unknown>>;
  /**
   * BUILD-CHAT-E2E-001: whether this deployment runs multi-step workflows (`FLOFI_WORKFLOW_RUNS=enabled`) and its delegated-execution facts
   * (null: delegation not enabled; otherwise its capability mode and why it cannot sign here, e.g. DELEGATED_SIGNER_UNAVAILABLE). Absent:
   * sequences are not enabled.
   */
  readonly sequences?: () => Promise<SequenceFacts>;
};
/** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: `userFunded` — the deployment's user-funded execution facts (null where not described). */
export type SequenceFacts = { readonly enabled: boolean; readonly delegation: DelegationFacts; readonly userFunded?: UserFundedFacts | null };

const REQUIRED: Result<never> = { ok: false, code: 'MCP_CLOUD_RUNTIME_REQUIRED' };
async function evidenceOf(flow: FlowName, record: Result<unknown> | null): Promise<Result<EvidenceRecord | null>> {
  if (!record) return REQUIRED;
  if (!record.ok) return record;
  const { FLOWS } = await import('../../backend/flows.ts');
  const evidence = FLOWS[flow].evidence(record.value);
  if (!evidence) return { ok: true, value: null };
  return { ok: true, value: { bundleHash: evidence.bundleHash, environment: evidence.environment, outcome: evidence.outcome,
    content: JSON.parse(new TextDecoder().decode(evidence.bytes)) as unknown } };
}

const infoOf = (result: { ok: boolean; value?: unknown } | null) => {
  const value = result?.ok ? result.value as { executionEnabled?: unknown; networks?: unknown } | null : null;
  return value && typeof value.executionEnabled === 'boolean' ? { executionEnabled: value.executionEnabled,
    ...(Array.isArray(value.networks) && value.networks.every(n => typeof n === 'string') ? { networks: value.networks as string[] } : {}) } : null;
};

/**
 * The deployment's runtime through the existing selection (`flow-runtime.ts`). With a request `budget` (the MCP gateway always passes
 * one) every remote call carries the budget's signal and bounded attempts, and the whole runtime is wrapped in `boundedRuntime`;
 * without one the behaviour is unchanged for the other surfaces that share this runtime.
 */
export function deploymentRuntime(env: Env = process.env, budget?: RequestBudget): McpRuntime {
  if (budget) return boundedRuntime(budgetedDeploymentRuntime(env, budget), budget);
  return {
    kind: flowRuntimeKind(env),
    mode: flow => cloudFlowMode(flow, env),
    info: async flow => infoOf(await cloudFlow<unknown>(flow, 'info', [], { env })),
    preview: async (flow, args) => await cloudPreview(flow, args, { env }) ?? REQUIRED,
    run: async (runId, owner) => await cloudRun(runId, owner, { env }) ?? REQUIRED,
    journal: async (runId, owner, after, limit) => await cloudRunJournal(runId, owner, after, limit, { env }) ?? REQUIRED,
    evidence: async (flow, runId, owner) => evidenceOf(flow, await cloudFlow(flow, 'status', [runId], { env, principal: owner })),
    runs: async (flow, owner) => await cloudRuns(flow, owner, env) ?? REQUIRED,
    record: async (flow, runId, owner) => await cloudFlow<unknown>(flow, 'status', [runId], { env, principal: owner }) ?? REQUIRED,
    sequences: async () => (await import('../workflow-runs/facts.ts')).sequenceFacts(env),
  };
}

/**
 * MCP: the remote runtime's calls with the request's deadline. Reads (deployment facts, status, owner-scoped runs) get one short attempt
 * cap and at most two attempts; a preview gets one attempt (a second attempt after a slow preview could only end past the budget).
 * The remote client stops retrying once the budget ends, and every fetch is aborted with it (`budgetTransport`).
 */
function budgetedDeploymentRuntime(env: Env, budget: RequestBudget): McpRuntime {
  const transport = budgetTransport(budget), kind = flowRuntimeKind(env);
  const cap = (ms: number) => Math.max(1, Math.min(ms, budget.remaining()));
  const read = () => ({ env, transport, timeoutMs: cap(MCP_UPSTREAM_TIMEOUTS.read), maxAttempts: 2 });
  const ended = () => new DeadlineError(budget.ended() === 'CLIENT_CLOSED' ? 'MCP_REQUEST_CANCELLED' : 'MCP_REQUEST_TIMEOUT');
  /** The remote client's deadline answer, as the gateway's code (never a domain failure such as "not found" or "off"). */
  const checked = <T>(result: Result<T>): Result<T> => !result.ok && result.code === CLOUD_API_DEADLINE_EXCEEDED ? { ok: false, code: ended().code } : result;
  const fact = <T>(result: Result<T> | null): Result<T> | null => { if (result && !result.ok && result.code === CLOUD_API_DEADLINE_EXCEEDED) throw ended(); return result; };
  return {
    kind,
    // Same fail-closed reading as `cloudFlowMode` (any runtime failure is `off`), except that a deadline is never read as `off`.
    mode: async flow => {
      const result = fact(await cloudFlow<unknown>(flow, 'mode', [], read()));
      return result === null ? null : result.ok && (result.value === 'live' || result.value === 'harness') ? result.value : 'off';
    },
    info: async flow => infoOf(fact(await cloudFlow<unknown>(flow, 'info', [], read()))),
    preview: async (flow, args) => checked<unknown>(await cloudPreview(flow, args, { env, transport, timeoutMs: cap(MCP_UPSTREAM_TIMEOUTS.preview), maxAttempts: 1 }) ?? REQUIRED),
    // The same per-read cap as every other upstream read (never the client's 30 s default, which outlived the tool's own cap).
    run: async (runId, owner) => checked<CloudRun | null>(await cloudRun(runId, owner, { env, transport, timeoutMs: cap(MCP_UPSTREAM_TIMEOUTS.read) }) ?? REQUIRED),
    journal: async (runId, owner, after, limit) => checked<CloudJournalPage | null>(await cloudRunJournal(runId, owner, after, limit,
      { env, transport, timeoutMs: cap(MCP_UPSTREAM_TIMEOUTS.read) }) ?? REQUIRED),
    evidence: async (flow, runId, owner) => checked(await evidenceOf(flow, await cloudFlow(flow, 'status', [runId], { ...read(), principal: owner }))),
    // `cloudRuns` takes no transport: the remote read is made here with the same client, so it carries the deadline too.
    runs: async (flow, owner) => checked<readonly CloudRunSummary[]>(kind === 'remote' ? await listCloudRuns(flow, owner, { env, transport, timeoutMs: cap(MCP_UPSTREAM_TIMEOUTS.read), signal: budget.signal })
      : await cloudRuns(flow, owner, env) ?? REQUIRED),
    record: async (flow, runId, owner) => checked<unknown>(await cloudFlow<unknown>(flow, 'status', [runId], { ...read(), principal: owner }) ?? REQUIRED),
    sequences: async () => (await import('../workflow-runs/facts.ts')).sequenceFacts(env),
  };
}

/** The classified code of a runtime call the budget cut short. */
const timedOut = (error: unknown): Result<never> => ({ ok: false, code: isDeadlineError(error) ? error.code : 'MCP_UPSTREAM_TIMEOUT' });
/**
 * Any runtime (remote, embedded, a test's) with every call bounded by the request budget and its per-operation cap. An embedded call
 * cannot be cancelled: the wrapper stops WAITING for it (its result, if any, is discarded); embedded previews and reads are read-only
 * and observe-only, so nothing durable depends on that late result. A `Result` method that times out returns the classified code; a
 * deployment fact (`mode`, `info`, `sequences`) throws it, so no caller can read a timeout as "off" or "not enabled".
 */
export function boundedRuntime(runtime: McpRuntime, budget: RequestBudget): McpRuntime {
  const { read, preview } = MCP_UPSTREAM_TIMEOUTS;
  const bounded = <T>(capMs: number, call: () => Promise<Result<T>>): Promise<Result<T>> => withinBudget(budget, capMs, call).catch(error => {
    if (isDeadlineError(error)) return timedOut(error);
    throw error;
  });
  return {
    kind: runtime.kind,
    mode: flow => withinBudget(budget, read, () => runtime.mode(flow)),
    ...runtime.info ? { info: (flow: FlowName) => withinBudget(budget, read, () => runtime.info!(flow)) } : {},
    preview: (flow, args) => bounded(preview, () => runtime.preview(flow, args)),
    run: (runId, owner) => bounded(read, () => runtime.run(runId, owner)),
    journal: (runId, owner, after, limit) => bounded(read, () => runtime.journal(runId, owner, after, limit)),
    evidence: (flow, runId, owner) => bounded(read, () => runtime.evidence(flow, runId, owner)),
    ...runtime.runs ? { runs: (flow: FlowName, owner: string) => bounded(read, () => runtime.runs!(flow, owner)) } : {},
    ...runtime.record ? { record: (flow: FlowName, runId: string, owner: string) => bounded(read, () => runtime.record!(flow, runId, owner)) } : {},
    ...runtime.sequences ? { sequences: () => withinBudget(budget, read, () => runtime.sequences!()) } : {},
  };
}

/**
 * The same runtime, remembering the first failed owner-scoped read (`runs`, `run`, `record`). A status view built from it can then say
 * that its run list is INCOMPLETE instead of presenting a read failure (a timeout above all) as "no runs".
 */
export function observeRuntime(runtime: McpRuntime): { readonly runtime: McpRuntime; readonly failure: () => string | null } {
  let failure: string | null = null;
  const seen = <T>(result: Result<T>): Result<T> => { if (!result.ok) failure ??= result.code; return result; };
  return { failure: () => failure, runtime: { ...runtime,
    run: async (runId, owner) => seen(await runtime.run(runId, owner)),
    ...runtime.runs ? { runs: async (flow: FlowName, owner: string) => seen(await runtime.runs!(flow, owner)) } : {},
    ...runtime.record ? { record: async (flow: FlowName, runId: string, owner: string) => seen(await runtime.record!(flow, runId, owner)) } : {} } };
}

/** An embedded runtime instance, e.g. one built with MOCKED seams in tests: the same calls `flow-runtime.ts` makes in embedded mode. */
export function embeddedMcpRuntime(runtime: Pick<EmbeddedRuntime, 'backend' | 'run' | 'journal'> & Partial<Pick<EmbeddedRuntime, 'runs'>>,
  observeRecord?: (flow: FlowName, runId: string, owner: string) => Promise<unknown>): McpRuntime {
  const guard = async <T>(action: () => Promise<T>): Promise<Result<T>> => {
    try { return { ok: true, value: await action() }; }
    catch (error) { return { ok: false, code: error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : 'CLOUD_RUNTIME_UNAVAILABLE' }; }
  };
  const record = async (flow: FlowName, runId: string, owner: string): Promise<Result<unknown>> => {
    if (observeRecord) return guard(() => observeRecord(flow, runId, owner));
    const result = await guard(() => runtime.backend.callFlow(flow, 'status', [runId], undefined, owner, currentBetaIdentity()));
    return result.ok ? result.value : result;
  };
  return {
    kind: 'embedded',
    mode: async flow => { const r = await runtime.backend.callFlow(flow, 'mode', [], undefined, null, currentBetaIdentity()); return r.ok && (r.value === 'live' || r.value === 'harness') ? r.value : 'off'; },
    info: async flow => infoOf(await runtime.backend.callFlow(flow, 'info', [], undefined, null, currentBetaIdentity()).catch(() => null)),
    preview: async (flow, args) => { const r = await guard(() => runtime.backend.previewFlow(flow, args, undefined, { betaIdentity: currentBetaIdentity() })); return r.ok ? r.value : r; },
    run: (runId, owner) => guard(() => runtime.run(runId, owner)),
    journal: (runId, owner, after, limit) => guard(() => runtime.journal(runId, owner, after, limit)),
    evidence: async (flow, runId, owner) => evidenceOf(flow, await record(flow, runId, owner)),
    ...runtime.runs ? { runs: (flow: FlowName, owner: string) => guard(async () => (await runtime.runs!(flow, owner)).filter(r => r.ownerAccount === owner && r.flow === flow)) } : {},
    record,
  };
}
