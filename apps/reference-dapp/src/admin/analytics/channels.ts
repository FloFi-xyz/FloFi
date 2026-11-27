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
 * from (`workflow_runs.handoff_id`, immutable), or the handoffs whose `run_ids` name a run of the execution. `run_ids` is written server-side
 * by `HandoffStore.bindRuns` only (`platform/approvals.ts` sharedRunsRead, when a requester reads the status the claimant shares, or an
 * automation reads its own approval; and native signing, `server/native-signing/service.ts`); this module only reads it. The requester kind and client id of a handoff are immutable
 * (migrations 0005/0006). A self-declared `client_name` is never read, and no wallet address, amount, timestamp or absence of a record is ever
 * used to infer an origin. An execution no record attributes stays UNKNOWN, always; one that two records attribute to different channels is
 * UNKNOWN too (never counted twice). FloFi Web is therefore counted only from positive records: workflow runs whose handoff is an
 * EDITOR_SESSION, and single flows an EDITOR_SESSION handoff names.
 * Known limits: a single flow started directly in the app has no origin record (UNKNOWN). A single flow started from an approval keeps the
 * approval's channel only while that approval's binding of the run exists: an approval records a run only when one of those two writers bound
 * it, holds at most 16 runs (`bindRuns` leaves a full list unchanged), and may be removed by retention (`HandoffStore.purge`). Otherwise, and
 * for earlier history without records, the execution is UNKNOWN.
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
/** A completed single-flow execution: every run that belongs to it, and the workflow ids they ran under. */
export type CompletedExecution = { readonly environment: AnalyticsEnvironment | null; readonly runIds: readonly string[]; readonly workflowIds: readonly string[] };
export type ChannelTally = { readonly counts: Readonly<Record<Channel, number>>; readonly total: number; readonly automation: number };

/** A handoff's network environment as an Admin environment. A workflow run on any other (MOCK, LOCAL_FORK…) is counted nowhere. */
const WORKFLOW_RUN_ENVIRONMENT: Readonly<Record<string, AnalyticsEnvironment>> = { MAINNET: 'MAINNET', PUBLIC_TESTNET: 'TESTNET' };
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
    return { environment: e.environment, runIds: [...ids], workflowIds };
  });
}

/** The tally (pure). `steps`: run ids a workflow run's OWNER_RUN step names. An execution no binding names is UNKNOWN, whenever it ran. */
export function foldChannels(input: { readonly workflowRuns: readonly WorkflowRunGroup[]; readonly executions: readonly CompletedExecution[];
  readonly steps: ReadonlySet<string>; readonly bindings: readonly RunBinding[] }):
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
    const origin: Origin = origins.size === 1 ? [...origins][0]! : 'UNKNOWN';
    add(e.environment, origin, 1);
  }
  const byEnvironment = Object.fromEntries(ENVIRONMENTS.map(env => { const t = tallies[env]!;
    return [env, { counts: t.counts, total: CHANNELS.reduce((n, c) => n + t.counts[c], 0), automation: t.automation }]; })) as Record<AnalyticsEnvironment, ChannelTally>;
  return { byEnvironment, unrecognizedEnvironment };
}

export type ChannelCounts = {
  readonly period: ChannelPeriod;
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
  // Never a partial attribution: a binding left unread could name another channel.
  if (rows.length > BINDING_LIMIT) throw new Error('ADMIN_CHANNEL_BINDINGS_TRUNCATED');
  return rows.map(row => ({ requesterKind: row.requester_kind, clientId: row.client_id, runIds: row.run_ids }));
}

/** One period's completed executions by channel, per environment. Any read failure is the closed code; nothing is estimated. */
export async function loadChannelCounts(host: AdminHost, options: { readonly period: ChannelPeriod }): Promise<ChannelCountsResult> {
  const { period } = options;
  try {
    const [read, workflowRuns] = await Promise.all([loadRuns(host.db, host.tenantId, period), completedWorkflowRuns(host, period)]);
    const all = executionsOf(read.runs), executions = completedExecutions(all, read.runs);
    const ids = [...new Set(executions.flatMap(e => e.runIds))];
    const { steps, bindings } = ids.length ? await bounded(host, async tx => ({ steps: await workflowRunSteps(tx, host.tenantId, ids),
      bindings: await runBindings(tx, host.tenantId, ids, period.to) })) : { steps: new Set<string>(), bindings: [] };
    const compositionsWithoutRecord = Object.fromEntries(ENVIRONMENTS.map(env => [env, all.filter(e => e.environment === env && COMPOSITION_FLOWS.has(e.flow) && !e.actions).length]));
    return { ok: true, value: { period, ...foldChannels({ workflowRuns: workflowRuns.groups, executions, steps, bindings }), coverage: read.coverage,
      workflowRunsTruncated: workflowRuns.truncated, compositionsWithoutRecord: compositionsWithoutRecord as Record<AnalyticsEnvironment, number> } };
  } catch { return { ok: false, code: 'ADMIN_CHANNEL_COUNTS_UNAVAILABLE' }; }
}
