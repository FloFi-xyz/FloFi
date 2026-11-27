// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-25): completed executions by the channel they originated from (read-only, tenant-scoped,
 * bounded, aggregate counts only: no address, account, approval, credential or run identifier leaves this module).
 *
 * What one count is: ONE unique financial workflow run that completed and reconciled.
 *   workflow run   a `workflow_runs` row (multi-step, Batch Payment and one-step Editor runs alike) in state COMPLETED — written once, by the runner,
 *                  when its last step or wallet group reconciled (`workflow-runs/runner.ts`, `user-funded-pass.ts`) — with, defensively, no step
 *                  left outside RECONCILED/SKIPPED and at least one RECONCILED. A Batch Payment of 8 recipients is ONE run, counted once.
 *   single flow    an execution of `execution_runs` (`workflows.ts`: a root run with its recoveries and composition step runs folded in) whose
 *                  classification is COMPLETED (a reconciled verdict with nothing left to observe). Runs that are the steps of a workflow run
 *                  (`OWNER_RUN` step outcomes name them; live developer steps run under a `wfr_…-step-N` workflow id, `workflow-runs/external-step.ts`)
 *                  are counted once, through their workflow run, never here.
 * Simulations, quotes, approval requests, retries (attempts of one run), reconciliation passes, recoveries and steps never add a count: they
 * are not executions of their own. An execution belongs to the period its root run (or its workflow run) was created in, as everywhere in
 * the Admin.
 *
 * Where a count comes from: only trusted, server-written, persisted records — the approval handoff (`mcp_handoffs`) a workflow run was started
 * from (`workflow_runs.handoff_id`, immutable), or the handoffs whose `run_ids` (written server-side by `bindRuns`) name a run of the execution.
 * The requester kind and client id of a handoff are immutable (migrations 0005/0006). A self-declared `client_name` is never read, and no
 * wallet address, amount or timestamp proximity is ever used to infer an origin. An execution no record attributes stays UNKNOWN; one that two
 * records attribute to different channels is UNKNOWN too (never counted twice). An unbound single-flow execution is a direct FloFi Web run
 * only once web attribution is enabled (`FLOFI_ADMIN_WEB_ATTRIBUTION_FROM`): from then on every approval-originated single flow simulated on
 * FloFi's signing page is bound to its approval at simulation (`server/approval-run-binder.ts`; native signing binds its own run).
 * Known limits of that rule: a binding exists only while its handoff row does (handoffs are meant to be purged after
 * 30 days, `HandoffStore.purge`), and a handoff holds at most 16 runs (`bindRuns` leaves a full list unchanged): a run of such an approval
 * would read as a FloFi Web run.
 */
import type { Queryable } from '@defi-workflow-engine/cloud-runtime';
import type { AdminHost } from '../host.ts';
import { cimdClientId } from '../../mcp/oauth/cimd.ts';
import { COMPOSITION_FLOWS } from './classify.ts';
import { ENVIRONMENTS, type AnalyticsEnvironment } from './networks.ts';
import { executionsOf, loadRuns, type Coverage, type Execution, type LoadedRun } from './workflows.ts';

/** The table's rows, in their fixed order. Web Chat and the Editor are one row: no record says which of the two started a run. */
export const CHANNELS = ['FLOFI_WEB', 'CHATGPT_MCP', 'CLAUDE_MCP', 'TELEGRAM', 'DEVELOPER_API', 'MCP_UNIDENTIFIED', 'UNKNOWN'] as const;
export type Channel = (typeof CHANNELS)[number];
/** An origin: a channel, or an automation rule (reported in its own note, never in the table or its total). */
export type Origin = Channel | 'AUTOMATION';
export const CHANNEL_LABELS: Readonly<Record<Channel, string>> = { FLOFI_WEB: 'FloFi Web', CHATGPT_MCP: 'ChatGPT MCP', CLAUDE_MCP: 'Claude MCP',
  TELEGRAM: 'Telegram', DEVELOPER_API: 'Developer API', MCP_UNIDENTIFIED: 'Unidentified MCP client', UNKNOWN: 'Unknown origin' };

/**
 * The OAuth Client ID Metadata Document hosts that name a channel. A CIMD client id is a trusted origin, unlike the client's name: FloFi's
 * OAuth server accepts it only in the exact form `cimdClientId` checks (https, the allowlisted host itself, no port, credentials, query or
 * fragment), fetches the client's metadata from that very URL, and sends authorization codes only to the redirect URIs that document lists
 * (`mcp/oauth/server.ts`). Whoever obtains a grant under it is therefore that host's client. A dynamically registered client (`flofi_dcr_…`)
 * names itself, so it is an unidentified MCP client whatever it is called. The same hosts decide where native signing returns
 * (`mcp/tools.ts` returnOf).
 */
const CIMD_CHANNELS: Readonly<Record<string, Channel>> = { 'chatgpt.com': 'CHATGPT_MCP', 'claude.ai': 'CLAUDE_MCP' };
const TELEGRAM_CLIENT = /^telegram:[1-9][0-9]{4,15}$/;

/** The origin of one approval handoff, from its immutable requester kind and client id only (pure). */
export function channelOf(requesterKind: string, clientId: string): Origin {
  switch (requesterKind) {
    case 'EDITOR_SESSION': return 'FLOFI_WEB';
    case 'DEVELOPER_PROJECT': return 'DEVELOPER_API';
    case 'AUTOMATION_RULE': return 'AUTOMATION';
    // `telegram:<bot id>` (`channels/telegram/adapter.ts`); any other channel is not one of the reported channels.
    case 'CHANNEL_CONVERSATION': return TELEGRAM_CLIENT.test(clientId) ? 'TELEGRAM' : 'UNKNOWN';
    case 'MCP_ACCOUNT': {
      const check = cimdClientId(clientId, Object.keys(CIMD_CHANNELS));
      return check.ok ? CIMD_CHANNELS[check.url.hostname] ?? 'MCP_UNIDENTIFIED' : 'MCP_UNIDENTIFIED';
    }
    default: return 'UNKNOWN';
  }
}

/** `FLOFI_ADMIN_WEB_ATTRIBUTION_FROM`: a strict ISO-8601 UTC instant (`YYYY-MM-DDTHH:MM:SS[.sss]Z`). Anything else: no cutover (null). */
export function webAttributionFrom(env: Readonly<Record<string, string | undefined>>): Date | null {
  const raw = env.FLOFI_ADMIN_WEB_ATTRIBUTION_FROM;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(raw)) return null;
  const at = new Date(raw);
  // Date accepts out-of-range fields (2026-02-30 → March 2): only an instant that reads back exactly as written is one.
  return !Number.isNaN(at.getTime()) && at.toISOString() === (raw.length === 20 ? raw.replace('Z', '.000Z') : raw) ? at : null;
}

export const CHANNEL_PERIODS = ['today', '7d', '30d', 'all'] as const;
export type ChannelPeriodId = (typeof CHANNEL_PERIODS)[number];
export const CHANNEL_PERIOD_LABELS: Readonly<Record<ChannelPeriodId, string>> = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time' };
export type ChannelPeriod = { readonly id: ChannelPeriodId; readonly from: Date; readonly to: Date; readonly invalid: boolean };
const DAY = 86_400_000;
/** `channels=today|7d|30d|all` (default 30d). Today starts at UTC midnight; All time at the epoch. Every period ends now. */
export function channelPeriod(value: string | undefined, now: Date): ChannelPeriod {
  const id: ChannelPeriodId = (CHANNEL_PERIODS as readonly string[]).includes(value ?? '') ? value as ChannelPeriodId : '30d';
  const t = now.getTime();
  const from = id === 'today' ? t - (t % DAY) : id === '7d' ? t - 7 * DAY : id === '30d' ? t - 30 * DAY : 0;
  return { id, from: new Date(from), to: now, invalid: value !== undefined && id !== value };
}

/** Completed workflow runs, grouped by what decides their origin and environment. */
export type WorkflowRunGroup = { readonly runKind: string; readonly requesterKind: string; readonly clientId: string; readonly networkEnvironment: string;
  readonly count: number };
/** A handoff's binding to runs (`run_ids`), with the facts that decide its origin. */
export type RunBinding = { readonly requesterKind: string; readonly clientId: string; readonly runIds: readonly string[] };
/** A completed single-flow execution: every run that belongs to it, and the workflow ids and flows they ran under. */
export type CompletedExecution = { readonly environment: AnalyticsEnvironment | null; readonly createdAt: Date; readonly runIds: readonly string[];
  readonly workflowIds: readonly string[]; readonly flows: readonly string[] };
export type ChannelTally = { readonly counts: Readonly<Record<Channel, number>>; readonly total: number; readonly automation: number };

/** A handoff's network environment as an Admin environment. A workflow run on any other (MOCK, LOCAL_FORK…) is counted nowhere. */
const WORKFLOW_RUN_ENVIRONMENT: Readonly<Record<string, AnalyticsEnvironment>> = { MAINNET: 'MAINNET', PUBLIC_TESTNET: 'TESTNET' };
/**
 * Flows whose runs the approval run binder never binds at simulation (`server/approval-run-binder.ts`: the Pix payment flow simulates a payment
 * request, not the approval's workflow, and keeps its own binding contract). An unbound run of one stays UNKNOWN after the cutover too: it may
 * be an approval's run that no record names.
 */
export const UNBOUND_AT_SIMULATION_FLOWS: ReadonlySet<string> = new Set(['pix-payment']);
/** Live developer steps run under the workflow id `wfr_<run>-step-<n>` (`workflow-runs/external-step.ts`): steps of a workflow run. */
const isWorkflowRunStepWorkflow = (workflowId: string) => workflowId.startsWith('wfr_');

/** Every run of an execution: its root and recoveries, and the step runs of a composition (so a binding or step reference to any is found). */
export function completedExecutions(executions: readonly Execution[], runs: readonly LoadedRun[]): CompletedExecution[] {
  const byId = new Map(runs.map(run => [run.runId, run]));
  return executions.filter(e => e.classification.outcome === 'COMPLETED').map(e => {
    const ids = new Set(e.runIds);
    for (const id of e.runIds) {
      const run = byId.get(id);
      if (run && COMPOSITION_FLOWS.has(run.flow)) for (const action of run.fact?.actions ?? []) for (const step of action.runs ?? []) ids.add(step);
    }
    const workflowIds = [...new Set([...ids].map(id => byId.get(id)?.workflowId ?? e.workflowId))];
    const flows = [...new Set([e.flow, ...[...ids].flatMap(id => byId.get(id)?.flow ?? [])])];
    return { environment: e.environment, createdAt: e.createdAt, runIds: [...ids], workflowIds, flows };
  });
}

/**
 * The tally (pure). `steps`: run ids a workflow run's OWNER_RUN step names. `cutover`: from when an unbound single flow is a direct FloFi Web
 * run (null: never, it stays UNKNOWN).
 */
export function foldChannels(input: { readonly workflowRuns: readonly WorkflowRunGroup[]; readonly executions: readonly CompletedExecution[];
  readonly steps: ReadonlySet<string>; readonly bindings: readonly RunBinding[]; readonly cutover: Date | null }):
  { readonly byEnvironment: Readonly<Record<AnalyticsEnvironment, ChannelTally>>; readonly unrecognizedEnvironment: number } {
  const tallies = Object.fromEntries(ENVIRONMENTS.map(env => [env, { counts: Object.fromEntries(CHANNELS.map(c => [c, 0])) as Record<Channel, number>, automation: 0 }]));
  let unrecognizedEnvironment = 0;
  const add = (environment: AnalyticsEnvironment | null, origin: Origin, n: number) => {
    if (!environment) { unrecognizedEnvironment += n; return; }
    if (origin === 'AUTOMATION') tallies[environment]!.automation += n; else tallies[environment]!.counts[origin] += n;
  };
  for (const group of input.workflowRuns) {
    // The run copies its handoff's requester (0015, immutable on both): a disagreement is not a trusted origin.
    const origin = group.runKind === group.requesterKind ? channelOf(group.requesterKind, group.clientId) : 'UNKNOWN';
    add(WORKFLOW_RUN_ENVIRONMENT[group.networkEnvironment] ?? null, origin, group.count);
  }
  const bound = new Map<string, Set<Origin>>();
  for (const binding of input.bindings) {
    const origin = channelOf(binding.requesterKind, binding.clientId);
    for (const id of binding.runIds) { const set = bound.get(id) ?? new Set<Origin>(); set.add(origin); bound.set(id, set); }
  }
  for (const e of input.executions) {
    if (e.runIds.some(id => input.steps.has(id)) || e.workflowIds.some(isWorkflowRunStepWorkflow)) continue;
    const origins = new Set(e.runIds.flatMap(id => [...bound.get(id) ?? []]));
    const web = input.cutover !== null && e.createdAt.getTime() >= input.cutover.getTime() && !e.flows.some(flow => UNBOUND_AT_SIMULATION_FLOWS.has(flow));
    const origin: Origin = origins.size > 1 ? 'UNKNOWN' : origins.size === 1 ? [...origins][0]! : web ? 'FLOFI_WEB' : 'UNKNOWN';
    add(e.environment, origin, 1);
  }
  const byEnvironment = Object.fromEntries(ENVIRONMENTS.map(env => { const t = tallies[env]!;
    return [env, { counts: t.counts, total: CHANNELS.reduce((n, c) => n + t.counts[c], 0), automation: t.automation }]; })) as Record<AnalyticsEnvironment, ChannelTally>;
  return { byEnvironment, unrecognizedEnvironment };
}

export type ChannelCounts = {
  readonly period: ChannelPeriod; readonly cutover: Date | null;
  readonly byEnvironment: Readonly<Record<AnalyticsEnvironment, ChannelTally>>;
  /** Completed executions of no recognized environment (a workflow run of another network environment, a run of unknown provenance). */
  readonly unrecognizedEnvironment: number;
  /** What the single-flow read covers (`loadRuns`): truncated, every count is a lower bound from `coveredFrom` on. */
  readonly coverage: Coverage;
  /** More groups of completed workflow runs than one read returns: every count is a lower bound. */
  readonly workflowRunsTruncated: boolean;
  /** Composition executions whose record is not indexed yet: their step runs cannot be recognized and may be counted on their own. */
  readonly compositionsWithoutRecord: Readonly<Record<AnalyticsEnvironment, number>>;
};
export type ChannelCountsResult = { readonly ok: true; readonly value: ChannelCounts } | { readonly ok: false; readonly code: 'ADMIN_CHANNEL_COUNTS_UNAVAILABLE' };

const GROUP_LIMIT = 5_000, BINDING_LIMIT = 20_000;
const bounded = <T>(host: AdminHost, work: (tx: Queryable) => Promise<T>) => host.db.transaction(async tx => {
  await tx.query("SET LOCAL statement_timeout = '4000'");
  return work(tx);
});

/**
 * Completed workflow runs created in the period, grouped by origin facts (no row identity is selected). Bounded by the tenant's runs, as the
 * FinOps cohort (`finops/report.ts`); groups are few (requester kind × client id × environment), at most GROUP_LIMIT are read.
 */
async function completedWorkflowRuns(host: AdminHost, period: ChannelPeriod): Promise<{ groups: WorkflowRunGroup[]; truncated: boolean }> {
  const { rows } = await bounded(host, tx => tx.query<{ run_kind: string; requester_kind: string; client_id: string; network_environment: string; n: number }>(`
    SELECT r.requester_kind AS run_kind, h.requester_kind, h.client_id, h.network_environment, count(*)::int AS n
    FROM workflow_runs r JOIN mcp_handoffs h ON h.tenant_id = r.tenant_id AND h.handoff_id = r.handoff_id
    WHERE r.tenant_id = $1 AND r.state = 'COMPLETED' AND r.completed_at IS NOT NULL AND r.created_at >= $2 AND r.created_at < $3
      AND NOT EXISTS (SELECT 1 FROM workflow_run_steps s WHERE s.tenant_id = r.tenant_id AND s.run_id = r.run_id AND s.state NOT IN ('RECONCILED', 'SKIPPED'))
      AND EXISTS (SELECT 1 FROM workflow_run_steps s WHERE s.tenant_id = r.tenant_id AND s.run_id = r.run_id AND s.state = 'RECONCILED')
    GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC, 1, 2, 3, 4 LIMIT $4`, [host.tenantId, period.from, period.to, GROUP_LIMIT + 1]));
  return { groups: rows.slice(0, GROUP_LIMIT).map(row => ({ runKind: row.run_kind, requesterKind: row.requester_kind, clientId: row.client_id,
    networkEnvironment: row.network_environment, count: row.n })), truncated: rows.length > GROUP_LIMIT };
}
/** The run ids among `ids` that a workflow run's owner-signed step names as its execution (whatever that run's state). */
async function workflowRunSteps(tx: Queryable, tenantId: string, ids: readonly string[]): Promise<Set<string>> {
  const { rows } = await tx.query<{ id: string }>(`SELECT DISTINCT s.outcome->>'executionId' AS id FROM workflow_run_steps s
    WHERE s.tenant_id = $1 AND s.outcome->>'kind' = 'OWNER_RUN' AND s.outcome->>'executionId' = ANY($2::text[])`, [tenantId, ids]);
  return new Set(rows.map(row => row.id));
}
/** The handoffs that bound any of `ids` (handoffs are created before their runs, so `before` bounds the read on the tenant's created_at index). */
async function runBindings(tx: Queryable, tenantId: string, ids: readonly string[], before: Date): Promise<RunBinding[]> {
  const { rows } = await tx.query<{ requester_kind: string; client_id: string; run_ids: string[] }>(`SELECT requester_kind, client_id,
      ARRAY(SELECT r FROM unnest(run_ids) AS r WHERE r = ANY($2::text[])) AS run_ids
    FROM mcp_handoffs WHERE tenant_id = $1 AND created_at < $3::timestamptz + interval '1 hour' AND cardinality(run_ids) > 0 AND run_ids && $2::text[]
    LIMIT $4`, [tenantId, ids, before, BINDING_LIMIT + 1]);
  // Never a partial attribution: a binding left unread could name another channel (or make an unbound run look like a FloFi Web run).
  if (rows.length > BINDING_LIMIT) throw new Error('ADMIN_CHANNEL_BINDINGS_TRUNCATED');
  return rows.map(row => ({ requesterKind: row.requester_kind, clientId: row.client_id, runIds: row.run_ids }));
}

/** One period's completed executions by channel, per environment. Any read failure is the closed code; nothing is estimated. */
export async function loadChannelCounts(host: AdminHost, options: { readonly period: ChannelPeriod; readonly cutover: Date | null }): Promise<ChannelCountsResult> {
  const { period, cutover } = options;
  try {
    const [read, workflowRuns] = await Promise.all([loadRuns(host.db, host.tenantId, period), completedWorkflowRuns(host, period)]);
    const all = executionsOf(read.runs), executions = completedExecutions(all, read.runs);
    const ids = [...new Set(executions.flatMap(e => e.runIds))];
    const { steps, bindings } = ids.length ? await bounded(host, async tx => ({ steps: await workflowRunSteps(tx, host.tenantId, ids),
      bindings: await runBindings(tx, host.tenantId, ids, period.to) })) : { steps: new Set<string>(), bindings: [] };
    const compositionsWithoutRecord = Object.fromEntries(ENVIRONMENTS.map(env => [env, all.filter(e => e.environment === env && COMPOSITION_FLOWS.has(e.flow) && !e.actions).length]));
    return { ok: true, value: { period, cutover, ...foldChannels({ workflowRuns: workflowRuns.groups, executions, steps, bindings, cutover }), coverage: read.coverage,
      workflowRunsTruncated: workflowRuns.truncated, compositionsWithoutRecord: compositionsWithoutRecord as Record<AnalyticsEnvironment, number> } };
  } catch { return { ok: false, code: 'ADMIN_CHANNEL_COUNTS_UNAVAILABLE' }; }
}
