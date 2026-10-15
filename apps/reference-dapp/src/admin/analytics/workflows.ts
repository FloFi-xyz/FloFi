// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: platform-wide workflow analytics over the durable projections (read-only, tenant-scoped, bounded).
 *
 * Correlation model:
 *   workflow   `workflow_id` — one authored workflow, however many times it is simulated or executed;
 *   execution  a root run: not a recovery (`recovery_of` folds into its root) and not a composition step run (`composition_of`, or named
 *              by an indexed composition record). Re-simulations create runs that never start, so they never count as executions;
 *              observations and reconciliation passes update the one projection row of a run, so they never add anything;
 *   action     one financial node of the execution's canonical workflow (`admin_run_facts`), with its own network and outcome.
 *
 * An execution belongs to the range its root run was created in. Its recovery runs and composition step runs are folded into it wherever
 * they were created (later ones are loaded too); a recovery whose root was created before the range is part of that earlier execution and is
 * never counted again here. Runs that cannot have started (no evidence, no attempt past PREPARED/CANCELLED, not a composition or recovery)
 * only ever count as simulated (and maybe authorized): they are counted in SQL by the facts the classifier reads, never loaded. The runs that
 * may have started are loaded in full, at most ANALYTICS_ROW_LIMIT per view, newest first: when a range holds more, every figure covers only
 * the newest part (`coverage`), and the page says so.
 *
 * Delegated executions (automations) are separate records and are reported in the Automations section, never added here.
 */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { ACTION_KINDS, type ActionKind, type FactAction } from './actions.ts';
import { attemptSubmitted, classifyRun, COMPOSITION_FLOWS, executed, RATE_OUTCOMES, type AttemptFact, type ExecutionOutcome, type RunClassification } from './classify.ts';
import { environmentOf, ENVIRONMENTS, networkInfo, type AnalyticsEnvironment, type NetworkInfo } from './networks.ts';

export const ANALYTICS_ROW_LIMIT = 20_000;
const DAY = 86_400_000;
export type RangePreset = '24h' | '7d' | '30d' | 'custom';
export type Bucket = 'hour' | 'day' | 'week';
export type AnalyticsRange = { readonly preset: RangePreset; readonly from: Date; readonly to: Date; readonly bucket: Bucket; readonly invalid: boolean };
export type OutcomeFilter = 'ALL' | 'COMPLETED' | 'FAILED' | 'PARTIAL' | 'IN_PROGRESS' | 'UNCERTAIN';
export const OUTCOME_FILTERS: readonly OutcomeFilter[] = ['ALL', 'COMPLETED', 'FAILED', 'PARTIAL', 'IN_PROGRESS', 'UNCERTAIN'];

/** `range=24h|7d|30d` or `range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD` (UTC days, both inclusive, at most 366 days). Default 7 days. */
export function analyticsRange(input: { readonly range?: string | undefined; readonly from?: string | undefined; readonly to?: string | undefined }, now: Date): AnalyticsRange {
  const preset = (days: number, p: RangePreset, invalid = false): AnalyticsRange =>
    ({ preset: p, from: new Date(now.getTime() - days * DAY), to: now, bucket: days <= 1 ? 'hour' : 'day', invalid });
  if (input.range === '24h') return preset(1, '24h');
  if (input.range === '30d') return preset(30, '30d');
  if (input.range !== 'custom') return preset(7, '7d', input.range !== undefined && input.range !== '7d');
  const day = (value: string | undefined) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? new Date(`${value}T00:00:00Z`) : null;
  const from = day(input.from), last = day(input.to);
  if (!from || !last || last < from) return preset(7, '7d', true);
  const to = new Date(Math.min(last.getTime() + DAY, now.getTime() + DAY)), span = (to.getTime() - from.getTime()) / DAY;
  if (span > 366 || from > now) return preset(7, '7d', true);
  return { preset: 'custom', from, to, bucket: span <= 2 ? 'hour' : span <= 92 ? 'day' : 'week', invalid: false };
}
export function bucketStart(at: Date, bucket: Bucket): number {
  const t = at.getTime();
  if (bucket === 'hour') return t - (t % 3_600_000);
  const day = t - (t % DAY);
  if (bucket === 'day') return day;
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // weeks start on Monday (UTC)
  return day - weekday * DAY;
}
export function bucketsOf(range: AnalyticsRange): number[] {
  const step = range.bucket === 'hour' ? 3_600_000 : range.bucket === 'day' ? DAY : 7 * DAY, out: number[] = [];
  for (let t = bucketStart(range.from, range.bucket); t < range.to.getTime() && out.length < 400; t += step) out.push(t);
  return out;
}

type FactRow = { readonly state: 'INDEXED' | 'UNINDEXABLE'; readonly code: string | null; readonly actions: readonly FactAction[]; readonly compositionOf: string | null;
  readonly skipped?: number };
export type LoadedRun = { readonly runId: string; readonly workflowId: string; readonly flow: string; readonly status: string; readonly provenance: string;
  readonly recoveryOf: string | null; readonly errorCode: string | null; readonly needsObservation: boolean; readonly attentionRequired: boolean;
  readonly hasEvidence: boolean; readonly createdAt: Date; readonly updatedAt: Date; readonly attempts: readonly AttemptFact[]; readonly journalAuthorized: boolean;
  readonly fact: FactRow | null };
type Row = { run_id: string; workflow_id: string; flow: string; status: string; provenance: string; recovery_of: string | null; error_code: string | null;
  needs_observation: boolean; attention_required: boolean; has_evidence: boolean; created_at: Date; updated_at: Date; attempts: AttemptFact[]; journal_authorized: boolean;
  fact_state: FactRow['state'] | null; fact_code: string | null; fact_actions: FactAction[] | null; composition_of: string | null; skipped_nodes: number | null };
const SELECT_RUNS = `SELECT r.run_id, r.workflow_id, r.flow, r.status, r.provenance, r.recovery_of, r.error_code, r.needs_observation, r.attention_required, r.has_evidence,
    r.created_at, r.updated_at,
    coalesce((SELECT json_agg(json_build_object('step', a.step, 'state', a.state, 'hash', a.transaction_hash IS NOT NULL, 'reconciled', a.reconciled)
      ORDER BY a.created_at, a.attempt_id) FROM execution_attempts a WHERE a.tenant_id = r.tenant_id AND a.run_id = r.run_id), '[]'::json) AS attempts,
    EXISTS (SELECT 1 FROM journal_entries j WHERE j.tenant_id = r.tenant_id AND j.run_id = r.run_id AND j.to_state = 'AUTHORIZED') AS journal_authorized,
    f.state AS fact_state, f.code AS fact_code, f.actions AS fact_actions, f.composition_of, f.skipped_nodes
  FROM execution_runs r LEFT JOIN admin_run_facts f ON f.tenant_id = r.tenant_id AND f.run_id = r.run_id`;
/**
 * Every ranged read is bounded by the existing (tenant_id, updated_at) index — migration 0012 adds no index to execution_runs. A projection
 * row is written with updated_at = created_at and only moves updated_at forward, so a run created (or recovered) since `from` was updated since
 * then; the hour of slack absorbs transaction-start skew between concurrent writers. `$2` is the range start.
 */
const UPDATED_SINCE = `r.updated_at >= $2::timestamptz - interval '1 hour'`;
const loaded = (row: Row): LoadedRun => ({ runId: row.run_id, workflowId: row.workflow_id, flow: row.flow, status: row.status, provenance: row.provenance,
  recoveryOf: row.recovery_of, errorCode: row.error_code, needsObservation: row.needs_observation, attentionRequired: row.attention_required,
  hasEvidence: row.has_evidence, createdAt: row.created_at, updatedAt: row.updated_at, attempts: row.attempts, journalAuthorized: row.journal_authorized,
  fact: row.fact_state ? { state: row.fact_state, code: row.fact_code, actions: row.fact_actions ?? [], compositionOf: row.composition_of,
    skipped: row.skipped_nodes ?? 0 } : null });

/**
 * What one view's figures cover: all runs created in the range, or (truncated) only those created from `coveredFrom` on. `runsInRange` counts
 * the runs that may have started (the ones the row limit applies to).
 */
export type Coverage = { readonly truncated: boolean; readonly runsInRange: number; readonly coveredFrom: Date | null };
export const FULL_COVERAGE: Coverage = Object.freeze({ truncated: false, runsInRange: 0, coveredFrom: null });
/** Runs in range that never started, grouped by the only facts the classifier reads for them. Each group counts `count` simulated executions. */
export type IdleRuns = { readonly flow: string; readonly provenance: string; readonly status: string; readonly journalAuthorized: boolean; readonly hasAttempts: boolean;
  readonly count: number };

/** `$4` is the composition flows. A run outside this set cannot have started: the classifier's `started` needs one of these facts. */
const MAY_HAVE_STARTED = `(r.has_evidence OR r.flow = ANY($4::text[]) OR r.recovery_of IS NOT NULL OR EXISTS (SELECT 1 FROM execution_attempts a
    WHERE a.tenant_id = r.tenant_id AND a.run_id = r.run_id AND a.state NOT IN ('PREPARED', 'CANCELLED')))`;
const COMPOSITIONS = [...COMPOSITION_FLOWS];

export async function loadRuns(db: Database, tenantId: string, range: { readonly from: Date; readonly to: Date }, limit = ANALYTICS_ROW_LIMIT):
  Promise<{ readonly runs: LoadedRun[]; readonly idle: readonly IdleRuns[]; readonly truncated: boolean; readonly coverage: Coverage }> {
  const { rows } = await db.query<Row>(`${SELECT_RUNS} WHERE r.tenant_id = $1 AND ${UPDATED_SINCE} AND r.created_at >= $2 AND r.created_at < $3 AND ${MAY_HAVE_STARTED}
    ORDER BY r.created_at DESC, r.run_id DESC LIMIT $5`, [tenantId, range.from, range.to, COMPOSITIONS, limit + 1]);
  const truncated = rows.length > limit, runs = rows.slice(0, limit).map(loaded), coveredFrom = truncated ? rows[limit - 1]!.created_at : null;
  const have = new Set(runs.map(run => run.runId)), add = (more: readonly LoadedRun[]) => { for (const run of more) if (!have.has(run.runId)) { have.add(run.runId); runs.push(run); } };
  // Recovery runs created after the range: they fold into an execution whose root may be in it (the others are dropped by `executionsOf`).
  add((await db.query<Row>(`${SELECT_RUNS} WHERE r.tenant_id = $1 AND ${UPDATED_SINCE} AND r.created_at >= $3 AND r.recovery_of IS NOT NULL
    ORDER BY r.created_at LIMIT 5000`, [tenantId, range.from, range.to])).rows.map(loaded));
  // The covered roots of loaded recoveries, should one of them never have started itself. Every run loaded by id is kept out of the idle
  // count below, so none is counted twice.
  const byId: string[] = [];
  for (let hops = 0; hops < 4; hops++) {
    const ids = [...new Set(runs.flatMap(run => run.recoveryOf && !have.has(run.recoveryOf) ? [run.recoveryOf] : []))];
    if (!ids.length) break;
    const found = (await db.query<Row>(`${SELECT_RUNS} WHERE r.tenant_id = $1 AND r.run_id = ANY($4::text[]) AND r.created_at >= $2 AND r.created_at < $3`,
      [tenantId, coveredFrom ?? range.from, range.to, ids])).rows.map(loaded);
    byId.push(...found.map(run => run.runId)); add(found);
    if (found.length < ids.length) break;
  }
  // Step runs of compositions in range that were created just outside it.
  const missing = [...new Set(runs.flatMap(run => COMPOSITION_FLOWS.has(run.flow) ? (run.fact?.actions ?? []).flatMap(a => a.runs ?? []) : []))].filter(id => !have.has(id));
  if (missing.length) { const steps = await loadRunsById(db, tenantId, missing); byId.push(...steps.map(run => run.runId)); add(steps); }
  // Every other run of the covered range never started: count it, grouped by what the classifier reads (composition steps excluded).
  const idle = (await db.query<{ flow: string; provenance: string; status: string; journal_authorized: boolean; has_attempts: boolean; n: number }>(`SELECT r.flow, r.provenance,
      r.status, EXISTS (SELECT 1 FROM journal_entries j WHERE j.tenant_id = r.tenant_id AND j.run_id = r.run_id AND j.to_state = 'AUTHORIZED') AS journal_authorized,
      EXISTS (SELECT 1 FROM execution_attempts a WHERE a.tenant_id = r.tenant_id AND a.run_id = r.run_id) AS has_attempts, count(*)::int AS n
    FROM execution_runs r LEFT JOIN admin_run_facts f ON f.tenant_id = r.tenant_id AND f.run_id = r.run_id
    WHERE r.tenant_id = $1 AND ${UPDATED_SINCE} AND r.created_at >= $2 AND r.created_at < $3 AND NOT ${MAY_HAVE_STARTED} AND f.composition_of IS NULL
      AND NOT (r.run_id = ANY($5::text[]))
    GROUP BY 1, 2, 3, 4, 5`, [tenantId, coveredFrom ?? range.from, range.to, COMPOSITIONS, byId])).rows
    .map(row => ({ flow: row.flow, provenance: row.provenance, status: row.status, journalAuthorized: row.journal_authorized, hasAttempts: row.has_attempts, count: row.n }));
  const runsInRange = truncated ? (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM execution_runs r WHERE r.tenant_id = $1 AND ${UPDATED_SINCE}
    AND r.created_at >= $2 AND r.created_at < $3 AND ${MAY_HAVE_STARTED}`, [tenantId, range.from, range.to, COMPOSITIONS])).rows[0]?.n ?? rows.length : rows.length;
  return { runs, idle, truncated, coverage: { truncated, runsInRange, coveredFrom } };
}
/** Runs by id (no range), e.g. the runs an approval handoff links to. */
export async function loadRunsById(db: Database, tenantId: string, ids: readonly string[]): Promise<LoadedRun[]> {
  if (!ids.length) return [];
  return (await db.query<Row>(`${SELECT_RUNS} WHERE r.tenant_id = $1 AND r.run_id = ANY($2::text[])`, [tenantId, ids.slice(0, 5_000)])).rows.map(loaded);
}

export type ActionOutcome = { readonly kind: ActionKind; readonly type: string; readonly chain: string; readonly to: string | null; readonly executed: boolean;
  readonly outcome: ExecutionOutcome };
export type Execution = { readonly rootId: string; readonly runIds: readonly string[]; readonly workflowId: string; readonly flow: string;
  readonly environment: AnalyticsEnvironment | null; readonly createdAt: Date; readonly updatedAt: Date; readonly status: string; readonly errorCode: string | null;
  readonly classification: RunClassification; readonly executed: boolean; readonly hasEvidence: boolean;
  /** null when the canonical record has not been indexed (or could not be read): the reason is in `factCode`. */
  readonly actions: readonly ActionOutcome[] | null; readonly factCode: string | null;
  /** Financial workflow nodes of the indexed record that name no recognizable network: missing from the distribution, never guessed. */
  readonly skippedActions: number };

const LENDING_STEP: Readonly<Record<string, string>> = { supply: 'SUPPLY', borrow: 'BORROW', 'asset.swap.exact-input': 'SWAP' };
const TERMINAL: ReadonlySet<ExecutionOutcome> = new Set(['COMPLETED', 'FAILED', 'PARTIAL', 'UNCERTAIN', 'NOT_EXECUTED']);
const idle = (whole: RunClassification): ExecutionOutcome => TERMINAL.has(whole.outcome) ? 'NOT_EXECUTED' : 'NOT_STARTED';

function actionOutcomes(latest: LoadedRun, whole: RunClassification, wholeExecuted: boolean, byId: ReadonlyMap<string, LoadedRun>): readonly ActionOutcome[] | null {
  const fact = latest.fact;
  if (!fact || fact.state !== 'INDEXED' || !fact.actions.length) return null;
  return fact.actions.map(action => {
    const base = { kind: action.kind, type: action.type, chain: action.chain, to: action.to ?? null };
    if (COMPOSITION_FLOWS.has(latest.flow)) {
      const steps = (action.runs ?? []).map(id => byId.get(id)).filter((run): run is LoadedRun => Boolean(run)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (!steps.length) return { ...base, executed: false, outcome: idle(whole) };
      const classes = steps.map(step => classifyRun(step)), last = classes.at(-1)!;
      return { ...base, executed: classes.some(executed), outcome: last.outcome };
    }
    if (latest.flow === 'lending-composition') {
      // A step may hold several attempts (cancelled ones, retries): it executed once any put a transaction on chain, and its latest live attempt
      // decides — an earlier reverted attempt followed by a retry is not a failure yet, and a retry never counts as a second action.
      const step = LENDING_STEP[action.type], attempts = latest.attempts.filter(a => a.step === step);
      if (attempts.some(a => a.reconciled)) return { ...base, executed: true, outcome: 'COMPLETED' };
      if (!attempts.some(attemptSubmitted)) return { ...base, executed: false, outcome: idle(whole) };
      if (attempts.filter(a => a.state !== 'CANCELLED').at(-1)?.state === 'REVERTED') return { ...base, executed: true, outcome: 'FAILED' };
      return { ...base, executed: true, outcome: whole.outcome === 'IN_PROGRESS' || whole.outcome === 'COMPLETED' ? whole.outcome : 'UNCERTAIN' };
    }
    return { ...base, executed: wholeExecuted, outcome: whole.outcome };
  });
}

/**
 * Folds runs into executions: recoveries into their root, composition step runs into their composition. A recovery whose root is not among
 * `runs` (created before the range, or before the covered part of it) belongs to that earlier execution and is dropped, never counted twice.
 */
export function executionsOf(runs: readonly LoadedRun[]): Execution[] {
  const byId = new Map(runs.map(run => [run.runId, run]));
  const steps = new Set<string>();
  for (const run of runs) {
    if (run.fact?.compositionOf) steps.add(run.runId);
    if (COMPOSITION_FLOWS.has(run.flow)) for (const action of run.fact?.actions ?? []) for (const id of action.runs ?? []) steps.add(id);
  }
  const groups = new Map<string, LoadedRun[]>();
  for (const run of runs) {
    if (steps.has(run.runId)) continue;
    let root = run;
    for (let hops = 0; root.recoveryOf && byId.has(root.recoveryOf) && hops < 32; hops++) root = byId.get(root.recoveryOf)!;
    if (root.recoveryOf) continue;
    const group = groups.get(root.runId) ?? [];
    group.push(run);
    groups.set(root.runId, group);
  }
  return [...groups.entries()].map(([rootId, group]) => {
    group.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const root = byId.get(rootId)!, latest = group.at(-1)!;
    const classes = group.map(run => {
      const own = classifyRun(run);
      if (!COMPOSITION_FLOWS.has(run.flow)) return own;
      const children = (run.fact?.actions ?? []).flatMap(a => a.runs ?? []).map(id => byId.get(id)).filter((r): r is LoadedRun => Boolean(r)).map(r => classifyRun(r));
      return { ...own, started: own.started || children.some(c => c.started), submitted: own.submitted || children.some(c => c.submitted) };
    });
    const last = classes.at(-1)!;
    const classification: RunClassification = { ...last, authorized: classes.some(c => c.authorized), started: classes.some(c => c.started),
      submitted: classes.some(c => c.submitted) };
    const isExecuted = executed(classification);
    return { rootId, runIds: group.map(run => run.runId), workflowId: root.workflowId, flow: latest.flow, environment: environmentOf(latest.provenance),
      createdAt: root.createdAt, updatedAt: latest.updatedAt, status: latest.status, errorCode: latest.errorCode, classification, executed: isExecuted,
      hasEvidence: group.some(run => run.hasEvidence), actions: actionOutcomes(latest, classification, isExecuted, byId),
      factCode: latest.fact?.state === 'UNINDEXABLE' ? latest.fact.code : latest.fact ? null : 'NOT_INDEXED',
      skippedActions: latest.fact?.state === 'INDEXED' ? latest.fact.skipped ?? 0 : 0 };
  });
}

/** Coarse action kind of a flow, used only to attribute executions whose canonical record is not indexed (never for networks). */
export function flowKind(flow: string): ActionKind {
  if (flow === 'lending-composition' || flow.endsWith('-aave') || flow === 'aave-supply') return 'LENDING';
  if (flow.startsWith('crosschain-router')) return 'BRIDGE';
  if (flow.endsWith('liquidity') || flow.endsWith('liquidity-mainnet')) return 'LIQUIDITY';
  if (flow.endsWith('-swap')) return 'SWAP';
  if (flow.endsWith('transfer')) return 'TRANSFER';
  if (flow.includes('payment')) return 'PAYMENT';
  return 'OTHER';
}

type OutcomeCounts = { COMPLETED: number; FAILED: number; PARTIAL: number; UNCERTAIN: number; IN_PROGRESS: number; UNCLASSIFIED: number };
const outcomeCounts = (): OutcomeCounts => ({ COMPLETED: 0, FAILED: 0, PARTIAL: 0, UNCERTAIN: 0, IN_PROGRESS: 0, UNCLASSIFIED: 0 });
const tally = (counts: OutcomeCounts, outcome: ExecutionOutcome) => { if (outcome in counts) counts[outcome as keyof OutcomeCounts]++; };
export type NetworkRow = NetworkInfo & OutcomeCounts & { readonly actions: number; readonly share: number; readonly workflowsInvolved: number;
  readonly workflowsCompleted: number; readonly asDestination: number };
export type WorkflowAnalytics = {
  readonly environment: AnalyticsEnvironment; readonly truncated: boolean; readonly coverage: Coverage;
  /** Composition executions whose record is not indexed yet: their step runs cannot be recognized, so they may be counted on their own. */
  readonly compositionsWithoutRecord: number;
  /** Executed actions missing from the network distribution because their indexed record names no recognizable network. */
  readonly skippedActions: number;
  readonly executedByEnvironment: Readonly<Record<AnalyticsEnvironment, number>>; readonly unknownProvenance: number;
  readonly funnel: { readonly simulated: number; readonly authorized: number; readonly started: number; readonly executed: number; readonly completed: number };
  readonly outcomes: OutcomeCounts; readonly notExecuted: number; readonly awaitingSignature: number; readonly attention: number;
  readonly rates: { readonly denominator: number; readonly success: number | null; readonly failure: number | null };
  readonly workflows: { readonly executed: number; readonly completed: number };
  readonly series: readonly ({ readonly at: number } & OutcomeCounts)[];
  readonly utilization: readonly { readonly kind: ActionKind; readonly executedActions: number; readonly completedActions: number; readonly failedActions: number;
    readonly executions: number; readonly executionsWithoutRecord: number }[];
  readonly networks: { readonly totalActions: number; readonly rows: readonly NetworkRow[]; readonly executionsWithoutRecord: number;
    readonly withoutRecordCodes: readonly { readonly code: string; readonly count: number }[] };
  readonly bridgeRoutes: readonly ({ readonly from: NetworkInfo; readonly to: NetworkInfo | null; readonly actions: number } & OutcomeCounts)[];
  readonly topByKind: readonly { readonly kind: ActionKind; readonly networks: readonly { readonly network: NetworkInfo; readonly actions: number }[] }[];
  readonly networkTrend: { readonly series: readonly NetworkInfo[]; readonly points: readonly { readonly at: number; readonly counts: readonly number[]; readonly other: number }[] };
  readonly flows: readonly ({ readonly flow: string; readonly executions: number } & OutcomeCounts)[];
  readonly errors: readonly { readonly code: string; readonly count: number; readonly lastAt: string; readonly flows: readonly string[] }[];
  readonly unclassified: readonly { readonly flow: string; readonly status: string; readonly count: number }[];
  readonly fees: { readonly eligibleCompleted: number; readonly byNetwork: readonly { readonly network: NetworkInfo; readonly completed: number }[] };
};

/**
 * Every Overview and Workflows metric for one environment; action/outcome filters narrow the action-level (network) section only. A truncated
 * view's activity series starts at the bucket it covers, so the uncovered part of the range is never drawn as zero activity.
 */
export function summarize(executions: readonly Execution[], range: AnalyticsRange, environment: AnalyticsEnvironment,
  filter: { readonly action: ActionKind | 'ALL'; readonly outcome: OutcomeFilter }, coverage: Coverage = FULL_COVERAGE, idle: readonly IdleRuns[] = []): WorkflowAnalytics {
  const truncated = coverage.truncated;
  // Runs that never started: simulated executions (authorized when the classifier says so), in their own environment; nothing else.
  const idleHere = idle.filter(group => environmentOf(group.provenance) === environment);
  const idleAuthorized = idleHere.reduce((n, group) => n + (classifyRun({ flow: group.flow, status: group.status, needsObservation: false, attentionRequired: false,
    hasEvidence: false, journalAuthorized: group.journalAuthorized, attempts: group.hasAttempts ? [{ step: 'X', state: 'PREPARED', hash: false, reconciled: false }] : [] })
    .authorized ? group.count : 0), 0);
  const executedByEnvironment = Object.fromEntries(ENVIRONMENTS.map(env => [env, executions.filter(e => e.environment === env && e.executed).length])) as Record<AnalyticsEnvironment, number>;
  const scoped = executions.filter(e => e.environment === environment), done = scoped.filter(e => e.executed);
  const outcomes = outcomeCounts();
  for (const e of done) tally(outcomes, e.classification.outcome);
  const denominator = [...RATE_OUTCOMES].reduce((n, outcome) => n + (outcomes[outcome as keyof OutcomeCounts] ?? 0), 0);
  const first = coverage.coveredFrom ? bucketStart(coverage.coveredFrom, range.bucket) : -Infinity;
  const buckets = bucketsOf(range).filter(at => at >= first), series = new Map(buckets.map(at => [at, outcomeCounts()]));
  for (const e of done) { const counts = series.get(bucketStart(e.createdAt, range.bucket)); if (counts) tally(counts, e.classification.outcome); }

  const utilization = ACTION_KINDS.map(kind => ({ kind, executedActions: 0, completedActions: 0, failedActions: 0, executions: 0, executionsWithoutRecord: 0 }));
  const use = (kind: ActionKind) => utilization.find(u => u.kind === kind)!;
  const networks = new Map<string, { info: NetworkInfo; counts: OutcomeCounts; actions: number; involved: Set<string>; completed: Set<string>; asDestination: number }>();
  const network = (chain: string) => { let row = networks.get(chain); if (!row) networks.set(chain, row = { info: networkInfo(chain), counts: outcomeCounts(), actions: 0,
    involved: new Set(), completed: new Set(), asDestination: 0 }); return row; };
  const routes = new Map<string, { from: NetworkInfo; to: NetworkInfo | null; actions: number; counts: OutcomeCounts }>();
  const trend = new Map<number, Map<string, number>>(buckets.map(at => [at, new Map()]));
  const withoutRecord = new Map<string, number>();
  const kindNetworks = new Map<ActionKind, Map<string, number>>();
  const matches = (a: ActionOutcome) => (filter.action === 'ALL' || a.kind === filter.action) && (filter.outcome === 'ALL' || a.outcome === filter.outcome);
  for (const e of done) {
    if (!e.actions) {
      withoutRecord.set(e.factCode ?? 'NOT_INDEXED', (withoutRecord.get(e.factCode ?? 'NOT_INDEXED') ?? 0) + 1);
      const u = use(flowKind(e.flow)); u.executions++; u.executionsWithoutRecord++;
      continue;
    }
    for (const kind of new Set(e.actions.filter(a => a.executed).map(a => a.kind))) use(kind).executions++;
    for (const a of e.actions.filter(x => x.executed)) {
      const u = use(a.kind); u.executedActions++;
      if (a.outcome === 'COMPLETED') u.completedActions++;
      if (a.outcome === 'FAILED') u.failedActions++;
      if (!matches(a)) continue;
      const row = network(a.chain); row.actions++; tally(row.counts, a.outcome); row.involved.add(e.workflowId);
      if (e.classification.outcome === 'COMPLETED') row.completed.add(e.workflowId);
      if (a.to) {
        const destination = network(a.to); destination.asDestination++; destination.involved.add(e.workflowId);
        if (e.classification.outcome === 'COMPLETED') destination.completed.add(e.workflowId);
      }
      if (a.kind === 'BRIDGE') {
        const key = `${a.chain}>${a.to ?? ''}`;
        let route = routes.get(key);
        if (!route) routes.set(key, route = { from: networkInfo(a.chain), to: a.to ? networkInfo(a.to) : null, actions: 0, counts: outcomeCounts() });
        route.actions++; tally(route.counts, a.outcome);
      }
      const point = trend.get(bucketStart(e.createdAt, range.bucket));
      if (point) point.set(a.chain, (point.get(a.chain) ?? 0) + 1);
      const perKind = kindNetworks.get(a.kind) ?? new Map<string, number>();
      perKind.set(a.chain, (perKind.get(a.chain) ?? 0) + 1); kindNetworks.set(a.kind, perKind);
    }
  }
  // The action-level denominator is exclusive (each executed action has exactly one primary network), so shares sum to 100 %.
  const totalActions = [...networks.values()].reduce((n, row) => n + row.actions, 0);
  const rows: NetworkRow[] = [...networks.values()].map(row => ({ ...row.info, ...row.counts, actions: row.actions, share: totalActions ? row.actions / totalActions : 0,
    workflowsInvolved: row.involved.size, workflowsCompleted: row.completed.size, asDestination: row.asDestination }))
    .sort((a, b) => b.actions - a.actions || b.asDestination - a.asDestination || a.name.localeCompare(b.name));
  const topSeries = rows.filter(row => row.actions > 0).slice(0, 5);
  const flows = new Map<string, { executions: number; counts: OutcomeCounts }>();
  for (const e of done) { const f = flows.get(e.flow) ?? { executions: 0, counts: outcomeCounts() }; f.executions++; tally(f.counts, e.classification.outcome); flows.set(e.flow, f); }
  const errors = new Map<string, { count: number; lastAt: number; flows: Set<string> }>();
  for (const e of scoped.filter(x => x.errorCode && x.classification.started)) {
    const entry = errors.get(e.errorCode!) ?? { count: 0, lastAt: 0, flows: new Set<string>() };
    entry.count++; entry.lastAt = Math.max(entry.lastAt, e.updatedAt.getTime()); entry.flows.add(e.flow); errors.set(e.errorCode!, entry);
  }
  const unclassified = new Map<string, number>();
  for (const e of done.filter(x => x.classification.outcome === 'UNCLASSIFIED')) unclassified.set(`${e.flow}\u0000${e.status}`, (unclassified.get(`${e.flow}\u0000${e.status}`) ?? 0) + 1);
  const fees = new Map<string, number>();
  const completedDone = done.filter(e => e.classification.outcome === 'COMPLETED');
  for (const e of completedDone) { const chain = e.actions?.[0]?.chain ?? 'unattributed'; fees.set(chain, (fees.get(chain) ?? 0) + 1); }
  return {
    environment, truncated, coverage, executedByEnvironment,
    unknownProvenance: executions.filter(e => e.environment === null).length + idle.filter(g => environmentOf(g.provenance) === null).reduce((n, g) => n + g.count, 0),
    compositionsWithoutRecord: scoped.filter(e => COMPOSITION_FLOWS.has(e.flow) && !e.actions).length,
    skippedActions: done.reduce((n, e) => n + (e.actions ? e.skippedActions : 0), 0),
    funnel: { simulated: scoped.length + idleHere.reduce((n, group) => n + group.count, 0), authorized: scoped.filter(e => e.classification.authorized).length + idleAuthorized,
      started: scoped.filter(e => e.classification.started).length,
      executed: done.length, completed: outcomes.COMPLETED },
    outcomes, notExecuted: scoped.filter(e => e.classification.started && e.classification.outcome === 'NOT_EXECUTED').length,
    awaitingSignature: scoped.filter(e => e.classification.started && !e.classification.submitted && e.classification.outcome === 'IN_PROGRESS').length,
    attention: scoped.filter(e => e.classification.started && e.classification.attention).length,
    rates: { denominator, success: denominator ? outcomes.COMPLETED / denominator : null, failure: denominator ? outcomes.FAILED / denominator : null },
    workflows: { executed: new Set(done.map(e => e.workflowId)).size, completed: new Set(completedDone.map(e => e.workflowId)).size },
    series: buckets.map(at => ({ at, ...series.get(at)! })),
    utilization,
    networks: { totalActions, rows, executionsWithoutRecord: [...withoutRecord.values()].reduce((n, v) => n + v, 0),
      withoutRecordCodes: [...withoutRecord.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count) },
    bridgeRoutes: [...routes.values()].map(route => ({ from: route.from, to: route.to, actions: route.actions, ...route.counts })).sort((a, b) => b.actions - a.actions),
    topByKind: (['SWAP', 'BRIDGE', 'LIQUIDITY', 'LENDING', 'PAYMENT', 'TRANSFER'] as const).map(kind => ({ kind,
      networks: [...(kindNetworks.get(kind) ?? new Map<string, number>()).entries()].map(([chain, actions]) => ({ network: networkInfo(chain), actions }))
        .sort((a, b) => b.actions - a.actions).slice(0, 3) })),
    networkTrend: { series: topSeries.map(row => networkInfo(row.chain)), points: buckets.map(at => {
      const point = trend.get(at)!, counts = topSeries.map(row => point.get(row.chain) ?? 0);
      return { at, counts, other: [...point.values()].reduce((n, v) => n + v, 0) - counts.reduce((n, v) => n + v, 0) }; }) },
    flows: [...flows.entries()].map(([flow, f]) => ({ flow, executions: f.executions, ...f.counts })).sort((a, b) => b.executions - a.executions),
    errors: [...errors.entries()].map(([code, e]) => ({ code, count: e.count, lastAt: new Date(e.lastAt).toISOString(), flows: [...e.flows].sort() }))
      .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, 20),
    unclassified: [...unclassified.entries()].map(([key, count]) => { const [flow, status] = key.split('\u0000'); return { flow: flow!, status: status!, count }; }),
    fees: { eligibleCompleted: completedDone.length, byNetwork: [...fees.entries()].map(([chain, completed]) => ({ network: networkInfo(chain), completed }))
      .sort((a, b) => b.completed - a.completed) },
  };
}

/** The default environment to show: the first of mainnet, testnet/devnet, mocked with any executed execution in range (else mainnet). */
export function defaultEnvironment(executions: readonly Execution[]): AnalyticsEnvironment {
  return ENVIRONMENTS.find(env => executions.some(e => e.environment === env && e.executed)) ?? 'MAINNET';
}
export const kindOfFilter = (value: string | undefined): ActionKind | 'ALL' => (ACTION_KINDS as readonly string[]).includes(value ?? '') ? value as ActionKind : 'ALL';
export const outcomeOfFilter = (value: string | undefined): OutcomeFilter => (OUTCOME_FILTERS as readonly string[]).includes(value ?? '') ? value as OutcomeFilter : 'ALL';
export const environmentOfFilter = (value: string | undefined): AnalyticsEnvironment | null =>
  (ENVIRONMENTS as readonly string[]).includes(value ?? '') ? value as AnalyticsEnvironment : null;
