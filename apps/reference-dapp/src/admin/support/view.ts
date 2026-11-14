// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: what the Support & Recovery pages show, assembled from the support modules and the console's
 * existing probes (System Health, AI Settings). Read-only. Every figure is a count of derived incidents or audited recovery attempts — no
 * rate, score or estimate is computed. A source that cannot be read is reported as unavailable, never as "no incidents".
 */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { copilotStatus, healthAttention } from '../attention.ts';
import { copilotSettingsView } from '../copilot-view.ts';
import { healthReport } from '../health.ts';
import { CATEGORIES, type IncidentCategory } from './codes.ts';
import { buildTimeline, incidentStatus, isIncidentId, listNotes, loadTimelineFacts, runTasks, type AttemptRow, type IncidentStatus, type JournalRow, type Milestone, type Note,
  type TaskRow } from './diagnostics.ts';
import { copilotIncidents, delegatedIncident, discoverIncidents, executionIncident, FEATURE_LABELS, loadExecutions, platformIncidents, sortIncidents, taskIncident,
  workflowRunIncident, type DelegatedRow, type ExecutionSnapshot, type Feature, type Incident, type Severity, type SourceStatus, type WorkflowRunRow } from './incidents.ts';
import { investigationOf, latestNoteKinds, loadExecutionAttention, runAttention, type ExecutionAttention, type LatestNote, type Lifecycle } from './lifecycle.ts';
import { loadRunFacts, recoveryHistory, recoverySummary, type HistoryEntry, type HistorySummary } from './recovery.ts';
import { ELIGIBILITY_ORDER, type EligibilityState, type RunRecoveryFacts } from './registry.ts';

type Env = Readonly<Record<string, string | undefined>>;
type Host = { readonly db: Database; readonly tenantId: string };
export type RangeFilter = 'all' | '24h' | '7d' | '30d';
/** OPEN = active + under investigation (the default view); FINAL = executions that failed on chain, shown for diagnosis only. */
export type LifecycleFilter = 'OPEN' | Lifecycle | 'FINAL' | 'ALL';
export const LIFECYCLE_FILTERS: readonly LifecycleFilter[] = ['OPEN', 'ACTIVE', 'UNDER_INVESTIGATION', 'HISTORICAL', 'VERIFIED_RESOLVED', 'FINAL', 'ALL'];
export type SupportFilters = { readonly lifecycle: LifecycleFilter; readonly status: IncidentStatus | 'ALL'; readonly severity: Severity | 'ALL'; readonly category: IncidentCategory | 'ALL';
  readonly feature: Feature | 'ALL'; readonly network: 'ALL' | 'MAINNET' | 'TESTNET' | 'MOCKED'; readonly range: RangeFilter; readonly eligibility: EligibilityState | 'ALL' };
const one = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T => value && (allowed as readonly string[]).includes(value) ? value as T : fallback;
export function supportFilters(params: Readonly<Record<string, string | undefined>>): SupportFilters {
  return {
    lifecycle: one(params.lifecycle, LIFECYCLE_FILTERS, 'OPEN'),
    status: one(params.status, ['ALL', 'NEW', 'INVESTIGATING', 'ESCALATED', 'RESOLUTION_NOTED'] as const, 'ALL'),
    severity: one(params.severity, ['ALL', 'HIGH', 'MEDIUM', 'LOW'] as const, 'ALL'),
    category: one(params.category, ['ALL', ...CATEGORIES] as const, 'ALL'),
    feature: one(params.feature, ['ALL', ...Object.keys(FEATURE_LABELS) as Feature[]] as const, 'ALL'),
    network: one(params.network, ['ALL', 'MAINNET', 'TESTNET', 'MOCKED'] as const, 'ALL'),
    range: one(params.range, ['all', '24h', '7d', '30d'] as const, 'all'),
    eligibility: one(params.eligibility, ['ALL', ...ELIGIBILITY_ORDER] as const, 'ALL'),
  };
}
const RANGE_MS: Readonly<Record<RangeFilter, number | null>> = { all: null, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

export function applyFilters(list: readonly Incident[], filters: SupportFilters, notes: ReadonlyMap<string, readonly Note[]>, now: Date): Incident[] {
  const since = RANGE_MS[filters.range];
  const lifecycle = (incident: Incident) => filters.lifecycle === 'ALL' || (filters.lifecycle === 'OPEN'
    ? incident.lifecycle === 'ACTIVE' || incident.lifecycle === 'UNDER_INVESTIGATION' : incident.lifecycle === filters.lifecycle);
  return list.filter(incident => lifecycle(incident) && (filters.severity === 'ALL' || incident.severity === filters.severity)
    && (filters.category === 'ALL' || incident.category === filters.category)
    && (filters.feature === 'ALL' || incident.feature === filters.feature)
    && (filters.network === 'ALL' || incident.environment === filters.network)
    && (filters.eligibility === 'ALL' || incident.eligibility === filters.eligibility)
    && (filters.status === 'ALL' || incidentStatus(notes.get(incident.id) ?? []) === filters.status)
    && (since === null || now.getTime() - Date.parse(incident.at) <= since));
}

/** Counts over OPEN incidents (active + under investigation); historical, verified-resolved and final ones are counted separately. */
export type SupportCounts = { readonly open: number; readonly underInvestigation: number; readonly historical: number; readonly resolved: number; readonly final: number;
  readonly high: number; readonly recoverable: number; readonly guided: number; readonly userAction: number; readonly engineering: number;
  readonly investigation: number; readonly waiting: number };
export function countIncidents(all: readonly Incident[]): SupportCounts {
  const list = all.filter(incident => incident.lifecycle === 'ACTIVE' || incident.lifecycle === 'UNDER_INVESTIGATION'), n = (l: Incident['lifecycle']) => all.filter(i => i.lifecycle === l).length;
  const by = (states: readonly EligibilityState[]) => list.filter(incident => states.includes(incident.eligibility)).length;
  return { open: list.length, underInvestigation: n('UNDER_INVESTIGATION'), historical: n('HISTORICAL'), resolved: n('VERIFIED_RESOLVED'), final: n('FINAL'), high: list.filter(incident => incident.severity === 'HIGH').length, recoverable: by(['RECOVERABLE_NOW']), guided: by(['REQUIRES_CONFIRMATION']),
    userAction: by(['USER_ACTION']), engineering: by(['ENGINEERING']), investigation: by(['INVESTIGATION']), waiting: by(['WAITING_EXTERNAL']) };
}
export type SupportView = { readonly incidents: Incident[]; readonly all: Incident[]; readonly counts: SupportCounts; readonly sources: SourceStatus[];
  readonly platform: { readonly ok: boolean }; readonly notes: ReadonlyMap<string, readonly Note[]>; readonly notesOk: boolean; readonly history: HistoryEntry[] | null;
  readonly historyCounts: HistorySummary | null; readonly checkedAt: string;
  /** The shared execution-attention model (same figures as System Health, the Overview and Workflows); null when unreadable. */
  readonly attention: ExecutionAttention | null };
export const HISTORY_ROWS = 50;

export async function notesByIncident(host: Host, now: Date, ids: readonly string[] | null): Promise<Map<string, Note[]>> {
  const map = new Map<string, Note[]>();
  for (const note of await listNotes(host, now, ids)) map.set(note.incidentId, [...map.get(note.incidentId) ?? [], note]);
  return map;
}

/** Every current incident, platform and AI conditions included. */
/**
 * An ACTIVE non-execution incident with an explicit review note is UNDER_INVESTIGATION (execution incidents get theirs from the shared model).
 * Only a recorded note counts — opening a page never does.
 */
export function withInvestigation(list: readonly Incident[], latest: ReadonlyMap<string, LatestNote>): Incident[] {
  return list.map(incident => incident.source !== 'EXECUTION' && incident.lifecycle === 'ACTIVE' && investigationOf(latest.get(incident.id)?.kind) === 'ACKNOWLEDGED'
    ? { ...incident, lifecycle: 'UNDER_INVESTIGATION' } : incident);
}

export async function allIncidents(env: Env, host: Host, now: Date): Promise<{ incidents: Incident[]; sources: SourceStatus[]; platformOk: boolean;
  attention: ExecutionAttention | null }> {
  // One read of the execution-attention model feeds both the incident list and System Health, so they cannot show different snapshots.
  const shared = loadExecutionAttention(host.db, host.tenantId, now).catch(() => null);
  const [discovery, report, copilot] = await Promise.all([discoverIncidents(host.db, host.tenantId, now, shared),
    healthReport(env, host, now, fetch, shared).catch(() => null), copilotSettingsView(env, host).catch(() => null)]);
  const extra = [...report ? platformIncidents(healthAttention(report), now) : [], ...copilot ? copilotIncidents(copilotStatus(copilot).items, now) : []];
  const sources: SourceStatus[] = [...discovery.sources, { source: 'PLATFORM', ok: report !== null, code: report ? null : 'HEALTH_UNAVAILABLE', truncated: false },
    { source: 'AI_COPILOT', ok: copilot !== null, code: copilot ? null : 'COPILOT_VIEW_UNAVAILABLE', truncated: false }];
  const others = [...discovery.incidents.filter(i => i.source !== 'EXECUTION'), ...extra];
  const kinds = await latestNoteKinds(host.db, host.tenantId, others.map(i => i.id), now).catch(() => new Map<string, LatestNote>());
  return { incidents: sortIncidents([...discovery.incidents.filter(i => i.source === 'EXECUTION'), ...withInvestigation(others, kinds)]), sources, platformOk: report !== null,
    attention: discovery.attention };
}

export async function supportView(env: Env, host: Host, now: Date, filters: SupportFilters): Promise<SupportView> {
  const [{ incidents, sources, platformOk, attention }, notes, history, historyCounts] = await Promise.all([allIncidents(env, host, now),
    notesByIncident(host, now, null).catch(() => null), recoveryHistory(host, now, { days: 30, limit: HISTORY_ROWS }).catch(() => null),
    recoverySummary(host, now, 30).catch(() => null)]);
  const notesMap = notes ?? new Map<string, Note[]>();
  return { all: incidents, incidents: applyFilters(incidents, filters, notesMap, now), counts: countIncidents(incidents), sources, platform: { ok: platformOk },
    notes: notesMap, notesOk: notes !== null, history, historyCounts, checkedAt: now.toISOString(), attention };
}

export type StepRow = { readonly index: number; readonly state: string; readonly code: string | null; readonly flow: string | null; readonly chain: string | null; readonly updatedAt: string };
export type IncidentDetail =
  | { readonly type: 'run'; readonly incident: Incident | null; readonly run: ExecutionSnapshot; readonly facts: RunRecoveryFacts | null; readonly milestones: Milestone[];
      readonly journal: JournalRow[]; readonly journalTruncated: boolean; readonly attempts: AttemptRow[]; readonly attemptsTruncated: boolean; readonly tasks: TaskRow[];
      readonly tasksTruncated: boolean; readonly history: HistoryEntry[] }
  | { readonly type: 'work'; readonly incident: Incident | null; readonly task: TaskRow & { readonly runId: string | null; readonly superseded: boolean } }
  | { readonly type: 'workflow-run'; readonly incident: Incident | null; readonly row: WorkflowRunRow & { readonly createdAt: string }; readonly steps: StepRow[] }
  | { readonly type: 'delegated'; readonly incident: Incident | null; readonly row: DelegatedRow & { readonly createdAt: string }; readonly steps: StepRow[] }
  | { readonly type: 'condition'; readonly incident: Incident | null }
  | { readonly type: 'not-found' };

/** Everything the diagnostic page shows for one incident id (or one resource found by search). Read-only. */
export async function incidentDetail(env: Env, host: Host, now: Date, id: string): Promise<IncidentDetail> {
  const separator = id.indexOf(':'), prefix = id.slice(0, separator), key = id.slice(separator + 1);
  if (!isIncidentId(id)) return { type: 'not-found' };
  const { db, tenantId } = host;
  const investigated = async (incident: Incident) => withInvestigation([incident], await latestNoteKinds(db, tenantId, [incident.id], now).catch(() => new Map<string, LatestNote>()))[0]!;
  if (prefix === 'run') {
    const [run] = await loadExecutions(db, tenantId, [key]);
    if (!run) return { type: 'not-found' };
    const [facts, timeline, tasks, history, kinds] = await Promise.all([loadRunFacts(db, tenantId, key, now), loadTimelineFacts(host, key), runTasks(host, key),
      recoveryHistory(host, now, { runId: key, days: 90, limit: 50 }), latestNoteKinds(db, tenantId, [id], now).catch(() => new Map<string, LatestNote>())]);
    const note = kinds.get(id), attention = runAttention(run, facts ?? undefined, investigationOf(note?.kind), now, note?.at ?? null);
    return { type: 'run', run, facts, incident: executionIncident(run, facts ?? undefined, now, attention), milestones: buildTimeline(run, timeline.journal, timeline.attempts),
      journal: timeline.journal, journalTruncated: timeline.journalTruncated, attempts: timeline.attempts, attemptsTruncated: timeline.attemptsTruncated,
      tasks: tasks.tasks, tasksTruncated: tasks.truncated, history };
  }
  if (prefix === 'work') {
    if (!/^[1-9][0-9]{0,17}$/.test(key)) return { type: 'not-found' };
    const { rows } = await db.query<{ id: string; kind: string; state: string; deliveries: number; last_error: string | null; created_at: Date; completed_at: Date | null;
      available_at: Date; run_id: string | null; superseded: boolean }>(`SELECT d.id::text AS id, d.kind, d.state, d.deliveries, d.last_error, d.created_at, d.completed_at,
        d.available_at, d.run_id, EXISTS (SELECT 1 FROM work_items n WHERE n.tenant_id = d.tenant_id AND n.kind = d.kind AND n.dedupe_key = d.dedupe_key AND n.id > d.id) AS superseded
      FROM work_items d WHERE d.tenant_id = $1 AND d.id = $2::bigint`, [tenantId, key]);
    const row = rows[0];
    if (!row) return { type: 'not-found' };
    const task = { id: row.id, kind: row.kind, state: row.state, deliveries: row.deliveries, lastError: row.last_error, createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null, availableAt: row.available_at.toISOString(), runId: row.run_id, superseded: row.superseded };
    const incident = row.state === 'DEAD' && !row.superseded && row.completed_at ? await investigated(taskIncident({ id: row.id, kind: row.kind, runId: row.run_id, lastError: row.last_error,
      deliveries: row.deliveries, createdAt: row.created_at, completedAt: row.completed_at })) : null;
    return { type: 'work', task, incident };
  }
  if (prefix === 'wfr') {
    const [run, steps] = await Promise.all([
      db.query<{ run_id: string; state: string; code: string | null; mode: string | null; requester_kind: string; current_step: number; step_count: number; created_at: Date; updated_at: Date }>(
        `SELECT run_id, state, code, mode, requester_kind, current_step, step_count, created_at, updated_at FROM workflow_runs WHERE tenant_id = $1 AND run_id = $2`, [tenantId, key]),
      db.query<{ step_index: number; state: string; code: string | null; flow: string | null; updated_at: Date }>(`SELECT step_index, state, code, flow, updated_at FROM workflow_run_steps
        WHERE tenant_id = $1 AND run_id = $2 ORDER BY step_index`, [tenantId, key])]);
    const r = run.rows[0];
    if (!r) return { type: 'not-found' };
    const row = { runId: r.run_id, state: r.state, code: r.code, mode: r.mode, requesterKind: r.requester_kind, currentStep: r.current_step, stepCount: r.step_count,
      updatedAt: r.updated_at, createdAt: r.created_at.toISOString() };
    return { type: 'workflow-run', row, incident: r.state === 'ATTENTION' ? await investigated(workflowRunIncident(row)) : null,
      steps: steps.rows.map(s => ({ index: s.step_index, state: s.state, code: s.code, flow: s.flow, chain: null, updatedAt: s.updated_at.toISOString() })) };
  }
  if (prefix === 'dex') {
    const [run, steps] = await Promise.all([
      db.query<{ execution_id: string; state: string; code: string | null; attention: boolean; current_step: number; step_count: number; created_at: Date; updated_at: Date }>(
        `SELECT execution_id, state, code, attention, current_step, step_count, created_at, updated_at FROM delegated_executions WHERE tenant_id = $1 AND execution_id = $2`, [tenantId, key]),
      db.query<{ step_index: number; state: string; code: string | null; chain: string; updated_at: Date }>(`SELECT step_index, state, code, chain, updated_at FROM delegated_execution_steps
        WHERE tenant_id = $1 AND execution_id = $2 ORDER BY step_index`, [tenantId, key])]);
    const r = run.rows[0];
    if (!r) return { type: 'not-found' };
    const row = { executionId: r.execution_id, state: r.state, code: r.code, attention: r.attention, currentStep: r.current_step, stepCount: r.step_count, updatedAt: r.updated_at,
      createdAt: r.created_at.toISOString() };
    const open = !['SETTLED', 'BLOCKED', 'FAILED'].includes(r.state) && (r.state === 'UNCERTAIN' || r.state === 'HALTED' || r.attention);
    return { type: 'delegated', row, incident: open ? await investigated(delegatedIncident(row)) : null,
      steps: steps.rows.map(s => ({ index: s.step_index, state: s.state, code: s.code, flow: null, chain: s.chain, updatedAt: s.updated_at.toISOString() })) };
  }
  const { incidents } = await allIncidents(env, host, now);
  return { type: 'condition', incident: incidents.find(incident => incident.id === id) ?? null };
}
